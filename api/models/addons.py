"""Wire models for ``/api/addons`` (the Add-ons page). Never carries an add-on's argv."""

from typing import Any, Literal, Optional

from pydantic import BaseModel


class AddonItem(BaseModel):
    id: str
    name: str
    version: str
    icon: str
    facet_api: int
    slots: list[str]
    permissions: list[str]
    mode: Literal["supervised", "external"]
    ui_path: str
    # external | stopped | starting | running | exited | failed
    status: str
    live_tokens: int = 0
    # Supervised add-ons: the last exit code, why a start failed, and the log tail after a failure.
    exit_code: Optional[int] = None
    error: Optional[str] = None
    log_tail: Optional[list[str]] = None


class RefusedManifest(BaseModel):
    directory: str
    reason: str


class AddonRun(BaseModel):
    """An after-import request (``addon_runs``) with its scan's state and photo count."""

    job_id: str
    addon_id: str
    requested_at: Optional[str] = None
    opened_at: Optional[str] = None
    run_id: Optional[int] = None
    status: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    photo_count: int = 0


class AddonList(BaseModel):
    addons: list[AddonItem]
    refused: list[RefusedManifest]
    addons_dir: str
    # After-import runs not opened yet ("pending: run #N").
    pending_runs: list[AddonRun] = []


class AddonTokenCreated(BaseModel):
    """The one response that carries an external add-on's token in plaintext."""

    id: int
    addon_id: str
    level: str
    token: str
    scopes: list[str]


class AddonTokensRevoked(BaseModel):
    addon_id: str
    revoked: int


class AddonOpenRequest(BaseModel):
    """``scope``: ``{"kind": "view", "query": "..."}`` | ``{"kind": "selection"}`` | ``{"kind": "import", "run_id": "..."}``."""

    scope: Optional[dict[str, Any]] = None


class AddonOpened(BaseModel):
    addon_id: str
    nonce: str
    src: str
    scope: dict[str, Any]


class AddonCloseRequest(BaseModel):
    nonce: str


class AddonClosed(BaseModel):
    closed: bool


class AddonStartRequest(BaseModel):
    """``scope`` as for ``/open``; when given, the started add-on's panel is opened for it."""

    scope: Optional[dict[str, Any]] = None


class AddonStarted(BaseModel):
    addon_id: str
    status: str
    error: Optional[str] = None
    log_tail: Optional[list[str]] = None
    opened: Optional[AddonOpened] = None


class AddonStopped(BaseModel):
    addon_id: str
    stopped: bool


class AddonLog(BaseModel):
    addon_id: str
    lines: list[str]
