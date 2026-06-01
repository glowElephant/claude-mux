"""
muxd client errors.

JSON-RPC 에러 응답을 Python 예외로 변환. `BlockedError`는 muxd core/errors.ts /
TS client errors.ts와 인터페이스 호환 (reason, raw_reply, session_id) — 같은
fallback 코드가 호출 위치만 바꿔서 동작.
"""

from __future__ import annotations

from typing import Any, Optional


class MuxClientError(Exception):
    """모든 muxd client 예외의 베이스. `.code`로 분기 가능."""

    def __init__(
        self,
        code: str,
        message: str,
        rpc_code: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.rpc_code = rpc_code


class BlockedError(MuxClientError):
    """모델이 `MUX_BLOCKED:` 또는 `<mux:blocked>` 약속어로 응답 — task 불가능 명시.

    호출자는 `.reason`으로 사유 확인 후 fallback 결정. `.raw_reply`는 디버깅용
    원본 응답 본문.
    """

    def __init__(
        self,
        session_id: Optional[str],
        reason: str,
        raw_reply: str,
    ) -> None:
        super().__init__(
            "BLOCKED",
            f"Session {session_id or '(unknown)'} blocked: {reason}",
        )
        self.session_id = session_id
        self.reason = reason
        self.raw_reply = raw_reply


# JSON-RPC 코드 → ClientErrorCode 매핑
# muxd/daemon/protocol.ts의 JsonRpcErrorCode와 동기화 — 양쪽 갱신 필요
_RPC_CODE_TO_CLIENT_CODE: dict[int, str] = {
    1001: "SESSION_NOT_FOUND",
    1002: "SESSION_DEAD",
    1003: "TIMEOUT",
    1010: "BLOCKED",
    1020: "PTY_SPAWN_FAILED",
    1021: "CLAUDE_NOT_FOUND",
}


def build_error_from_rpc(rpc_error: dict[str, Any]) -> MuxClientError:
    """JSON-RPC error 객체 → MuxClientError 서브클래스 변환."""
    code = rpc_error.get("code")
    message = rpc_error.get("message", "")
    data = rpc_error.get("data") or {}

    if code == 1010:
        return BlockedError(
            session_id=data.get("sessionId") if isinstance(data, dict) else None,
            reason=data.get("reason", "(no reason)") if isinstance(data, dict) else "(no reason)",
            raw_reply=data.get("rawReply", "") if isinstance(data, dict) else "",
        )
    client_code = _RPC_CODE_TO_CLIENT_CODE.get(code, "RPC_ERROR")
    return MuxClientError(client_code, message, rpc_code=code)
