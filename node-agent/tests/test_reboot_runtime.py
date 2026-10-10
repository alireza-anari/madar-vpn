from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_systemd_contract_binds_xray_lifetime_to_one_agent_activation() -> None:
    agent_unit = (ROOT / "systemd" / "madar-node-agent.service").read_text(encoding="utf-8")
    xray_unit = (ROOT / "systemd" / "madar-xray.service").read_text(encoding="utf-8")

    assert "Wants=network-online.target" in agent_unit
    assert "After=network-online.target" in agent_unit
    assert "Wants=madar-xray.service" not in agent_unit
    assert "Requires=madar-xray.service" not in agent_unit
    assert "RuntimeDirectory=madar-node-agent" in agent_unit
    assert "RuntimeDirectoryMode=0700" in agent_unit
    assert "RuntimeDirectoryPreserve=no" in agent_unit

    assert "BindsTo=madar-node-agent.service" in xray_unit
    assert "After=madar-node-agent.service" in xray_unit
    assert "ConditionPathExists=/etc/madar-node-agent/xray-config.json" in xray_unit
    assert "ConditionPathExists=/run/madar-node-agent/xray-authorized" in xray_unit
    assert "ExecStartPre=/usr/bin/test -f /etc/madar-node-agent/xray-config.json" in xray_unit
    assert "ExecStartPre=/usr/bin/test -f /run/madar-node-agent/xray-authorized" in xray_unit
    assert "TimeoutStopSec=" in xray_unit
    assert "KillMode=control-group" in xray_unit
    assert "[Install]" not in xray_unit
    assert "WantedBy=" not in xray_unit
    assert "PartOf=madar-node-agent.service" not in xray_unit
