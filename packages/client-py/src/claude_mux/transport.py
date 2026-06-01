"""
JSON-RPC sync transport over Unix socket (POSIX) / Named pipe (Windows).

NDJSON framing — 한 줄에 한 메시지, 줄바꿈(\\n) 종료. TS daemon과 동일.

Sync API — currency-edge처럼 subprocess.run 패턴을 그대로 대체. async가 필요하면
별도 어댑터(asyncio 래퍼)를 후속에 추가.
"""

from __future__ import annotations

import json
import socket
import sys
import threading
import time
from typing import Any, Callable, Optional

from .errors import MuxClientError, build_error_from_rpc


class _PipeConnection:
    """Windows Named pipe를 socket-like 인터페이스로 감쌈."""

    def __init__(self, path: str, timeout_ms: int) -> None:
        if sys.platform != "win32":
            raise RuntimeError("_PipeConnection is Windows-only")
        # pywin32 imports는 Windows에서만 — 런타임 import.
        import pywintypes  # type: ignore
        import win32file  # type: ignore

        self._pywintypes = pywintypes
        self._win32file = win32file
        deadline = time.monotonic() + timeout_ms / 1000.0
        last_err: Optional[Exception] = None
        while time.monotonic() < deadline:
            try:
                self._handle = win32file.CreateFile(
                    path,
                    win32file.GENERIC_READ | win32file.GENERIC_WRITE,
                    0,
                    None,
                    win32file.OPEN_EXISTING,
                    0,
                    None,
                )
                return
            except pywintypes.error as e:  # pipe busy/not found
                last_err = e
                time.sleep(0.05)
        raise MuxClientError(
            "CONNECT_FAILED",
            f"named pipe connect failed: {last_err}",
        )

    def sendall(self, data: bytes) -> None:
        self._win32file.WriteFile(self._handle, data)

    def recv(self, n: int) -> bytes:
        _, data = self._win32file.ReadFile(self._handle, n)
        return bytes(data)

    def close(self) -> None:
        try:
            self._handle.Close()
        except Exception:
            pass


def _connect(socket_path: str, timeout_ms: int) -> Any:
    if sys.platform == "win32":
        return _PipeConnection(socket_path, timeout_ms)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout_ms / 1000.0)
    sock.connect(socket_path)
    sock.settimeout(None)
    return sock


class RpcTransport:
    """JSON-RPC sync client. 단일 스레드 사용 가정 — 동시 call은 thread-safe 안 함."""

    def __init__(self, socket_path: str) -> None:
        self.socket_path = socket_path
        self._conn: Any = None
        self._connected = False
        self._next_id = 1
        self._buffer = b""
        self._lock = threading.Lock()  # call 직렬화 (sendall + 응답 wait 묶음)
        self._stream_handler: Optional[Callable[[str, str], None]] = None

    def on_stream_chunk(self, handler: Callable[[str, str], None]) -> None:
        self._stream_handler = handler

    def connect(self, timeout_ms: int = 5000) -> None:
        if self._connected:
            return
        try:
            self._conn = _connect(self.socket_path, timeout_ms)
        except MuxClientError:
            raise
        except OSError as e:
            raise MuxClientError(
                "CONNECT_FAILED",
                f"socket connect failed: {e} ({self.socket_path})",
            )
        self._connected = True

    def _send_raw(self, data: bytes) -> None:
        self._conn.sendall(data)

    def _read_line(self) -> bytes:
        """누적 버퍼에서 \\n으로 끝나는 한 줄 읽기. 부족하면 socket에서 추가."""
        while True:
            idx = self._buffer.find(b"\n")
            if idx >= 0:
                line = self._buffer[:idx]
                self._buffer = self._buffer[idx + 1 :]
                return line
            chunk = self._conn.recv(4096)
            if not chunk:
                raise MuxClientError("RPC_ERROR", "socket closed mid-read")
            self._buffer += chunk

    def call(self, method: str, params: Any) -> Any:
        """JSON-RPC method 호출 → 결과 반환. error 응답이면 MuxClientError raise."""
        with self._lock:
            if not self._connected:
                raise MuxClientError("RPC_ERROR", "not connected")
            req_id = self._next_id
            self._next_id += 1
            req = {
                "jsonrpc": "2.0",
                "id": req_id,
                "method": method,
                "params": params,
            }
            self._send_raw(json.dumps(req).encode("utf-8") + b"\n")

            # response 또는 streamChunk notification 들어옴 — id 매칭으로 분리
            while True:
                line = self._read_line()
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                # notification: streamChunk
                if (
                    isinstance(msg, dict)
                    and msg.get("method") == "mux.streamChunk"
                    and self._stream_handler
                ):
                    params = msg.get("params") or {}
                    self._stream_handler(
                        params.get("streamId", ""),
                        params.get("chunk", ""),
                    )
                    continue
                # response
                if isinstance(msg, dict) and msg.get("id") == req_id:
                    if "error" in msg and msg["error"]:
                        raise build_error_from_rpc(msg["error"])
                    return msg.get("result")
                # 다른 id의 응답 — 단일 스레드라 발생 안 해야 함. 무시하고 계속.

    def close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                pass
        self._conn = None
        self._connected = False
