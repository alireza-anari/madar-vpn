from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent import xray
from madar_agent.models import ManagedClient


VERSION = "26.3.27"
CLIENT_ID = "27848739-7e62-4138-9fd3-098a63964b6b"
SECOND_CLIENT_ID = "50848739-7e62-4138-9fd3-098a63964b6b"


def _configured_adapter(tmp_path: Path, run, logs: list[str]):
    state_root = tmp_path / "state"
    state_root.mkdir()
    private_path = state_root / "reality.private"
    private_path.write_text("fixture-private-key", encoding="utf-8")
    private_path.chmod(0o600)
    binary = tmp_path / "runtime" / VERSION / "xray"
    server = xray.RealityServerConfig(
        port=443,
        target="www.example.com:443",
        server_names=("www.example.com",),
        short_ids=("0123456789abcdef",),
    )
    return xray.PinnedXrayAdapter(
        install_root=tmp_path / "runtime",
        state_root=state_root,
        download=lambda _url: b"",
        run=run,
        log=logs.append,
        binary=binary,
        server=server,
        authorize_runtime=lambda: None,
        revoke_runtime_authorization=lambda: None,
        reload=lambda: None,
        is_active=lambda: True,
        disable_runtime=lambda: None,
    )


def test_managed_config_enables_per_user_uplink_downlink_and_online_stats(tmp_path: Path) -> None:
    def run(_argv: list[str]):
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    adapter = _configured_adapter(tmp_path, run, [])
    adapter.apply_clients([ManagedClient(client_id=CLIENT_ID, tier="premium", speed_kbps=None)])

    config = json.loads((tmp_path / "state" / "xray-config.json").read_text(encoding="utf-8"))
    assert config["policy"]["levels"]["0"] == {
        "statsUserOnline": True,
        "statsUserUplink": True,
        "statsUserDownlink": True,
    }


def test_read_user_traffic_counters_returns_managed_cumulative_bytes_and_zero_for_missing(tmp_path: Path) -> None:
    calls: list[list[str]] = []
    logs: list[str] = []

    def run(argv: list[str]):
        calls.append(argv)
        if "statsquery" in argv:
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps(
                    {
                        "stat": [
                            {
                                "name": f"user>>>madar:{CLIENT_ID}>>>traffic>>>uplink",
                                "value": 120,
                            },
                            {
                                "name": f"user>>>madar:{CLIENT_ID}>>>traffic>>>downlink",
                                "value": 80,
                            },
                            {
                                "name": "user>>>other-app>>>traffic>>>uplink",
                                "value": 999999,
                            },
                        ]
                    }
                ),
                stderr="",
            )
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    adapter = _configured_adapter(tmp_path, run, logs)
    adapter.apply_clients(
        [
            ManagedClient(client_id=CLIENT_ID, tier="free", speed_kbps=5000),
            ManagedClient(client_id=SECOND_CLIENT_ID, tier="premium", speed_kbps=None),
        ]
    )

    read_counters = getattr(adapter, "read_user_traffic_counters", None)
    assert callable(read_counters), "PinnedXrayAdapter must expose cumulative per-user traffic counters"
    counters = read_counters()

    assert counters[CLIENT_ID].uplink_bytes == 120
    assert counters[CLIENT_ID].downlink_bytes == 80
    assert counters[SECOND_CLIENT_ID].uplink_bytes == 0
    assert counters[SECOND_CLIENT_ID].downlink_bytes == 0
    query = next(call for call in calls if "statsquery" in call)
    assert "user>>>madar:" in query
    assert CLIENT_ID not in query
    assert SECOND_CLIENT_ID not in query
    assert logs == []


def test_read_user_traffic_counters_redacts_malformed_xray_output(tmp_path: Path) -> None:
    raw_identifier = f"user>>>madar:{CLIENT_ID}>>>traffic>>>uplink"
    secretish_output = f"malformed {raw_identifier} bearer-do-not-echo"
    logs: list[str] = []

    def run(argv: list[str]):
        if "statsquery" in argv:
            return SimpleNamespace(returncode=1, stdout=secretish_output, stderr=secretish_output)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    adapter = _configured_adapter(tmp_path, run, logs)
    adapter.apply_clients([ManagedClient(client_id=CLIENT_ID, tier="premium", speed_kbps=None)])

    read_counters = getattr(adapter, "read_user_traffic_counters", None)
    assert callable(read_counters), "PinnedXrayAdapter must expose cumulative per-user traffic counters"
    with pytest.raises(xray.XrayRuntimeError) as exc_info:
        read_counters()

    assert str(exc_info.value) == "Xray traffic observation unavailable"
    assert CLIENT_ID not in str(exc_info.value)
    assert secretish_output not in str(exc_info.value)
    assert all(CLIENT_ID not in line and secretish_output not in line for line in logs)
