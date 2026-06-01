"""
Auto-spawn — 데몬이 없으면 `muxd serve`를 detached로 띄움.

위치 우선순위:
  1. opts.muxd_path
  2. MUXD_BIN env
  3. PATH lookup (`where`/`which`)
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from typing import Optional

from .errors import MuxClientError


def is_daemon_running(socket_path: str, timeout_ms: int = 300) -> bool:
    """짧은 connect 시도로 데몬 listening 여부 확인."""
    deadline = time.monotonic() + timeout_ms / 1000.0
    if sys.platform == "win32":
        # Windows Named pipe — 존재 확인은 CreateFile 시도가 가장 확실
        try:
            import pywintypes  # type: ignore
            import win32file  # type: ignore

            while time.monotonic() < deadline:
                try:
                    handle = win32file.CreateFile(
                        socket_path,
                        win32file.GENERIC_READ,
                        0,
                        None,
                        win32file.OPEN_EXISTING,
                        0,
                        None,
                    )
                    handle.Close()
                    return True
                except pywintypes.error:
                    time.sleep(0.05)
            return False
        except ImportError:
            return False
    # POSIX
    while time.monotonic() < deadline:
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(0.1)
            sock.connect(socket_path)
            sock.close()
            return True
        except OSError:
            time.sleep(0.05)
    return False


def _find_muxd_binary(explicit: Optional[str] = None) -> str:
    if explicit:
        return explicit
    env = os.environ.get("MUXD_BIN")
    if env:
        return env
    found = shutil.which("muxd")
    if found:
        return found
    raise MuxClientError(
        "DAEMON_NOT_FOUND",
        "muxd binary not found. Set MUXD_BIN, pass muxd_path, "
        "or install @claude-mux/muxd globally.",
    )


def spawn_daemon(
    socket_path: str,
    muxd_path: Optional[str] = None,
    spawn_timeout_ms: int = 5000,
) -> None:
    """muxd serve를 detached로 spawn 후 ready 폴링."""
    binary = _find_muxd_binary(muxd_path)
    # Windows에서 .cmd shim일 수 있으므로 shell=True
    if sys.platform == "win32":
        subprocess.Popen(
            [binary, "serve"],
            shell=True,
            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    else:
        subprocess.Popen(
            [binary, "serve"],
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    deadline = time.monotonic() + spawn_timeout_ms / 1000.0
    while time.monotonic() < deadline:
        if is_daemon_running(socket_path, timeout_ms=200):
            return
        time.sleep(0.2)
    raise MuxClientError(
        "CONNECT_FAILED",
        f"muxd spawned but not responding on {socket_path} within {spawn_timeout_ms}ms",
    )
