"""Photo annotation tools: read, store and remove a plugin's overlay for one photo.

``get_annotations`` reads the overlays stored for one photo, as a summary without geometry unless
the caller asks for the payloads (``summary: false``); ``set_annotations`` and ``clear_annotations``
write one source's.
The caller names the source: the plugin id the overlay belongs to.
"""

from typing import Annotated, Any, Optional

from mcp.server.mcpserver import Context, MCPServer
from mcp.types import CallToolResult
from pydantic import Field

from api.agent.internal_client import InternalClient, err, ok
from api.agent.runtime import run_tool
from api.agent.tools_common import READ_ANNOTATIONS, WRITE_ANNOTATIONS, register_tool
from api.agent.tools_write import WRITE_TOOL_LEVELS
from db.annotations import MAX_PAYLOAD_BYTES

Path = Annotated[str, Field(min_length=1, max_length=4096)]
Source = Annotated[Optional[str], Field(min_length=1, max_length=64)]


def _source(resolved: Any, source: Optional[str]) -> tuple[Optional[str], Optional[dict]]:
    """The source to write, or a refusal when none is given."""
    if not source:
        return None, err("invalid_input", "Pass source: the plugin id the overlay belongs to")
    return source, None


def _summary(annotation: dict) -> dict:
    """One overlay without geometry: its source, title, legend, frame, ranges and item counts per group."""
    payload = annotation.get("payload") or {}
    items = payload.get("items") or []
    counts: dict[Any, int] = {}
    for item in items:
        group = item.get("group")
        counts[group] = counts.get(group, 0) + 1
    groups = [{**{k: g.get(k) for k in ("id", "label", "default") if k in g}, "count": counts.get(g.get("id"), 0)}
              for g in payload.get("groups") or [] if isinstance(g, dict)]
    return {"source": annotation.get("source"), "version": payload.get("version"), "title": payload.get("title"),
            "legend": payload.get("legend"), "image": payload.get("image"), "groups": groups,
            "metrics": payload.get("metrics") or [], "score": payload.get("score"), "items": len(items)}


def register_annotation_tools(server: MCPServer, client: InternalClient) -> None:
    def add(fn, name: str, description: str, read_only: bool = False) -> None:
        register_tool(server, fn, name, description, READ_ANNOTATIONS if read_only else WRITE_ANNOTATIONS,
                      WRITE_TOOL_LEVELS[name])

    async def get_annotations(ctx: Context, path: Path, source: Source = None,
                              summary: bool = True) -> CallToolResult:
        async def handler(grant, resolved, settings):
            query = {"path": path, **({"source": source} if source is not None else {})}
            r = await client.call(grant, "annotations.get", query=query, timeout=settings["call_timeout_s"])
            if not r["ok"]:
                return r
            annotations = (r["data"] or {}).get("annotations") or []
            if summary:
                return ok({"path": path, "summary": [_summary(a) for a in annotations]})
            return ok({"path": path, "annotations": annotations})
        return await run_tool(ctx, "get_annotations", handler)

    add(get_annotations, "get_annotations",
        "The plugin overlays stored for one photo, every source unless `source` names one. By default a summary "
        "with no geometry, small enough for any overlay: `summary: [{source, version, title, legend, image, groups "
        "(with item counts), metrics, score, items}]`. `summary: false` answers `annotations: [{source, payload}]` "
        f"instead (payload v1, see docs/API.md; up to {MAX_PAYLOAD_BYTES // 1024} KB per source, so name the "
        "`source`). Empty for a photo the caller cannot see.", read_only=True)

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
        f"groups, metrics and score range; at most {MAX_PAYLOAD_BYTES // 1024} KB). Replaces that source's earlier "
        "overlay. `source` is the plugin id and is required.")

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
        "Remove one plugin's overlay from one photo (`removed: false` when there was none). `source` is required.")
