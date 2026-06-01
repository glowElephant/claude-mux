"""
muxd daemon의 socket path resolver — TS daemon/socket-path.ts와 같은 규칙.

POSIX (Linux/Mac):
  - $XDG_RUNTIME_DIR/muxd.sock if set
  - else /tmp/muxd-<uid>.sock

Windows:
  - \\\\.\\pipe\\muxd-<username>

규칙 변경 시 양쪽(TS daemon + TS client + Python client) 모두 갱신.
"""

from __future__ import annotations

import os
import sys
import tempfile


def default_socket_path() -> str:
    if sys.platform == "win32":
        user = os.environ.get("USERNAME", "default").lower()
        return rf"\\.\pipe\muxd-{user}"
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    if runtime_dir:
        return os.path.join(runtime_dir, "muxd.sock")
    uid = os.getuid() if hasattr(os, "getuid") else 0
    return os.path.join(tempfile.gettempdir(), f"muxd-{uid}.sock")
