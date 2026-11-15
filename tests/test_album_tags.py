"""Album tags: manual tags marked as organisation, kept off the photo page's content tags."""

import sqlite3

import pytest

from api.db_helpers import (
    ALBUM_TAGS_SELECT, MANUAL_TAGS_CONTENT_SELECT, MANUAL_TAGS_SELECT,
    build_photo_select_columns, split_photo_tags,
)
from db import DEFAULT_DB_PATH
from db.manual_tags import load_album_tag_set, split_album_tags

PREFIX = "/at-"
EVENT = PREFIX + "peter/communion/"
CHURCH_1 = EVENT + "church/one.jpg"
CHURCH_2 = EVENT + "church/two.jpg"
LUNCH_1 = EVENT + "lunch/one.jpg"
OTHER = PREFIX + "elsewhere/one.jpg"
SEED_PATHS = [CHURCH_1, CHURCH_2, LUNCH_1, OTHER]
CAMERA = "Album Tag Cam"

MARK = "/api/album_tags"
FACETS = "/api/album_tags/facets"

TAGS = {
    CHURCH_1: ["peter/communion", "peter/communion/church", "photographer[ray]", "cake"],
    CHURCH_2: ["peter/communion", "peter/communion/church", "photographer[robin]"],
    LUNCH_1: ["peter/communion", "peter/communion/lunch", "photographer[robin]"],
    OTHER: ["cake"],
}
ALBUM = ["peter/communion", "peter/communion/church", "peter/communion/lunch",
         "photographer[ray]", "photographer[robin]"]


@pytest.fixture()
def seeded(seed_photos_prefix):
    seed_photos_prefix(PREFIX, [
        {"path": p, "filename": p.rsplit("/", 1)[-1], "camera_model": CAMERA, "tags": "fashion, landscape"}
        for p in SEED_PATHS
    ])
    with sqlite3.connect(DEFAULT_DB_PATH) as conn:
        for path, tags in TAGS.items():
            conn.executemany(
                "INSERT INTO photo_manual_tags (photo_path, tag, source) VALUES (?, ?, 'user')",
                [(path, t) for t in tags],
            )
    yield
    with sqlite3.connect(DEFAULT_DB_PATH) as conn:
        conn.execute("DELETE FROM photo_manual_tags WHERE photo_path LIKE ?", (PREFIX + "%",))
        conn.executemany("DELETE FROM album_tags WHERE tag = ?", [(t,) for t in ALBUM + ["cake"]])
        conn.execute("DELETE FROM stats_cache WHERE key = 'tags'")


@pytest.fixture()
def marked(seeded, edition_client):
    for tag in ALBUM:
        assert edition_client.put(MARK, json={"tag": tag}).status_code == 200


def _album_rows():
    with sqlite3.connect(DEFAULT_DB_PATH) as conn:
        return {r[0] for r in conn.execute("SELECT tag FROM album_tags")}


class TestHelpers:
    def test_split_album_tags(self):
        content, album = split_album_tags(["cake", "peter/x", "photographer[ray]"],
                                          frozenset({"peter/x", "photographer[ray]"}))
        assert content == ["cake"]
        assert album == ["peter/x", "photographer[ray]"]

    def test_split_photo_tags_fills_album_tags_and_drops_raw_alias(self):
        row = {"tags": "a", "manual_tags_raw": "cake", "album_tags_raw": "peter/x\x1fpeter"}
        photo = split_photo_tags([row, {"tags": None}], 3)
        assert photo[0]["manual_tags"] == ["cake"]
        assert photo[0]["album_tags"] == ["peter", "peter/x"]
        assert "album_tags_raw" not in photo[0]
        assert photo[1]["album_tags"] == []
        hidden = split_photo_tags([dict(row)], 3, include_manual_tags=False)[0]
        assert hidden["album_tags"] == [] and "album_tags_raw" not in hidden

    def test_select_uses_split_columns_when_registry_exists(self):
        with sqlite3.connect(DEFAULT_DB_PATH) as conn:
            cols = build_photo_select_columns(conn)
        assert MANUAL_TAGS_CONTENT_SELECT in cols and ALBUM_TAGS_SELECT in cols
        assert MANUAL_TAGS_SELECT not in cols

    def test_load_album_tag_set_without_table(self):
        conn = sqlite3.connect(":memory:")
        assert load_album_tag_set(conn) == frozenset()


class TestMarking:
    def test_mark_is_normalized_and_idempotent(self, seeded, edition_client):
        first = edition_client.put(MARK, json={"tag": "  Peter/Communion "}).json()
        assert first == {"success": True, "tag": "peter/communion", "changed": True}
        again = edition_client.put(MARK, json={"tag": "peter/communion"}).json()
        assert again["changed"] is False
        assert "peter/communion" in _album_rows()

    def test_unmark_keeps_photo_rows(self, marked, edition_client):
        resp = edition_client.request("DELETE", MARK, json={"tag": "photographer[ray]"})
        assert resp.json()["changed"] is True
        assert "photographer[ray]" not in _album_rows()
        with sqlite3.connect(DEFAULT_DB_PATH) as conn:
            assert conn.execute(
                "SELECT 1 FROM photo_manual_tags WHERE photo_path = ? AND tag = 'photographer[ray]'",
                (CHURCH_1,),
            ).fetchone()

    def test_invalid_tag_is_422(self, seeded, edition_client):
        assert edition_client.put(MARK, json={"tag": "a,b"}).status_code == 422

    def test_writes_need_edition(self, seeded, regular_client):
        assert regular_client.put(MARK, json={"tag": "x"}).status_code in (401, 403)
        assert regular_client.request("DELETE", MARK, json={"tag": "x"}).status_code in (401, 403)


class TestReading:
    def test_photo_splits_content_and_album_tags(self, marked, edition_client):
        photo = edition_client.get("/api/photo", params={"path": CHURCH_1}).json()
        assert photo["manual_tags"] == ["cake"]
        assert photo["album_tags"] == ["peter/communion", "peter/communion/church", "photographer[ray]"]

    def test_unmarked_tags_stay_content(self, seeded, edition_client):
        photo = edition_client.get("/api/photo", params={"path": CHURCH_1}).json()
        assert "peter/communion" in photo["manual_tags"]
        assert photo["album_tags"] == []

    def test_list_counts(self, marked, edition_client):
        tags = {t["tag"]: t["count"] for t in edition_client.get(MARK).json()["tags"]}
        assert tags["peter/communion"] == 3
        assert tags["peter/communion/church"] == 2
        assert tags["photographer[robin]"] == 2
        assert "cake" not in tags

    def test_facets_follow_the_view_and_ignore_album_tags(self, marked, edition_client):
        params = {"camera": CAMERA, "album_tags": "peter/communion/church"}
        tags = {t["tag"]: t["count"] for t in edition_client.get(FACETS, params=params).json()["tags"]}
        assert tags == {
            "peter/communion": 3, "peter/communion/church": 2, "peter/communion/lunch": 1,
            "photographer[ray]": 1, "photographer[robin]": 2,
        }

    def test_facets_scope_to_a_folder(self, marked, edition_client):
        params = {"camera": CAMERA, "path_prefix": EVENT + "lunch/"}
        tags = {t["tag"]: t["count"] for t in edition_client.get(FACETS, params=params).json()["tags"]}
        assert tags == {"peter/communion": 1, "peter/communion/lunch": 1, "photographer[robin]": 1}

    def test_tag_dropdown_leaves_album_tags_out(self, marked, edition_client):
        values = [t[0] for t in edition_client.get("/api/filter_options/tags").json()["tags"]]
        assert "cake" in values
        assert not set(ALBUM) & set(values)

    def test_facets_follow_a_content_tag(self, marked, edition_client):
        params = {"camera": CAMERA, "tag": "cake"}
        tags = {t["tag"]: t["count"] for t in edition_client.get(FACETS, params=params).json()["tags"]}
        assert tags == {"peter/communion": 1, "peter/communion/church": 1, "photographer[ray]": 1}

    @pytest.mark.parametrize("album_tags, expected", [
        ("peter/communion/church", [CHURCH_1, CHURCH_2]),
        ("photographer[robin]", [CHURCH_2, LUNCH_1]),
        ("peter/communion/church,photographer[robin]", [CHURCH_2]),
        ("peter/communion/lunch,photographer[ray]", []),
        (" peter/communion/church , ", [CHURCH_1, CHURCH_2]),
    ])
    def test_album_tags_must_all_match(self, marked, edition_client, album_tags, expected):
        resp = edition_client.get("/api/photos", params={"camera": CAMERA, "album_tags": album_tags})
        assert resp.status_code == 200
        assert sorted(p["path"] for p in resp.json()["photos"]) == sorted(expected)

    def test_album_tags_match_nothing_without_manual_tags(self, marked):
        from api.routers.gallery import _add_album_tags_filter
        where, params = [], []
        _add_album_tags_filter(where, params, "peter/communion/church", conn=None, include_manual=False)
        assert where == ["0"] and params == []

    def test_gallery_filter_still_matches_album_tag(self, marked, edition_client):
        resp = edition_client.get("/api/photos", params={"camera": CAMERA, "tag": "peter/communion/church"})
        assert sorted(p["path"] for p in resp.json()["photos"]) == [CHURCH_1, CHURCH_2]
