"""The add-on credential: one token kind, MCP as the data channel, default deny on ``/api``.

An add-on's token is an ``mcp_tokens`` row with ``kind='addon'`` (same ``fct_`` prefix, same SHA-256
storage, same live re-derivation as an agent token: ``TokenGrant.resolve``). Two issuers share it: a
supervised launch mints one per start and revokes it at stop; an external (Docker) add-on gets one
minted once from the Add-ons page.

**Data channel (R-MCP).** The add-on reads and writes Facet data over ``/mcp``, like an agent, through
the tools :data:`ADDON_PERMISSION_TOOLS` grants for its permissions: ``tools/list`` shows only those,
``tools/call`` on any other answers ``forbidden_level``, and each tool's ``TOOL_LEVELS`` floor and the
principal's live level still apply. No destructive tool is in the table, whatever
``viewer.mcp.allow_destructive`` says. ``TokenGrant.resolve`` carries the allowlist on the grant.

**``/api``.** Every request carrying such a bearer goes through :func:`addon_user`, from two places that
share one cached result: ``get_optional_user`` and :func:`addon_route_gate`, an app-wide dependency (so a
route with no auth dependency at all is still default-deny). Only the routes in
:func:`addon_api_routes` answer -- the image bytes (``GET /thumbnail``, ``GET /image``: open question (g),
MCP has no byte channel yet) and the add-on's own after-import runs. Anything else: 403. The add-on
proxy (``/addons/{id}/...``) never sees the token: the panel talks to its own backend through it.

Agent tokens are unchanged: ``tokens.verify`` only accepts ``kind='addon'`` when asked, so an agent
token on ``/api`` falls through exactly as before.
"""

import functools
import logging
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional

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


# ``ADDON_PERMISSION_TOOLS``: manifest permission -> the MCP tools it grants. The one table; a test iterates it
# (every tool exists, none is destructive). Never put a destructive tool here.
ADDON_PERMISSION_TOOLS: Mapping[str, frozenset] = {
    # list_albums: the add-on's album picker (an album_id filter on search_photos is the same read).
    "photos.read": frozenset({"status", "search_photos", "get_photo", "filter_options", "list_albums"}),
    # add_tags writes created_by = the add-on id (``mcp_addon`` claim); source stays 'user' because the
    # photo_manual_tags CHECK allows only 'user'/'xmp'. FORK-ONLY until upstream PR-3 (plugin tags,
    # source='plugin'): then this permission maps to the plugin-tag tools instead.
    "tags.write": frozenset({"add_tags", "remove_tags"}),
    # PR-1: the source is forced to the add-on id (tools_annotations), so an add-on only touches its own overlay.
    "annotations.write": frozenset({"get_annotations", "set_annotations", "clear_annotations"}),
    "gps.write": frozenset({"set_gps"}),
}


def addon_scope(grant: Any) -> Optional[AddonScope]:
    """The live scope of an add-on token, or None when add-ons are off or its manifest is gone.

    The manifest can only narrow what the token was minted with, never widen it.
    """
    from api.addons import manifest
    addon = manifest.get(getattr(grant, "addon_id", None) or "")
    if not manifest.addons_enabled() or addon is None:
        return None
    return AddonScope(addon.id, frozenset(grant.scopes) & frozenset(addon.permissions))


def allowed_tools(scope: AddonScope) -> frozenset:
    """The MCP tools ``scope`` may list and call."""
    return frozenset().union(*(ADDON_PERMISSION_TOOLS.get(p, frozenset()) for p in scope.scopes))


@functools.cache
def addon_api_routes() -> dict[tuple[str, Callable], str]:
    """The ``/api`` routes an add-on token may still call: ``{(method, endpoint function): permission}``.

    Image bytes only (MCP carries no bytes yet: open question (g)), plus what later pieces register
    (the after-import run route). Built on first use, because the endpoints live in routers that
    import ``api.auth``.
    """
    from api.routers.thumbnails import get_thumbnail, image

    routes: dict[tuple[str, Callable], str] = {
        ("GET", get_thumbnail): "photos.read",
        ("GET", image): "photos.read",
    }
    for extra in _EXTRA_ROUTES:
        routes.update(extra())
    return routes


# Later pieces register their own add-on routes here (a callable returning more map rows), so the
# map stays one dict without this module importing every router up front.
_EXTRA_ROUTES: list[Callable[[], dict]] = []


def register_routes(provider: Callable[[], dict]) -> None:
    _EXTRA_ROUTES.append(provider)
    addon_api_routes.cache_clear()


def required_permission(request: Request) -> Optional[str]:
    """The permission the matched route needs from an add-on, or None when it is not open to add-ons."""
    endpoint = request.scope.get("endpoint")
    method = "GET" if request.method == "HEAD" else request.method
    return addon_api_routes().get((method, endpoint)) if endpoint is not None else None


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
    from api.agent import tokens
    from api.auth import CurrentUser

    grant = tokens.verify_request(plaintext, request, kinds=(tokens.KIND_ADDON,))
    if grant is None:
        return None
    scope = addon_scope(grant)
    if scope is None:
        raise HTTPException(status_code=403, detail="Add-on is not enabled")
    resolved = grant.resolve()
    if resolved is None:
        raise HTTPException(status_code=401, detail="Add-on token is no longer valid",
                            headers={"WWW-Authenticate": "Bearer"})
    needed = required_permission(request)
    if needed is None or not scope.allows(needed):
        raise HTTPException(status_code=403, detail="Not permitted for this add-on: use Facet's MCP endpoint (/mcp)")
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
