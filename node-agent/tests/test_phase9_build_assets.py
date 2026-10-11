from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_phase9_ci_runs_go_race_vet_and_static_build_from_speed_enforcer() -> None:
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    assert "actions/setup-go@" in workflow
    assert ("go-version: '1.24.x'" in workflow) or ('go-version: "1.24.x"' in workflow)
    assert "working-directory: speed-enforcer" in workflow
    assert "go test -race ./..." in workflow
    assert "go vet ./..." in workflow
    assert "CGO_ENABLED=0 go build -trimpath" in workflow


def test_speed_enforcer_build_helper_is_executable_static_and_rejects_unsupported_targets(tmp_path: Path) -> None:
    script = ROOT / "scripts" / "build-speed-enforcer.sh"
    assert script.is_file(), "Phase 9 static build helper is required"
    assert stat.S_IMODE(script.stat().st_mode) & 0o111

    text = script.read_text(encoding="utf-8")
    assert "CGO_ENABLED=0" in text
    assert "-trimpath" in text
    assert "GOOS" in text
    assert "GOARCH" in text
    assert "speed-enforcer" in text

    missing_output = subprocess.run(
        ["bash", str(script)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    assert missing_output.returncode != 0

    unsupported_os = subprocess.run(
        ["bash", str(script), str(tmp_path / "bad-os"), "windows", "amd64"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    assert unsupported_os.returncode != 0
    assert not (tmp_path / "bad-os").exists()

    unsupported_arch = subprocess.run(
        ["bash", str(script), str(tmp_path / "bad-arch"), "linux", "386"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    assert unsupported_arch.returncode != 0
    assert not (tmp_path / "bad-arch").exists()


def test_speed_sidecar_assets_do_not_expose_public_listener_or_secret_cli_fields() -> None:
    unit = (ROOT / "node-agent" / "systemd" / "madar-speed-enforcer.service").read_text(encoding="utf-8")
    speed = (ROOT / "node-agent" / "madar_agent" / "speed.py").read_text(encoding="utf-8")

    assert "0.0.0.0:10808" not in speed
    assert "[::]:10808" not in speed
    assert "127.0.0.1:10808" in speed
    assert "--password" not in unit
    assert "--alias" not in unit
    assert "--verifier" not in unit
    assert "EnvironmentFile=" not in unit
