"""socket_path resolver — 단위 테스트."""

from __future__ import annotations

import os
import sys

import pytest

from claude_mux.socket_path import default_socket_path


@pytest.fixture
def clean_env(monkeypatch):
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    monkeypatch.delenv("USERNAME", raising=False)
    return monkeypatch


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only test")
def test_posix_uses_xdg_runtime_dir(clean_env):
    clean_env.setenv("XDG_RUNTIME_DIR", "/run/user/1000")
    assert default_socket_path() == os.path.join("/run/user/1000", "muxd.sock")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only test")
def test_posix_falls_back_to_tmp(clean_env):
    p = default_socket_path()
    assert p.endswith(".sock")
    assert "muxd-" in p


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only test")
def test_windows_uses_username(clean_env):
    clean_env.setenv("USERNAME", "Alice")
    assert default_socket_path() == r"\\.\pipe\muxd-alice"


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only test")
def test_windows_falls_back_to_default(clean_env):
    assert default_socket_path() == r"\\.\pipe\muxd-default"
