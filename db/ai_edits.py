"""AI edits: files an AI tool made from a library photo, linked to their original.

Rows live in ``photo_ai_edits`` (see ``db/schema.py``), written by
``POST /api/photo/ai_edits/import``. The viewer marks an edit with ✨ and offers
its original beside it; nothing in scoring, grouping or export reads the table.
"""

import ntpath
import posixpath
import re
import sqlite3

# Enough for one page of the gallery; a longer list is read in chunks.
_IN_CHUNK = 500


def _path_module(path: str):
    """``ntpath`` for a Windows or UNC path, else ``posixpath``: the stored path's own flavour,
    so a library scanned on Windows keeps its separators whatever host reads it."""
    return ntpath if ('\\' in path or re.match(r'^[A-Za-z]:', path)) else posixpath


def edit_file_name(original_path: str, suffix: str, revision: int, source_ext: str) -> str:
    """``{stem}_{suffix}_{revision}{ext}`` for an edit of ``original_path``.

    The extension is the edit's own (a PNG stays a PNG), spelled like the
    original's when the two match ignoring case, so ``IMG_1.JPG`` gets ``IMG_1_agy_1.JPG``.
    """
    mod = _path_module(original_path)
    stem, original_ext = mod.splitext(mod.basename(original_path))
    ext = original_ext if original_ext.lower() == source_ext.lower() else source_ext
    return f'{stem}_{suffix}_{revision}{ext}'


def next_revision(original_path: str, suffixes, names_in_folder, recorded_revisions) -> int:
    """One past the highest revision already used for this original, across every tool.

    Revisions are shared by all tools (``suffixes``: every configured tool suffix), so the
    number orders an original's edits: after ``IMG_1_agy_2``, a ChatGPT edit is ``IMG_1_gpt_3``.
    Counts both the files beside the original (an edit placed by hand counts too) and the
    recorded rows (an edit whose file was since moved still holds its number), so a live
    edit's number is never taken. A deleted edit leaves neither, so its number can come back;
    ``apply_ai_edit_captions`` gives the new edit a fresh ``preview_revision`` so a cached
    thumbnail of the old one is never shown under its name.
    """
    mod = _path_module(original_path)
    stem = mod.splitext(mod.basename(original_path))[0]
    tags = '|'.join(re.escape(s) for s in suffixes)
    if not tags:
        return max((int(r) for r in recorded_revisions), default=0) + 1
    pattern = re.compile(rf'^{re.escape(stem)}_(?:{tags})_(\d+)\.[^.]+$', re.IGNORECASE)
    used = [int(m.group(1)) for name in names_in_folder if (m := pattern.match(name))]
    used.extend(int(r) for r in recorded_revisions)
    return max(used, default=0) + 1


async def attach_ai_edit_sources_async(conn, photos: list[dict]) -> None:
    """Set ``ai_edit_of`` (the original's path) on each photo that is a recorded AI edit."""
    paths = [p['path'] for p in photos]
    found: dict[str, str] = {}
    for start in range(0, len(paths), _IN_CHUNK):
        chunk = paths[start:start + _IN_CHUNK]
        try:
            cur = await conn.execute(
                'SELECT edit_path, source_path FROM photo_ai_edits WHERE edit_path IN ('
                + ','.join('?' for _ in chunk) + ')', chunk)
        except sqlite3.OperationalError:
            # A database not yet upgraded has no table: no photo is an edit.
            return
        for row in await cur.fetchall():
            found[row[0]] = row[1]
        await cur.close()
    for photo in photos:
        if photo['path'] in found:
            photo['ai_edit_of'] = found[photo['path']]



def apply_ai_edit_captions(conn) -> int:
    """Caption each newly scanned AI edit: the original's caption, then "AI: <note>".

    Runs after a scan has saved its rows (a plain UPDATE, so the FTS update trigger
    keeps the search index in step). Each edit is captioned once (``captioned``); an
    edit without a note is only marked. Returns how many captions were written.

    Each newly scanned edit also gets a fresh ``preview_revision``. Its file name can
    repeat one used before (delete ``IMG_1_agy_2``, import again, and the new edit is
    ``IMG_1_agy_2`` too), and clients cache thumbnails by path plus that revision, so
    without it a browser would keep showing the deleted edit's picture.
    Does not commit."""
    try:
        rows = conn.execute(
            "SELECT e.edit_path, e.note, o.caption FROM photo_ai_edits e "
            "JOIN photos p ON p.path = e.edit_path LEFT JOIN photos o ON o.path = e.source_path "
            "WHERE e.captioned = 0").fetchall()
    except sqlite3.OperationalError:
        # A database not yet upgraded has no table or column: nothing to caption.
        return 0
    written = 0
    for edit_path, note, original_caption in rows:
        note = ' '.join((note or '').split())
        if note:
            base = (original_caption or '').strip().rstrip('.')
            caption = f'{base}. AI: {note}' if base else f'AI: {note}'
            conn.execute('UPDATE photos SET caption = ?, caption_translated = NULL WHERE path = ?',
                         (caption, edit_path))
            written += 1
        conn.execute('UPDATE photos SET preview_revision = lower(hex(randomblob(16))) WHERE path = ?',
                     (edit_path,))
        conn.execute('UPDATE photo_ai_edits SET captioned = 1 WHERE edit_path = ?', (edit_path,))
    return written
