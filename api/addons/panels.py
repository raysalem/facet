"""Open add-on panels: one random nonce per sidebar open, and the validated scope it was opened for.

The nonce is the panel's only capability. The sandboxed (opaque-origin) iframe carries no cookie and
cannot read storage, so the proxy admits a request only when its ``X-Addon-Nonce`` header (or, for
the one document request, the ``nonce`` query parameter) equals a live nonce of that add-on, compared
in constant time. Stopping an add-on closes its panels.

The scope is validated here, server side, before it can reach the panel in a ``context`` message:
``kind`` is an enum, a ``run_id`` must name this add-on's after-import run, a ``path_prefix`` must lie
under a configured scan directory, and a view ``query`` is capped at 2 KB and cut to gallery filter keys.
"""

import hmac
import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Callable, Optional
from urllib.parse import parse_qsl, urlencode

from fastapi import HTTPException

MAX_PANELS_PER_ADDON = 32
MAX_QUERY_BYTES = 2048
SCOPE_KINDS = ("import", "view", "selection")


@dataclass(frozen=True)
class Panel:
    addon_id: str
    nonce: str
    scope: dict
    opened_at: float


_lock = threading.Lock()
_panels: dict[str, "OrderedDict[str, Panel]"] = {}

# The after-import piece registers ``check(addon_id, run_id) -> bool`` here; without it, an
# ``import`` scope cannot be validated and is refused.
IMPORT_RUN_CHECKS: list[Callable[[str, str], bool]] = []
IMPORT_OPENED: list[Callable[[str, str], None]] = []


def _gallery_keys() -> frozenset:
    from api.models.gallery import GalleryParams
    return frozenset(GalleryParams.model_fields)


def _under_scan_directory(prefix: str) -> bool:
    from api.config import get_all_scan_directories
    norm = prefix.replace("\\", "/").rstrip("/") + "/"
    for directory in get_all_scan_directories():
        root = str(directory).replace("\\", "/").rstrip("/") + "/"
        if norm.lower().startswith(root.lower()):
            return True
    return False


def _check_prefix(prefix: object) -> str:
    if not isinstance(prefix, str) or not prefix or len(prefix) > 1024 or "\0" in prefix:
        raise HTTPException(status_code=422, detail="path_prefix must be a path")
    if ".." in prefix.replace("\\", "/").split("/") or not _under_scan_directory(prefix):
        raise HTTPException(status_code=422, detail="path_prefix is not under a configured scan directory")
    return prefix


def validate_scope(addon_id: str, scope: object) -> dict:
    """The scope as the panel will see it, or a 422 naming what is wrong."""
    if scope is None:
        scope = {"kind": "view"}
    if not isinstance(scope, dict):
        raise HTTPException(status_code=422, detail="scope must be an object")
    kind = scope.get("kind")
    if kind not in SCOPE_KINDS:
        raise HTTPException(status_code=422, detail=f"scope.kind must be one of {', '.join(SCOPE_KINDS)}")
    unknown = set(scope) - {"kind", "run_id", "query", "path_prefix"}
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown scope keys: {', '.join(sorted(unknown))}")
    out: dict = {"kind": kind}
    if kind == "import":
        run_id = scope.get("run_id")
        if not isinstance(run_id, str) or not IMPORT_RUN_CHECKS or not any(c(addon_id, run_id) for c in IMPORT_RUN_CHECKS):
            raise HTTPException(status_code=422, detail="scope.run_id is not an after-import run of this add-on")
        out["run_id"] = run_id
    elif "run_id" in scope:
        raise HTTPException(status_code=422, detail="scope.run_id belongs to an import scope")
    if kind == "view":
        query = scope.get("query", "")
        if not isinstance(query, str) or len(query.encode("utf-8")) > MAX_QUERY_BYTES:
            raise HTTPException(status_code=422, detail="scope.query must be a string of at most 2 KB")
        allowed = _gallery_keys()
        # Keys that are not gallery filters are dropped, never forwarded: the panel sees only a
        # query the gallery itself would accept.
        pairs = [(k, v) for k, v in parse_qsl(query, keep_blank_values=False) if k in allowed]
        for key, value in pairs:
            if key == "path_prefix":
                _check_prefix(value)
        out["query"] = urlencode(pairs)
    elif "query" in scope:
        raise HTTPException(status_code=422, detail="scope.query belongs to a view scope")
    if "path_prefix" in scope:
        out["path_prefix"] = _check_prefix(scope["path_prefix"])
    return out


def open_panel(addon_id: str, scope: dict) -> Panel:
    """Issue a fresh nonce for ``scope`` (already validated). The oldest open is dropped past the cap."""
    panel = Panel(addon_id, secrets.token_urlsafe(32), scope, time.time())
    with _lock:
        table = _panels.setdefault(addon_id, OrderedDict())
        table[panel.nonce] = panel
        while len(table) > MAX_PANELS_PER_ADDON:
            table.popitem(last=False)
    if scope.get("kind") == "import":
        for opened in IMPORT_OPENED:
            opened(addon_id, scope["run_id"])
    return panel


def match(addon_id: str, presented: Optional[str]) -> Optional[Panel]:
    """The live panel whose nonce equals ``presented``; every candidate is compared in constant time."""
    if not isinstance(presented, str) or not presented:
        return None
    with _lock:
        candidates = list((_panels.get(addon_id) or {}).values())
    found = None
    for panel in candidates:
        if hmac.compare_digest(panel.nonce.encode(), presented.encode()):
            found = panel
    return found


def close_all(addon_id: str) -> None:
    with _lock:
        _panels.pop(addon_id, None)


def close(addon_id: str, nonce: str) -> bool:
    with _lock:
        table = _panels.get(addon_id)
        return bool(table) and table.pop(nonce, None) is not None


def has_panels(addon_id: str) -> bool:
    with _lock:
        return bool(_panels.get(addon_id))
