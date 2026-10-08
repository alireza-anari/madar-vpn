from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.config import load_config


def test_load_config_requires_https_and_explicit_credential_path(tmp_path: Path) -> None:
    credential = tmp_path / "node.credential"
    loaded = load_config({
        "MADAR_API_BASE_URL": "https://control.example.test/",
        "MADAR_NODE_CREDENTIAL_PATH": str(credential),
        "MADAR_REQUEST_TIMEOUT_SECONDS": "8.5",
    })

    assert loaded.api_base_url == "https://control.example.test"
    assert loaded.credential_path == credential
    assert loaded.request_timeout_seconds == 8.5

    with pytest.raises(ValueError, match="MADAR_API_BASE_URL"):
        load_config({"MADAR_NODE_CREDENTIAL_PATH": str(credential)})

    with pytest.raises(ValueError, match="HTTPS"):
        load_config({
            "MADAR_API_BASE_URL": "http://control.example.test",
            "MADAR_NODE_CREDENTIAL_PATH": str(credential),
        })
