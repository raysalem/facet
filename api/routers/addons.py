"""The Add-ons page's API: list the installed manifests, and mint an external add-on's token.

Read-only by design: a manifest is placed on disk by the operator, never declared or edited from a
browser, and no route here accepts an argv, a path or a URL. ``argv`` never leaves the server.

Gate: the feature switch ``addons.enabled`` (404 when off, like every disabled feature), then
``require_scan_access`` -- the rule Facet already applies to "this route can start an OS process" --
and, for minting, a human session (an agent or add-on credential can never mint itself a token).
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from api.addons import manifest, panels, proxy, runs, supervisor
from api.addons.auth import register_routes
from api.addons.auth import live_addon_tokens, mint_addon_token, revoke_addon_tokens
from api.auth import (
    EDITION_PASSWORD_KEY, CurrentUser, _is_open_install, require_authenticated, require_human_session,
    require_scan_access, scan_access_refusal,
)
from api.config import is_multi_user_enabled
from api.models.addons import (
    AddonClosed, AddonCloseRequest, AddonList, AddonLog, AddonNames, AddonRun, AddonStarted, AddonStartRequest, AddonStopped, AddonOpened, AddonOpenRequest, AddonTokenCreated,
    AddonTokensRevoked,
)

logger = logging.getLogger(__name__)


def require_addons_enabled() -> None:
    if not manifest.addons_enabled():
        raise HTTPException(status_code=404, detail="Not Found")


def require_addon_operator(
    user: CurrentUser = Depends(require_scan_access),
    _human: CurrentUser = Depends(require_human_session),
) -> CurrentUser:
    """``require_scan_access`` from a human session (never an agent JWT or an add-on token)."""
    if user.addon is not None:
        raise HTTPException(status_code=403, detail="Add-on credentials cannot manage add-ons")
    return user


def addon_or_404(addon_id: str) -> manifest.Addon:
    addon = manifest.get(addon_id)
    if addon is None:
        raise HTTPException(status_code=404, detail="Unknown add-on")
    return addon


router = APIRouter(prefix="/api/addons", tags=["addons"], dependencies=[Depends(require_addons_enabled)])

# Status, log tail and pending runs are contributed by the later pieces (supervisor, import hook)
# through these hooks, so this list route stays the single read the page makes.
STATUS_PROVIDERS: list = []
LIST_EXTRAS: list = []


def addon_entry(addon: manifest.Addon) -> dict:
    entry = {**addon.public(), "status": "external" if not addon.supervised else "stopped",
             "live_tokens": len(live_addon_tokens(addon.id)) if not addon.supervised else 0}
    for provider in STATUS_PROVIDERS:
        entry.update(provider(addon))
    return entry


@router.get(
    "",
    response_model=AddonList,
    responses={403: {"description": "Scan access required."}, 404: {"description": "Add-ons are disabled (addons.enabled)."}},
)
def list_addons(_user: CurrentUser = Depends(require_addon_operator)):
    """Installed add-ons (never their argv) and the manifests that were refused, with the reason."""
    registry = manifest.registry()
    body = {
        "addons": [addon_entry(a) for a in registry.addons.values()],
        "refused": list(registry.refused),
        "addons_dir": manifest.addons_dir(),
    }
    for extra in LIST_EXTRAS:
        body.update(extra())
    return body


@router.get(
    "/names",
    response_model=AddonNames,
    responses={404: {"description": "Add-ons are disabled (addons.enabled)."}},
)
def list_addon_names(_user: CurrentUser = Depends(require_authenticated)):
    """The installed add-ons' display names and icons, for any signed-in viewer.

    A viewer without scan access sees what an add-on stored (its object tags) and the add-on's tab, shown
    off with the reason; it needs the name for both. Nothing else of the manifest (no version, permissions,
    state or path) is in this answer.
    """
    return {"addons": [{"id": a.id, "name": a.name, "icon": a.icon, "slots": list(a.slots)}
                       for a in manifest.registry().addons.values()]}


@router.post(
    "/{addon_id}/token",
    response_model=AddonTokenCreated,
    responses={404: {"description": "Unknown add-on, or add-ons are disabled."},
               409: {"description": "A supervised add-on gets a fresh token on every start."}},
)
def mint_token(addon_id: str, user: CurrentUser = Depends(require_addon_operator)):
    """Mint an external add-on's token. The plaintext is in this response and nowhere else."""
    addon = addon_or_404(addon_id)
    if addon.supervised:
        raise HTTPException(status_code=409, detail="A supervised add-on gets its token at start")
    row, plaintext = mint_addon_token(addon, user, f"add-on {addon.id}")
    logger.info("Add-on token %d minted for %s (level %s)", row["id"], addon.id, row["level"])
    return {"id": row["id"], "addon_id": addon.id, "level": row["level"], "token": plaintext,
            "scopes": list(addon.permissions)}


@router.delete(
    "/{addon_id}/tokens",
    response_model=AddonTokensRevoked,
    responses={404: {"description": "Unknown add-on, or add-ons are disabled."}},
)
def revoke_tokens(addon_id: str, _user: CurrentUser = Depends(require_addon_operator)):
    """Revoke every live token of an add-on (an external add-on's credential, in practice)."""
    revoked = revoke_addon_tokens(addon_id)
    logger.info("Revoked %d token(s) of add-on %s", revoked, addon_id)
    return {"addon_id": addon_id, "revoked": revoked}


def open_addon_panel(addon: manifest.Addon, scope: object) -> dict:
    """Validate ``scope`` and issue a panel nonce; shared with the supervisor's start."""
    if "sidebar" not in addon.slots:
        raise HTTPException(status_code=409, detail="This add-on has no sidebar")
    if proxy.upstream_for(addon) is None:
        raise HTTPException(status_code=409, detail="The add-on is not running")
    panel = panels.open_panel(addon.id, panels.validate_scope(addon.id, scope))
    return {"addon_id": addon.id, "nonce": panel.nonce, "scope": panel.scope,
            "src": f"{proxy.PREFIX}/{addon.id}{addon.ui_path}?nonce={panel.nonce}"}


@router.post(
    "/{addon_id}/open",
    response_model=AddonOpened,
    responses={404: {"description": "Unknown add-on, or add-ons are disabled."},
               409: {"description": "No sidebar slot, or the add-on is not running."},
               422: {"description": "The scope failed validation."}},
)
def open_panel(addon_id: str, body: AddonOpenRequest, _user: CurrentUser = Depends(require_addon_operator)):
    """Open the add-on's sidebar for ``scope``: a fresh per-open nonce and the iframe ``src``."""
    return open_addon_panel(addon_or_404(addon_id), body.scope)


@router.post("/{addon_id}/close", response_model=AddonClosed)
def close_panel(addon_id: str, body: AddonCloseRequest, _user: CurrentUser = Depends(require_addon_operator)):
    """Forget one panel's nonce (the sidebar was closed); the proxy refuses it from now on."""
    return {"closed": panels.close(addon_id, body.nonce)}


@router.get(
    "/runs/{job_id}",
    response_model=AddonRun,
    responses={404: {"description": "No such after-import run (for an add-on: none of its own)."}},
)
def get_addon_run(job_id: str, user: CurrentUser = Depends(require_authenticated)):
    """One after-import run: its add-on, scan state and photo count.

    An add-on token (``photos.read``) sees only its own runs; a person needs the scan gate.
    """
    if user.addon is None:
        refusal = scan_access_refusal(is_multi_user_enabled(), user.is_superadmin, user.is_edition,
                                      _is_open_install(EDITION_PASSWORD_KEY), user.trusted_local_editing)
        if refusal is not None:
            raise HTTPException(status_code=refusal[0], detail=refusal[1])
    run = runs.get_run(job_id)
    if run is None or (user.addon is not None and run["addon_id"] != user.addon.id):
        raise HTTPException(status_code=404, detail="Run not found")
    return run


# The import hook plugs into the shared add-on surfaces: the route map, the scope check and the list.
register_routes(lambda: {("GET", get_addon_run): "photos.read"})
panels.IMPORT_RUN_CHECKS.append(runs.is_run_of)
panels.IMPORT_OPENED.append(runs.mark_opened)
LIST_EXTRAS.append(lambda: {"pending_runs": runs.pending_runs()})


def facet_url(request: Request) -> str:
    """Where a supervised add-on on this machine reaches Facet: loopback on the port this server listens on."""
    server = request.scope.get("server") or ("127.0.0.1", 5000)
    host, port = server[0], server[1]
    if host in ("0.0.0.0", "::", "", "localhost", "::1") or host is None:
        host = "127.0.0.1"
    return f"http://{host}:{port}"


def supervised_or_409(addon_id: str) -> manifest.Addon:
    addon = addon_or_404(addon_id)
    if not addon.supervised:
        raise HTTPException(status_code=409, detail="This add-on is not started by Facet (no start block)")
    return addon


@router.post(
    "/{addon_id}/start",
    response_model=AddonStarted,
    responses={404: {"description": "Unknown add-on, or add-ons are disabled."},
               409: {"description": "Not a supervised add-on."},
               422: {"description": "The scope failed validation."},
               502: {"description": "The add-on did not start; the body carries the reason and the log tail."}},
)
def start_addon(addon_id: str, body: AddonStartRequest, request: Request,
                user: CurrentUser = Depends(require_addon_operator)):
    """Start a supervised add-on (or keep the running one) and, with ``scope``, open its panel.

    Takes ``{scope}`` only: the program, its arguments and its environment come from the manifest
    on disk and from Facet, never from the request.
    """
    addon = supervised_or_409(addon_id)
    scope = panels.validate_scope(addon.id, body.scope) if body.scope is not None else None
    inst = supervisor.start(addon, user, facet_url(request))
    if inst.status != "running":
        raise HTTPException(status_code=502, detail={
            "addon_id": addon.id, "status": inst.status, "error": inst.error,
            "log_tail": supervisor.log_tail(addon.id)})
    opened = open_addon_panel(addon, scope) if scope is not None and "sidebar" in addon.slots else None
    return {"addon_id": addon.id, "status": inst.status, "opened": opened}


@router.post("/{addon_id}/stop", response_model=AddonStopped,
             responses={404: {"description": "Unknown add-on, or add-ons are disabled."},
                        409: {"description": "Not a supervised add-on."}})
def stop_addon(addon_id: str, _user: CurrentUser = Depends(require_addon_operator)):
    """Stop a supervised add-on: its process tree ends, its launch token is revoked, its panels close."""
    addon = supervised_or_409(addon_id)
    return {"addon_id": addon.id, "stopped": supervisor.stop(addon.id)}


@router.get("/{addon_id}/log", response_model=AddonLog,
            responses={404: {"description": "Unknown add-on, or add-ons are disabled."}})
def addon_log(addon_id: str, lines: int = Query(200, ge=1, le=1000),
              _user: CurrentUser = Depends(require_addon_operator)):
    """The tail of ``<facet data>/logs/addons/<id>.log``."""
    addon = addon_or_404(addon_id)
    return {"addon_id": addon.id, "lines": supervisor.log_tail(addon.id, lines)}


# The supervisor plugs into the shared surfaces: live status on the list, and the proxy's upstream.
STATUS_PROVIDERS.append(supervisor.status)
proxy.UPSTREAMS.insert(0, supervisor.upstream)
