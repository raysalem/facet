"""Plugin-written photo annotations: the side table, the helper, the endpoint, the export merge."""

import json
import sqlite3
from io import BytesIO
from unittest import mock

import pytest
from PIL import Image

from db.annotations import (MAX_PAYLOAD_BYTES, AnnotationError, delete_annotation,
                            list_annotations, upsert_annotation, validate_payload)
from db.maintenance import delete_photo_rows, export_viewer_db
from db.schema import init_database
from tests.conftest import _TEST_DB_FILE

PREFIX = "/photo-annotations-test/"


def _payload(**over):
    payload = {
        "version": 1, "source": "astro-id", "title": "Sky annotations",
        "image": {"width": 6000, "height": 4000},
        "legend": "test legend",
        "groups": [{"id": "planet", "label": "Planets", "default": True},
                   {"id": "star", "label": "Stars", "default": False}],
        "metrics": [{"key": "mag", "label": "Max magnitude", "min": -5, "max": 8,
                     "step": 0.5, "default": 6, "direction": "max"}],
        "score": {"label": "Confidence", "min": 0, "max": 100, "default": 65},
        "items": [
            {"id": "uranus", "label": "Uranus", "group": "planet", "score": 100,
             "shape": "point", "x": 10.5, "y": 20, "r": 18, "values": {"mag": 5.6}},
            {"id": "m45", "label": "M45", "group": "planet", "score": 99,
             "shape": "circle", "x": 400, "y": 180, "r": 220},
            {"id": "orion", "label": "Orion", "group": "planet", "score": 100,
             "shape": "lines", "segments": [[[1, 2], [3, 4]]], "label_at": [2, 3]},
        ],
    }
    payload.update(over)
    return payload


# --- helper -------------------------------------------------------------------

class TestValidate:
    def test_accepts_the_spec_example_and_returns_compact_json(self):
        text = validate_payload(_payload())
        assert json.loads(text)["items"][0]["label"] == "Uranus"
        assert ", " not in text

    def test_accepts_json_text(self):
        assert json.loads(validate_payload(json.dumps(_payload())))["version"] == 1

    def test_keeps_unknown_fields(self):
        assert json.loads(validate_payload(_payload(extra={"a": 1})))["extra"] == {"a": 1}

    @pytest.mark.parametrize("over", [
        {"version": 2}, {"version": "1"}, {"image": {"width": 0, "height": 10}},
        {"image": None}, {"items": {}}, {"groups": "x"}, {"metrics": [{"key": "m"}]},
        {"score": {"min": "a", "max": 1}},
        {"items": [{"id": "a", "label": "A", "group": "g", "shape": "blob", "x": 1, "y": 1}]},
        {"items": [{"id": "a", "label": "A", "group": "g", "shape": "point", "x": 1}]},
        {"items": [{"id": "a", "label": "A", "group": "g", "shape": "circle", "x": 1, "y": 1, "r": 0}]},
        {"items": [{"id": "a", "label": "A", "group": "g", "shape": "lines", "segments": [[[1, 2]]]}]},
        {"items": [{"id": "a", "label": "", "group": "g", "shape": "point", "x": 1, "y": 1}]},
        {"items": [{"id": "a", "label": "A", "group": "g", "shape": "point", "x": 1, "y": 1,
                    "values": {"mag": "bright"}}]},
        {"items": [{"id": "a", "label": "A", "group": "g", "shape": "point", "x": float("nan"), "y": 1}]},
    ])
    def test_rejects_a_bad_payload(self, over):
        with pytest.raises(AnnotationError):
            validate_payload(_payload(**over))

    def test_rejects_invalid_json_text(self):
        with pytest.raises(AnnotationError):
            validate_payload("{not json")

    def test_rejects_a_payload_over_the_size_cap(self):
        with pytest.raises(AnnotationError, match="exceeds"):
            validate_payload(_payload(legend="x" * (MAX_PAYLOAD_BYTES + 1)))


@pytest.fixture()
def db(tmp_path):
    path = str(tmp_path / "lib.db")
    init_database(path)
    conn = sqlite3.connect(path)
    conn.executemany("INSERT INTO photos (path, filename) VALUES (?, ?)",
                     [("/p/a.jpg", "a.jpg"), ("/p/b.jpg", "b.jpg")])
    conn.commit()
    yield conn
    conn.close()


class TestHelper:
    def test_upsert_replaces_the_same_source_and_keeps_others(self, db):
        upsert_annotation(db, "/p/a.jpg", "astro-id", _payload(title="first"))
        upsert_annotation(db, "/p/a.jpg", "other", _payload())
        upsert_annotation(db, "/p/a.jpg", "astro-id", _payload(title="second"))
        rows = list_annotations(db, "/p/a.jpg")
        assert [r[0] for r in rows] == ["astro-id", "other"]
        assert json.loads(rows[0][1])["title"] == "second"

    def test_unknown_photo_is_refused(self, db):
        with pytest.raises(LookupError):
            upsert_annotation(db, "/p/missing.jpg", "astro-id", _payload())

    @pytest.mark.parametrize("source", ["", "Astro", "a b", "x" * 65, None, "../x"])
    def test_bad_source_is_refused(self, db, source):
        with pytest.raises(AnnotationError):
            upsert_annotation(db, "/p/a.jpg", source, _payload())

    def test_delete(self, db):
        upsert_annotation(db, "/p/a.jpg", "astro-id", _payload())
        assert delete_annotation(db, "/p/a.jpg", "astro-id") is True
        assert delete_annotation(db, "/p/a.jpg", "astro-id") is False
        assert list_annotations(db, "/p/a.jpg") == []


# --- photo delete / path move -------------------------------------------------

class TestFollowsThePhoto:
    @pytest.mark.parametrize("fk", ["ON", "OFF"])
    def test_photo_delete_removes_the_rows(self, db, fk):
        upsert_annotation(db, "/p/a.jpg", "astro-id", _payload())
        db.commit()
        db.execute(f"PRAGMA foreign_keys = {fk}")
        db.execute("DELETE FROM photos WHERE path = ?", ("/p/a.jpg",))
        assert db.execute("SELECT COUNT(*) FROM photo_annotations").fetchone()[0] == 0

    def test_delete_photo_rows_cascades(self, db):
        upsert_annotation(db, "/p/a.jpg", "astro-id", _payload())
        upsert_annotation(db, "/p/b.jpg", "astro-id", _payload())
        db.execute("PRAGMA foreign_keys = ON")
        delete_photo_rows(db, ["/p/a.jpg"])
        assert [r[0] for r in db.execute("SELECT photo_path FROM photo_annotations")] == ["/p/b.jpg"]

    @pytest.mark.parametrize("fk", ["ON", "OFF"])
    def test_path_move_carries_the_rows(self, db, fk):
        upsert_annotation(db, "/p/a.jpg", "astro-id", _payload())
        db.commit()
        db.execute(f"PRAGMA foreign_keys = {fk}")
        db.execute("UPDATE photos SET path = ? WHERE path = ?", ("/q/a.jpg", "/p/a.jpg"))
        assert [r[0] for r in db.execute("SELECT photo_path FROM photo_annotations")] == ["/q/a.jpg"]

    def test_relink_rewrites_the_table(self, db):
        from db.relink import _references
        assert ("photo_annotations", "photo_path") in _references(db)

    def test_schema_is_idempotent_and_reported(self, tmp_path):
        path = str(tmp_path / "again.db")
        init_database(path)
        init_database(path)
        from db.info import get_schema_info
        assert get_schema_info()["photo_annotations_columns"] == 4


# --- endpoint -----------------------------------------------------------------

@pytest.fixture()
def photo(seed_photos_prefix):
    seed_photos_prefix(PREFIX, [
        {"path": PREFIX + "sky.jpg", "filename": "sky.jpg", "aggregate": 7.0,
         "category": "default", "date_taken": "2026:11:07 21:57:00"},
    ])
    yield PREFIX + "sky.jpg"
    # The seeder's teardown connection does not enforce foreign keys; the trigger covers it,
    # but clean up explicitly so a failure here never leaks into the shared DB.
    with sqlite3.connect(_TEST_DB_FILE.name) as conn:
        conn.execute("DELETE FROM photo_annotations WHERE photo_path LIKE ?", (PREFIX + "%",))


def _write(path, source="astro-id", payload=None, raw=None):
    with sqlite3.connect(_TEST_DB_FILE.name) as conn:
        if raw is not None:
            conn.execute("INSERT OR REPLACE INTO photo_annotations (photo_path, source, payload) "
                         "VALUES (?, ?, ?)", (path, source, raw))
        else:
            upsert_annotation(conn, path, source, payload or _payload())


def test_get_returns_each_source_payload(regular_client, photo):
    _write(photo)
    body = regular_client.get("/api/photo/annotations", params={"path": photo}).json()
    assert [a["source"] for a in body["annotations"]] == ["astro-id"]
    assert body["annotations"][0]["payload"]["items"][0]["label"] == "Uranus"


def test_get_is_empty_without_annotations(regular_client, photo):
    assert regular_client.get("/api/photo/annotations", params={"path": photo}).json() == {"annotations": []}


def test_get_is_empty_for_an_invisible_photo(regular_client, photo):
    _write(photo)
    with mock.patch("api.routers.annotations.get_visibility_clause", return_value=("1=0", [])):
        r = regular_client.get("/api/photo/annotations", params={"path": photo})
    assert r.status_code == 200
    assert r.json() == {"annotations": []}


def test_get_is_empty_for_an_unknown_photo(regular_client):
    r = regular_client.get("/api/photo/annotations", params={"path": PREFIX + "missing.jpg"})
    assert r.json() == {"annotations": []}


def test_get_skips_rows_it_cannot_draw(regular_client, photo):
    _write(photo, "broken", raw="{not json")
    _write(photo, "future", raw=json.dumps({"version": 2, "items": []}))
    _write(photo, "astro-id")
    body = regular_client.get("/api/photo/annotations", params={"path": photo}).json()
    assert [a["source"] for a in body["annotations"]] == ["astro-id"]


def test_delete_needs_edition(regular_client, edition_client, photo):
    _write(photo)
    params = {"path": photo, "source": "astro-id"}
    assert regular_client.delete("/api/photo/annotations", params=params).status_code == 403
    assert edition_client.delete("/api/photo/annotations", params=params).json() == {
        "success": True, "removed": True}
    assert edition_client.delete("/api/photo/annotations", params=params).json()["removed"] is False
    assert edition_client.get("/api/photo/annotations", params={"path": photo}).json() == {"annotations": []}


def test_delete_unknown_photo_is_404(edition_client):
    r = edition_client.delete("/api/photo/annotations",
                              params={"path": PREFIX + "missing.jpg", "source": "astro-id"})
    assert r.status_code == 404


# --- viewer-DB export ---------------------------------------------------------

def _thumb():
    buf = BytesIO()
    Image.new('RGB', (64, 64), (1, 2, 3)).save(buf, format='JPEG')
    return buf.getvalue()


class TestViewerDbMerge:
    """Scan-side plugin rows reach the viewer DB; a re-run replaces, viewer-only rows stay."""

    def _pair(self, tmp_path):
        src = str(tmp_path / "scan.db")
        init_database(src)
        s = sqlite3.connect(src)
        for name in ("a.jpg", "b.jpg"):
            path = str(tmp_path / name)
            open(path, "wb").write(b"JPEGDATA")
            s.execute("INSERT INTO photos (path, filename, thumbnail, star_rating, is_favorite, is_rejected) "
                      "VALUES (?, ?, ?, 0, 0, 0)", (path, name, _thumb()))
        upsert_annotation(s, str(tmp_path / "a.jpg"), "astro-id", _payload(title="v1"))
        s.commit()
        s.close()
        out = str(tmp_path / "viewer.db")
        export_viewer_db(src, out, thumbnail_size=64, verbose=False)
        return src, out

    @staticmethod
    def _rows(out):
        v = sqlite3.connect(out)
        rows = [(p, s, json.loads(t)["title"]) for p, s, t in
                v.execute("SELECT photo_path, source, payload FROM photo_annotations ORDER BY 1, 2")]
        v.close()
        return rows

    def test_full_export_carries_the_rows(self, tmp_path):
        _, out = self._pair(tmp_path)
        assert self._rows(out) == [(str(tmp_path / "a.jpg"), "astro-id", "v1")]

    def test_rerun_replaces_and_viewer_only_rows_survive(self, tmp_path):
        src, out = self._pair(tmp_path)
        a, b = str(tmp_path / "a.jpg"), str(tmp_path / "b.jpg")
        v = sqlite3.connect(out)
        upsert_annotation(v, b, "viewer-side", _payload(title="kept"))
        v.commit()
        v.close()
        s = sqlite3.connect(src)
        s.execute("UPDATE photo_annotations SET created_at = '2999-01-01 00:00:00', payload = ? "
                  "WHERE photo_path = ?", (validate_payload(_payload(title="v2")), a))
        s.commit()
        s.close()
        export_viewer_db(src, out, thumbnail_size=64, verbose=False)
        export_viewer_db(src, out, thumbnail_size=64, verbose=False)
        assert self._rows(out) == [(a, "astro-id", "v2"), (b, "viewer-side", "kept")]

    def test_orphan_source_row_is_skipped(self, tmp_path):
        src, out = self._pair(tmp_path)
        s = sqlite3.connect(src)
        s.execute("PRAGMA foreign_keys = OFF")
        s.execute("INSERT INTO photo_annotations (photo_path, source, payload) VALUES ('/gone.jpg', 'x', '{}')")
        s.commit()
        s.close()
        export_viewer_db(src, out, thumbnail_size=64, verbose=False)
        assert all(r[0] != "/gone.jpg" for r in self._rows(out))

    @pytest.mark.parametrize("drop", ["src", "dest"])
    def test_missing_table_on_either_side_does_not_abort(self, tmp_path, drop):
        import os
        src, out = self._pair(tmp_path)
        c = sqlite3.connect(src if drop == "src" else out)
        c.execute("DROP TABLE photo_annotations")
        c.commit()
        c.close()
        export_viewer_db(src, out, thumbnail_size=64, verbose=False)
        assert os.path.exists(out)
