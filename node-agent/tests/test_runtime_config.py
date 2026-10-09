from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.config import load_runtime_config


def test_load_runtime_config_requires_pinned_xray_and_explicit_reality_settings(tmp_path: Path) -> None:
    binary = tmp_path / "opt" / "madar-xray" / "26.3.27" / "xray"
    loaded = load_runtime_config({
        "MADAR_XRAY_BINARY": str(binary),
        "MADAR_XRAY_VERSION": "26.3.27",
        "MADAR_NODE_PORT": "443",
        "MADAR_NODE_SERVER_NAME": "edge.example.test",
        "MADAR_REALITY_TARGET": "origin.example.test:443",
        "MADAR_REALITY_SHORT_ID": "0123456789abcdef",
        "MADAR_NODE_MAX_CLIENTS": "128",
    })

    assert loaded.binary == binary
    assert loaded.version == "26.3.27"
    assert loaded.port == 443
    assert loaded.server_name == "edge.example.test"
    assert loaded.reality_target == "origin.example.test:443"
    assert loaded.reality_short_id == "0123456789abcdef"
    assert loaded.max_clients == 128

    with pytest.raises(ValueError, match="MADAR_REALITY_TARGET"):
        load_runtime_config({
            "MADAR_XRAY_BINARY": str(binary),
            "MADAR_XRAY_VERSION": "26.3.27",
            "MADAR_NODE_PORT": "443",
            "MADAR_NODE_SERVER_NAME": "edge.example.test",
            "MADAR_REALITY_SHORT_ID": "0123456789abcdef",
        })

    with pytest.raises(ValueError, match="pinned"):
        load_runtime_config({
            "MADAR_XRAY_BINARY": str(binary),
            "MADAR_XRAY_VERSION": "unexpected-version",
            "MADAR_NODE_PORT": "443",
            "MADAR_NODE_SERVER_NAME": "edge.example.test",
            "MADAR_REALITY_TARGET": "origin.example.test:443",
            "MADAR_REALITY_SHORT_ID": "0123456789abcdef",
        })
