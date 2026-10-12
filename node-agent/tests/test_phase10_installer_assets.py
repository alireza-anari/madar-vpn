from __future__ import annotations

import re
from pathlib import Path

from madar_agent.speed_release import pinned_speed_enforcer_asset


ROOT = Path(__file__).resolve().parents[2]
NODE_AGENT = ROOT / "node-agent"


def test_production_units_keep_managed_runtime_guards_and_exact_speed_execstart() -> None:
    speed_unit_path = NODE_AGENT / "systemd" / "madar-speed-enforcer.service"
    xray_unit_path = NODE_AGENT / "systemd" / "madar-xray.service"

    assert speed_unit_path.is_file()
    assert xray_unit_path.is_file()

    speed_unit = speed_unit_path.read_text(encoding="utf-8")
    xray_unit = xray_unit_path.read_text(encoding="utf-8")

    assert (
        "ExecStart=/opt/madar-speed-enforcer/madar-speed-enforcer "
        "--config /etc/madar-node-agent/speed-enforcer.json"
    ) in speed_unit
    assert "ConditionPathExists=/etc/madar-node-agent/speed-enforcer.json" in speed_unit
    assert "ConditionPathExists=/run/madar-node-agent/speed-enforcer-authorized" in speed_unit
    assert "ConditionPathExists=/etc/madar-node-agent/xray-config.json" in xray_unit
    assert "ConditionPathExists=/run/madar-node-agent/xray-authorized" in xray_unit


def test_production_speed_release_pin_is_versioned_and_non_placeholder() -> None:
    amd64 = pinned_speed_enforcer_asset("Linux", "x86_64")
    arm64 = pinned_speed_enforcer_asset("Linux", "aarch64")

    assert amd64.tag == arm64.tag == "speed-enforcer-v0.1.0"
    assert amd64.asset_name == "madar-speed-enforcer-linux-amd64"
    assert arm64.asset_name == "madar-speed-enforcer-linux-arm64"
    assert amd64.sha256 != arm64.sha256

    for asset in (amd64, arm64):
        assert re.fullmatch(r"[0-9a-f]{64}", asset.sha256)
        assert asset.sha256 != "0" * 64
        assert f"/releases/download/{asset.tag}/{asset.asset_name}" in asset.url


def test_shell_installer_keeps_silent_fd3_enrollment_input_and_has_no_release_override() -> None:
    install_sh = (NODE_AGENT / "install.sh").read_text(encoding="utf-8")
    installer_cli = (NODE_AGENT / "installer_cli.py").read_text(encoding="utf-8")
    combined = f"{install_sh}\n{installer_cli}".lower()

    assert "read -r -s" in install_sh
    assert '3<<<"${token}"' in install_sh

    forbidden_overrides = (
        "madar_speed_enforcer_url",
        "madar_speed_enforcer_sha256",
        "--speed-enforcer-url",
        "--speed-enforcer-sha256",
        "--speed-release-url",
        "--speed-release-sha256",
    )
    for forbidden in forbidden_overrides:
        assert forbidden not in combined


def test_installer_output_and_fixtures_do_not_carry_old_sensitive_sentinel_values() -> None:
    paths = (
        NODE_AGENT / "installer_cli.py",
        NODE_AGENT / "madar_agent" / "installer.py",
        NODE_AGENT / "tests" / "test_installer.py",
        NODE_AGENT / "tests" / "test_installer_cli.py",
    )
    combined = "\n".join(path.read_text(encoding="utf-8") for path in paths)

    forbidden_sentinels = (
        "must-never-leave-" + "vps",
        "node-issued-" + "credential",
        "one-time-enrollment-" + "secret",
        "must-never-be-" + "sent",
    )
    for forbidden in forbidden_sentinels:
        assert forbidden not in combined
