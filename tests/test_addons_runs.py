"""The after-import hook: ``after_addon`` on scan start, ``addon_runs``, ``scan_run`` and the runs route."""

import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from api import config as api_config
from api import create_app
from api.addons import manifest, panels, runs
from api.auth import CurrentUser, require_scan_access
from tests.conftest import _TEST_DB_FILE

PREFIX = "/addon-runs-test/"
JOB = "a" * 32
OTHER_JOB = "b" * 32


def _db():
    conn = sqlite3.connect(_TEST_DB_FILE.name)
    conn.row_factory = sqlite3.Row
    return conn


@pytest.fixture()
def installed(monkeypatch, tmp_path):
    monkeypatch.setattr(manifest, "addons_dir", lambda: str(tmp_path))
    monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": True})
    for addon_id, slots in (("astro", ["sidebar", "import_hook"]), ("plain", ["sidebar"])):
        (tmp_path / addon_id).mkdir()
        (tmp_path / addon_id / "addon.json").write_text(json.dumps({
            "id": addon_id, "name": addon_id.title(), "version": "1", "facet_api": 1,
            "ui": {"url": "http://127.0.0.1:9/"}, "slots": slots, "permissions": ["photos.read"]}), encoding="utf-8")
    manifest.reload()
    yield
    with _db() as conn:
        conn.execute("DELETE FROM addon_runs")
        conn.execute("DELETE FROM scan_runs WHERE viewer_job_id IN (?, ?)", (JOB, OTHER_JOB))
    panels.close_all("astro")
    monkeypatch.undo()
    manifest.reload()


@pytest.fixture()
def library(seed_photos_prefix):
    """Two runs: JOB scanned a/ and b/ 10:00-11:00; OTHER_JOB (still running) scanned c/ from 12:00."""
    rows = []
    for i in range(5):
        rows.append({"path": f"{PREFIX}a/{i}.jpg", "filename": f"a{i}.jpg", "aggregate": 5.0 + i,
                     "category": "astro" if i % 2 else "landscape", "scanned_at": f"2026-11-01 10:0{i}:00"})
    rows += [
        {"path": f"{PREFIX}b/x.jpg", "filename": "bx.jpg", "aggregate": 4.0, "category": "astro", "scanned_at": "2026-11-01 10:30:00"},
        {"path": f"{PREFIX}a/late.jpg", "filename": "late.jpg", "aggregate": 4.0, "category": "astro", "scanned_at": "2026-11-01 12:30:00"},
        {"path": f"{PREFIX}c/y.jpg", "filename": "cy.jpg", "aggregate": 4.0, "category": "astro", "scanned_at": "2026-11-01 12:30:00"},
        {"path": f"{PREFIX}ab/z.jpg", "filename": "abz.jpg", "aggregate": 4.0, "category": "astro", "scanned_at": "2026-11-01 10:30:00"},
        {"path": f"{PREFIX}a/old.jpg", "filename": "old.jpg", "aggregate": 4.0, "category": "astro", "scanned_at": "2026-10-01 10:30:00"},
    ]
    seed_photos_prefix(PREFIX, rows)
    with _db() as conn:
        conn.execute("INSERT INTO scan_runs (started_at, finished_at, status, args_json, viewer_job_id) VALUES (?, ?, ?, ?, ?)",
                     ("2026-11-01 10:00:00", "2026-11-01 11:00:00", "completed",
                      json.dumps({"directories": [PREFIX + "a", PREFIX + "b/"]}), JOB))
        conn.execute("INSERT INTO scan_runs (started_at, finished_at, status, args_json, viewer_job_id) VALUES (?, NULL, ?, ?, ?)",
                     ("2026-11-01 12:00:00", "running", json.dumps({"directories": [PREFIX + "c"]}), OTHER_JOB))
        run_id = conn.execute("SELECT id FROM scan_runs WHERE viewer_job_id = ?", (JOB,)).fetchone()[0]
    return run_id


def _names(client, query):
    resp = client.get("/api/photos?" + query)
    assert resp.status_code == 200, resp.text
    return sorted(p["filename"] for p in resp.json()["photos"]), resp.json()


class TestScanRunFilter:
    def test_window_and_directories(self, edition_client, library, installed):
        expected = ["a0.jpg", "a1.jpg", "a2.jpg", "a3.jpg", "a4.jpg", "bx.jpg"]
        assert _names(edition_client, f"scan_run={JOB}&per_page=100")[0] == expected
        assert _names(edition_client, f"scan_run={library}&per_page=100")[0] == expected
        # still running: the window is open to now
        assert _names(edition_client, f"scan_run={OTHER_JOB}&per_page=100")[0] == ["cy.jpg"]

    def test_combines_with_category_hide_toggles_and_paging(self, edition_client, library, installed):
        names, _ = _names(edition_client, f"scan_run={JOB}&category=astro&hide_bursts=0&hide_duplicates=0&per_page=100")
        assert names == ["a1.jpg", "a3.jpg", "bx.jpg"]
        page1, body = _names(edition_client, f"scan_run={JOB}&per_page=4&page=1&sort=aggregate&sort_direction=DESC")
        assert len(page1) == 4 and body["has_more"] is True and body["total"] == 6
        page2, body = _names(edition_client, f"scan_run={JOB}&per_page=4&page=2&sort=aggregate&sort_direction=DESC")
        assert len(page2) == 2 and body["has_more"] is False

    @pytest.mark.parametrize("value", ["nope", "123abc", "A" * 32, "1; DROP TABLE photos", "99999999"])
    def test_unknown_or_malformed_run_matches_nothing(self, edition_client, library, installed, value):
        assert _names(edition_client, f"scan_run={value}&per_page=100")[0] == []

    def test_malformed_args_json_matches_nothing(self, edition_client, library, installed):
        with _db() as conn:
            conn.execute("UPDATE scan_runs SET args_json = 'not json' WHERE viewer_job_id = ?", (JOB,))
        assert _names(edition_client, f"scan_run={JOB}&per_page=100")[0] == []


def _scan_app(monkeypatch, spawned):
    from api.routers import scan as scan_router
    app = create_app()
    app.dependency_overrides[require_scan_access] = lambda: CurrentUser(user_id="root", role="superadmin",
                                                                        edition_authenticated=True)
    monkeypatch.setitem(scan_router.VIEWER_CONFIG, "features", {"show_scan_button": True})
    monkeypatch.setattr(scan_router, "get_all_scan_directories", lambda: ["/photos"])
    monkeypatch.setattr(scan_router, "_library_job_conflict_detail", lambda: None)

    def fake_spawn(cmd, directories, **kwargs):
        spawned.append(cmd)
        return {"success": True, "message": "ok", "directories": directories, "pid": 1, "job_id": JOB}
    monkeypatch.setattr(scan_router, "_spawn_scan", fake_spawn)
    return TestClient(app)


class TestAfterAddon:
    def test_records_the_intent_without_telling_the_scanner(self, monkeypatch, installed):
        spawned = []
        client = _scan_app(monkeypatch, spawned)
        resp = client.post("/api/scan/start", json={"directories": ["/photos"], "after_addon": "astro"})
        assert resp.status_code == 200, resp.text
        assert "astro" not in " ".join(spawned[0])
        with _db() as conn:
            row = dict(conn.execute("SELECT * FROM addon_runs WHERE viewer_job_id = ?", (JOB,)).fetchone())
        assert row["addon_id"] == "astro" and row["opened_at"] is None and row["requested_at"]

    @pytest.mark.parametrize("value", ["plain", "nope", "../x"])
    def test_refuses_an_addon_without_import_hook(self, monkeypatch, installed, value):
        spawned = []
        client = _scan_app(monkeypatch, spawned)
        resp = client.post("/api/scan/start", json={"directories": ["/photos"], "after_addon": value})
        assert resp.status_code == 400 and spawned == []

    def test_refused_when_addons_are_off(self, monkeypatch, installed):
        monkeypatch.setitem(api_config._FULL_CONFIG, "addons", {"enabled": False})
        client = _scan_app(monkeypatch, [])
        assert client.post("/api/scan/start", json={"directories": ["/photos"], "after_addon": "astro"}).status_code == 400

    def test_without_after_addon_nothing_is_recorded(self, monkeypatch, installed):
        client = _scan_app(monkeypatch, [])
        assert client.post("/api/scan/start", json={"directories": ["/photos"]}).status_code == 200
        with _db() as conn:
            assert conn.execute("SELECT COUNT(*) FROM addon_runs").fetchone()[0] == 0


class TestRunsRoute:
    @pytest.fixture()
    def env(self, agent_app, installed, library):
        runs.record_request(JOB, "astro", "_legacy")
        runs.record_request(OTHER_JOB, "plain", "_legacy")
        e = agent_app("legacy")
        e.headers = e.login(edition=True)
        return e

    def _token(self, env, addon_id):
        resp = env.client.post(f"/api/addons/{addon_id}/token", headers=env.headers)
        assert resp.status_code == 200, resp.text
        return {"Authorization": "Bearer " + resp.json()["token"]}

    def test_addon_sees_only_its_own_run(self, env, library):
        astro = self._token(env, "astro")
        body = env.client.get(f"/api/addons/runs/{JOB}", headers=astro).json()
        assert body["addon_id"] == "astro" and body["run_id"] == library and body["photo_count"] == 6
        assert body["status"] == "completed"
        assert env.client.get(f"/api/addons/runs/{OTHER_JOB}", headers=astro).status_code == 404
        # and pulls its scope through the photos route
        names = sorted(p["filename"] for p in env.client.get(
            f"/api/photos?scan_run={JOB}&per_page=100", headers=astro).json()["photos"])
        assert len(names) == 6

    def test_person_needs_the_scan_gate(self, env):
        assert env.client.get(f"/api/addons/runs/{JOB}", headers=env.headers).status_code == 200
        viewer = env.login(edition=False)
        assert env.client.get(f"/api/addons/runs/{JOB}", headers=viewer).status_code == 403
        assert env.client.get("/api/addons/runs/" + "c" * 32, headers=env.headers).status_code == 404

    def test_pending_until_opened_with_an_import_scope(self, env):
        listed = env.client.get("/api/addons", headers=env.headers).json()["pending_runs"]
        assert {r["job_id"] for r in listed} == {JOB, OTHER_JOB}
        # the run of another add-on is not this add-on's import scope
        refused = env.client.post("/api/addons/astro/open", json={"scope": {"kind": "import", "run_id": OTHER_JOB}},
                                  headers=env.headers)
        assert refused.status_code == 422
        opened = env.client.post("/api/addons/astro/open", json={"scope": {"kind": "import", "run_id": JOB}},
                                 headers=env.headers)
        assert opened.status_code == 200 and opened.json()["scope"] == {"kind": "import", "run_id": JOB}
        listed = env.client.get("/api/addons", headers=env.headers).json()["pending_runs"]
        assert {r["job_id"] for r in listed} == {OTHER_JOB}


def test_viewer_export_drops_addon_runs():
    from db.maintenance import VIEWER_EXPORT_EXCLUDED_TABLES
    assert "addon_runs" in VIEWER_EXPORT_EXCLUDED_TABLES


def test_scan_run_clause_shapes():
    assert runs.scan_run_clause("x") == ("0=1", [])
    sql, params = runs.scan_run_clause("12")
    assert params == [12, 12] and "json_valid" in sql
    sql, params = runs.scan_run_clause(JOB)
    assert params == [JOB, JOB]
