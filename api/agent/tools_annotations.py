"""Photo annotation tools (PR-1 overlay) for agents and add-ons.

``get_annotations`` reads every source's overlay for one photo; ``set_annotations`` and
``clear_annotations`` write one source's. An add-on token never names the source: it is
forced to the add-on id, so an add-on only ever touches its own overlay. An agent token
passes ``source`` explicitly.
"""

from typing import Annotated, Any, Optional

from mcp.server.mcpserver import Context, MCPServer
from mcp.types import CallToolResult
from pydantic import Field

from api.agent.internal_client import InternalClient, err, ok
from api.agent.runtime import run_tool
from api.agent.tools_common import READ_ANNOTATIONS, WRITE_ANNOTATIONS, register_tool
from api.agent.tools_write import WRITE_TOOL_LEVELS

Path = Annotated[str, Field(min_length=1, max_length=4096)]
Source = Annotated[Optional[str], Field(min_length=1, max_length=64)]


def _source(resolved: Any, source: Optional[str]) -> tuple[Optional[str], Optional[dict]]:
    """The source to write: the add-on's own id for an add-on token, else the one given."""
    addon_id = getattr(resolved, "addon_id", None)
    if addon_id is not None:
        if source not in (None, addon_id):
            return None, err("invalid_input", f"An add-on writes only its own overlay (source '{addon_id}')")
        return addon_id, None
    if not source:
        return None, err("invalid_input", "Pass source: the plugin id the overlay belongs to")
    return source, None


def register_annotation_tools(server: MCPServer, client: InternalClient) -> None:
    def add(fn, name: str, description: str, read_only: bool = False) -> None:
        register_tool(server, fn, name, description, READ_ANNOTATIONS if read_only else WRITE_ANNOTATIONS,
                      WRITE_TOOL_LEVELS[name])

    async def get_annotations(ctx: Context, path: Path) -> CallToolResult:
        async def handler(grant, resolved, settings):
            r = await client.call(grant, "annotations.get", query={"path": path}, timeout=settings["call_timeout_s"])
            if not r["ok"]:
                return r
            return ok({"path": path, "annotations": (r["data"] or {}).get("annotations") or []})
        return await run_tool(ctx, "get_annotations", handler)

    add(get_annotations, "get_annotations",
        "Every plugin overlay stored for one photo: `[{source, payload}]` (payload v1, see docs/API.md). Empty for "
        "a photo the caller cannot see.", read_only=True)

    async def set_annotations(ctx: Context, path: Path, payload: dict[str, Any], source: Source = None) -> CallToolResult:
        async def handler(grant, resolved, settings):
            src, refusal = _source(resolved, source)
            if refusal is not None:
                return refusal
            r = await client.call(grant, "annotations.set", json={"path": path, "source": src, "payload": payload},
                                  timeout=settings["call_timeout_s"])
            if not r["ok"]:
                return r
            return ok({"path": path, "source": src, "items": len(payload.get("items") or [])})
        return await run_tool(ctx, "set_annotations", handler, write=True)

    add(set_annotations, "set_annotations",
        "Store one plugin's overlay for one photo (payload v1: image size, items of point/circle/lines, optional "
        "groups, metrics and score range; at most 2 MB). Replaces that source's earlier overlay; the photo page draws "
        "it live. An add-on's source is always its own id.")

    async def clear_annotations(ctx: Context, path: Path, source: Source = None) -> CallToolResult:
        async def handler(grant, resolved, settings):
            src, refusal = _source(resolved, source)
            if refusal is not None:
                return refusal
            r = await client.call(grant, "annotations.clear", query={"path": path, "source": src},
                                  timeout=settings["call_timeout_s"])
            if not r["ok"]:
                return r
            return ok({"path": path, "source": src, "removed": bool((r["data"] or {}).get("removed"))})
        return await run_tool(ctx, "clear_annotations", handler, write=True)

    add(clear_annotations, "clear_annotations",
        "Remove one plugin's overlay from one photo (`removed: false` when there was none). An add-on's source is "
        "always its own id.")
