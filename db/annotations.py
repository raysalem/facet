"""Plugin-written photo annotations (``photo_annotations``): validation and writes.

A plugin computes an overlay once (a plate solve's stars, planets and
constellation lines, for example) and stores it here as one JSON payload per
``(photo, source)``: everything a viewer needs to draw it and filter it
(groups, score, metric limits) without recomputing anything.

Stdlib-only on purpose, like :mod:`db.manual_tags`: an external plugin imports
it with nothing but Facet's ``db`` package on ``sys.path``::

    import sqlite3
    from db.annotations import upsert_annotation

    with sqlite3.connect(db_path) as conn:
        upsert_annotation(conn, photo_path, 'sky-labels', payload)

The table is a side table, never a ``photos`` column: ``photos`` is rewritten on
rescan, this is not. Rows follow their photo through a delete or a path move
(foreign key plus triggers, see ``db.schema``).

Payload v1 (``plugins/examples/README.md``, section Photo annotations, is the plugin-facing spec)::

    {"version": 1, "source": "sky-labels", "title": "...",
     "image": {"width": W, "height": H},          # pixel frame of the coordinates
     "legend": "...",                               # one line shown under the controls
     "groups": [{"id", "label", "default"}],
     "metrics": [{"key", "label", "min", "max", "step", "default", "direction": "max"}],
     "score": {"label", "min", "max", "default"},
     "items": [{"id", "label", "group", "score", "shape": "point|circle|lines",
                "x", "y", "r", "segments", "label_at", "values", "member_of"}]}

Only the fields a viewer cannot draw without are checked here, plus what would
make a drawing ambiguous (duplicate item ids, an empty range); unknown fields
are kept.
"""

import json
import math
import re

PAYLOAD_VERSION = 1
# A sky full of labelled stars is a few hundred kilobytes; the cap keeps one
# photo's row from growing without bound and the GET response small.
MAX_PAYLOAD_BYTES = 512 * 1024
MAX_ITEMS = 5000
SHAPES = ('point', 'circle', 'lines')
# A source names the plugin that wrote the row: lowercase letters, digits, '-', '_', '.'.
_SOURCE_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{0,63}$')


class AnnotationError(ValueError):
    """A payload or source that cannot be stored; the message is safe to show."""


def _number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:  # an int too large for a float (JSON integers are unbounded)
        return False


def _range(value):
    """``{min, max}`` (and ``step`` when present): numbers, ``min <= max``, ``step > 0``."""
    if not (isinstance(value, dict) and _number(value.get('min')) and _number(value.get('max'))
            and value['min'] <= value['max']):
        return False
    return 'step' not in value or (_number(value['step']) and value['step'] > 0)


def _point(value):
    return isinstance(value, (list, tuple)) and len(value) == 2 and all(_number(v) for v in value)


def validate_source(source):
    """Return ``source`` or raise :class:`AnnotationError`."""
    if not isinstance(source, str) or not _SOURCE_RE.match(source):
        raise AnnotationError(
            "source must be 1-64 characters: lowercase letters, digits, '.', '_' or '-'")
    return source


def _validate_item(index, item):
    where = f"items[{index}]"
    if not isinstance(item, dict):
        raise AnnotationError(f"{where} must be an object")
    for key in ('id', 'label', 'group'):
        if not isinstance(item.get(key), str) or not item[key]:
            raise AnnotationError(f"{where}.{key} must be a non-empty string")
    if 'score' in item and not _number(item['score']):
        raise AnnotationError(f"{where}.score must be a number")
    shape = item.get('shape')
    if shape not in SHAPES:
        raise AnnotationError(f"{where}.shape must be one of {', '.join(SHAPES)}")
    if shape in ('point', 'circle'):
        if not (_number(item.get('x')) and _number(item.get('y'))):
            raise AnnotationError(f"{where} needs numeric x and y")
        if shape == 'circle' and not (_number(item.get('r')) and item['r'] > 0):
            raise AnnotationError(f"{where}: a circle needs a positive r")
        if shape == 'point' and 'r' in item and not (_number(item['r']) and item['r'] > 0):
            raise AnnotationError(f"{where}.r must be a positive number")
    else:
        segments = item.get('segments')
        if not isinstance(segments, list) or not segments or not all(
                isinstance(seg, (list, tuple)) and len(seg) == 2 and all(_point(p) for p in seg)
                for seg in segments):
            raise AnnotationError(f"{where}.segments must be a non-empty list of [[x, y], [x, y]]")
        if 'label_at' in item and not _point(item['label_at']):
            raise AnnotationError(f"{where}.label_at must be [x, y]")
    values = item.get('values')
    if values is not None and (not isinstance(values, dict)
                               or not all(_number(v) for v in values.values())):
        raise AnnotationError(f"{where}.values must map keys to numbers")


def validate_payload(payload):
    """Check a payload and return it as compact JSON text; raise :class:`AnnotationError`.

    ``payload`` may be a dict or its JSON text.
    """
    if isinstance(payload, (str, bytes)):
        try:
            payload = json.loads(payload)
        except ValueError as ex:
            raise AnnotationError(f"payload is not valid JSON: {ex}") from None
    if not isinstance(payload, dict):
        raise AnnotationError("payload must be a JSON object")
    if payload.get('version') != PAYLOAD_VERSION:
        raise AnnotationError(f"payload version must be {PAYLOAD_VERSION}")
    image = payload.get('image')
    if not (isinstance(image, dict) and _number(image.get('width')) and _number(image.get('height'))
            and image['width'] > 0 and image['height'] > 0):
        raise AnnotationError("payload.image needs a positive width and height")
    items = payload.get('items')
    if not isinstance(items, list):
        raise AnnotationError("payload.items must be a list")
    if len(items) > MAX_ITEMS:
        raise AnnotationError(f"payload has more than {MAX_ITEMS} items")
    for key in ('groups', 'metrics'):
        if key in payload and not isinstance(payload[key], list):
            raise AnnotationError(f"payload.{key} must be a list")
    for i, group in enumerate(payload.get('groups') or []):
        if not (isinstance(group, dict) and isinstance(group.get('id'), str)):
            raise AnnotationError(f"groups[{i}] needs a string id")
    for i, metric in enumerate(payload.get('metrics') or []):
        if not (isinstance(metric, dict) and isinstance(metric.get('key'), str)
                and _range(metric)):
            raise AnnotationError(f"metrics[{i}] needs a string key, numeric min <= max and a positive step")
    if 'score' in payload and not _range(payload['score']):
        raise AnnotationError("payload.score needs numeric min <= max")
    seen = set()
    for i, item in enumerate(items):
        _validate_item(i, item)
        if item['id'] in seen:
            raise AnnotationError(f"items[{i}].id {item['id']!r} is used twice")
        seen.add(item['id'])
    try:
        text = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    except ValueError as ex:
        raise AnnotationError(f"payload is not serialisable: {ex}") from None
    if len(text.encode('utf-8')) > MAX_PAYLOAD_BYTES:
        raise AnnotationError(f"payload exceeds {MAX_PAYLOAD_BYTES // 1024} KB")
    return text


def upsert_annotation(conn, photo_path, source, payload):
    """Store (or replace) ``source``'s annotations for one photo.

    Validates ``source`` and ``payload`` first (:class:`AnnotationError` on a bad
    one) and refuses a path that is not a photo in the library (``LookupError``).
    Replaces any earlier row of the same source and stamps ``created_at`` now.
    Does not commit: the caller owns the transaction (``with conn:`` commits).
    """
    validate_source(source)
    text = validate_payload(payload)
    if conn.execute('SELECT 1 FROM photos WHERE path = ?', (photo_path,)).fetchone() is None:
        raise LookupError(f"not a photo in this library: {photo_path}")
    conn.execute(
        "INSERT INTO photo_annotations (photo_path, source, payload, created_at) "
        "VALUES (?, ?, ?, datetime('now')) "
        "ON CONFLICT(photo_path, source) DO UPDATE SET "
        "payload = excluded.payload, created_at = excluded.created_at",
        (photo_path, source, text))


def delete_annotation(conn, photo_path, source):
    """Delete one source's annotations for a photo; True when a row was removed."""
    cursor = conn.execute(
        'DELETE FROM photo_annotations WHERE photo_path = ? AND source = ?', (photo_path, source))
    return cursor.rowcount > 0


def list_annotations(conn, photo_path):
    """``[(source, payload_text)]`` for one photo, ordered by source. No visibility check."""
    return [tuple(row) for row in conn.execute(
        'SELECT source, payload FROM photo_annotations WHERE photo_path = ? ORDER BY source',
        (photo_path,))]
