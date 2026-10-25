"""Naming a scene: POST /api/scenes/manual_tags and the ``names`` on GET /api/scenes.

A scene is named by tagging every photo captured in its window, burst repeats
included; the scenes feed reads the name back from tags on most of a scene's
photos. Real session database, rows seeded under a private prefix and a capture
date no other test uses.
"""

import sqlite3

import pytest

from tests.conftest import _TEST_DB_FILE

PFX = "/scene-names/"
DAY = "2001:02:03"


def at(hms):
    return f"{DAY} {hms}"


@pytest.fixture()
def party(seed_photos_prefix):
    """Two scenes 30 minutes apart; the first has a hidden burst repeat."""
    rows = [
        {"path": PFX + "pool1.jpg", "filename": "pool1.jpg", "aggregate": 6.0, "date_taken": at("14:00:00")},
        {"path": PFX + "pool2.jpg", "filename": "pool2.jpg", "aggregate": 7.0, "date_taken": at("14:02:00"),
         "burst_group_id": 990001, "is_burst_lead": 1},
        {"path": PFX + "pool2b.jpg", "filename": "pool2b.jpg", "aggregate": 5.0, "date_taken": at("14:02:01"),
         "burst_group_id": 990001, "is_burst_lead": 0},
        {"path": PFX + "pool3.jpg", "filename": "pool3.jpg", "aggregate": 6.5, "date_taken": at("14:05:00")},
        {"path": PFX + "cake1.jpg", "filename": "cake1.jpg", "aggregate": 6.0, "date_taken": at("14:40:00")},
        {"path": PFX + "cake2.jpg", "filename": "cake2.jpg", "aggregate": 6.0, "date_taken": at("14:41:00")},
    ]
    seed_photos_prefix(PFX, rows)
    yield
    with sqlite3.connect(_TEST_DB_FILE.name) as conn:
        conn.execute("DELETE FROM photo_manual_tags WHERE photo_path LIKE ?", (PFX + "%",))


def tags_of(path):
    with sqlite3.connect(_TEST_DB_FILE.name) as conn:
        return sorted(r[0] for r in conn.execute(
            "SELECT tag FROM photo_manual_tags WHERE photo_path = ?", (path,)))


def scenes(client):
    body = client.get("/api/scenes", params={"date_from": at("00:00:00"), "date_to": at("23:59:59")}).json()
    return body["scenes"]


def test_naming_tags_every_photo_in_the_window_including_burst_repeats(edition_client, party):
    resp = edition_client.post("/api/scenes/manual_tags", json={
        "start": at("14:00:00"), "end": at("14:05:00"), "tag": "Pool"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["count"] == 4
    for name in ("pool1", "pool2", "pool2b", "pool3"):
        assert tags_of(PFX + name + ".jpg") == ["pool"], name
    assert tags_of(PFX + "cake1.jpg") == []


def test_the_scenes_feed_reads_the_name_back(edition_client, party):
    edition_client.post("/api/scenes/manual_tags", json={
        "start": at("14:00:00"), "end": at("14:05:00"), "tag": "Pool"})
    found = scenes(edition_client)
    assert [s["names"] for s in found] == [["pool"], []]


def test_a_tag_on_a_few_photos_does_not_name_the_scene(edition_client, party):
    edition_client.post("/api/scenes/manual_tags", json={
        "start": at("14:00:00"), "end": at("14:00:00"), "tag": "Splash"})
    assert scenes(edition_client)[0]["names"] == []


def test_removing_the_name(edition_client, party):
    edition_client.post("/api/scenes/manual_tags", json={
        "start": at("14:40:00"), "end": at("14:41:00"), "tag": "Cake"})
    resp = edition_client.post("/api/scenes/manual_tags", json={
        "start": at("14:40:00"), "end": at("14:41:00"), "tag": "Cake", "action": "delete"})
    assert resp.json()["count"] == 2
    assert scenes(edition_client)[1]["names"] == []


def test_naming_needs_edition(regular_client, party):
    resp = regular_client.post("/api/scenes/manual_tags", json={
        "start": at("14:00:00"), "end": at("14:05:00"), "tag": "Pool"})
    assert resp.status_code in (401, 403)
    assert tags_of(PFX + "pool1.jpg") == []
