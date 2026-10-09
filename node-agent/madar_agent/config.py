from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from .models import AgentConfig
from .xray import XRAY_STABLE_VERSION


@dataclass(frozen=True, slots=True)
class XrayRuntimeSettings:
    binary: Path
    version: str
    port: int
    server_name: str
    reality_target: str
    reality_short_id: str
    max_clients: int


def _required(environment: Mapping[str, str], name: str) -> str:
    value = environment.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


def load_config(environment: Mapping[str, str] | None = None) -> AgentConfig:
    values = os.environ if environment is None else environment
    api_base_url = _required(values, "MADAR_API_BASE_URL").rstrip("/")
    credential_path = Path(_required(values, "MADAR_NODE_CREDENTIAL_PATH"))
    raw_timeout = values.get("MADAR_REQUEST_TIMEOUT_SECONDS", "10").strip()
    try:
        timeout = float(raw_timeout)
    except ValueError as error:
        raise ValueError("MADAR_REQUEST_TIMEOUT_SECONDS must be numeric") from error

    return AgentConfig(
        api_base_url=api_base_url,
        credential_path=credential_path,
        request_timeout_seconds=timeout,
    )


def load_runtime_config(environment: Mapping[str, str] | None = None) -> XrayRuntimeSettings:
    values = os.environ if environment is None else environment
    binary = Path(_required(values, "MADAR_XRAY_BINARY"))
    if not binary.is_absolute():
        raise ValueError("MADAR_XRAY_BINARY must be an absolute path")

    version = _required(values, "MADAR_XRAY_VERSION")
    if version != XRAY_STABLE_VERSION:
        raise ValueError("MADAR_XRAY_VERSION must match pinned Xray version")

    try:
        port = int(_required(values, "MADAR_NODE_PORT"))
    except ValueError as error:
        raise ValueError("MADAR_NODE_PORT must be an integer") from error
    if port < 1 or port > 65535:
        raise ValueError("MADAR_NODE_PORT must be between 1 and 65535")

    server_name = _required(values, "MADAR_NODE_SERVER_NAME")
    reality_target = _required(values, "MADAR_REALITY_TARGET")
    reality_short_id = _required(values, "MADAR_REALITY_SHORT_ID")

    raw_max_clients = values.get("MADAR_NODE_MAX_CLIENTS", "128").strip()
    try:
        max_clients = int(raw_max_clients)
    except ValueError as error:
        raise ValueError("MADAR_NODE_MAX_CLIENTS must be an integer") from error
    if max_clients <= 0:
        raise ValueError("MADAR_NODE_MAX_CLIENTS must be positive")

    return XrayRuntimeSettings(
        binary=binary,
        version=version,
        port=port,
        server_name=server_name,
        reality_target=reality_target,
        reality_short_id=reality_short_id,
        max_clients=max_clients,
    )
