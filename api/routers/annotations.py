"""Plugin-written photo annotations: one overlay payload per photo and source.

A plugin (a plate solver, for example) writes one JSON payload per photo
and source into the ``photo_annotations`` side table through
``db.annotations.upsert_annotation``, in-process, or through ``PUT`` (which the
MCP ``set_annotations`` tool calls).
Reads follow photo visibility; writing or removing a source's overlay is
edition-gated like every other write.
"""

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from api.auth import CurrentUser, require_authenticated, require_edition
from api.database import get_async_db, get_db
from api.db_helpers import get_visibility_clause, retry_on_locked
from api.models.annotations import (PhotoAnnotation, PhotoAnnotationDelete, PhotoAnnotationPut,
                                    PhotoAnnotationSaved, PhotoAnnotationsResponse)
from api.routers.faces import _require_writable_photo
from db.annotations import PAYLOAD_VERSION, AnnotationError, delete_annotation, upsert_annotation

logger = logging.getLogger(__name__)

router = APIRouter(tags=['photo annotations'])


def _parse(source: str, text: str) -> PhotoAnnotation | None:
    """The stored payload as an object, or None for a row the viewer cannot draw."""
    try:
        payload = json.loads(text)
    except (TypeError, ValueError):
        logger.warning("photo_annotations: unreadable payload from source %r", source)
        return None
    if not isinstance(payload, dict) or payload.get('version') != PAYLOAD_VERSION:
        return None
    return PhotoAnnotation(source=source, payload=payload)


@router.get('/api/photo/annotations', response_model=PhotoAnnotationsResponse)
async def list_photo_annotations(path: str, source: Optional[str] = Query(None, max_length=64),
                                 user: CurrentUser = Depends(require_authenticated)):
    """Every source's annotations for one photo (or ``source``'s only); empty for a photo the caller cannot see."""
    vis_sql, vis_params = get_visibility_clause(user.user_id if user else None)
    async with get_async_db() as conn:
        cur = await conn.execute(f'SELECT 1 FROM photos WHERE path = ? AND {vis_sql}', [path, *vis_params])
        visible = await cur.fetchone()
        await cur.close()
        if not visible:
            return {'annotations': []}
        cur = await conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'photo_annotations'")
        has_table = await cur.fetchone()
        await cur.close()
        if not has_table:
            return {'annotations': []}
        sql = 'SELECT source, payload FROM photo_annotations WHERE photo_path = ?'
        params = [path]
        if source is not None:
            sql += ' AND source = ?'
            params.append(source)
        cur = await conn.execute(sql + ' ORDER BY source', params)
        rows = await cur.fetchall()
        await cur.close()
    parsed = (_parse(r['source'], r['payload']) for r in rows)
    return {'annotations': [a for a in parsed if a is not None]}


@router.delete('/api/photo/annotations', response_model=PhotoAnnotationDelete)
@retry_on_locked()
def delete_photo_annotation(path: str, source: str, user: CurrentUser = Depends(require_edition)):
    """Remove one source's annotations from a photo (the plugin can write them again)."""
    with get_db() as conn:
        _require_writable_photo(conn, user, path)
        removed = delete_annotation(conn, path, source)
        conn.commit()
    return {'success': True, 'removed': removed}


@router.put('/api/photo/annotations', response_model=PhotoAnnotationSaved)
@retry_on_locked()
def put_photo_annotation(body: PhotoAnnotationPut, user: CurrentUser = Depends(require_edition)):
    """Store (or replace) one source's annotations for a photo; 422 on a payload that fails validation."""
    with get_db() as conn:
        _require_writable_photo(conn, user, body.path)
        try:
            upsert_annotation(conn, body.path, body.source, body.payload)
        except AnnotationError as ex:
            raise HTTPException(status_code=422, detail=str(ex)) from None
        except LookupError as ex:
            raise HTTPException(status_code=404, detail=str(ex)) from None
        conn.commit()
    return {'success': True}
