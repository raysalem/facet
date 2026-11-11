"""``/addons/{id}/{path}``: the reverse proxy that serves an add-on's sidebar under Facet's origin.

The panel runs in ``<iframe sandbox="allow-scripts">``: an opaque origin, so it holds no Facet cookie
or storage, and every fetch it makes is a CORS request. This proxy is the only way its traffic
reaches the add-on, and it enforces the policy below on every request (docs/CONFIGURATION.md, Add-ons):

* **Gate.** Unknown or stopped add-on: 404 (so the prefix is not an oracle). Otherwise the request must
  carry ``X-Addon-Nonce`` equal to a live panel nonce (constant time) or 403. The document request
  (GET/HEAD of the manifest's ``ui.path``) is the one place the nonce may be the ``nonce`` query
  parameter; the page then keeps it in memory. Subresources the page loads without that header are
  refused, so a panel inlines its script and style and fetches everything else with the header.
* **CORS.** ``Access-Control-Allow-Origin: *`` without credentials; the nonce, not the origin, is the
  capability. A preflight is answered here, never forwarded.
* **Path.** Decoded once by the router; refused on ``..``, ``\\``, NUL, empty segments or a leading ``/``;
  the upstream URL is rebuilt from quoted segments. The query is forwarded minus ``nonce``.
* **Headers.** Request: an allowlist only (never Cookie or Authorization), plus ``X-Facet-Launch`` (the
  supervised launch secret) and ``X-Forwarded-Prefix``. Response: an allowlist only (never Set-Cookie,
  the add-on's CSP, X-Frame-Options or Access-Control-*); a relative ``Location`` is rewritten under the
  prefix and an absolute one refused. The sandbox CSP and the other security headers are set
  explicitly, because ``SecurityHeadersMiddleware`` only ``setdefault``s.
* GET/HEAD/POST/PUT/DELETE/OPTIONS and streamed responses (SSE); no WebSocket. The 10 MB request body
  cap of ``RequestBodyCapMiddleware`` applies.

Where to send a request is decided by :data:`UPSTREAMS` (external add-ons: ``ui.url``; the supervisor
registers its own provider for the add-ons it runs), so the proxy knows nothing about processes.
"""

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable, Optional
from urllib.parse import parse_qsl, quote, urlencode, urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from api.addons import manifest, panels

if TYPE_CHECKING:
    import httpx

logger = logging.getLogger(__name__)

PREFIX = "/addons"
METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]
NONCE_HEADER = "x-addon-nonce"
LAUNCH_HEADER = "X-Facet-Launch"
REQUEST_HEADERS = ("content-type", "content-length", "accept", "accept-language",
                   "range", "if-none-match")
RESPONSE_HEADERS = ("content-type", "content-length", "etag", "last-modified", "content-disposition")
SANDBOX_CSP = ("sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; "
               "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; "
               "frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "X-Addon-Nonce, Content-Type",
    "Access-Control-Allow-Methods": ", ".join(m for m in METHODS if m != "OPTIONS"),
    "Access-Control-Max-Age": "600",
}
POLICY_HEADERS = {
    "Content-Security-Policy": SANDBOX_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


@dataclass(frozen=True)
class Upstream:
    """Where an add-on's panel traffic goes: ``base`` ends in ``/``; ``launch_secret`` when supervised."""

    base: str
    launch_secret: Optional[str] = None


def _external(addon: manifest.Addon) -> Optional[Upstream]:
    return Upstream(addon.ui_url) if addon.ui_url else None


# Providers are asked in order; the first non-None answer wins. The supervisor prepends its own.
UPSTREAMS: list[Callable[[manifest.Addon], Optional[Upstream]]] = [_external]


def upstream_for(addon: manifest.Addon) -> Optional[Upstream]:
    for provider in UPSTREAMS:
        found = provider(addon)
        if found is not None:
            return found
    return None


def _policy(extra: Optional[dict] = None) -> dict:
    return {**POLICY_HEADERS, **CORS_HEADERS, **(extra or {})}


def _refuse(status: int, detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=status, headers=_policy())


def safe_segments(path: str) -> Optional[list[str]]:
    """The path's segments, or None when it must be refused. A trailing ``/`` is kept as a final ''."""
    if path.startswith("/") or "\\" in path or "\0" in path:
        return None
    if path == "":
        return [""]
    segments = path.split("/")
    for index, segment in enumerate(segments):
        if segment in (".", ".."):
            return None
        if segment == "" and index != len(segments) - 1:
            return None
    return segments


_client: Optional["httpx.AsyncClient"] = None


def client() -> "httpx.AsyncClient":
    """The shared upstream client. ``httpx`` is imported here, not at module load: the viewer must
    start on an install that lacks it (the agent layer makes the same promise)."""
    global _client
    import httpx
    if _client is None or _client.is_closed:
        # No env proxies (trust_env=False): the upstream is loopback or a compose service.
        _client = httpx.AsyncClient(trust_env=False, follow_redirects=False,
                                    timeout=httpx.Timeout(30.0, read=300.0))
    return _client


async def aclose() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _rewrite_location(value: str, prefix: str, base_path: str) -> Optional[str]:
    parts = urlsplit(value)
    if parts.scheme or parts.netloc:
        return None
    if value.startswith("/"):
        if not value.startswith(base_path):
            return None
        return prefix + value[len(base_path):]
    return value  # relative to the document: already under the prefix


router = APIRouter(include_in_schema=False)


@router.api_route(PREFIX + "/{addon_id}/{path:path}", methods=METHODS)
async def addon_proxy(addon_id: str, path: str, request: Request):
    if not manifest.addons_enabled():
        return _refuse(404, "Not Found")
    addon = manifest.get(addon_id)
    upstream = upstream_for(addon) if addon is not None else None
    if addon is None or upstream is None:
        return _refuse(404, "Not Found")
    if request.method == "OPTIONS" and "access-control-request-method" in request.headers:
        return Response(status_code=204, headers=_policy())
    segments = safe_segments(path)
    if segments is None:
        return _refuse(400, "Invalid path")
    rel = "/".join(segments)
    nonce = request.headers.get(NONCE_HEADER)
    query = [(k, v) for k, v in parse_qsl(request.url.query, keep_blank_values=True) if k != "nonce"]
    if nonce is None and request.method in ("GET", "HEAD") and "/" + rel == addon.ui_path:
        nonce = request.query_params.get("nonce")
    if panels.match(addon.id, nonce) is None:
        return _refuse(403, "Missing or stale panel nonce")

    base = urlsplit(upstream.base)
    target = upstream.base + "/".join(quote(s, safe="") for s in segments)
    if query:
        target += "?" + urlencode(query)
    headers = {k: v for k, v in request.headers.items() if k.lower() in REQUEST_HEADERS}
    # Raw bytes are passed through, so ask for an unencoded body rather than forward Content-Encoding.
    headers["Accept-Encoding"] = "identity"
    headers["X-Forwarded-Prefix"] = f"{PREFIX}/{addon.id}"
    if upstream.launch_secret:
        headers[LAUNCH_HEADER] = upstream.launch_secret
    body = request.stream() if request.method in ("POST", "PUT", "DELETE") else None
    try:
        import httpx
    except ImportError:
        return _refuse(503, "The add-on proxy needs the httpx package")
    try:
        upstream_request = client().build_request(request.method, target, headers=headers, content=body)
        response = await client().send(upstream_request, stream=True)
    except httpx.HTTPError as exc:
        logger.warning("Add-on %s did not answer (%s)", addon.id, type(exc).__name__)
        return _refuse(502, "The add-on did not answer")

    out = {k: v for k, v in response.headers.items() if k.lower() in RESPONSE_HEADERS}
    location = response.headers.get("location")
    if location is not None:
        rewritten = _rewrite_location(location, f"{PREFIX}/{addon.id}/", base.path or "/")
        if rewritten is None:
            await response.aclose()
            return _refuse(502, "The add-on redirected outside its panel")
        out["Location"] = rewritten
    out.update(_policy())
    if request.method == "HEAD":
        await response.aclose()
        return Response(status_code=response.status_code, headers=out)
    return StreamingResponse(response.aiter_raw(), status_code=response.status_code, headers=out,
                             background=BackgroundTask(response.aclose))
