from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.models import ManagedClient
from madar_agent.xray import PinnedXrayAdapter, RealityServerConfig


CLIENT_ID = "27848739-7e62-4138-9fd3-098a63964b6b"


def test_managed_config_exposes_stats_service_on_loopback_only(tmp_path: Path) -> None:
    state_root = tmp_path / "state"
    state_root.mkdir()
    private_path = state_root / "reality.private"
    private_path.write_text("fixture-private-key", encoding="utf-8")
    private_path.chmod(0o600)

    binary = tmp_path / "runtime" / "26.3.27" / "xray"
    server = RealityServerConfig(
        port=443,
        target="www.example.com:443",
        server_names=("www.example.com",),
        short_ids=("0123456789abcdef",),
    )

    def run(_argv: list[str]):
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    adapter = PinnedXrayAdapter(
        install_root=tmp_path / "runtime",
        state_root=state_root,
        download=lambda _url: b"",
        run=run,
        binary=binary,
        server=server,
        reload=lambda: None,
    )

    adapter.apply_clients(
        [ManagedClient(client_id=CLIENT_ID, tier="premium", speed_kbps=None)]
    )

    config = json.loads((state_root / "xray-config.json").read_text(encoding="utf-8"))

    assert config["api"] == {
        "tag": "madar-local-api",
        "listen": "127.0.0.1:10085",
        "services": ["StatsService"],
    }
    assert config["stats"] == {}
    assert config["policy"] == {
        "levels": {"0": {"statsUserOnline": True}},
    }
    assert config["api"]["listen"].startswith("127.0.0.1:")
    # The real Xray process emits its client's email/UUID through the default
    # access logger even when the error log level is warning.
    assert config["log"].get("access") == "none"
