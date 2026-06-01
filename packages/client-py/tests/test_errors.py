"""Errors module — 단위 테스트."""

from __future__ import annotations

import pytest

from claude_mux.errors import BlockedError, MuxClientError, build_error_from_rpc


def test_blocked_error_carries_fields():
    e = BlockedError(session_id="s-1", reason="no internet", raw_reply="MUX_BLOCKED: no internet")
    assert e.code == "BLOCKED"
    assert e.session_id == "s-1"
    assert e.reason == "no internet"
    assert e.raw_reply == "MUX_BLOCKED: no internet"
    assert "s-1" in str(e)
    assert "no internet" in str(e)


def test_blocked_error_is_catchable_as_mux_and_exception():
    e = BlockedError(None, "r", "MUX_BLOCKED: r")
    assert isinstance(e, MuxClientError)
    assert isinstance(e, Exception)


def test_build_error_from_rpc_blocked_with_full_data():
    err = build_error_from_rpc(
        {
            "code": 1010,
            "message": "blocked",
            "data": {
                "reason": "no api access",
                "sessionId": "s-2",
                "rawReply": "MUX_BLOCKED: no api access",
            },
        }
    )
    assert isinstance(err, BlockedError)
    assert err.reason == "no api access"
    assert err.session_id == "s-2"
    assert err.raw_reply == "MUX_BLOCKED: no api access"


def test_build_error_from_rpc_blocked_with_no_data():
    err = build_error_from_rpc({"code": 1010, "message": "blocked"})
    assert isinstance(err, BlockedError)
    assert err.reason == "(no reason)"
    assert err.raw_reply == ""
    assert err.session_id is None


@pytest.mark.parametrize(
    "rpc_code,expected",
    [
        (1001, "SESSION_NOT_FOUND"),
        (1002, "SESSION_DEAD"),
        (1003, "TIMEOUT"),
        (1020, "PTY_SPAWN_FAILED"),
        (1021, "CLAUDE_NOT_FOUND"),
    ],
)
def test_build_error_maps_known_codes(rpc_code: int, expected: str):
    err = build_error_from_rpc({"code": rpc_code, "message": "x"})
    assert isinstance(err, MuxClientError)
    assert not isinstance(err, BlockedError)
    assert err.code == expected
    assert err.rpc_code == rpc_code


def test_build_error_falls_back_to_rpc_error_for_unknown_code():
    err = build_error_from_rpc({"code": 9999, "message": "weird"})
    assert err.code == "RPC_ERROR"
    assert err.rpc_code == 9999
