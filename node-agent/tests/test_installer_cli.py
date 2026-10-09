from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import installer_cli


def configure_install_environment(monkeypatch) -> None:
    monkeypatch.setenv("MADAR_API_BASE_URL", "https://control.example.test")
    monkeypatch.setenv("MADAR_NODE_ADDRESS", "203.0.113.10")
    monkeypatch.setenv("MADAR_NODE_PORT", "443")
    monkeypatch.setenv("MADAR_NODE_SERVER_NAME", "edge.example.test")
    monkeypatch.setenv("MADAR_REALITY_TARGET", "origin.example.test:443")
    monkeypatch.setenv("MADAR_REALITY_SHORT_ID", "0123456789abcdef")
    monkeypatch.delenv("MADAR_REALITY_PUBLIC_KEY", raising=False)


def configure_paths(monkeypatch, tmp_path: Path) -> Path:
    state_root = tmp_path / "etc" / "madar-node-agent"
    monkeypatch.setattr(installer_cli, "STATE_ROOT", state_root)
    monkeypatch.setattr(installer_cli, "CREDENTIAL_PATH", state_root / "node.credential")
    monkeypatch.setattr(installer_cli, "INSTALL_ROOT", tmp_path / "opt" / "madar-node-agent")
    monkeypatch.setattr(installer_cli, "XRAY_INSTALL_ROOT", tmp_path / "opt" / "madar-xray")
    monkeypatch.setattr(installer_cli, "SERVICE_PATH", tmp_path / "etc" / "systemd" / "system" / "madar-node-agent.service")
    return state_root


def require_online_observer():
    observer = getattr(installer_cli, "observe_xray_online_users", None)
    assert callable(observer), "observe_xray_online_users must be implemented"
    return observer


def test_install_builder_bootstraps_local_xray_and_does_not_require_reality_public_key_env(monkeypatch, tmp_path: Path) -> None:
    configure_paths(monkeypatch, tmp_path)
    configure_install_environment(monkeypatch)

    calls: list[bool] = []

    def fake_bootstrap_xray():
        calls.append(True)
        return SimpleNamespace(
            version="26.3.27",
            public_key="generated-public-key",
            binary=tmp_path / "opt" / "madar-xray" / "26.3.27" / "xray",
        )

    monkeypatch.setattr(installer_cli, "bootstrap_xray", fake_bootstrap_xray, raising=False)

    installer = installer_cli.build_install_installer()
    enrollment = installer.enrollment

    assert enrollment.capabilities["xray"] == "26.3.27"
    assert calls == []
    assert enrollment._public_config() == {
        "address": "203.0.113.10",
        "port": 443,
        "serverName": "edge.example.test",
        "realityPublicKey": "generated-public-key",
        "realityShortId": "0123456789abcdef",
    }
    assert calls == [True]


def test_install_requires_explicit_reality_target_instead_of_inventing_one(monkeypatch, tmp_path: Path) -> None:
    configure_paths(monkeypatch, tmp_path)
    configure_install_environment(monkeypatch)
    monkeypatch.delenv("MADAR_REALITY_TARGET")

    with pytest.raises(SystemExit, match="MADAR_REALITY_TARGET is required for install"):
        installer_cli.build_install_installer()


def test_agent_environment_persists_only_non_secret_xray_runtime_settings(monkeypatch, tmp_path: Path) -> None:
    state_root = configure_paths(monkeypatch, tmp_path)
    configure_install_environment(monkeypatch)

    installer_cli.build_install_installer()

    content = (state_root / "agent.env").read_text(encoding="utf-8")
    lines = set(content.splitlines())
    expected_binary = tmp_path / "opt" / "madar-xray" / "26.3.27" / "xray"
    assert lines >= {
        "MADAR_API_BASE_URL=https://control.example.test",
        f"MADAR_NODE_CREDENTIAL_PATH={state_root / 'node.credential'}",
        f"MADAR_XRAY_BINARY={expected_binary}",
        "MADAR_XRAY_VERSION=26.3.27",
        "MADAR_NODE_PORT=443",
        "MADAR_NODE_SERVER_NAME=edge.example.test",
        "MADAR_REALITY_TARGET=origin.example.test:443",
        "MADAR_REALITY_SHORT_ID=0123456789abcdef",
    }
    assert "PRIVATE" not in content.upper()
    assert "PUBLIC_KEY" not in content.upper()
    assert "ENROLLMENT" not in content.upper()
    assert "node-issued-credential" not in content


def test_xray_observation_reports_only_managed_online_count(monkeypatch, tmp_path: Path) -> None:
    configure_paths(monkeypatch, tmp_path)
    raw_client_one = "user>>>madar:11111111-1111-1111-1111-111111111111>>>online"
    raw_client_two = "user>>>madar:22222222-2222-2222-2222-222222222222>>>online"
    calls: list[list[str]] = []

    def fake_run(arguments: list[str]):
        calls.append(arguments)
        return SimpleNamespace(
            returncode=0,
            stdout='{"users":["' + raw_client_one + '","' + raw_client_two + '","user>>>other@example.test>>>online"]}',
            stderr="",
        )

    monkeypatch.setattr(installer_cli, "_run_process", fake_run)
    observer = require_online_observer()

    assert observer() == 2
    expected_binary = tmp_path / "opt" / "madar-xray" / "26.3.27" / "xray"
    assert calls == [[
        str(expected_binary),
        "api",
        "statsgetallonlineusers",
        "--server=127.0.0.1:10085",
    ]]


def test_xray_observation_failure_never_echoes_raw_xray_output(monkeypatch, tmp_path: Path) -> None:
    configure_paths(monkeypatch, tmp_path)
    raw_identifier = "user>>>madar:33333333-3333-3333-3333-333333333333>>>online"

    monkeypatch.setattr(
        installer_cli,
        "_run_process",
        lambda _arguments: SimpleNamespace(
            returncode=1,
            stdout=raw_identifier,
            stderr=f"failure near {raw_identifier}",
        ),
    )
    observer = require_online_observer()

    with pytest.raises(SystemExit) as captured:
        observer()

    message = str(captured.value)
    assert message == "local Xray observation unavailable"
    assert raw_identifier not in message


def test_observe_command_prints_aggregate_json_only(monkeypatch, capsys) -> None:
    monkeypatch.setattr(installer_cli, "observe_xray_online_users", lambda: 1, raising=False)

    assert installer_cli.main(["observe"]) == 0

    captured = capsys.readouterr()
    assert captured.out == '{"onlineUsers":1}\n'
    assert captured.err == ""
