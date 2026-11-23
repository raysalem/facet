"""Supervised add-ons: start/stop, the clean env, port: auto, the HMAC ready check, tokens and logs.

Runs a real child process (tests/fixtures_addon_child.py) on the real auth chain (``agent_app``).
"""

import json
import os
import shutil
import sys
import time

import psutil
import pytest

from api import config as api_config
from api.addons import manifest, panels, supervisor
from api.agent import tokens

CHILD = os.path.join(os.path.dirname(__file__), "fixtures_addon_child.py")


def _write(root, addon_id, *flags, port="auto", slots=("sidebar", "import_hook")):
    folder = root / addon_id
    folder.mkdir(exist_ok=True)
    shutil.copy(CHILD, folder / "child.py")
    (folder / "addon.json").write_text(json.dumps({
        "id": addon_id, "name": addon_id.title(), "version": "1", "facet_api": 1,
        "start": {"argv": [sys.executable, "child.py", *flags], "port": port, "health": "/health"},
        "ui": {"path": "/ui/"}, "slots": list(slots), "permissions": ["photos.read"]}), encoding="utf-8")
    return folder


def _gone(pid, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if psutil.Process(pid).status() == psutil.STATUS_ZOMBIE:
                return True
        except psutil.NoSuchProcess:
            return True
        time.sleep(0.1)
    return False


@pytest.fixture()
def env(monkeypatch, tmp_path, agent_app):
    addons = tmp_path / "addons"
    addons.mkdir()
    logs = tmp_path / "logs"
    monkeypatch.setattr(manifest, "addons_dir", lambda: str(addons))
    monkeypatch.setattr(manifest, "addon_logs_dir", lambda: str(logs))
    monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": True})
    monkeypatch.setattr(supervisor, "READY_BUDGET_SECONDS", 15.0)
    folders = {
        "good": _write(addons, "good"),
        "badack": _write(addons, "badack", "--bad-ack"),
        "noport": _write(addons, "noport", "--no-port"),
        "crashy": _write(addons, "crashy", "--crash-after", "2"),
    }
    (addons / "external").mkdir()
    (addons / "external" / "addon.json").write_text(json.dumps({
        "id": "external", "name": "Ext", "version": "1", "facet_api": 1, "ui": {"url": "http://127.0.0.1:9/"},
        "slots": ["sidebar"], "permissions": ["photos.read"]}), encoding="utf-8")
    e = agent_app("legacy")
    e.headers = e.login(edition=True)
    e.folders = folders
    e.logs = logs
    yield e
    supervisor.stop_all()
    supervisor._instances.clear()
    monkeypatch.undo()
    manifest.reload()


def _pids(folder):
    return json.loads((folder / "pids.json").read_text(encoding="utf-8"))


def _start(env, addon_id, scope=None):
    return env.client.post(f"/api/addons/{addon_id}/start", json={"scope": scope}, headers=env.headers)


class TestLifecycle:
    def test_start_proxy_stop_ends_the_whole_tree(self, env):
        resp = _start(env, "good", {"kind": "view"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "running" and body["opened"]["src"].startswith("/addons/good/ui/?nonce=")
        listed = {a["id"]: a for a in env.client.get("/api/addons", headers=env.headers).json()["addons"]}
        assert listed["good"]["status"] == "running"
        # The proxy now forwards, with the launch secret the child requires.
        page = env.client.get(body["opened"]["src"])
        assert page.status_code == 200 and "child" in page.text
        pids = _pids(env.folders["good"])
        # One instance per id: a second start returns the same process.
        assert _start(env, "good").json()["status"] == "running"
        assert _pids(env.folders["good"]) == pids
        stopped = env.client.post("/api/addons/good/stop", headers=env.headers)
        assert stopped.json() == {"addon_id": "good", "stopped": True}
        assert _gone(pids["child"]) and _gone(pids["grandchild"]), "the add-on's process tree outlived stop"
        assert env.client.get(body["opened"]["src"]).status_code == 404
        listed = {a["id"]: a for a in env.client.get("/api/addons", headers=env.headers).json()["addons"]}
        assert listed["good"]["status"] == "stopped"

    def test_stop_then_start_rereads_an_edited_manifest(self, env):
        """#394: Stop + Start on the Add-ons page picks up a changed addon.json, without a restart."""
        manifest_path = env.folders["good"] / "addon.json"
        assert _start(env, "good").json()["status"] == "running"
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        data.update(name="Good Two", version="2")
        manifest_path.write_text(json.dumps(data), encoding="utf-8")
        # Running: a start keeps the running process and the manifest it began with.
        assert _start(env, "good").json()["status"] == "running"
        listed = {a["id"]: a for a in env.client.get("/api/addons", headers=env.headers).json()["addons"]}
        assert listed["good"]["version"] == "1"
        env.client.post("/api/addons/good/stop", headers=env.headers)
        assert _start(env, "good").json()["status"] == "running"
        listed = {a["id"]: a for a in env.client.get("/api/addons", headers=env.headers).json()["addons"]}
        assert (listed["good"]["name"], listed["good"]["version"]) == ("Good Two", "2")
        assert "starting good 2" in (env.logs / "good.log").read_text(encoding="utf-8", errors="replace")
        # An edit that breaks the manifest: the start says why, and the Add-ons page lists it as refused.
        env.client.post("/api/addons/good/stop", headers=env.headers)
        data["permissions"] = ["photos.read", "everything"]
        manifest_path.write_text(json.dumps(data), encoding="utf-8")
        refused = _start(env, "good")
        assert refused.status_code == 409 and "unknown permissions: everything" in refused.json()["detail"]
        body = env.client.get("/api/addons", headers=env.headers).json()
        assert "good" not in {a["id"] for a in body["addons"]}
        assert any(r["directory"] == "good" and "everything" in r["reason"] for r in body["refused"])
        # Fixed again: the next start reads it back.
        data["permissions"] = ["photos.read"]
        manifest_path.write_text(json.dumps(data), encoding="utf-8")
        assert _start(env, "good").json()["status"] == "running"
        # The request never names a path: an id that was never installed is not read.
        assert _start(env, "nothere").status_code == 404

    def test_clean_env_cwd_and_loopback(self, env):
        opened = _start(env, "good", {"kind": "view"}).json()["opened"]
        seen = env.client.get("/addons/good/env", headers={"X-Addon-Nonce": opened["nonce"]}).json()
        child_env = seen["env"]
        allowed = set(supervisor.ENV_PASSTHROUGH) | {"FACET_URL", "FACET_TOKEN", "FACET_ADDON_ID", "FACET_LAUNCH_SECRET"}
        extra = {k for k in child_env if k not in allowed and k.upper() not in {a.upper() for a in allowed}}
        # Windows may add a handful of per-process variables the OS injects itself (none of Facet's).
        assert "DB_PATH" not in child_env and "FACET_CONFIG" not in child_env
        assert not {k for k in extra if "FACET" in k.upper() or "DB" in k.upper() or "SECRET" in k.upper()}
        assert child_env["FACET_ADDON_ID"] == "good" and len(child_env["FACET_LAUNCH_SECRET"]) >= 16
        assert child_env["FACET_URL"].startswith("http://")
        assert os.path.normcase(seen["cwd"]) == os.path.normcase(str(env.folders["good"]))
        assert seen["host"].startswith("127.0.0.1:")
        grant = tokens.verify(child_env["FACET_TOKEN"], kinds=(tokens.KIND_ADDON,))
        assert grant is not None and grant.addon_id == "good"
        env.client.post("/api/addons/good/stop", headers=env.headers)
        assert tokens.verify(child_env["FACET_TOKEN"], kinds=(tokens.KIND_ADDON,)) is None

    def test_wrong_health_ack_never_becomes_running(self, env, monkeypatch):
        monkeypatch.setattr(supervisor, "READY_BUDGET_SECONDS", 3.0)
        resp = _start(env, "badack", {"kind": "view"})
        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert detail["status"] == "failed" and "health check" in detail["error"]
        assert any("fake add-on starting" in line for line in detail["log_tail"])
        assert _gone(_pids(env.folders["badack"])["child"])
        assert panels.match("badack", "x") is None
        live = [r for r in tokens.list_tokens() if r.get("addon_id") == "badack" and not r["revoked"]]
        assert live == []

    def test_no_port_line_fails(self, env, monkeypatch):
        monkeypatch.setattr(supervisor, "READY_BUDGET_SECONDS", 3.0)
        resp = _start(env, "noport")
        assert resp.status_code == 502 and "FACET_ADDON_PORT" in resp.json()["detail"]["error"]

    def test_crash_shows_exit_code_and_revokes(self, env):
        assert _start(env, "crashy").status_code == 200
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            listed = {a["id"]: a for a in env.client.get("/api/addons", headers=env.headers).json()["addons"]}
            if listed["crashy"]["status"] == "exited":
                break
            time.sleep(0.2)
        assert listed["crashy"]["status"] == "exited" and listed["crashy"]["exit_code"] == 3
        live = [r for r in tokens.list_tokens() if r.get("addon_id") == "crashy" and not r["revoked"]]
        assert live == []
        # The next Open starts it again.
        assert _start(env, "crashy").json()["status"] == "running"

    def test_log_route_and_file(self, env):
        _start(env, "good")
        env.client.post("/api/addons/good/stop", headers=env.headers)
        lines = env.client.get("/api/addons/good/log", headers=env.headers).json()["lines"]
        assert any("starting good" in line for line in lines)
        assert (env.logs / "good.log").exists()

    def test_stop_all(self, env):
        _start(env, "good")
        pids = _pids(env.folders["good"])
        supervisor.stop_all()
        assert _gone(pids["child"]) and _gone(pids["grandchild"])


class TestGate:
    def test_needs_scan_access(self, env):
        viewer = env.login(edition=False)
        assert env.client.post("/api/addons/good/start", json={}, headers=viewer).status_code == 403
        assert env.client.post("/api/addons/good/stop", headers=viewer).status_code == 403

    def test_needs_the_switch_and_a_start_block(self, env, monkeypatch):
        assert _start(env, "external").status_code == 409
        monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": False})
        assert _start(env, "good").status_code == 404

    def test_request_cannot_carry_argv_or_env(self, env):
        resp = env.client.post("/api/addons/good/start", headers=env.headers,
                               json={"scope": {"kind": "view"}, "argv": ["calc.exe"], "env": {"X": "1"}})
        # Unknown fields are ignored by the model; the program still comes from the manifest only.
        assert resp.status_code == 200
        assert _pids(env.folders["good"])

    def test_bad_scope_is_refused_before_anything_starts(self, env):
        assert _start(env, "good", {"kind": "nope"}).status_code == 422
        assert supervisor.instance("good") is None

    def test_addon_token_cannot_start_addons(self, env):
        opened = _start(env, "good").json()
        assert opened["status"] == "running"
        child_token = None
        for row in tokens.list_tokens():
            if row.get("addon_id") == "good" and not row["revoked"]:
                child_token = row
        assert child_token is not None  # the launch token exists...
        # ...but no route that starts add-ons is open to an add-on token.
        from api.addons.auth import addon_api_routes
        names = {fn.__name__ for (_, fn) in addon_api_routes()}
        assert not names & {"start_addon", "stop_addon", "mint_token", "open_panel", "list_addons"}


def test_ack_is_hex_hmac_sha256():
    import hashlib
    import hmac
    assert supervisor.ack_for("s" * 32, "abc") == hmac.new(b"s" * 32, b"abc", hashlib.sha256).hexdigest()
