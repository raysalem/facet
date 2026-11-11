"""The Add-ons page's API: list the installed manifests, and mint an external add-on's token.

Read-only by design: a manifest is placed on disk by the operator, never declared or edited from a
browser, and no route here accepts an argv, a path or a URL. ``argv`` never leaves the server.

Gate: the feature switch ``addons.enabled`` (404 when off, like every disabled feature), then
``require_scan_access`` -- the rule Facet already applies to "this route can start an OS process" --
and, for minting, a human session (an agent or add-on credential can never mint itself a token).
"""

import logging

from fastapi import APIRouter, Depends, HTTPException

from api.addons import manifest
from api.addons.auth import live_addon_tokens, mint_addon_token, revoke_addon_tokens
from api.auth import CurrentUser, require_human_session, require_scan_access
from api.models.addons import (
    AddonList, AddonTokenCreated, AddonTokensRevoked,
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

