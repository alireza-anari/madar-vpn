from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


ROOT = Path(__file__).resolve().parents[1]


def test_shell_entrypoint_supports_lifecycle_and_reads_token_without_echo() -> None:
    script = (ROOT / "install.sh").read_text(encoding="utf-8")
    lowered = script.lower()

    for command in ("install", "status", "observe", "update", "remove"):
        assert command in script
    assert "read -r -s" in script
    assert "MADAR_ENROLLMENT_TOKEN" not in script
    assert "echo \"$token\"" not in script
    assert "printf '%s' \"$token\"" not in script

    for forbidden in ("ufw ", "iptables", "nft ", "sshd_config", "systemctl restart ssh"):
        assert forbidden not in lowered


def test_systemd_unit_uses_restrictive_umask_and_does_not_autostart_stale_xray() -> None:
    unit = (ROOT / "systemd" / "madar-node-agent.service").read_text(encoding="utf-8")

    assert "UMask=0077" in unit
    assert "EnvironmentFile=/etc/madar-node-agent/agent.env" in unit
    assert "ExecStart=/opt/madar-node-agent/venv/bin/python -m madar_agent.service" in unit
    assert "Restart=on-failure" in unit
    assert "ENROLLMENT_TOKEN" not in unit
    assert "--token" not in unit
    assert "Wants=madar-xray.service" not in unit
    assert "After=madar-xray.service" not in unit
    assert "After=network-online.target madar-xray.service" not in unit


def test_xray_systemd_unit_uses_pinned_binary_and_requires_managed_config_before_start() -> None:
    unit = (ROOT / "systemd" / "madar-xray.service").read_text(encoding="utf-8")

    assert "ExecStartPre=/usr/bin/test -f /etc/madar-node-agent/xray-config.json" in unit
    assert "ExecStart=/opt/madar-xray/26.3.27/xray run -c /etc/madar-node-agent/xray-config.json" in unit
    assert "Restart=on-failure" in unit
    assert "UMask=0077" in unit
    assert "NoNewPrivileges=true" in unit
    assert "PrivateTmp=true" in unit
    assert "REALITY" not in unit
    assert "PRIVATE" not in unit
    assert "CREDENTIAL" not in unit
    assert "EnvironmentFile=" not in unit
