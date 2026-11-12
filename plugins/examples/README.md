# Facet Plugin Examples

Runnable plugin reference implementations. Copy a file into the project's
top-level `plugins/` directory (drop the `.example` suffix) and enable
plugins in `scoring_config.json`:

```json
"plugins": {
  "enabled": true,
  "webhooks": [],
  "actions": {}
}
```

## Available examples

| File | Trigger | What it does |
|------|---------|--------------|
| `slack_webhook.py.example` | `on_high_score` | Posts a one-line Slack message (via a Slack incoming-webhook URL) when a photo scores above the threshold. |
| `copy_to_folder.py.example` | `on_high_score` | Hard-links (or copies, across filesystems) each photo above the threshold into a destination folder, preserving its directory structure. |
| `score_publisher.py.example` | `on_score_complete` | Writes each finished score as a JSON line to a rolling log file (works with `tail -F` or a log shipper). |

## Photo annotations

A plugin that knows *what is where* in a photo (a plate solve's stars and planets,
a detector's labelled regions) can store it as an overlay the photo page draws
and filters live. Compute it once; the viewer never calls the plugin again when
the user moves a slider.

```python
import sqlite3
from db.annotations import AnnotationError, upsert_annotation  # stdlib only

payload = {
    "version": 1, "source": "astro-id", "title": "Sky annotations",
    "image": {"width": 6000, "height": 4000},      # pixel frame of the coordinates below
    "legend": "ASTAP grade A · 2452 stars",
    "groups": [{"id": "planet", "label": "Planets", "default": True},
               {"id": "star", "label": "Stars", "default": False}],
    "metrics": [{"key": "mag", "label": "Max magnitude", "min": -5, "max": 8,
                 "step": 0.5, "default": 6, "direction": "max"}],
    "score": {"label": "Confidence", "min": 0, "max": 100, "default": 65},
    "items": [
        {"id": "uranus", "label": "Uranus", "group": "planet", "score": 100,
         "shape": "point", "x": 5123.4, "y": 2210.8, "r": 18, "values": {"mag": 5.6}},
        {"id": "orion", "label": "Orion", "group": "planet", "score": 100,
         "shape": "lines", "segments": [[[10, 20], [30, 40]]], "label_at": [20, 30]},
    ],
}
with sqlite3.connect(db_path) as conn:        # Facet's photo_scores_pro.db
    upsert_annotation(conn, photo_path, "astro-id", payload)
```

- `photo_path` must be a photo already in the library (`LookupError` otherwise);
  `source` is your plugin's id (lowercase letters, digits, `.`, `_`, `-`).
  Writing again replaces your earlier row for that photo; other plugins' rows
  are untouched. `delete_annotation(conn, photo_path, source)` removes it.
- Coordinates are pixels of `image` (origin top-left), and `image` must have the
  same aspect ratio as the photo as Facet displays it (upright, after EXIF
  rotation), since the overlay is scaled onto the displayed frame.
- `shape` is `point` (`x`, `y`, optional `r`), `circle` (`x`, `y`, `r`) or `lines`
  (`segments` of two `[x, y]` points, optional `label_at`). `member_of` names the
  item a part belongs to (hidden while that item shows, unless the user turns on
  **Show members**).
- The viewer shows an item when its group is on, its `score` is at least the
  score slider and, for each metric, `values[key]` is at most (`direction: "max"`)
  or at least (`"min"`) its slider. An item without a value is not filtered by it.
- `upsert_annotation` validates the payload (`AnnotationError`: `version` must be
  1, the shapes need their coordinates, the JSON at most 2 MB) and does not
  commit; `with conn:` does. Unknown fields are kept and ignored.

## Webhook payload shape

Outgoing HTTP webhooks (configured under `plugins.webhooks` in
`scoring_config.json`) POST a JSON body of the form:

```json
{
  "event": "on_high_score",
  "data": {
    "path": "/photos/2026/01/IMG_1234.cr3",
    "aggregate": 9.4,
    "aesthetic": 8.9,
    "comp_score": 9.1,
    "category": "portrait",
    "tags": ["portrait", "golden_hour"]
  }
}
```

`event` is one of:

* `on_score_complete` — every photo, once scoring finishes
* `on_new_photo` — first time a photo is added to the DB
* `on_burst_detected` — when a burst group is identified
* `on_high_score` — only when `aggregate` clears `plugins.high_score_threshold`
  (default 8.0). A per-webhook `min_score` (default 0.0) can filter further.

A formal JSON Schema for the payload lives in
`plugins/examples/webhook_payload.schema.json` if you want to validate
incoming requests on the receiving side.

## Security notes

* Webhook URLs are validated on delivery (and by the test endpoint).
  Only `http`/`https` are allowed; hostnames that resolve to a private,
  loopback, or link-local address (including the cloud metadata IP
  `169.254.169.254`) are rejected and logged.

* The request connects to the resolved IP with the original hostname in
  the `Host` header, so a DNS-rebinding swap cannot redirect a validated
  URL to a private address mid-flight.

* Delivery is best-effort: a 5xx, timeout, or transport error is logged
  but not retried. For at-least-once delivery, queue and retry on the
  receiving side.

* Outbound timeout is 10 seconds.
