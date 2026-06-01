"""Integration — Python client → muxd daemon → real claude.

환경:
  MUX_INTEGRATION=1 — 게이트 (없으면 skip)
  MUXD_BIN — daemon binary (auto-spawn 시 필요)

봇 한도 보호: ask 1회만.
"""

from __future__ import annotations

import os
import sys

import pytest

from claude_mux import Client


ENABLED = os.environ.get("MUX_INTEGRATION") == "1"


@pytest.mark.skipif(not ENABLED, reason="MUX_INTEGRATION=1 not set")
def test_status_returns_daemon_info():
    """status는 PTY spawn 없이 daemon 정보만 반환 — 봇 한도 0."""
    c = Client()
    try:
        s = c.status()
        assert "pid" in s
        assert "sessions" in s
        assert "version" in s
    finally:
        c.close()


@pytest.mark.skipif(not ENABLED, reason="MUX_INTEGRATION=1 not set")
def test_ask_simple_imperative_works():
    """확정된 통과 패턴 — standalone imperative prompt → 정확한 응답."""
    c = Client()
    try:
        text = c.ask(
            "respond with exactly one line: 'OK-PY-CLIENT'",
            cwd=os.path.dirname(os.path.abspath(__file__)),
            invoker="claude-mux-py-integration-test",
            mode="automation",
            idle_death_ms=120_000,
            max_ms=180_000,
        )
        assert "OK-PY-CLIENT" in text
    finally:
        c.close()
