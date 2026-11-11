"""Add-on manifests: discovery under ``<facet data>/addons`` and fail-closed validation."""

import json
import os
import sys

import pytest

from api.addons import manifest
from api.addons.manifest import ManifestError, load_registry, parse_manifest


def _supervised(**over):
    data = {
        "id": "astro-id", "name": "Astro", "version": "0.3.0", "icon": "star", "facet_api": 1,
        "start": {"argv": [sys.executable, "-m", "astro"], "port": "auto", "health": "/health"},
        "ui": {"path": "/ui/"},
        "slots": ["sidebar", "import_hook"],
        "permissions": ["photos.read", "tags.write", "annotations.write", "gps.write"],
    }
    data.update(over)
    return data


def _external(**over):
    data = {"id": "astro-id", "name": "Astro", "version": "1", "facet_api": 1,
            "ui": {"url": "http://astro:5100/"}, "slots": ["sidebar"], "permissions": ["photos.read"]}
    data.update(over)
    return data


def _dir(tmp_path, name="astro-id"):
    path = tmp_path / name
    path.mkdir(exist_ok=True)
    return str(path)


class TestParse:
    def test_supervised_manifest_parses(self, tmp_path):
        addon = parse_manifest(_supervised(), _dir(tmp_path))
        assert addon.supervised and addon.port == "auto" and addon.ui_path == "/ui/"
        assert addon.permissions == ("annotations.write", "gps.write", "photos.read", "tags.write")

    def test_public_view_never_carries_argv(self, tmp_path):
        public = parse_manifest(_supervised(), _dir(tmp_path)).public()
        assert "argv" not in public and sys.executable not in json.dumps(public)
        assert public["mode"] == "supervised"

    def test_external_manifest_parses(self, tmp_path):
        addon = parse_manifest(_external(), _dir(tmp_path))
        assert not addon.supervised and addon.ui_url == "http://astro:5100/" and addon.ui_path == "/"

    @pytest.mark.parametrize("change, reason", [
        ({"permissions": ["photos.read", "db.write"]}, "unknown permissions"),
        ({"slots": ["photo_layer"]}, "unknown slots"),
        ({"env": ["DB_PATH"]}, "unknown keys"),
        ({"id": "Astro"}, "id must match"),
        ({"id": "other"}, "directory name"),
        ({"facet_api": 2}, "facet_api"),
        ({"facet_api": True}, "facet_api"),
        ({"ui": {"path": "/ui/", "url": "http://x/"}}, "ui must be exactly one"),
        ({"ui": {"url": "http://x/"}}, "mutually exclusive"),
        ({"ui": {"path": "ui/"}}, "ui.path"),
        ({"start": {"argv": ["relative.exe"]}}, "absolute path"),
        ({"start": {"argv": []}}, "non-empty list"),
        ({"start": {"argv": [sys.executable], "cwd": "/"}}, "only hold"),
        ({"start": {"argv": [sys.executable], "port": 80}}, "start.port"),
        ({"start": {"argv": [sys.executable], "health": "http://evil/health"}}, "start.health"),
        ({"start": {"argv": [sys.executable], "health": "/../x"}}, "start.health"),
    ])
    def test_refusals(self, tmp_path, change, reason):
        directory = _dir(tmp_path)
        with pytest.raises(ManifestError, match=reason):
            parse_manifest(_supervised(**change), directory)

    def test_argv0_must_exist(self, tmp_path):
        missing = os.path.join(str(tmp_path), "nope.exe")
        with pytest.raises(ManifestError, match="existing file"):
            parse_manifest(_supervised(start={"argv": [missing]}), _dir(tmp_path))

    @pytest.mark.parametrize("url", ["ftp://x/", "http://u:p@x/", "http://x/?a=1", "/relative", "http:///nohost"])
    def test_external_url_refusals(self, tmp_path, url):
        with pytest.raises(ManifestError, match="ui.url"):
            parse_manifest(_external(ui={"url": url}), _dir(tmp_path))

    def test_external_needs_url(self, tmp_path):
        with pytest.raises(ManifestError, match="external mode"):
            parse_manifest(_external(ui={"path": "/ui/"}), _dir(tmp_path))


class TestRegistry:
    def test_missing_folder_is_empty(self, tmp_path):
        registry = load_registry(str(tmp_path / "absent"))
        assert registry.addons == {} and registry.refused == []

    def test_valid_and_refused_are_listed_with_reasons(self, tmp_path):
        (tmp_path / "astro-id").mkdir()
        (tmp_path / "astro-id" / "addon.json").write_text(json.dumps(_supervised()), encoding="utf-8")
        (tmp_path / "broken").mkdir()
        (tmp_path / "broken" / "addon.json").write_text("{not json", encoding="utf-8")
        (tmp_path / "empty").mkdir()
        (tmp_path / "bad").mkdir()
        (tmp_path / "bad" / "addon.json").write_text(json.dumps(_external(id="bad", permissions=["x"])), encoding="utf-8")
        (tmp_path / "stray.txt").write_text("ignored", encoding="utf-8")
        registry = load_registry(str(tmp_path))
        assert list(registry.addons) == ["astro-id"]
        reasons = {r["directory"]: r["reason"] for r in registry.refused}
        assert set(reasons) == {"broken", "empty", "bad"}
        assert "not valid JSON" in reasons["broken"] and "no addon.json" in reasons["empty"]
        assert "unknown permissions" in reasons["bad"]

    def test_bom_is_accepted(self, tmp_path):
        (tmp_path / "astro-id").mkdir()
        (tmp_path / "astro-id" / "addon.json").write_bytes(b"\xef\xbb\xbf" + json.dumps(_external()).encode())
        assert "astro-id" in load_registry(str(tmp_path)).addons

    def test_oversized_manifest_is_refused(self, tmp_path):
        (tmp_path / "astro-id").mkdir()
        (tmp_path / "astro-id" / "addon.json").write_text(" " * (manifest.MAX_MANIFEST_BYTES + 1), encoding="utf-8")
        assert "larger than" in load_registry(str(tmp_path)).refused[0]["reason"]

    def test_facet_data_is_the_database_directory(self):
        from db.connection import DEFAULT_DB_PATH
        assert manifest.facet_data_dir() == os.path.dirname(os.path.abspath(DEFAULT_DB_PATH))
        assert manifest.addons_dir() == os.path.join(manifest.facet_data_dir(), "addons")
        assert manifest.addon_logs_dir() == os.path.join(manifest.facet_data_dir(), "logs", "addons")


def test_reload_config_rereads_manifests(monkeypatch, tmp_path):
    from api import config as api_config
    monkeypatch.setattr(manifest, "addons_dir", lambda: str(tmp_path))
    manifest.reload()
    assert manifest.get("astro-id") is None
    (tmp_path / "astro-id").mkdir()
    (tmp_path / "astro-id" / "addon.json").write_text(json.dumps(_external()), encoding="utf-8")
    try:
        api_config.reload_config()
        assert manifest.get("astro-id") is not None
    finally:
        monkeypatch.undo()
        manifest.reload()


def test_shipped_default_is_off_and_schema_checks_the_block():
    from config.scoring_config import ScoringConfig
    from config_resolve import load_defaults
    assert load_defaults()["addons"] == {"enabled": False}
    config = ScoringConfig(validate=False)
    config.config = {**load_defaults(), "addons": {"enabled": "yes"}}
    assert any(e.startswith("addons/enabled") for e in config.validate_schema())
    config.config = {**load_defaults(), "addons": {"enabled": True, "tools": []}}
    assert any(e.startswith("addons") for e in config.validate_schema())
