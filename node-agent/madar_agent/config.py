from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

from .models import AgentConfig


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
