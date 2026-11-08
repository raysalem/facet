"""Album tags: manual tags marked as organisation (event, part, photographer).

A manual tag is either *content* (what the photo shows, listed with the AI tags
on the photo page) or an *album tag* (how the photos are organised: the event,
its parts, who shot them). The photo rows stay in ``photo_manual_tags`` either
way, so the gallery's tag filter, sidecar export and keyword import are
unchanged; the ``album_tags`` registry only decides where a tag is shown:

- the photo page leaves album tags out of its tag list (``Photo.album_tags``);
- an album lists them in two filter pull-downs, Set and Photographer, with counts
  (``GET /api/album_tags/facets``; chosen through the gallery's ``album_tags``);
- the gallery's tag picker lists them as their own group (``GET /api/album_tags``)
  instead of competing with AI tags for its top-N slots.

Marking is per tag and library-wide: the kind belongs to the tag, not to one
photo's copy of it.
"""

import logging
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ValidationError

from api.auth import CurrentUser, get_optional_user, require_edition
from api.config import is_multi_user_enabled
from api.database import get_async_db, get_db
from api.db_helpers import (
    after_commit, get_visibility_clause, is_album_tags_available, is_locked_error,
    retry_on_locked,
)
from db.manual_tags import ManualTagError, normalize_manual_tag

logger = logging.getLogger(__name__)

router = APIRouter(tags=["album_tags"])

# Cap on the chips one album shows; an album with more distinct album tags than
# this is mis-tagged, and the chip row would be unusable anyway.
_FACETS_MAX = 200


class AlbumTagRequest(BaseModel):
    """One tag to mark or unmark. Normalized server-side (422 when invalid)."""

    tag: str


class AlbumTagResponse(BaseModel):
    success: bool
    tag: str
    changed: bool


class AlbumTagCount(BaseModel):
    tag: str
    count: int


class AlbumTagListResponse(BaseModel):
    tags: list[AlbumTagCount]


def _normalized(tag):
    try:
        return normalize_manual_tag(tag)
    except ManualTagError as ex:
        raise HTTPException(status_code=422, detail=str(ex)) from None


def _drop_tag_caches(conn):
    """The tag dropdown leaves album tags out, so a (un)mark changes it."""
    conn.execute("DELETE FROM stats_cache WHERE key = 'tags'")


def _write(tag, user, mark):
    tag = _normalized(tag)
    with get_db() as conn:
        if not is_album_tags_available(conn):
            raise HTTPException(status_code=503, detail="album tags need a schema upgrade")
        try:
            if mark:
                cursor = conn.execute(
                    "INSERT OR IGNORE INTO album_tags (tag, created_by) VALUES (?, ?)",
                    (tag, user.user_id if user and is_multi_user_enabled() else None),
                )
            else:
                cursor = conn.execute("DELETE FROM album_tags WHERE tag = ?", (tag,))
            changed = cursor.rowcount > 0
            if changed:
                _drop_tag_caches(conn)
            conn.commit()
        except sqlite3.Error as ex:
            conn.rollback()
            if is_locked_error(ex):
                raise
            logger.exception("Database error writing album tag")
            raise HTTPException(status_code=500, detail='Internal server error')
    if changed:
        after_commit()
    return {"success": True, "tag": tag, "changed": changed}


@router.put("/api/album_tags", response_model=AlbumTagResponse)
@retry_on_locked()
def api_mark_album_tag(body: AlbumTagRequest, user: CurrentUser = Depends(require_edition)):
    """Mark a tag as an album tag (organisation, not content). Idempotent."""
    return _write(body.tag, user, mark=True)


@router.delete("/api/album_tags", response_model=AlbumTagResponse)
@retry_on_locked()
def api_unmark_album_tag(body: AlbumTagRequest, user: CurrentUser = Depends(require_edition)):
    """Turn an album tag back into an ordinary (content) tag. The photo rows are kept."""
    return _write(body.tag, user, mark=False)


@router.get("/api/album_tags", response_model=AlbumTagListResponse)
async def api_list_album_tags(user: Optional[CurrentUser] = Depends(get_optional_user)):
    """Every album tag with the number of photos the caller can see that carry it.

    A marked tag no photo carries any longer is still listed (count 0), so it can
    be unmarked. Sorted by tag, which groups ``person/event/part`` paths.
    """
    user_id = user.user_id if user else None
    vis_sql, vis_params = get_visibility_clause(user_id)
    async with get_async_db() as conn:
        if not is_album_tags_available():
            return {"tags": []}
        cur = await conn.execute(
            "SELECT a.tag, (SELECT COUNT(*) FROM photo_manual_tags m "
            "JOIN photos ON photos.path = m.photo_path "
            f"WHERE m.tag = a.tag AND {vis_sql}) FROM album_tags a ORDER BY a.tag",
            vis_params,
        )
        rows = await cur.fetchall()
        await cur.close()
    return {"tags": [{"tag": t, "count": n} for t, n in rows]}


@router.get("/api/album_tags/facets", response_model=AlbumTagListResponse)
async def api_album_tag_facets(
    request: Request,
    user: Optional[CurrentUser] = Depends(get_optional_user),
):
    """Album tags inside one gallery view, with how many of its photos carry each.

    Takes the gallery's own query string (album, folder, hide toggles...), so a
    pull-down option's count is what choosing it shows. An ``album_tags`` parameter
    is ignored: every set and photographer stays listed while one is chosen. A tag every
    photo of the view carries (the event itself) is still returned; the client
    decides whether to show it.
    """
    from api.routers.gallery import _raise_422_for_invalid_gallery_params, gallery_scope_sql_async

    qp = {k: v for k, v in request.query_params.items() if k != 'album_tags'}
    try:
        async with get_async_db() as conn:
            if not is_album_tags_available():
                return {"tags": []}
            user_id = user.user_id if user else None
            from_clause, where_str, params = await gallery_scope_sql_async(conn, qp, user_id)
            cur = await conn.execute(
                "SELECT m.tag, COUNT(*) FROM photo_manual_tags m "
                "JOIN album_tags a ON a.tag = m.tag "
                f"WHERE m.photo_path IN (SELECT photos.path FROM {from_clause}{where_str}) "
                "GROUP BY m.tag ORDER BY m.tag LIMIT ?",
                params + [_FACETS_MAX],
            )
            rows = await cur.fetchall()
            await cur.close()
    except ValidationError as e:
        _raise_422_for_invalid_gallery_params(e, logger, "Album tag facet parameter validation failed: %s")
    except sqlite3.Error:
        logger.exception("Failed to count album tags for the gallery view")
        raise HTTPException(status_code=500, detail='Internal server error')
    return {"tags": [{"tag": t, "count": n} for t, n in rows]}
