"""Temporary diagnostic plugin for the B16 repro (Windows CI: "no such table: photos").

Loaded with ``-p b16probe``. In every xdist worker it:
  * logs any os.remove/unlink/replace/rename or shutil.rmtree that touches the
    worker's shared test DB (DB_PATH) or its directory, with a stack trace;
  * after each test, checks the DB still exists and still has a ``photos`` table,
    and logs the first test after which it does not (plus the previous 5 tests).

Output goes to b16-probe/<worker>.log (uploaded as a workflow artifact).
"""
import os
import shutil
import sqlite3
import traceback
from collections import deque

import pytest

_LOG_DIR = os.path.join(os.environ.get("GITHUB_WORKSPACE", os.getcwd()), "b16-probe")
os.makedirs(_LOG_DIR, exist_ok=True)
_WORKER = os.environ.get("PYTEST_XDIST_WORKER", "main")
_state = {"db": None, "broken": False, "current": None}
_recent = deque(maxlen=5)


def _log(msg):
    with open(os.path.join(_LOG_DIR, f"{_WORKER}.log"), "a", encoding="utf-8") as fh:
        fh.write(msg.rstrip() + "\n")


def _db():
    return _state["db"] or os.environ.get("DB_PATH")


def _touches_db(*paths):
    db = _db()
    if not db:
        return False
    db_dir = os.path.normcase(os.path.dirname(os.path.abspath(db)))
    for p in paths:
        try:
            p = os.path.normcase(os.path.abspath(os.fspath(p)))
        except TypeError:
            continue
        if p.startswith(db_dir) or db_dir.startswith(p + os.sep):
            return True
    return False


def _wrap(module, name):
    original = getattr(module, name)

    def wrapper(*args, **kwargs):
        if _touches_db(*args[:2]):
            _log(f"B16PROBE {module.__name__}.{name}{args[:2]!r} during "
                 f"{_state['current']}\n{''.join(traceback.format_stack(limit=25))}")
        return original(*args, **kwargs)

    setattr(module, name, wrapper)


for _mod, _name in [(os, "remove"), (os, "unlink"), (os, "replace"), (os, "rename"),
                    (shutil, "rmtree"), (shutil, "move")]:
    _wrap(_mod, _name)


def _thread_stacks():
    import sys
    import threading
    names = {t.ident: t.name for t in threading.enumerate()}
    out = []
    for ident, frame in sys._current_frames().items():
        out.append(f"--- thread {names.get(ident, '?')} ({ident})\n"
                   + "".join(traceback.format_stack(frame, limit=15)))
    return "\n".join(out)


def _dump_failure(conn, sql, ex):
    """At the moment a statement fails with "no such table": what did THIS connection see?"""
    lines = [f"B16PROBE NO-SUCH-TABLE during {_state['current']}: {ex!r}",
             f"  sql: {str(sql)[:200]}",
             f"  sqlite {sqlite3.sqlite_version}"]
    for pragma in ("database_list", "schema_version", "data_version", "journal_mode"):
        try:
            lines.append(f"  {pragma}: {conn.execute(f'PRAGMA {pragma}').fetchall()}")
        except Exception as inner:  # noqa: BLE001
            lines.append(f"  {pragma}: <{inner!r}>")
    try:
        names = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        lines.append(f"  this conn sees {len(names)} tables: {names[:15]}")
    except Exception as inner:  # noqa: BLE001
        lines.append(f"  sqlite_master: <{inner!r}>")
    db = _db()
    if db:
        for suffix in ("", "-wal", "-shm"):
            p = db + suffix
            lines.append(f"  {p}: {os.path.getsize(p) if os.path.exists(p) else 'absent'}")
        lines.append(f"  fresh conn health: {_health(db) or 'ok'}")
    lines.append(_thread_stacks())
    _log("\n".join(lines))


class _ProbeConnection(sqlite3.Connection):
    def execute(self, sql, *args, **kwargs):
        try:
            return super().execute(sql, *args, **kwargs)
        except sqlite3.OperationalError as ex:
            if "no such table: photos" in str(ex):
                _dump_failure(self, sql, ex)
            raise


_original_connect = sqlite3.connect


def _probe_connect(*args, **kwargs):
    if "factory" not in kwargs and len(args) < 6:
        kwargs["factory"] = _ProbeConnection
    return _original_connect(*args, **kwargs)


sqlite3.connect = _probe_connect


def _health(path):
    if not os.path.exists(path):
        return "file missing"
    size = os.path.getsize(path)
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            n = con.execute("SELECT count(*) FROM sqlite_master WHERE name='photos'").fetchone()[0]
        finally:
            con.close()
    except Exception as ex:  # noqa: BLE001 - diagnostic only
        return f"open/query failed ({ex!r}), size={size}"
    return None if n else f"no photos table, size={size}"


def pytest_runtest_logstart(nodeid, location):
    _state["current"] = nodeid


def pytest_runtest_logfinish(nodeid, location):
    _recent.append(nodeid)
    if _state["broken"]:
        return
    path = os.environ.get("DB_PATH")
    if not path:
        return
    if _state["db"] is None:
        _state["db"] = path
        _log(f"B16PROBE worker={_WORKER} DB_PATH={path} sqlite={sqlite3.sqlite_version}")
    elif path != _state["db"]:
        _log(f"B16PROBE DB_PATH changed after {nodeid}: {_state['db']} -> {path}")
    bad = _health(_state["db"])
    if bad:
        _state["broken"] = True
        _log(f"B16PROBE worker={_WORKER} DB BROKEN after {nodeid}: {bad}\n"
             f"  previous tests on this worker: {list(_recent)}")


@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session, exitstatus):
    _log(f"B16PROBE worker={_WORKER} session end, db broken={_state['broken']}")
