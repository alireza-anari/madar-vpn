from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_node_agent_requests_xray_on_boot_but_xray_waits_for_managed_config() -> None:
    agent_unit = (ROOT / "systemd" / "madar-node-agent.service").read_text(encoding="utf-8")
    xray_unit = (ROOT / "systemd" / "madar-xray.service").read_text(encoding="utf-8")

    assert "Wants=network-online.target madar-xray.service" in agent_unit
    assert "After=network-online.target madar-xray.service" in agent_unit
    assert "ConditionPathExists=/etc/madar-node-agent/xray-config.json" in xray_unit
