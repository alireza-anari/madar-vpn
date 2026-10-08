from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


ROOT = Path(__file__).resolve().parents[1]


def test_shell_entrypoint_supports_lifecycle_and_reads_token_without_echo() -> None:
    script = (ROOT / "install.sh").read_text(encoding="utf-8")
    lowered = script.lower()

    for command in ("install", "status", "update", "remove"):
        assert command in script
    assert "read -r -s" in script
    assert "MADAR_ENROLLMENT_TOKEN" not in script
    assert "echo \"$token\"" not in script
    assert "printf '%s' \"$token\"" not in script

    for forbidden in ("ufw ", "iptables", "nft ", "sshd_config", "systemctl restart ssh"):
        assert forbidden not in lowered


def test_systemd_unit_uses_restrictive_umask_and_never_contains_enrollment_secret() -> None:
    unit = (ROOT / "systemd" / "madar-node-agent.service").read_text(encoding="utf-8")

    assert "UMask=0077" in unit
    assert "EnvironmentFile=/etc/madar-node-agent/agent.env" in unit
    assert "ExecStart=/opt/madar-node-agent/venv/bin/python -m madar_agent.service" in unit
    assert "Restart=on-failure" in unit
    assert "ENROLLMENT_TOKEN" not in unit
    assert "--token" not in unit
