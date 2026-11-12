"""Add-on tokens: mcp_tokens kind='addon', MCP as the data channel (R-MCP) and default deny on ``/api``.

Runs on ``agent_app`` -- the real auth chain and lifespan, no ``dependency_overrides`` -- because what
is under test IS the auth chain: ``get_optional_user``, the app-wide gate and ``TokenGrant.resolve``.
"""

import json
import sqlite3
import sys

import pytest

from api import config as api_config
from api.addons import manifest
from api.addons.auth import ADDON_PERMISSION_TOOLS, addon_api_routes
from api.agent import tokens
from db.schema import init_database
from tests.conftest import _TEST_DB_FILE, AGENT_DIR, intercept_internal_call


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


READ_TOOLS = {"status", "search_photos", "get_photo", "filter_options", "list_albums"}
ASTRO_TOOLS = READ_TOOLS | {"add_tags", "remove_tags", "set_gps"}
SEEDED = [AGENT_DIR + f"addon/{i}.jpg" for i in range(3)]


@pytest.fixture()
def seeded(seed_photos_prefix):
    seed_photos_prefix(AGENT_DIR + "addon/", [
        {"path": path, "filename": path.rsplit("/", 1)[1], "aggregate": 5.0,
         "scanned_at": f"2026-11-01 10:0{i}:00"} for i, path in enumerate(SEEDED)])
    yield SEEDED
    with sqlite3.connect(_TEST_DB_FILE.name) as conn:
        conn.execute("DELETE FROM photo_manual_tags WHERE photo_path LIKE ?", (AGENT_DIR + "addon%",))
        conn.execute("DELETE FROM scan_runs WHERE viewer_job_id = ?", ("c" * 32,))


class TestPermissionTools:
    def test_every_allowlisted_tool_exists_and_none_is_destructive(self, agent_app):
        env = agent_app("open")
        from api.agent.tools_common import TOOL_LEVELS
        server = env.app.state.mcp_server
        assert set(ADDON_PERMISSION_TOOLS) == set(manifest.PERMISSIONS)
        for permission, names in ADDON_PERMISSION_TOOLS.items():
            for name in names:
                assert name in TOOL_LEVELS, f"{permission}: {name} is not a registered tool"
                tool = server._tool_manager.get_tool(name)
                assert tool is not None and not tool.annotations.destructive_hint, (permission, name)
                assert not name.startswith("ui_"), (permission, name)

    def test_annotations_write_maps_the_annotation_tools(self):
        assert ADDON_PERMISSION_TOOLS["annotations.write"] == {"get_annotations", "set_annotations",
                                                                "clear_annotations"}


class TestMcp:
    def test_addon_token_opens_mcp_with_only_its_tools(self, addons):
        env, headers = addons()
        assert env.tool_names(_mint(env, headers)["token"]) == ASTRO_TOOLS
        assert env.tool_names(_mint(env, headers, "reader")["token"]) == READ_TOOLS

    def test_call_outside_the_allowlist_is_refused_before_anything_runs(self, addons, monkeypatch):
        env, headers = addons()
        token = _mint(env, headers, "reader")["token"]
        calls = []
        intercept_internal_call(monkeypatch, lambda tool, kw: calls.append(tool))
        for tool, args in (("set_gps", {"path_prefix": "/x/", "latitude": 1, "longitude": 2}),
                           ("set_rating", {"paths": ["/x.jpg"], "rating": 3}),
                           ("delete_photos", {"bogus": 1}), ("ui_navigate", {})):
            result = env.call(token, tool, args)
            assert result["error"] == "forbidden_level" and "permissions" in result["message"], (tool, result)
        assert calls == []

    def test_destructive_tools_never_reach_an_addon(self, addons, agent_app):
        env, headers = addons()
        api_config.VIEWER_CONFIG["mcp"]["allow_destructive"] = True
        names = env.tool_names(_mint(env, headers)["token"])
        assert names == ASTRO_TOOLS and not names & {"delete_photos", "cull_apply", "junk_reject"}

    def test_level_floor_still_applies(self, addons, seeded):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        api_config.VIEWER_CONFIG["edition_password"] = "rotated-edition"
        assert env.tool_names(token) == READ_TOOLS  # resolved to readonly: the write tools are above it
        result = env.call(token, "set_gps", {"path_prefix": AGENT_DIR, "latitude": 1.0, "longitude": 2.0})
        assert result["error"] == "forbidden_level" and "level" in result["message"]

    def test_disabled_or_removed_addon_is_refused_on_mcp(self, addons, tmp_path, monkeypatch):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": False})
        assert env.rpc(token, "tools/list").status_code == 403
        monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": True})
        (tmp_path / "astro" / "addon.json").unlink()
        manifest.reload()
        assert env.rpc(token, "tools/list").status_code == 403

    def test_manifest_narrows_but_never_widens(self, addons, tmp_path):
        env, headers = addons()
        token = _mint(env, headers, "reader")["token"]
        _write(tmp_path, "reader", permissions=["photos.read", "gps.write"])
        manifest.reload()
        assert env.tool_names(token) == READ_TOOLS  # gps.write was not minted into the token
        _write(tmp_path, "reader", permissions=["gps.write"])
        manifest.reload()
        assert env.tool_names(token) == set()

    def test_no_prompts_and_no_resources(self, addons):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        assert env.rpc(token, "prompts/list").json()["result"]["prompts"] == []
        assert env.rpc(token, "resources/list").json()["result"]["resources"] == []
        assert "error" in env.rpc(token, "resources/read", {"uri": "facet://scoring-contexts"}).json()

    def test_status_reports_only_its_own_hidden_tools(self, addons):
        env, headers = addons()
        result = env.call(_mint(env, headers, "reader")["token"], "status")
        assert result["ok"] and result["data"]["hidden_tools"]["count"] == 0

    def _gps(self, path):
        with sqlite3.connect(_TEST_DB_FILE.name) as conn:
            return conn.execute("SELECT gps_latitude, gps_longitude, gps_manually_set FROM photos WHERE path = ?",
                                (path,)).fetchone()

    def test_annotations_are_written_under_the_addon_id_only(self, addons, seeded, tmp_path):
        _write(tmp_path, "annot", permissions=["photos.read", "annotations.write"])
        env, headers = addons()
        token = _mint(env, headers, "annot")["token"]
        assert {"get_annotations", "set_annotations", "clear_annotations"} <= env.tool_names(token)
        payload = {"version": 1, "image": {"width": 100, "height": 80},
                   "items": [{"id": "deneb", "label": "Deneb", "group": "stars", "shape": "point", "x": 10, "y": 20}]}
        refused = env.call(token, "set_annotations", {"path": SEEDED[0], "payload": payload, "source": "other"})
        assert refused["error"] == "invalid_input", refused
        done = env.call(token, "set_annotations", {"path": SEEDED[0], "payload": payload})
        assert done["ok"] and done["data"]["source"] == "annot", done
        got = env.call(token, "get_annotations", {"path": SEEDED[0]})
        assert [a["source"] for a in got["data"]["annotations"]] == ["annot"], got
        bad = env.call(token, "set_annotations", {"path": SEEDED[0], "payload": {"version": 9}})
        assert not bad["ok"], bad
        cleared = env.call(token, "clear_annotations", {"path": SEEDED[0]})
        assert cleared["ok"] and cleared["data"]["removed"] is True, cleared
        with sqlite3.connect(_TEST_DB_FILE.name) as conn:
            assert conn.execute("SELECT COUNT(*) FROM photo_annotations WHERE photo_path = ?",
                                (SEEDED[0],)).fetchone()[0] == 0

    def test_set_gps_scope_is_a_folder_or_an_album_never_photos(self, addons, seeded, monkeypatch):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        calls = []
        intercept_internal_call(monkeypatch, lambda tool, kw: calls.append(tool))
        coords = {"latitude": 1.0, "longitude": 2.0}
        for args in ({}, {"path_prefix": AGENT_DIR, "album_id": 1}, {"paths": SEEDED}, {"path": SEEDED[0]},
                     {"path_prefix": ""}, {"album_id": 0}):
            result = env.call(token, "set_gps", {**coords, **args})
            assert result["error"] == "invalid_input", (args, result)
        assert calls == []

    def test_set_gps_changes_only_photos_without_gps_unless_overwrite(self, addons, seeded):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        with sqlite3.connect(_TEST_DB_FILE.name) as conn:  # SEEDED[0] carries camera GPS
            conn.execute("UPDATE photos SET gps_latitude = 10, gps_longitude = 20, gps_manually_set = 0 "
                         "WHERE path = ?", (SEEDED[0],))
        args = {"path_prefix": AGENT_DIR + "addon/", "latitude": 32.7, "longitude": -116.9}
        dry = env.call(token, "set_gps", {**args, "dry_run": True})
        assert dry["ok"] and (dry["data"]["changed"], dry["data"]["skipped"]) == (2, 1), dry
        assert self._gps(SEEDED[1])[0] is None  # a dry run writes nothing
        done = env.call(token, "set_gps", args)
        assert done["ok"] and (done["data"]["changed"], done["data"]["skipped"]) == (2, 1), done
        assert done["data"]["scope"] == {"path_prefix": AGENT_DIR + "addon/"} and done["data"]["overwrite"] is False
        assert self._gps(SEEDED[0]) == (10, 20, 0)  # camera GPS kept
        assert self._gps(SEEDED[1]) == (32.7, -116.9, 1) and self._gps(SEEDED[2]) == (32.7, -116.9, 1)
        again = env.call(token, "set_gps", {**args, "overwrite": True})
        assert again["ok"] and (again["data"]["changed"], again["data"]["skipped"]) == (1, 2), again
        assert self._gps(SEEDED[0]) == (32.7, -116.9, 1)

    def test_set_gps_by_album(self, addons, seeded):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        with sqlite3.connect(_TEST_DB_FILE.name) as conn:
            album = conn.execute("INSERT INTO albums (user_id, name) VALUES ('_legacy', 'addon-gps-test')").lastrowid
            conn.execute("INSERT INTO album_photos (album_id, photo_path) VALUES (?, ?)", (album, SEEDED[2]))
        try:
            result = env.call(token, "set_gps", {"album_id": album, "latitude": -33.9, "longitude": 18.4})
            assert result["ok"] and (result["data"]["changed"], result["data"]["skipped"]) == (1, 0), result
            assert self._gps(SEEDED[2]) == (-33.9, 18.4, 1) and self._gps(SEEDED[1])[0] is None
        finally:
            with sqlite3.connect(_TEST_DB_FILE.name) as conn:
                conn.execute("DELETE FROM album_photos WHERE album_id = ?", (album,))
                conn.execute("DELETE FROM albums WHERE id = ?", (album,))

    def test_tags_are_recorded_as_the_addons(self, addons, seeded):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        added = env.call(token, "add_tags", {"tags": ["andromeda"], "paths": SEEDED[:2]})
        assert added["ok"] and added["data"]["affected"] == 2, added
        agent = env.token(headers, "edition")
        assert env.call(agent, "add_tags", {"tags": ["by-agent"], "paths": SEEDED[:1]})["ok"]
        with sqlite3.connect(_TEST_DB_FILE.name) as conn:
            rows = dict(conn.execute("SELECT tag || ':' || photo_path, created_by FROM photo_manual_tags "
                                     "WHERE photo_path LIKE ?", (AGENT_DIR + "addon%",)).fetchall())
        assert rows[f"andromeda:{SEEDED[0]}"] == "astro" and rows[f"andromeda:{SEEDED[1]}"] == "astro"
        assert rows[f"by-agent:{SEEDED[0]}"] is None  # an agent's write is unchanged (single-user: NULL)
        removed = env.call(token, "remove_tags", {"tags": ["andromeda"], "paths": SEEDED[:2]})
        assert removed["ok"] and removed["data"]["affected"] == 2

    def test_search_by_scan_run(self, addons, seeded):
        env, headers = addons()
        token = _mint(env, headers, "reader")["token"]
        with sqlite3.connect(_TEST_DB_FILE.name) as conn:
            conn.execute("INSERT INTO scan_runs (started_at, finished_at, status, args_json, viewer_job_id) "
                         "VALUES (?, ?, ?, ?, ?)", ("2026-11-01 10:00:30", "2026-11-01 10:05:00", "completed",
                                                    json.dumps({"directories": [AGENT_DIR]}), "c" * 32))
            run_id = conn.execute("SELECT id FROM scan_runs WHERE viewer_job_id = ?", ("c" * 32,)).fetchone()[0]
        for value in (run_id, str(run_id), "c" * 32):
            result = env.call(token, "search_photos", {"filters": {"scan_run": value}, "per_page": 100})
            assert result["ok"], result
            assert sorted(r["path"] for r in result["data"]["rows"]) == SEEDED[1:], value
            # The tab has no field for it: never shown (and an add-on never reaches the tab anyway).
            assert result["shown_in_tab"]["applied"] is False
        assert env.call(token, "search_photos", {"filters": {"scan_run": "nope"}})["error"] == "invalid_input"
        assert env.call(token, "search_photos", {"filters": {"scan_run": 999999999}, "show": False})["data"]["total"] == 0

    def test_addon_never_reaches_the_tab(self, addons, seeded):
        env, headers = addons()
        token = _mint(env, headers, "reader")["token"]
        result = env.call(token, "search_photos", {"filters": {"path_prefix": AGENT_DIR}})
        assert result["ok"] and result["shown_in_tab"]["applied"] is False
        selection = env.call(token, "get_photo", {"target": "selection"})
        assert selection["ok"] is False

    def test_agent_token_is_unchanged_on_mcp(self, addons):
        env, headers = addons()
        agent = env.token(headers, "edition")
        names = env.tool_names(agent)
        assert ASTRO_TOOLS <= names and "ui_navigate" in names and len(names) > len(ASTRO_TOOLS) + 10
        assert env.rpc(agent, "prompts/list").json()["result"]["prompts"]


class TestApiExceptions:
    def test_every_open_route_exists(self, app):
        registered = {(m, r.endpoint) for r in _iter_routes(app.routes) for m in r.methods}
        mapped = addon_api_routes()
        assert {endpoint.__name__ for (_, endpoint) in mapped} == {"get_thumbnail", "image", "get_addon_run"}
        for (method, endpoint), permission in mapped.items():
            assert method == "GET", endpoint.__name__  # reads only: every write goes through /mcp
            assert (method, endpoint) in registered, f"{method} {endpoint.__name__} is not a route"
            assert permission == "photos.read"

    def test_image_routes_and_own_runs_answer(self, addons):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        for url in ("/thumbnail?path=/nowhere.jpg", "/image?path=/nowhere.jpg", "/api/addons/runs/" + "d" * 32):
            resp = env.client.get(url, headers=_bearer(token))
            assert resp.status_code not in (401, 403), (url, resp.status_code, resp.text)

    @pytest.mark.parametrize("method,url,body", [
        ("GET", "/api/photos?per_page=1", None), ("GET", "/api/photo?path=/nowhere.jpg", None),
        ("PUT", "/api/photo/gps", {"path": "/x.jpg", "gps_latitude": 1, "gps_longitude": 2}),
        ("POST", "/api/photos/batch_manual_tags", {"photo_paths": ["/x.jpg"], "tag": "x", "action": "add"}),
        ("DELETE", "/api/photo/manual_tags", {"path": "/x.jpg", "tag": "x"}),
        ("GET", "/api/stats/overview", None), ("GET", "/api/auth/status", None), ("GET", "/api/scan/runs", None),
        ("GET", "/api/mcp/tokens", None), ("GET", "/api/addons", None), ("GET", "/api/config", None),
        ("POST", "/api/scan/start", {"directories": []}),
    ])
    def test_every_other_route_answers_403(self, addons, method, url, body):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        resp = env.client.request(method, url, json=body, headers=_bearer(token))
        assert resp.status_code == 403, (url, resp.status_code)
        assert "/mcp" in resp.json()["detail"]

    def test_websocket_refuses_an_addon_token(self, addons):
        from starlette.websockets import WebSocketDisconnect
        env, headers = addons()
        token = _mint(env, headers)["token"]
        with pytest.raises(WebSocketDisconnect):
            with env.client.websocket_connect("/api/mcp/bridge", headers=_bearer(token)) as ws:
                ws.receive_json()

    def test_switch_off_or_manifest_removed_refuses(self, addons, tmp_path, monkeypatch):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": False})
        assert env.client.get("/thumbnail?path=/x.jpg", headers=_bearer(token)).status_code == 403
        monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": True})
        (tmp_path / "astro" / "addon.json").unlink()
        manifest.reload()
        assert env.client.get("/thumbnail?path=/x.jpg", headers=_bearer(token)).status_code == 403

    def test_image_route_needs_photos_read(self, addons, tmp_path):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        _write(tmp_path, "astro", permissions=["gps.write"])
        manifest.reload()
        assert env.client.get("/thumbnail?path=/x.jpg", headers=_bearer(token)).status_code == 403

    def test_rotated_viewer_password_kills_the_token(self, addons):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        api_config.VIEWER_CONFIG["password"] = "rotated-viewer"
        assert env.client.get("/thumbnail?path=/x.jpg", headers=_bearer(token)).status_code == 401
        assert env.rpc(token, "tools/list").status_code == 401

    def test_revoked_token_is_no_credential(self, addons):
        env, headers = addons()
        token = _mint(env, headers)["token"]
        assert env.client.delete("/api/addons/astro/tokens", headers=headers).json()["revoked"] == 1
        # A locked install: no credential at all on a route that needs one.
        assert env.client.get("/api/scan/runs", headers=_bearer(token)).status_code == 401
        assert env.rpc(token, "tools/list").status_code == 401

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

        # Ahead of the SPA fallback, which a built client (client/dist) registers as a catch-all.
        env.app.router.routes.insert(0, env.app.router.routes.pop())

        assert env.client.get("/__probe_addon_user", headers=_bearer(token)).status_code == 403
        assert "user" not in seen  # unmapped: refused before the handler runs
        addon_auth.register_routes(lambda: {("GET", probe): "photos.read"})
        try:
            resp = env.client.get("/__probe_addon_user", headers=_bearer(token))
            assert resp.status_code == 200, resp.text
        finally:
            addon_auth._EXTRA_ROUTES.pop()
            addon_auth.addon_api_routes.cache_clear()
        user = seen["user"]
        assert user.agent and user.addon.id == "reader" and user.addon.scopes == frozenset({"photos.read"})

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
        assert env.tool_names(minted["token"]) == ASTRO_TOOLS


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
