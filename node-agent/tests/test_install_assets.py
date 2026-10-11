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


def test_agent_systemd_unit_does_not_boot_start_managed_children() -> None:
    unit = (ROOT / "systemd" / "madar-node-agent.service").read_text(encoding="utf-8")

    assert "UMask=0077" in unit
    assert "EnvironmentFile=/etc/madar-node-agent/agent.env" in unit
    assert "ExecStart=/opt/madar-node-agent/venv/bin/python -m madar_agent.service" in unit
    assert "Restart=on-failure" in unit
    assert "ENROLLMENT_TOKEN" not in unit
    assert "--token" not in unit
    for child in ("madar-xray.service", "madar-speed-enforcer.service"):
        assert f"Wants={child}" not in unit
        assert f"After={child}" not in unit


def test_xray_systemd_unit_uses_pinned_binary_ephemeral_authorization_and_agent_binding() -> None:
    unit = (ROOT / "systemd" / "madar-xray.service").read_text(encoding="utf-8")

    assert "BindsTo=madar-node-agent.service" in unit
    assert "ConditionPathExists=/etc/madar-node-agent/xray-config.json" in unit
    assert "ConditionPathExists=/run/madar-node-agent/xray-authorized" in unit
    assert "ExecStartPre=/usr/bin/test -f /etc/madar-node-agent/xray-config.json" in unit
    assert "ExecStartPre=/usr/bin/test -f /run/madar-node-agent/xray-authorized" in unit
    assert "ExecStart=/opt/madar-xray/26.3.27/xray run -c /etc/madar-node-agent/xray-config.json" in unit
    assert "Restart=on-failure" in unit
    assert "UMask=0077" in unit
    assert "NoNewPrivileges=true" in unit
    assert "PrivateTmp=true" in unit
    assert "REALITY" not in unit
    assert "PRIVATE" not in unit
    assert "CREDENTIAL" not in unit
    assert "EnvironmentFile=" not in unit
    assert "[Install]" not in unit


def test_speed_enforcer_unit_requires_live_config_ephemeral_authorization_and_agent_binding() -> None:
    unit = (ROOT / "systemd" / "madar-speed-enforcer.service").read_text(encoding="utf-8")

    assert "BindsTo=madar-node-agent.service" in unit
    assert "ConditionPathExists=/etc/madar-node-agent/speed-enforcer.json" in unit
    assert "ConditionPathExists=/run/madar-node-agent/speed-enforcer-authorized" in unit
    assert "ExecStartPre=/usr/bin/test -f /etc/madar-node-agent/speed-enforcer.json" in unit
    assert "ExecStartPre=/usr/bin/test -f /run/madar-node-agent/speed-enforcer-authorized" in unit
    assert "ExecStart=/opt/madar-speed-enforcer/madar-speed-enforcer --config /etc/madar-node-agent/speed-enforcer.json" in unit
    assert "Restart=on-failure" in unit
    assert "UMask=0077" in unit
    assert "NoNewPrivileges=true" in unit
    assert "PrivateTmp=true" in unit
    assert "EnvironmentFile=" not in unit
    assert "[Install]" not in unit
