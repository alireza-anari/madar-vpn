from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_node_agent_owns_xray_startup_after_reboot_instead_of_systemd_dependency() -> None:
    agent_unit = (ROOT / "systemd" / "madar-node-agent.service").read_text(encoding="utf-8")
    xray_unit = (ROOT / "systemd" / "madar-xray.service").read_text(encoding="utf-8")

    assert "Wants=network-online.target" in agent_unit
    assert "After=network-online.target" in agent_unit
    assert "madar-xray.service" not in agent_unit
    assert "ConditionPathExists=/etc/madar-node-agent/xray-config.json" in xray_unit
