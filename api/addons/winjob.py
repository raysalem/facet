"""FORK-ONLY: a Windows job object so stopping an add-on also ends the processes it started.

On Windows, ``Popen.terminate()`` ends only the direct child. A supervised add-on launched through
a wrapper (``uv.exe run ...``) leaves its real server and interpreter behind. A job object created
with ``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`` ends every process in it when it is terminated or when
its last handle closes -- including when Facet itself dies. Kept isolated so upstream can drop it.
"""

import ctypes
import logging
import subprocess
import sys
from ctypes import wintypes
from typing import Optional

logger = logging.getLogger(__name__)

_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000


class _IoCounters(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class _BasicLimit(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD),
    ]


class _ExtendedLimit(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimit), ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class Job:
    """A kill-on-close job holding one process tree. ``close()`` ends every process still in it."""

    def __init__(self, handle):
        self._handle = handle

    @classmethod
    def for_process(cls, proc: subprocess.Popen) -> Optional["Job"]:
        if sys.platform != "win32":
            return None
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            logger.warning("CreateJobObject failed (%d)", ctypes.get_last_error())
            return None
        info = _ExtendedLimit()
        info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = kernel32.SetInformationJobObject(handle, _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                                              ctypes.byref(info), ctypes.sizeof(info))
        process_handle = getattr(proc, "_handle", None)
        if ok and process_handle is not None:
            ok = kernel32.AssignProcessToJobObject(handle, wintypes.HANDLE(int(process_handle)))
        if not ok:
            logger.warning("Could not put add-on process %d in a job object (%d)", proc.pid, ctypes.get_last_error())
            kernel32.CloseHandle(handle)
            return None
        return cls(handle)

    def close(self) -> None:
        """Terminate every process in the job, then release it."""
        if not self._handle:
            return
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.TerminateJobObject(self._handle, 1)
        kernel32.CloseHandle(self._handle)
        self._handle = None


def kill_tree(pid: int) -> None:
    """Fallback when no job object exists: ``taskkill /T /F`` on the add-on's process tree."""
    if sys.platform != "win32":
        return
    subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True, timeout=15,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
