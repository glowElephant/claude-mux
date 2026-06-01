"""
claude-mux Python client.

Sync API — currency-edge의 subprocess.run 패턴을 그대로 대체:

    from claude_mux import Client
    text = Client().ask(prompt, cwd="/path/to/project", mode="automation")
"""

from __future__ import annotations

import uuid
from typing import Any, Callable, Optional

from .auto_spawn import is_daemon_running, spawn_daemon
from .socket_path import default_socket_path
from .transport import RpcTransport


class Client:
    """muxd 데몬에 JSON-RPC로 연결하는 sync 클라이언트.

    첫 호출 시 자동으로 데몬을 띄움 (auto_spawn=True).
    """

    def __init__(
        self,
        socket_path: Optional[str] = None,
        auto_spawn: bool = True,
        muxd_path: Optional[str] = None,
        spawn_timeout_ms: int = 5000,
    ) -> None:
        self._socket_path = socket_path or default_socket_path()
        self._auto_spawn = auto_spawn
        self._muxd_path = muxd_path
        self._spawn_timeout_ms = spawn_timeout_ms
        self._transport = RpcTransport(self._socket_path)
        self._ensured = False
        self._stream_callbacks: dict[str, Callable[[str], None]] = {}
        self._transport.on_stream_chunk(self._on_stream_chunk)

    def _on_stream_chunk(self, stream_id: str, chunk: str) -> None:
        cb = self._stream_callbacks.get(stream_id)
        if cb:
            cb(chunk)

    def _ensure(self) -> None:
        if self._ensured:
            return
        if self._auto_spawn and not is_daemon_running(self._socket_path):
            spawn_daemon(
                self._socket_path,
                muxd_path=self._muxd_path,
                spawn_timeout_ms=self._spawn_timeout_ms,
            )
        self._transport.connect()
        self._ensured = True

    def connect(self, timeout_ms: int = 5000) -> None:
        """명시 연결. ask/open_session이 자동 호출하므로 일반적으론 불필요."""
        if self._auto_spawn and not is_daemon_running(self._socket_path):
            spawn_daemon(
                self._socket_path,
                muxd_path=self._muxd_path,
                spawn_timeout_ms=self._spawn_timeout_ms,
            )
        self._transport.connect(timeout_ms=timeout_ms)
        self._ensured = True

    def close(self) -> None:
        self._transport.close()
        self._ensured = False

    # ===== API =====

    def ask(
        self,
        prompt: str,
        cwd: str,
        invoker: Optional[str] = None,
        mode: str = "automation",
        allowed_tools: Optional[str] = None,
        idle_death_ms: Optional[int] = None,
        max_ms: Optional[int] = None,
        detect_failure: bool = False,
    ) -> str:
        """단발 호출 — drop-in for subprocess.run(['claude', '-p', ...]).

        BlockedError는 호출자가 `except BlockedError`로 분기.
        """
        self._ensure()
        params: dict[str, Any] = {
            "prompt": prompt,
            "cwd": cwd,
            "mode": mode,
        }
        if invoker is not None:
            params["invoker"] = invoker
        if allowed_tools is not None:
            params["allowedTools"] = allowed_tools
        if idle_death_ms is not None:
            params["idleDeathMs"] = idle_death_ms
        if max_ms is not None:
            params["maxMs"] = max_ms
        if detect_failure:
            params["detectFailure"] = True
        result = self._transport.call("mux.ask", params)
        return result["text"]

    def open_session(
        self,
        cwd: str,
        invoker: Optional[str] = None,
        mode: str = "automation",
        allowed_tools: Optional[str] = None,
        resume_id: Optional[str] = None,
    ) -> "Session":
        """재사용 가능한 세션 핸들 반환."""
        self._ensure()
        params: dict[str, Any] = {"cwd": cwd, "mode": mode}
        if invoker is not None:
            params["invoker"] = invoker
        if allowed_tools is not None:
            params["allowedTools"] = allowed_tools
        if resume_id is not None:
            params["resumeId"] = resume_id
        result = self._transport.call("mux.openSession", params)
        return Session(self, result["sessionId"])

    def stream(
        self,
        prompt: str,
        cwd: str,
        on_chunk: Callable[[str], None],
        invoker: Optional[str] = None,
        mode: str = "automation",
        idle_death_ms: Optional[int] = None,
        max_ms: Optional[int] = None,
        detect_failure: bool = False,
    ) -> str:
        """Streaming — v0.1.x는 응답 단위 한 청크. 토큰 streaming은 후속."""
        self._ensure()
        sess = self.open_session(cwd=cwd, invoker=invoker, mode=mode)
        try:
            stream_id = str(uuid.uuid4())
            self._stream_callbacks[stream_id] = on_chunk
            try:
                params: dict[str, Any] = {
                    "sessionId": sess.id,
                    "prompt": prompt,
                    "streamId": stream_id,
                }
                if idle_death_ms is not None:
                    params["idleDeathMs"] = idle_death_ms
                if max_ms is not None:
                    params["maxMs"] = max_ms
                if detect_failure:
                    params["detectFailure"] = True
                result = self._transport.call("mux.stream", params)
                return result["text"]
            finally:
                self._stream_callbacks.pop(stream_id, None)
        finally:
            try:
                sess.close()
            except Exception:
                pass

    def status(self) -> dict[str, Any]:
        self._ensure()
        return self._transport.call("mux.status", {})

    # ===== 내부 =====

    def _send(
        self,
        session_id: str,
        prompt: str,
        idle_death_ms: Optional[int] = None,
        max_ms: Optional[int] = None,
        detect_failure: bool = False,
    ) -> str:
        self._ensure()
        params: dict[str, Any] = {"sessionId": session_id, "prompt": prompt}
        if idle_death_ms is not None:
            params["idleDeathMs"] = idle_death_ms
        if max_ms is not None:
            params["maxMs"] = max_ms
        if detect_failure:
            params["detectFailure"] = True
        result = self._transport.call("mux.send", params)
        return result["text"]

    def _close_session(self, session_id: str) -> None:
        self._ensure()
        self._transport.call("mux.close", {"sessionId": session_id})


class Session:
    """openSession이 반환하는 재사용 세션 핸들."""

    def __init__(self, client: Client, session_id: str) -> None:
        self._client = client
        self.id = session_id

    def send(
        self,
        prompt: str,
        idle_death_ms: Optional[int] = None,
        max_ms: Optional[int] = None,
        detect_failure: bool = False,
    ) -> str:
        return self._client._send(
            self.id,
            prompt,
            idle_death_ms=idle_death_ms,
            max_ms=max_ms,
            detect_failure=detect_failure,
        )

    def close(self) -> None:
        self._client._close_session(self.id)
