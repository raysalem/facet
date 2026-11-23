"""Add-on manifests: ``<facet data>/addons/<id>/addon.json``, read at startup and on ``reload_config``.

The operator (or the add-on's own installer) places the file; Facet never writes it, because an
out-of-process writer cannot hold ``CONFIG_WRITE_LOCK``. Uninstall = delete the directory.

*Facet data* is the directory that holds the database (``dirname(DB_PATH)``): ``%LOCALAPPDATA%\\Facet\\data``
on a Windows install, ``/app/data`` in Docker, the working directory for a bare ``python viewer.py``. The
add-on logs live beside the viewer's own, under ``<facet data>/logs/addons/``.

Validation fails closed: a manifest that breaks any rule is refused as a whole and listed with its
reason on the Add-ons page, never half-loaded. The master switch is ``addons.enabled`` (default false).
"""

import json
import logging
import os
import re
import threading
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

FACET_API = 1
MANIFEST_NAME = "addon.json"
MAX_MANIFEST_BYTES = 64 * 1024
# The same rule as an annotation ``source`` and a plugin tag's ``created_by``: the id is all three.
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
ICON_RE = re.compile(r"^[a-z0-9_]{1,40}$")
PERMISSIONS = frozenset({"photos.read", "tags.write", "annotations.write", "gps.write"})
SLOTS = frozenset({"sidebar", "import_hook"})
_TOP_KEYS = frozenset({"id", "name", "version", "icon", "facet_api", "start", "ui", "slots", "permissions"})
_START_KEYS = frozenset({"argv", "port", "health"})
_UI_KEYS = frozenset({"path", "url"})
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


class ManifestError(ValueError):
    """The reason a manifest was refused (shown on the Add-ons page)."""


@dataclass(frozen=True)
class Addon:
    """One valid manifest. ``argv`` never leaves the server (``public()`` omits it)."""

    id: str
    name: str
    version: str
    icon: str
    facet_api: int
    directory: str
    slots: tuple[str, ...]
    permissions: tuple[str, ...]
    ui_path: str = "/"
    ui_url: Optional[str] = None
    argv: tuple[str, ...] = ()
    port: object = None  # "auto" | int | None
    health: str = "/health"

    @property
    def supervised(self) -> bool:
        return bool(self.argv)

    def public(self) -> dict:
        return {
            "id": self.id, "name": self.name, "version": self.version, "icon": self.icon,
            "facet_api": self.facet_api, "slots": list(self.slots), "permissions": list(self.permissions),
            "mode": "supervised" if self.supervised else "external",
            "ui_path": self.ui_path,
        }


@dataclass
class Registry:
    addons: dict[str, Addon] = field(default_factory=dict)
    refused: list[dict] = field(default_factory=list)


def facet_data_dir() -> str:
    """The directory holding the database, which is what "facet data" means for add-ons."""
    from db.connection import DEFAULT_DB_PATH
    return os.path.dirname(os.path.abspath(DEFAULT_DB_PATH))


def addons_dir() -> str:
    return os.path.join(facet_data_dir(), "addons")


def addon_logs_dir() -> str:
    return os.path.join(facet_data_dir(), "logs", "addons")


def addons_enabled() -> bool:
    """The operator master switch ``addons.enabled`` (default false, the twin of ``plugins.enabled``)."""
    from api.config import _FULL_CONFIG
    block = _FULL_CONFIG.get("addons")
    return isinstance(block, dict) and block.get("enabled") is True


def _is_path(value: object) -> bool:
    """A server-relative URL path: leading ``/``, no scheme, query, fragment, ``..``, ``\\`` or ``//``."""
    if not isinstance(value, str) or not value.startswith("/") or len(value) > 200:
        return False
    if "\\" in value or "\0" in value or "//" in value or any(c in value for c in "?#"):
        return False
    return ".." not in value.split("/")


def _str_field(data: dict, key: str, limit: int, required: bool = True) -> str:
    value = data.get(key)
    if value is None and not required:
        return ""
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ManifestError(f"{key} must be a non-empty string of at most {limit} characters")
    return value.strip()


def _string_set(data: dict, key: str, allowed: frozenset) -> tuple[str, ...]:
    value = data.get(key, [])
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ManifestError(f"{key} must be a list of strings")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ManifestError(f"unknown {key}: {', '.join(unknown)}")
    return tuple(sorted(set(value)))


def parse_manifest(data: object, directory: str) -> Addon:
    """Validate one decoded manifest; :class:`ManifestError` names the first rule it breaks."""
    if not isinstance(data, dict):
        raise ManifestError("the manifest must be a JSON object")
    unknown = sorted(set(data) - _TOP_KEYS)
    if unknown:
        raise ManifestError(f"unknown keys: {', '.join(unknown)}")
    addon_id = data.get("id")
    if not isinstance(addon_id, str) or not ID_RE.fullmatch(addon_id):
        raise ManifestError("id must match ^[a-z0-9][a-z0-9._-]{0,63}$")
    if os.path.basename(os.path.normpath(directory)) != addon_id:
        raise ManifestError(f"id {addon_id!r} must equal its directory name")
    name = _str_field(data, "name", 64)
    version = _str_field(data, "version", 32)
    icon = data.get("icon", "extension")
    if not isinstance(icon, str) or not ICON_RE.fullmatch(icon):
        raise ManifestError("icon must be a Material icon name ([a-z0-9_])")
    api = data.get("facet_api")
    if not isinstance(api, int) or isinstance(api, bool) or api < 1 or api > FACET_API:
        raise ManifestError(f"facet_api must be an integer from 1 to {FACET_API} (this server speaks {FACET_API})")
    slots = _string_set(data, "slots", SLOTS)
    permissions = _string_set(data, "permissions", PERMISSIONS)

    ui = data.get("ui")
    if not isinstance(ui, dict) or not ui or set(ui) - _UI_KEYS or len(ui) != 1:
        raise ManifestError('ui must be exactly one of {"path": "/ui/"} or {"url": "http://host:port/"}')
    start = data.get("start")
    if start is not None and "url" in ui:
        raise ManifestError("start and ui.url are mutually exclusive")
    if start is None and "url" not in ui:
        raise ManifestError("an add-on without start (external mode) needs ui.url")

    fields: dict = {}
    if start is not None:
        if not isinstance(start, dict) or set(start) - _START_KEYS:
            raise ManifestError("start may only hold argv, port and health")
        argv = start.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) and a and "\0" not in a for a in argv):
            raise ManifestError("start.argv must be a non-empty list of strings")
        if not os.path.isabs(argv[0]) or not os.path.isfile(argv[0]):
            raise ManifestError("start.argv[0] must be an absolute path to an existing file (no PATH lookup)")
        port = start.get("port", "auto")
        if not (port == "auto" or (isinstance(port, int) and not isinstance(port, bool) and 1024 <= port <= 65535)):
            raise ManifestError('start.port must be "auto" or an integer from 1024 to 65535')
        health = start.get("health", "/health")
        if not _is_path(health):
            raise ManifestError("start.health must be a path such as /health")
        if not _is_path(ui.get("path")):
            raise ManifestError("ui.path must be a path such as /ui/")
        fields.update(argv=tuple(argv), port=port, health=health, ui_path=ui["path"])
    else:
        url = ui.get("url")
        parts = urlsplit(url) if isinstance(url, str) else None
        if (parts is None or parts.scheme not in ("http", "https") or not parts.hostname
                or parts.username or parts.password or parts.query or parts.fragment):
            raise ManifestError("ui.url must be an http(s) URL with a host and no credentials, query or fragment")
        fields.update(ui_url=url if url.endswith("/") else url + "/", ui_path="/")
    return Addon(id=addon_id, name=name, version=version, icon=icon, facet_api=api,
                 directory=os.path.abspath(directory), slots=slots, permissions=permissions, **fields)


def read_manifest(directory: str) -> Addon:
    """Read and validate ``<directory>/addon.json``; every failure is a :class:`ManifestError` with its reason."""
    path = os.path.join(directory, MANIFEST_NAME)
    try:
        with open(path, "rb") as handle:
            raw = handle.read(MAX_MANIFEST_BYTES + 1)
    except FileNotFoundError as exc:
        raise ManifestError(f"no {MANIFEST_NAME}") from exc
    except OSError as exc:
        raise ManifestError(f"cannot read {MANIFEST_NAME}: {exc.strerror}") from exc
    if len(raw) > MAX_MANIFEST_BYTES:
        raise ManifestError(f"{MANIFEST_NAME} is larger than {MAX_MANIFEST_BYTES // 1024} KB")
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ManifestError(f"{MANIFEST_NAME} is not valid JSON: {exc}") from exc
    return parse_manifest(data, directory)


def load_registry(root: Optional[str] = None) -> Registry:
    """Read every ``<root>/<dir>/addon.json``; a bad one is refused with its reason, never raised."""
    root = root or addons_dir()
    registry = Registry()
    try:
        entries = sorted(os.scandir(root), key=lambda e: e.name)
    except FileNotFoundError:
        return registry
    except OSError as exc:
        registry.refused.append({"directory": root, "reason": f"cannot read the add-ons folder: {exc.strerror}"})
        return registry
    for entry in entries:
        if not entry.is_dir(follow_symlinks=True):
            continue
        try:
            addon = read_manifest(entry.path)
        except ManifestError as exc:
            registry.refused.append({"directory": entry.name, "reason": str(exc)})
            continue
        registry.addons[addon.id] = addon
    for item in registry.refused:
        logger.warning("Add-on manifest refused (%s): %s", item["directory"], item["reason"])
    return registry


_lock = threading.Lock()
_registry = Registry()


def reload() -> Registry:
    """Re-read the manifests (startup and ``reload_config``). Running add-ons are not touched."""
    global _registry
    fresh = load_registry()
    with _lock:
        _registry = fresh
    if fresh.addons:
        logger.info("Add-ons discovered: %s", ", ".join(sorted(fresh.addons)))
    return fresh


def reread(addon_id: str) -> Optional[Addon]:
    """Re-read one installed add-on's manifest (a start after a stop picks up an edited ``addon.json``).

    Only a name already in the registry or among the refused folders is read, so the request can never name a
    path. A manifest that is now invalid (or gone) moves to the refused list with its reason; None then.
    """
    global _registry
    with _lock:
        current = _registry
    known = addon_id in current.addons or any(item["directory"] == addon_id for item in current.refused)
    if not isinstance(addon_id, str) or not ID_RE.fullmatch(addon_id) or not known:
        return current.addons.get(addon_id) if isinstance(addon_id, str) else None
    directory = os.path.join(addons_dir(), addon_id)
    try:
        fresh: Optional[Addon] = read_manifest(directory)
        reason = None
    except ManifestError as exc:
        fresh, reason = None, str(exc)
        logger.warning("Add-on manifest refused (%s): %s", addon_id, reason)
    with _lock:
        addons = {k: v for k, v in _registry.addons.items() if k != addon_id}
        refused = [item for item in _registry.refused if item["directory"] != addon_id]
        if fresh is not None:
            addons[addon_id] = fresh
        else:
            refused.append({"directory": addon_id, "reason": reason})
        _registry = Registry(addons=dict(sorted(addons.items())), refused=refused)
    return fresh


def registry() -> Registry:
    return _registry


def get(addon_id: str) -> Optional[Addon]:
    """The valid manifest named exactly ``addon_id``, or None."""
    return _registry.addons.get(addon_id) if isinstance(addon_id, str) else None
