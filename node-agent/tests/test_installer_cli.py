from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import installer_cli


def test_install_builder_bootstraps_local_xray_and_does_not_require_reality_public_key_env(monkeypatch, tmp_path: Path) -> None:
    state_root = tmp_path / "etc" / "madar-node-agent"
    monkeypatch.setattr(installer_cli, "STATE_ROOT", state_root)
    monkeypatch.setattr(installer_cli, "CREDENTIAL_PATH", state_root / "node.credential")
    monkeypatch.setattr(installer_cli, "INSTALL_ROOT", tmp_path / "opt" / "madar-node-agent")
    monkeypatch.setattr(installer_cli, "SERVICE_PATH", tmp_path / "etc" / "systemd" / "system" / "madar-node-agent.service")

    monkeypatch.setenv("MADAR_API_BASE_URL", "https://control.example.test")
    monkeypatch.setenv("MADAR_NODE_ADDRESS", "203.0.113.10")
    monkeypatch.setenv("MADAR_NODE_PORT", "443")
    monkeypatch.setenv("MADAR_NODE_SERVER_NAME", "edge.example.test")
    monkeypatch.setenv("MADAR_REALITY_SHORT_ID", "0123456789abcdef")
    monkeypatch.delenv("MADAR_REALITY_PUBLIC_KEY", raising=False)

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
