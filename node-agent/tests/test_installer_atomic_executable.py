from __future__ import annotations

import stat
from pathlib import Path

import pytest

import madar_agent.installer as installer_module
from madar_agent.installer import LocalSystem


def test_local_system_installs_verified_executable_atomically(tmp_path: Path) -> None:
    destination = tmp_path / "opt" / "madar-speed-enforcer" / "madar-speed-enforcer"
    payload = b"verified-speed-enforcer-binary"

    LocalSystem().install_executable(payload, destination)

    assert destination.read_bytes() == payload
    assert stat.S_IMODE(destination.stat().st_mode) == 0o755
    assert list(destination.parent.glob(".madar-speed-enforcer.*")) == []


def test_atomic_executable_failure_preserves_old_binary_and_removes_temp(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    destination = tmp_path / "opt" / "madar-speed-enforcer" / "madar-speed-enforcer"
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"old-known-good-binary")
    destination.chmod(0o755)

    def fail_replace(source, target) -> None:
        raise RuntimeError("injected replace failure")

    monkeypatch.setattr(installer_module.os, "replace", fail_replace)

    with pytest.raises(RuntimeError, match="injected replace failure"):
        LocalSystem().install_executable(b"new-verified-binary", destination)

    assert destination.read_bytes() == b"old-known-good-binary"
    assert stat.S_IMODE(destination.stat().st_mode) == 0o755
    assert list(destination.parent.glob(".madar-speed-enforcer.*")) == []
