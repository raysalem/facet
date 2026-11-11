"""The add-on credential on ``/api``: one verifier, one route map, default deny.

An add-on's token is an ``mcp_tokens`` row with ``kind='addon'`` (same ``fct_`` prefix, same SHA-256
storage, same live re-derivation as an agent token: ``TokenGrant.resolve``). Two issuers share it: a
supervised launch mints one per start and revokes it at stop; an external (Docker) add-on gets one
minted once from the Add-ons page.

Every request carrying such a bearer goes through :func:`addon_user`, from two places that share
one cached result: ``get_optional_user`` (so every authenticated route sees the add-on principal) and
:func:`addon_route_gate`, an app-wide dependency (so a route with no auth dependency at all is still
default-deny). The route is identified by ``request.scope["endpoint"]`` -- the handler function
Starlette's router matched -- and looked up in :data:`ADDON_ROUTE_SCOPES`. Unmapped, or mapped to a
permission the token does not hold: 403. Add-on checks live here and nowhere else.

Agent tokens are unchanged: ``tokens.verify`` only accepts ``kind='addon'`` when asked, so an agent
token on ``/api`` falls through exactly as before, and an add-on token never opens ``/mcp``.
"""

import functools
import logging
from dataclasses import dataclass
from typing import Callable, Optional

from fastapi import HTTPException, Request
from starlette.requests import HTTPConnection

logger = logging.getLogger(__name__)

_STATE_KEY = "facet_addon_user"
_UNSET = object()


@dataclass(frozen=True)
class AddonScope:
    """What the add-on behind a request may do: its id and its effective permissions."""

    id: str
    scopes: frozenset

    def allows(self, permission: str) -> bool:
        return permission in self.scopes


@functools.cache
def addon_route_scopes() -> dict[tuple[str, Callable], str]:
    """``ADDON_ROUTE_SCOPES``: ``{(method, endpoint function): permission}``.

    Built on first use, because the endpoints live in routers that import ``api.auth``.
    ``annotations.write`` maps to nothing until upstream PR-1 adds ``PUT /api/photo/annotations``.
    """
    from api.routers.gallery import api_photo, api_photos
    from api.routers.manual_tags import api_batch_manual_tags, api_delete_manual_tag
    from api.routers.map import api_update_gps
    from api.routers.thumbnails import get_thumbnail, image

    routes: dict[tuple[str, Callable], str] = {
        ("GET", api_photos): "photos.read",
        ("GET", api_photo): "photos.read",
        ("GET", get_thumbnail): "photos.read",
        ("GET", image): "photos.read",
        ("PUT", api_update_gps): "gps.write",
        # FORK-ONLY, TEMPORARY until upstream PR-3 (plugin tags, POST /api/photos/plugin_tags) lands:
        # the add-on writes manual tags. Remove both rows when PR-3 is merged.
        ("POST", api_batch_manual_tags): "tags.write",
        ("DELETE", api_delete_manual_tag): "tags.write",
    }
    for extra in _EXTRA_ROUTES:
        routes.update(extra())
    return routes


# Later pieces register their own add-on routes here (a callable returning more map rows), so the
# map stays one dict without this module importing every router up front.
_EXTRA_ROUTES: list[Callable[[], dict]] = []


def register_routes(provider: Callable[[], dict]) -> None:
    _EXTRA_ROUTES.append(provider)
    addon_route_scopes.cache_clear()


def required_permission(request: Request) -> Optional[str]:
    """The permission the matched route needs from an add-on, or None when it is not mapped."""
    endpoint = request.scope.get("endpoint")
    method = "GET" if request.method == "HEAD" else request.method
    return addon_route_scopes().get((method, endpoint)) if endpoint is not None else None


def _bearer(request: Request) -> Optional[str]:
    from api.agent.tokens import TOKEN_PREFIX, bearer_token
    secret = bearer_token(request.headers)
    return secret if secret and secret.startswith(TOKEN_PREFIX) else None


def addon_user(request: Request):
    """The ``CurrentUser`` an add-on token stands for, or None when the bearer is no add-on token.

    Raises 403 when the add-on feature is off, its manifest is gone, or the route is unmapped or
    outside its permissions; 401 when the token's principal no longer holds (rotated password,
    deleted account). The result is cached on the request.
    """
    cached = getattr(request.state, _STATE_KEY, _UNSET)
    if cached is not _UNSET:
        return cached
    user = None
    plaintext = _bearer(request)
    if plaintext is not None:
        user = _resolve(request, plaintext)
    setattr(request.state, _STATE_KEY, user)
    return user


def _resolve(request: Request, plaintext: str):
    from api.addons import manifest
    from api.agent import tokens
    from api.auth import CurrentUser

    grant = tokens.verify_request(plaintext, request, kinds=(tokens.KIND_ADDON,))
    if grant is None:
        return None
    addon = manifest.get(grant.addon_id or "")
    if not manifest.addons_enabled() or addon is None:
        raise HTTPException(status_code=403, detail="Add-on is not enabled")
    resolved = grant.resolve()
    if resolved is None:
        raise HTTPException(status_code=401, detail="Add-on token is no longer valid",
                            headers={"WWW-Authenticate": "Bearer"})
    # The manifest can only narrow what the token was minted with, never widen it.
    scope = AddonScope(addon.id, frozenset(grant.scopes) & frozenset(addon.permissions))
    needed = required_permission(request)
    if needed is None or not scope.allows(needed):
        raise HTTPException(status_code=403, detail="Not permitted for this add-on")
    claims = resolved.jwt_claims()
    user = CurrentUser.from_payload(claims) if claims is not None else CurrentUser(agent=True)
    user.agent = True  # learning and auto-retrain skip it, as for every agent write
    user.addon = scope
    try:
        tokens.touch(grant.id)
    except Exception:  # noqa: BLE001 -- a lost last-used stamp must not fail the call
        logger.debug("Could not stamp add-on token %s", grant.id, exc_info=True)
    return user


WRITE_PERMISSIONS = frozenset({"tags.write", "annotations.write", "gps.write"})


def mint_addon_token(addon, user, name: str) -> tuple[dict, str]:
    """Mint ``addon``'s credential as the principal of ``user``'s session (never a service principal).

    The level is ``edition`` when the manifest asks for a write and the session holds edition, else
    ``readonly``; ``TokenGrant.resolve`` re-lowers it to the principal's live level on every call.
    """
    from api.agent import tokens
    principal = tokens.session_principal(user.user_id)
    if not principal:
        raise HTTPException(status_code=401, detail="Authentication required")
    wants_write = bool(WRITE_PERMISSIONS & set(addon.permissions))
    level = "edition" if wants_write and user.is_edition else "readonly"
    return tokens.mint(principal, name, level, tokens.session_level(user),
                       kind=tokens.KIND_ADDON, addon_id=addon.id, scopes=list(addon.permissions))


def live_addon_tokens(addon_id: str) -> list[dict]:
    from api.database import get_db
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT id, name, token_prefix, level, created_at, last_used_at FROM mcp_tokens "
            "WHERE kind = 'addon' AND addon_id = ? AND revoked = 0 ORDER BY id DESC", (addon_id,))]


def revoke_addon_tokens(addon_id: str, token_id: Optional[int] = None) -> int:
    """Revoke ``addon_id``'s live tokens (only ``token_id`` when given); the number revoked."""
    from api.agent import tokens
    from api.database import get_db
    sql = "UPDATE mcp_tokens SET revoked = 1, revoked_at = ? WHERE kind = 'addon' AND addon_id = ? AND revoked = 0"
    params: list = [tokens._now_iso(), addon_id]
    if token_id is not None:
        sql += " AND id = ?"
        params.append(token_id)
    with get_db() as conn:
        changed = conn.execute(sql, params).rowcount
        conn.commit()
    return changed


async def addon_route_gate(connection: HTTPConnection) -> None:
    """App-wide dependency: default deny for an add-on token on every route, authenticated or not.

    Typed ``HTTPConnection`` because app-wide dependencies also run for WebSocket routes (the agent
    bridge), which have no ``Request``; an add-on token is refused on every WebSocket outright.
    """
    if _bearer(connection) is None:
        return
    if connection.scope["type"] != "http":
        raise HTTPException(status_code=403, detail="Not permitted for this add-on")
    addon_user(connection)
