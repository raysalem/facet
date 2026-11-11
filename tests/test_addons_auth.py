"""Add-on tokens on ``/api``: mcp_tokens kind='addon', the verifier and ADDON_ROUTE_SCOPES (default deny).

Runs on ``agent_app`` -- the real auth chain and lifespan, no ``dependency_overrides`` -- because what
is under test IS the auth chain: ``get_optional_user``, the app-wide gate and ``TokenGrant.resolve``.
"""

import json
import sqlite3
import sys

import pytest

from api import config as api_config
from api.addons import manifest
from api.addons.auth import addon_route_scopes
from api.agent import tokens
from db.schema import init_database
from tests.conftest import _TEST_DB_FILE


def _write(root, addon_id, **over):
    data = {"id": addon_id, "name": addon_id.title(), "version": "1", "facet_api": 1,
            "ui": {"url": "http://127.0.0.1:9/"}, "slots": ["sidebar"],
            "permissions": ["photos.read", "gps.write", "tags.write"]}
    data.update(over)
    (root / addon_id).mkdir(exist_ok=True)
    (root / addon_id / "addon.json").write_text(json.dumps(data), encoding="utf-8")


@pytest.fixture()
def addons(monkeypatch, tmp_path, agent_app):
    """``addons(mode)`` -> (env, edition headers) with add-ons on and two manifests installed."""
    monkeypatch.setattr(manifest, "addons_dir", lambda: str(tmp_path))
    monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": True})
    _write(tmp_path, "astro")
    _write(tmp_path, "reader", permissions=["photos.read"])
    _write(tmp_path, "supervised", ui={"path": "/ui/"},
           start={"argv": [sys.executable, "-c", "pass"], "port": "auto"})

    def build(mode="legacy"):
        env = agent_app(mode)  # create_app() runs manifest.reload() against tmp_path
        headers = env.login(edition=True) if mode == "legacy" else env.login(user="root")
        return env, headers

    yield build
    monkeypatch.undo()
    manifest.reload()


def _mint(env, headers, addon_id="astro"):
    resp = env.client.post(f"/api/addons/{addon_id}/token", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _bearer(token):
    return {"Authorization": "Bearer " + token}


def _iter_routes(routes):
    for route in routes:
        inner = getattr(route, "original_router", None)
        if inner is not None:
            yield from _iter_routes(inner.routes)
        elif getattr(route, "methods", None):
            yield route


class TestRouteMap:
    def test_every_mapped_route_exists(self, app):
        registered = {(m, r.endpoint) for r in _iter_routes(app.routes) for m in r.methods}
        mapped = addon_route_scopes()
        assert mapped, "the map must not be empty"
        for (method, endpoint), permission in mapped.items():
            assert (method, endpoint) in registered, f"{method} {endpoint.__name__} is not a route"
            assert permission in manifest.PERMISSIONS

    def test_annotations_write_maps_nothing_until_pr1(self):
        assert "annotations.write" not in set(addon_route_scopes().values())

    def test_every_mapped_route_answers_an_addon_token(self, addons):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        paths = {
            ("GET", "api_photos"): ("/api/photos?per_page=1", None),
            ("GET", "api_photo"): ("/api/photo?path=/nowhere.jpg", None),
            ("GET", "get_thumbnail"): ("/thumbnail?path=/nowhere.jpg", None),
            ("GET", "image"): ("/image?path=/nowhere.jpg", None),
            ("PUT", "api_update_gps"): ("/api/photo/gps", {"path": "/nowhere.jpg", "latitude": 1, "longitude": 2}),
            ("POST", "api_batch_manual_tags"): ("/api/photos/batch_manual_tags", {"photo_paths": ["/nowhere.jpg"], "add": ["x"]}),
            ("DELETE", "api_delete_manual_tag"): ("/api/photo/manual_tags?path=/nowhere.jpg&tag=x", None),
        }
        for (method, endpoint) in addon_route_scopes():
            key = (method, endpoint.__name__)
            if key not in paths:
                continue  # a later piece's route; its own suite exercises it
            url, body = paths[key]
            resp = env.client.request(method, url, json=body, headers=_bearer(token))
            assert resp.status_code not in (401, 403), (key, resp.status_code, resp.text)


class TestVerifier:
    def test_scoped_token_reads_photos(self, addons):
        env, headers = addons()
        minted = _mint(env, headers)
        assert minted["token"].startswith("fct_") and minted["level"] == "edition"
        assert env.client.get("/api/photos?per_page=1", headers=_bearer(minted["token"])).status_code == 200

    @pytest.mark.parametrize("url", ["/api/stats/overview", "/api/auth/status", "/api/scan/runs",
                                     "/api/mcp/tokens", "/api/addons", "/api/config"])
    def test_unmapped_route_answers_403(self, addons, url):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        resp = env.client.get(url, headers=_bearer(token))
        assert resp.status_code == 403, (url, resp.status_code)

    def test_unmapped_write_answers_403(self, addons):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        resp = env.client.post("/api/scan/start", json={"directories": []}, headers=_bearer(token))
        assert resp.status_code == 403

    def test_granted_route_still_validates_its_body(self, addons):
        # An add-on probes "is this route available to me" with an empty body: 422 = granted.
        env, headers = addons()
        token = _mint(env, headers)["token"]
        assert env.client.put("/api/photo/gps", json={}, headers=_bearer(token)).status_code == 422
        assert env.client.post("/api/photos/batch_manual_tags", json={}, headers=_bearer(token)).status_code == 422
        reader = _mint(env, headers, "reader")["token"]
        assert env.client.put("/api/photo/gps", json={}, headers=_bearer(reader)).status_code == 403

    def test_websocket_refuses_an_addon_token(self, addons):
        from starlette.websockets import WebSocketDisconnect
        env, headers = addons()
        token = _mint(env, headers)["token"]
        with pytest.raises(WebSocketDisconnect):
            with env.client.websocket_connect("/api/mcp/bridge", headers=_bearer(token)) as ws:
                ws.receive_json()

    def test_permission_outside_the_token_answers_403(self, addons):
        env, headers = addons()
        token = _mint(env, headers, "reader")["token"]
        assert env.client.get("/api/photos?per_page=1", headers=_bearer(token)).status_code == 200
        resp = env.client.put("/api/photo/gps", json={"path": "/x.jpg", "latitude": 1, "longitude": 2},
                              headers=_bearer(token))
        assert resp.status_code == 403

    def test_manifest_narrows_but_never_widens(self, addons, tmp_path):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        _write(tmp_path, "astro", permissions=["gps.write"])
        manifest.reload()
        assert env.client.get("/api/photos?per_page=1", headers=_bearer(token)).status_code == 403

    def test_switch_off_or_manifest_removed_refuses(self, addons, tmp_path, monkeypatch):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": False})
        assert env.client.get("/api/photos?per_page=1", headers=_bearer(token)).status_code == 403
        monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": True})
        (tmp_path / "astro" / "addon.json").unlink()
        manifest.reload()
        assert env.client.get("/api/photos?per_page=1", headers=_bearer(token)).status_code == 403

    def test_rotated_edition_password_cuts_the_token(self, addons):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        api_config.VIEWER_CONFIG["edition_password"] = "rotated-edition"
        resp = env.client.put("/api/photo/gps", json={"path": "/x.jpg", "latitude": 1, "longitude": 2},
                              headers=_bearer(token))
        assert resp.status_code == 403  # resolved to readonly: the gps route needs edition

    def test_rotated_viewer_password_kills_the_token(self, addons):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        api_config.VIEWER_CONFIG["password"] = "rotated-viewer"
        assert env.client.get("/api/photos?per_page=1", headers=_bearer(token)).status_code == 401

    def test_revoked_token_is_no_credential(self, addons):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        assert env.client.delete("/api/addons/astro/tokens", headers=headers).json()["revoked"] == 1
        # A locked install: no credential at all on a route that needs one.
        assert env.client.get("/api/scan/runs", headers=_bearer(token)).status_code == 401

    def test_addon_user_is_an_agent_with_its_scope(self, addons):
        from fastapi import Request
        from api.addons import auth as addon_auth
        env, headers = addons()
        token = _mint(env, headers, "reader")["token"]
        seen = {}

        @env.app.get("/__probe_addon_user")
        def probe(request: Request):
            seen["user"] = addon_auth.addon_user(request)
            return {}

        assert env.client.get("/__probe_addon_user", headers=_bearer(token)).status_code == 403
        assert "user" not in seen  # unmapped: refused before the handler runs
        addon_auth.register_routes(lambda: {("GET", probe): "photos.read"})
        try:
            assert env.client.get("/__probe_addon_user", headers=_bearer(token)).status_code == 200
        finally:
            addon_auth._EXTRA_ROUTES.pop()
            addon_auth.addon_route_scopes.cache_clear()
        user = seen["user"]
        assert user.agent and user.addon.id == "reader" and user.addon.scopes == frozenset({"photos.read"})

    def test_addon_token_never_opens_mcp(self, addons):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        assert tokens.verify(token) is None
        assert env.rpc(token, "tools/list").status_code == 401

    def test_agent_token_on_api_is_unchanged(self, addons):
        env, headers = addons()
        agent = env.token(headers, "readonly")
        assert tokens.verify(agent, kinds=(tokens.KIND_ADDON,)) is None
        # As before this change: not a credential on /api (a locked install answers 401), never a 403.
        assert env.client.get("/api/scan/runs", headers=_bearer(agent)).status_code == 401
        assert env.rpc(agent, "tools/list").status_code == 200

    def test_multi_user_token_acts_as_the_minting_superadmin(self, addons, monkeypatch):
        env, _ = addons("multi")
        root = env.login(user="root")
        # require_scan_access in multi-user mode: superadmin only.
        assert env.client.post("/api/addons/astro/token", headers=root).status_code == 403
        api_config._FULL_CONFIG["users"]["root"]["role"] = "superadmin"
        root = env.login(user="root")  # the role is in the session's generation: log in again
        minted = _mint(env, root)
        row = next(r for r in tokens.list_tokens() if r["id"] == minted["id"])
        assert row["user_id"] == "root" and row["kind"] == "addon" and row["addon_id"] == "astro"
        assert env.client.get("/api/photos?per_page=1", headers=_bearer(minted["token"])).status_code == 200


class TestAddonsRoutes:
    def test_list_hides_argv_and_shows_refusals(self, addons, tmp_path):
        (tmp_path / "Bad Dir").mkdir()
        env, headers = addons()
        body = env.client.get("/api/addons", headers=headers).json()
        ids = {a["id"]: a for a in body["addons"]}
        assert set(ids) == {"astro", "reader", "supervised"}
        assert ids["supervised"]["mode"] == "supervised" and ids["astro"]["mode"] == "external"
        assert sys.executable not in json.dumps(body["addons"]) and "argv" not in json.dumps(body["addons"])
        assert any(r["directory"] == "Bad Dir" for r in body["refused"])

    def test_disabled_feature_is_404(self, addons, monkeypatch):
        env, headers = addons()
        monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": False})
        assert env.client.get("/api/addons", headers=headers).status_code == 404
        assert env.client.post("/api/addons/astro/token", headers=headers).status_code == 404

    def test_list_needs_scan_access(self, addons):
        env, _ = addons()
        viewer_only = env.login(edition=False)
        assert env.client.get("/api/addons", headers=viewer_only).status_code == 403

    def test_supervised_addon_cannot_mint_once(self, addons):
        env, headers = addons()
        assert env.client.post("/api/addons/supervised/token", headers=headers).status_code == 409
        assert env.client.post("/api/addons/nope/token", headers=headers).status_code == 404

    def test_mint_needs_a_human_session(self, addons):
        env, headers = addons()
        agent = env.token(headers, "edition")
        addon = _mint(env, headers)["token"]
        assert env.client.post("/api/addons/astro/token", headers=_bearer(agent)).status_code in (401, 403)
        assert env.client.post("/api/addons/astro/token", headers=_bearer(addon)).status_code == 403

    def test_live_token_count_and_hash_only_on_disk(self, addons):
        env, headers = addons()
        minted = _mint(env, headers)
        body = env.client.get("/api/addons", headers=headers).json()
        assert next(a for a in body["addons"] if a["id"] == "astro")["live_tokens"] == 1
        with sqlite3.connect(_TEST_DB_FILE.name) as conn:
            stored = conn.execute("SELECT token_hash, kind, scopes FROM mcp_tokens WHERE id = ?",
                                  (minted["id"],)).fetchone()
        assert minted["token"] not in stored and stored[1] == "addon"
        assert json.loads(stored[2]) == ["gps.write", "photos.read", "tags.write"]

    def test_auth_status_reports_the_feature(self, addons, monkeypatch):
        env, headers = addons()
        assert env.client.get("/api/auth/status", headers=headers).json()["features"]["addons"] is True
        monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": False})
        assert env.client.get("/api/auth/status", headers=headers).json()["features"]["addons"] is False


def test_migration_adds_kind_columns_to_an_old_table(tmp_path):
    path = str(tmp_path / "old.db")
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE mcp_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, "
                     "name TEXT NOT NULL, token_prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, "
                     "level TEXT NOT NULL, user_gen TEXT NOT NULL, edition_gen TEXT NOT NULL DEFAULT '', "
                     "created_at TEXT NOT NULL, last_used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0, "
                     "revoked_at TEXT, minted_level TEXT)")
        conn.execute("INSERT INTO mcp_tokens (user_id, name, token_prefix, token_hash, level, user_gen, created_at) "
                     "VALUES ('_legacy', 'old', 'fct_x', 'h', 'readonly', 'g', 'now')")
    init_database(path)
    with sqlite3.connect(path) as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(mcp_tokens)")}
        kind = conn.execute("SELECT kind, addon_id, scopes FROM mcp_tokens").fetchone()
    assert {"kind", "addon_id", "scopes"} <= cols
    assert kind == ("agent", None, None)
