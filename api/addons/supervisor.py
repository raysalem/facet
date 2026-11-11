"""Supervised add-ons: Facet starts and stops the add-on's process itself (off by default).

Interface used by the rest of Facet: :func:`start`, :func:`stop`, :func:`stop_all`, :func:`status`,
:func:`upstream` (registered with the proxy) and :func:`log_tail`. Nothing else knows about processes.

* **Gate** (in the routes): ``require_scan_access`` + ``addons.enabled``, and a manifest with ``start``.
* **Spawn**: ``Popen(argv, shell=False, cwd=<manifest dir>, env=<clean>)``, one instance per id. The env
  is built from scratch (never a copy of Facet's): a few OS variables the program needs to run, plus
  ``FACET_URL``, ``FACET_TOKEN``, ``FACET_ADDON_ID``, ``FACET_LAUNCH_SECRET`` (+ ``FACET_PORT`` when the
  manifest fixes the port). stderr goes to ``<facet data>/logs/addons/<id>.log``; stdout is read for the
  one line ``FACET_ADDON_PORT=<n>`` (``port: "auto"``) and logged too.
* **Ready**: ``GET <health>?c=<random>`` must answer ``{"addon": id, "ack": hex(HMAC-SHA256(secret, c))}``
  within 30 s; until then the proxy forwards nothing (it has no upstream).
* **Token**: minted per launch as the starting principal, revoked at stop, exit or failure.
* **Stop**: terminate -> wait 5 s -> kill (POSIX: the whole session group). On Windows the process
  tree is in a kill-on-close job object (:mod:`api.addons.winjob`, fork-only) or ``taskkill /T``.
* **Crash**: no auto-restart, no idle stop. Status reads ``exited (code)``; the next Open starts it again.
"""

import atexit
import collections
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote

from api.addons import manifest, panels

logger = logging.getLogger(__name__)

READY_BUDGET_SECONDS = 30.0
STOP_GRACE_SECONDS = 5.0
LOG_TAIL_LINES = 20
PORT_LINE = re.compile(r"^FACET_ADDON_PORT=(\d{1,5})\s*$")
# What a program needs from the OS to run at all; nothing of Facet's own (no DB_PATH, no secrets).
ENV_PASSTHROUGH = ("PATH", "SYSTEMROOT", "SystemRoot", "USERPROFILE", "HOME", "LOCALAPPDATA", "TEMP", "TMP", "LANG")


@dataclass
class Instance:
    addon_id: str
    proc: subprocess.Popen
    secret: str
    token_id: Optional[int]
    log_path: str
    port: Optional[int] = None
    status: str = "starting"  # starting | running | exited | failed | stopped
    exit_code: Optional[int] = None
    error: Optional[str] = None
    job: object = None
    started_at: float = field(default_factory=time.time)
    lines: collections.deque = field(default_factory=lambda: collections.deque(maxlen=200))
    port_seen: threading.Event = field(default_factory=threading.Event)
    stopping: bool = False


_lock = threading.RLock()
_instances: dict[str, Instance] = {}
_atexit_registered = False
LAUNCH_TOKEN_SUFFIX = "(launch)"


def _stamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean_env(addon: manifest.Addon, facet_url: str, token: str, secret: str) -> dict:
    env = {k: os.environ[k] for k in ENV_PASSTHROUGH if k in os.environ}
    env.update(FACET_URL=facet_url, FACET_TOKEN=token, FACET_ADDON_ID=addon.id, FACET_LAUNCH_SECRET=secret)
    if isinstance(addon.port, int):
        env["FACET_PORT"] = str(addon.port)
    return env


def ack_for(secret: str, challenge: str) -> str:
    return hmac.new(secret.encode("utf-8"), challenge.encode("utf-8"), hashlib.sha256).hexdigest()


def _spawn(addon: manifest.Addon, env: dict, log_handle) -> subprocess.Popen:
    kwargs: dict = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(list(addon.argv), shell=False, cwd=addon.directory, env=env,
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=log_handle, **kwargs)


def _read_stdout(inst: Instance, log_handle) -> None:
    """Pump the child's stdout: find the port line, keep every line in the log and the tail."""
    stream = inst.proc.stdout
    try:
        for raw in iter(stream.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            inst.lines.append(line)
            try:
                log_handle.write(raw)
                log_handle.flush()
            except (OSError, ValueError):
                pass
            match = PORT_LINE.match(line)
            if match and inst.port is None and 0 < int(match.group(1)) < 65536:
                inst.port = int(match.group(1))
                inst.port_seen.set()
    finally:
        inst.port_seen.set()
        try:
            log_handle.close()
        except OSError:
            pass


def _health_ok(addon: manifest.Addon, inst: Instance) -> bool:
    challenge = secrets.token_hex(16)
    url = f"http://127.0.0.1:{inst.port}{addon.health}?c={quote(challenge)}"
    request = urllib.request.Request(url, headers={"X-Facet-Launch": inst.secret})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=2) as response:
            body = json.loads(response.read(4096).decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return False
    return (isinstance(body, dict) and body.get("addon") == addon.id and isinstance(body.get("ack"), str)
            and hmac.compare_digest(body["ack"], ack_for(inst.secret, challenge)))


def _wait_ready(addon: manifest.Addon, inst: Instance) -> Optional[str]:
    """None when the add-on proved itself within the budget, else the reason it did not."""
    deadline = time.monotonic() + READY_BUDGET_SECONDS
    if isinstance(addon.port, int):
        inst.port = addon.port
    else:
        inst.port_seen.wait(READY_BUDGET_SECONDS)
        if inst.port is None:
            return "exited before reporting its port" if inst.proc.poll() is not None \
                else "did not report FACET_ADDON_PORT=<n> in time"
    while time.monotonic() < deadline:
        if inst.proc.poll() is not None:
            return f"exited with code {inst.proc.returncode} while starting"
        if _health_ok(addon, inst):
            return None
        time.sleep(0.25)
    return "did not answer its health check in time"


def _kill(inst: Instance) -> None:
    proc = inst.proc
    if proc.poll() is None:
        try:
            if sys.platform != "win32":
                os.killpg(proc.pid, signal.SIGTERM)
            else:
                proc.terminate()
        except OSError:
            pass
        try:
            proc.wait(STOP_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            try:
                if sys.platform != "win32":
                    os.killpg(proc.pid, signal.SIGKILL)
                else:
                    proc.kill()
            except OSError:
                pass
            try:
                proc.wait(STOP_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                logger.warning("Add-on %s (pid %d) did not exit", inst.addon_id, proc.pid)
    # The add-on's own children: the job object ends what is left of the tree.
    if inst.job is not None:
        inst.job.close()
        inst.job = None
    elif sys.platform == "win32":
        from api.addons.winjob import kill_tree
        try:
            kill_tree(proc.pid)
        except (OSError, subprocess.SubprocessError):
            pass


def _release(inst: Instance) -> None:
    """Revoke the launch token and close the add-on's panels (the proxy then has no upstream)."""
    from api.addons.auth import revoke_addon_tokens
    panels.close_all(inst.addon_id)
    if inst.token_id is not None:
        try:
            revoke_addon_tokens(inst.addon_id, inst.token_id)
        except Exception:  # noqa: BLE001 -- the DB may already be closing at shutdown
            logger.warning("Could not revoke the launch token of add-on %s", inst.addon_id, exc_info=True)
        inst.token_id = None


def _watch(inst: Instance) -> None:
    code = inst.proc.wait()
    with _lock:
        if inst.stopping:
            return
        inst.exit_code = code
        if inst.status == "running":
            inst.status = "exited"
            logger.warning("Add-on %s exited with code %s", inst.addon_id, code)
        _release(inst)
        if inst.job is not None:
            inst.job.close()
            inst.job = None


def _revoke_stale_launch_tokens(addon_id: str) -> None:
    """A launch token outlives its process only when Facet died without stopping it: revoke it now."""
    from api.agent.tokens import _now_iso
    from api.database import get_db
    with get_db() as conn:
        conn.execute("UPDATE mcp_tokens SET revoked = 1, revoked_at = ? WHERE kind = 'addon' AND addon_id = ? "
                     "AND revoked = 0 AND name = ?", (_now_iso(), addon_id, f"add-on {addon_id} {LAUNCH_TOKEN_SUFFIX}"))
        conn.commit()


def start(addon: manifest.Addon, user, facet_url: str) -> Instance:
    """Start ``addon`` (or return the running instance). Blocks until ready or failed (30 s budget)."""
    from api.addons.auth import mint_addon_token
    if not addon.supervised:
        raise ValueError("not a supervised add-on")
    with _lock:
        current = _instances.get(addon.id)
        if current is not None and current.status in ("running", "starting") and current.proc.poll() is None:
            starting = current
        else:
            starting = None
    if starting is not None:
        if starting.status == "starting":
            _wait_ready(addon, starting)
        return starting

    global _atexit_registered
    if not _atexit_registered:
        atexit.register(stop_all)
        _atexit_registered = True
    _revoke_stale_launch_tokens(addon.id)
    os.makedirs(manifest.addon_logs_dir(), exist_ok=True)
    log_path = os.path.join(manifest.addon_logs_dir(), f"{addon.id}.log")
    secret = secrets.token_urlsafe(32)
    row, token = mint_addon_token(addon, user, f"add-on {addon.id} {LAUNCH_TOKEN_SUFFIX}")
    log_handle = open(log_path, "ab", buffering=0)
    log_handle.write(f"\n--- {_stamp()} starting {addon.id} {addon.version} ---\n".encode())
    try:
        proc = _spawn(addon, clean_env(addon, facet_url, token, secret), log_handle)
    except OSError as exc:
        log_handle.write(f"could not start: {exc}\n".encode())
        log_handle.close()
        from api.addons.auth import revoke_addon_tokens
        revoke_addon_tokens(addon.id, row["id"])
        inst = Instance(addon.id, None, secret, None, log_path, status="failed", error=f"could not start: {exc.strerror or exc}")  # type: ignore[arg-type]
        with _lock:
            _instances[addon.id] = inst
        return inst
    inst = Instance(addon.id, proc, secret, row["id"], log_path)
    if sys.platform == "win32":
        from api.addons.winjob import Job
        inst.job = Job.for_process(proc)
    with _lock:
        _instances[addon.id] = inst
    threading.Thread(target=_read_stdout, args=(inst, log_handle), daemon=True,
                     name=f"addon-{addon.id}-stdout").start()
    reason = _wait_ready(addon, inst)
    with _lock:
        if reason is None:
            inst.status = "running"
            threading.Thread(target=_watch, args=(inst,), daemon=True, name=f"addon-{addon.id}-watch").start()
            logger.info("Add-on %s running on 127.0.0.1:%s (pid %d)", addon.id, inst.port, proc.pid)
            return inst
        inst.status = "failed"
        inst.error = reason
        inst.stopping = True
    logger.warning("Add-on %s did not start: %s", addon.id, reason)
    _kill(inst)
    inst.exit_code = proc.poll()
    _release(inst)
    return inst


def stop(addon_id: str) -> bool:
    with _lock:
        inst = _instances.get(addon_id)
        if inst is None or inst.proc is None or inst.status not in ("running", "starting"):
            return False
        inst.stopping = True
    _kill(inst)
    with _lock:
        inst.status = "stopped"
        inst.exit_code = inst.proc.poll()
    _release(inst)
    logger.info("Add-on %s stopped", addon_id)
    return True


def stop_all() -> None:
    """Facet is exiting: stop every add-on it started."""
    for addon_id in list(_instances):
        try:
            stop(addon_id)
        except Exception:  # noqa: BLE001 -- keep stopping the others
            logger.warning("Could not stop add-on %s", addon_id, exc_info=True)


def instance(addon_id: str) -> Optional[Instance]:
    return _instances.get(addon_id)


def upstream(addon: manifest.Addon):
    """The proxy's upstream for a running, verified supervised add-on; None otherwise."""
    from api.addons.proxy import Upstream
    inst = _instances.get(addon.id)
    if not addon.supervised or inst is None or inst.status != "running" or inst.proc.poll() is not None:
        return None
    return Upstream(f"http://127.0.0.1:{inst.port}/", inst.secret)


def log_tail(addon_id: str, lines: int = LOG_TAIL_LINES) -> list[str]:
    """The last ``lines`` lines of the add-on's log file (stdout and stderr)."""
    path = os.path.join(manifest.addon_logs_dir(), f"{addon_id}.log")
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 64 * 1024))
            text = handle.read().decode("utf-8", "replace")
    except OSError:
        return []
    return text.splitlines()[-lines:]


def status(addon: manifest.Addon) -> dict:
    """The Add-ons page's view of a supervised add-on: status, exit code, error, failure log tail."""
    if not addon.supervised:
        return {}
    inst = _instances.get(addon.id)
    if inst is None:
        return {"status": "stopped"}
    if inst.status == "running" and inst.proc.poll() is not None:
        return {"status": "exited", "exit_code": inst.proc.returncode}
    out = {"status": inst.status, "exit_code": inst.exit_code, "error": inst.error}
    if inst.status in ("failed", "exited"):
        out["log_tail"] = log_tail(addon.id)
    return out
