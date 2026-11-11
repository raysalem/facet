"""The after-import hook: ``addon_runs`` (intent) and the ``scan_run`` photo scope.

A scan started with ``after_addon`` records one ``addon_runs`` row keyed by the viewer job id, which
the scanner already writes into ``scan_runs.viewer_job_id``; the scanner itself learns nothing about
add-ons and no ``photos`` column is added. Nothing is started when the scan finishes: the client's
scan-status poll offers "Open X for N photos?", and the Add-ons page lists runs not yet opened.

``scan_run`` (on ``GET /api/photos``) names a run by ``scan_runs.id`` or by viewer job id. It selects the
photos that run fully (re)saved: ``scanned_at`` within the run's ``started_at .. COALESCE(finished_at,
now)`` window and under one of the directories in its ``args_json``. A restricted pass does not
re-stamp ``scanned_at``, so it does not re-mark photos.
"""

import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException

JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
RUN_ID_RE = re.compile(r"^[0-9]{1,18}$")
_PATH = "REPLACE(photos.path, char(92), '/')"
_DIR = "rtrim(REPLACE(d.value, char(92), '/'), '/')"


def _run_match(value: str) -> Optional[tuple[str, list]]:
    if RUN_ID_RE.fullmatch(value):
        return "r.id = ?", [int(value)]
    if JOB_ID_RE.fullmatch(value):
        return "r.viewer_job_id = ?", [value]
    return None


def scan_run_clause(value: object) -> tuple[str, list]:
    """The WHERE fragment for ``scan_run=<id or job id>`` on ``photos``; an invalid value matches nothing."""
    match = _run_match(value) if isinstance(value, str) else None
    if match is None:
        return "0=1", []
    run_sql, run_params = match
    # The window bounds are sargable on idx_scanned_at; the EXISTS then checks run and directory.
    sql = (
        f"photos.scanned_at >= (SELECT MIN(r.started_at) FROM scan_runs r WHERE {run_sql}) AND "
        f"EXISTS (SELECT 1 FROM scan_runs r, json_each(CASE WHEN json_valid(r.args_json) THEN r.args_json "
        f"ELSE '{{}}' END, '$.directories') d WHERE {run_sql} "
        f"AND photos.scanned_at BETWEEN r.started_at AND COALESCE(r.finished_at, datetime('now')) "
        f"AND typeof(d.value) = 'text' "
        f"AND ({_PATH} = {_DIR} OR substr({_PATH}, 1, length({_DIR}) + 1) = {_DIR} || '/'))"
    )
    return sql, [*run_params, *run_params]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def validate_after_addon(addon_id: Optional[str]) -> Optional[str]:
    """``after_addon`` of a scan start: None, or an enabled add-on that declares ``import_hook``."""
    if addon_id is None or addon_id == "":
        return None
    from api.addons import manifest
    addon = manifest.get(addon_id) if manifest.addons_enabled() else None
    if addon is None or "import_hook" not in addon.slots:
        raise HTTPException(status_code=400, detail="after_addon is not an enabled add-on with an import hook")
    return addon.id


def record_request(job_id: str, addon_id: str, requested_by: Optional[str]) -> None:
    from api.database import get_db
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO addon_runs (viewer_job_id, addon_id, requested_by, requested_at, opened_at) "
            "VALUES (?, ?, ?, ?, NULL)", (job_id, addon_id, requested_by, _now()))
        conn.commit()


def is_run_of(addon_id: str, job_id: str) -> bool:
    if not isinstance(job_id, str) or not JOB_ID_RE.fullmatch(job_id):
        return False
    from api.database import get_db
    with get_db() as conn:
        return conn.execute("SELECT 1 FROM addon_runs WHERE viewer_job_id = ? AND addon_id = ?",
                            (job_id, addon_id)).fetchone() is not None


def mark_opened(addon_id: str, job_id: str) -> None:
    from api.database import get_db
    with get_db() as conn:
        conn.execute("UPDATE addon_runs SET opened_at = COALESCE(opened_at, ?) WHERE viewer_job_id = ? AND addon_id = ?",
                     (_now(), job_id, addon_id))
        conn.commit()


def photo_count(conn, job_id: str) -> int:
    sql, params = scan_run_clause(job_id)
    return conn.execute(f"SELECT COUNT(*) FROM photos WHERE {sql}", params).fetchone()[0]


def describe(conn, row) -> dict:
    """One ``addon_runs`` row joined to its latest ``scan_runs`` row, with the photo count."""
    scan = conn.execute(
        "SELECT id, status, job_status, started_at, finished_at FROM scan_runs WHERE viewer_job_id = ? "
        "ORDER BY id DESC LIMIT 1", (row["viewer_job_id"],)).fetchone()
    return {
        "job_id": row["viewer_job_id"], "addon_id": row["addon_id"],
        "requested_at": row["requested_at"], "opened_at": row["opened_at"],
        "run_id": scan["id"] if scan else None,
        "status": (scan["job_status"] or scan["status"]) if scan else None,
        "started_at": scan["started_at"] if scan else None,
        "finished_at": scan["finished_at"] if scan else None,
        "photo_count": photo_count(conn, row["viewer_job_id"]) if scan else 0,
    }


def get_run(job_id: str) -> Optional[dict]:
    if not JOB_ID_RE.fullmatch(job_id or ""):
        return None
    from api.database import get_db
    with get_db() as conn:
        row = conn.execute("SELECT * FROM addon_runs WHERE viewer_job_id = ?", (job_id,)).fetchone()
        return describe(conn, row) if row else None


def pending_runs(limit: int = 20) -> list[dict]:
    """Requested runs not opened yet, newest first, for the Add-ons page."""
    from api.addons import manifest
    from api.database import get_db
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM addon_runs WHERE opened_at IS NULL ORDER BY requested_at DESC LIMIT ?",
                            (limit,)).fetchall()
        return [describe(conn, r) for r in rows if manifest.get(r["addon_id"]) is not None]
