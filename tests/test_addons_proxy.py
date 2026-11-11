"""The add-on panel proxy (``/addons/{id}/{path}``) and the per-open nonce + scope validation.

The upstream is a real HTTP server on a loopback port (``serve_app``), so headers, redirects and
streaming are what a browser would see through Facet, not a mocked transport.
"""

import json

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse, PlainTextResponse, RedirectResponse, Response, StreamingResponse
from starlette.routing import Route

from api import config as api_config
from api.addons import manifest, panels, proxy
from tests.conftest import serve_app


async def _echo(request):
    body = await request.body()
    return JSONResponse({"method": request.method, "path": request.url.path, "query": request.url.query,
                         "headers": {k.lower(): v for k, v in request.headers.items()},
                         "body": body.decode()})


async def _doc(request):
    return Response("<!doctype html><p>panel</p>", media_type="text/html", headers={
        "Set-Cookie": "facet_auth=evil; Path=/", "Content-Security-Policy": "default-src *",
        "X-Frame-Options": "DENY", "Access-Control-Allow-Origin": "https://evil.example",
        "Access-Control-Allow-Credentials": "true", "X-Custom": "dropped"})


async def _stream(request):
    async def gen():
        for i in range(3):
            yield f"data: {i}\n\n".encode()
    return StreamingResponse(gen(), media_type="text/event-stream")


UPSTREAM = Starlette(routes=[
    Route("/", _doc),
    Route("/ui/", _doc),
    Route("/ui", lambda r: RedirectResponse("/ui/", status_code=308)),
    Route("/away", lambda r: RedirectResponse("http://evil.example/", status_code=302)),
    Route("/echo/{rest:path}", _echo, methods=["GET", "POST", "PUT", "DELETE"]),
    Route("/events", _stream),
    Route("/text", lambda r: PlainTextResponse("ok")),
])


@pytest.fixture(scope="module")
def upstream_port():
    with serve_app(UPSTREAM) as port:
        yield port


@pytest.fixture()
def env(monkeypatch, tmp_path, agent_app, upstream_port):
    monkeypatch.setattr(manifest, "addons_dir", lambda: str(tmp_path))
    monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": True})
    monkeypatch.setitem(api_config.VIEWER_CONFIG, "scan_directories", ["/photos/library"])
    for addon_id, slots in (("panel", ["sidebar"]), ("headless", [])):
        (tmp_path / addon_id).mkdir()
        (tmp_path / addon_id / "addon.json").write_text(json.dumps({
            "id": addon_id, "name": addon_id, "version": "1", "facet_api": 1,
            "ui": {"url": f"http://127.0.0.1:{upstream_port}/"}, "slots": slots,
            "permissions": ["photos.read"]}), encoding="utf-8")
    e = agent_app("legacy")
    e.headers = e.login(edition=True)
    yield e
    panels.close_all("panel")
    monkeypatch.undo()
    manifest.reload()


def _open(env, scope=None, addon_id="panel"):
    resp = env.client.post(f"/api/addons/{addon_id}/open", json={"scope": scope}, headers=env.headers)
    return resp


def _nonce(env, scope=None):
    resp = _open(env, scope)
    assert resp.status_code == 200, resp.text
    return resp.json()


class TestGate:
    def test_unknown_or_disabled_is_404(self, env, monkeypatch):
        assert env.client.get("/addons/nope/").status_code == 404
        monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": False})
        assert env.client.get("/addons/panel/").status_code == 404

    def test_no_nonce_is_403_with_the_sandbox_policy(self, env):
        resp = env.client.get("/addons/panel/text")
        assert resp.status_code == 403
        assert resp.headers["content-security-policy"] == proxy.SANDBOX_CSP
        assert resp.headers["access-control-allow-origin"] == "*"

    def test_preflight_is_answered_without_a_nonce(self, env):
        resp = env.client.options("/addons/panel/echo/x", headers={
            "Origin": "null", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-addon-nonce, content-type"})
        assert resp.status_code == 204
        assert resp.headers["access-control-allow-origin"] == "*"
        assert "X-Addon-Nonce" in resp.headers["access-control-allow-headers"]
        assert "access-control-allow-credentials" not in resp.headers

    def test_document_takes_the_nonce_from_the_query_once(self, env):
        opened = _nonce(env)
        assert opened["src"] == f"/addons/panel/?nonce={opened['nonce']}"
        assert env.client.get(opened["src"]).status_code == 200
        # A subresource cannot use the query form; it sends the header.
        assert env.client.get(f"/addons/panel/text?nonce={opened['nonce']}").status_code == 403
        assert env.client.get("/addons/panel/text", headers={"X-Addon-Nonce": opened["nonce"]}).text == "ok"

    def test_wrong_or_closed_nonce_is_403(self, env):
        opened = _nonce(env)
        assert env.client.get("/addons/panel/text", headers={"X-Addon-Nonce": opened["nonce"] + "x"}).status_code == 403
        assert env.client.post("/api/addons/panel/close", json={"nonce": opened["nonce"]},
                               headers=env.headers).json() == {"closed": True}
        assert env.client.get("/addons/panel/text", headers={"X-Addon-Nonce": opened["nonce"]}).status_code == 403

    def test_open_needs_scan_access_and_a_sidebar(self, env):
        viewer = env.login(edition=False)
        assert env.client.post("/api/addons/panel/open", json={}, headers=viewer).status_code == 403
        assert _open(env, addon_id="headless").status_code == 409
        assert _open(env, addon_id="nope").status_code == 404


class TestTopLevelLoad:
    def test_direct_document_load_is_sandboxed_and_sets_no_cookie(self, env):
        """F3: a top-level load of the panel document must not run as Facet's origin."""
        opened = _nonce(env)
        resp = env.client.get(opened["src"])
        assert resp.status_code == 200
        assert resp.headers["content-security-policy"] == proxy.SANDBOX_CSP
        assert resp.headers["content-security-policy"].startswith("sandbox allow-scripts;")
        assert "set-cookie" not in resp.headers
        assert resp.headers["x-content-type-options"] == "nosniff"
        assert resp.headers["referrer-policy"] == "no-referrer"
        assert resp.headers["cache-control"] == "no-store"
        assert resp.headers["access-control-allow-origin"] == "*"
        assert "access-control-allow-credentials" not in resp.headers
        assert "x-custom" not in resp.headers
        assert resp.headers.get("x-frame-options") != "DENY"


class TestForwarding:
    def test_request_headers_are_allowlisted(self, env):
        opened = _nonce(env)
        resp = env.client.get("/addons/panel/echo/a%20b?x=1&nonce=leak", headers={
            "X-Addon-Nonce": opened["nonce"], "Authorization": "Bearer secret", "Cookie": "facet_auth=jwt",
            "X-Forwarded-For": "6.6.6.6", "Accept-Language": "de", "X-Other": "no"})
        seen = resp.json()
        assert seen["path"] == "/echo/a b" and seen["query"] == "x=1"
        headers = seen["headers"]
        for dropped in ("authorization", "cookie", "x-forwarded-for", "x-other", "x-addon-nonce"):
            assert dropped not in headers, dropped
        assert headers["accept-language"] == "de"
        assert headers["x-forwarded-prefix"] == "/addons/panel"
        assert headers["host"].startswith("127.0.0.1:")
        assert "x-facet-launch" not in headers  # external mode: no launch secret

    def test_body_and_methods_are_forwarded(self, env):
        opened = _nonce(env)
        hdr = {"X-Addon-Nonce": opened["nonce"]}
        for method in ("POST", "PUT", "DELETE"):
            seen = env.client.request(method, "/addons/panel/echo/x", content=b'{"a":1}',
                                      headers={**hdr, "Content-Type": "application/json"}).json()
            assert seen["method"] == method and seen["body"] == '{"a":1}'
        assert env.client.head("/addons/panel/text", headers=hdr).status_code == 200

    def test_streamed_response_passes_through(self, env):
        opened = _nonce(env)
        resp = env.client.get("/addons/panel/events", headers={"X-Addon-Nonce": opened["nonce"]})
        assert resp.headers["content-type"].startswith("text/event-stream")
        assert resp.text == "data: 0\n\ndata: 1\n\ndata: 2\n\n"

    def test_relative_redirect_is_rewritten_and_absolute_refused(self, env):
        opened = _nonce(env)
        hdr = {"X-Addon-Nonce": opened["nonce"]}
        resp = env.client.get("/addons/panel/ui", headers=hdr, follow_redirects=False)
        assert resp.status_code == 308 and resp.headers["location"] == "/addons/panel/ui/"
        assert env.client.get("/addons/panel/away", headers=hdr, follow_redirects=False).status_code == 502

    @pytest.mark.parametrize("path", ["/addons/panel/a//b", "/addons/panel/a/%2e%2e/b", "/addons/panel/a%5Cb",
                                      "/addons/panel/a%00b"])
    def test_unsafe_paths_are_refused(self, env, path):
        opened = _nonce(env)
        assert env.client.get(path, headers={"X-Addon-Nonce": opened["nonce"]}).status_code in (400, 404)

    def test_safe_segments(self):
        assert proxy.safe_segments("ui/") == ["ui", ""]
        assert proxy.safe_segments("") == [""]
        for bad in ("/x", "a//b", "a/../b", "..", "a\\b", "a\0b", "./a"):
            assert proxy.safe_segments(bad) is None, bad

    def test_upstream_down_is_502(self, env, monkeypatch):
        opened = _nonce(env)
        monkeypatch.setattr(proxy, "UPSTREAMS", [lambda addon: proxy.Upstream("http://127.0.0.1:9/")])
        assert env.client.get("/addons/panel/text", headers={"X-Addon-Nonce": opened["nonce"]}).status_code == 502

    def test_launch_secret_is_sent_when_supervised(self, env, monkeypatch, upstream_port):
        opened = _nonce(env)
        monkeypatch.setattr(proxy, "UPSTREAMS", [
            lambda addon: proxy.Upstream(f"http://127.0.0.1:{upstream_port}/", "s" * 32)])
        seen = env.client.get("/addons/panel/echo/x", headers={"X-Addon-Nonce": opened["nonce"]}).json()
        assert seen["headers"]["x-facet-launch"] == "s" * 32

    def test_body_cap_applies(self, env):
        opened = _nonce(env)
        resp = env.client.post("/addons/panel/echo/x", content=b"x" * (10 * 1024 * 1024 + 1),
                               headers={"X-Addon-Nonce": opened["nonce"]})
        assert resp.status_code == 413


class TestScope:
    def test_default_is_the_view(self, env):
        assert _nonce(env)["scope"] == {"kind": "view", "query": ""}

    def test_view_query_keeps_only_gallery_keys(self, env):
        scope = _nonce(env, {"kind": "view", "query": "type=astro&min_score=5&evil=1&argv=x"})["scope"]
        assert scope == {"kind": "view", "query": "type=astro&min_score=5"}

    @pytest.mark.parametrize("scope", [
        {"kind": "nope"},
        {"kind": "view", "query": "x" * 3000},
        {"kind": "view", "query": "path_prefix=/etc/"},
        {"kind": "selection", "path_prefix": "/photos/library/../../etc"},
        {"kind": "selection", "query": "type=astro"},
        {"kind": "view", "run_id": "abc"},
        {"kind": "import", "run_id": "abc"},
        {"kind": "view", "argv": ["x"]},
        "view",
    ])
    def test_bad_scopes_are_422(self, env, scope):
        assert _open(env, scope).status_code == 422

    def test_prefix_under_a_scan_directory_is_accepted(self, env):
        scope = _nonce(env, {"kind": "selection", "path_prefix": "/photos/library/2026"})["scope"]
        assert scope == {"kind": "selection", "path_prefix": "/photos/library/2026"}

    def test_nonce_shape_matches_the_bridge_contract(self, env):
        import re
        assert re.fullmatch(r"[A-Za-z0-9_.~-]{8,256}", _nonce(env)["nonce"])

    def test_panel_cap_drops_the_oldest(self, env):
        first = _nonce(env)["nonce"]
        for _ in range(panels.MAX_PANELS_PER_ADDON):
            _nonce(env)
        assert panels.match("panel", first) is None


def test_viewer_starts_and_proxy_degrades_without_httpx():
    import subprocess
    import sys
    code = ("import sys; sys.modules['httpx'] = None\n"
            "import api\n"
            "api.create_app()\n")
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr[-2000:]
