from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal


Tier = Literal["free", "premium"]


@dataclass(frozen=True, slots=True)
class AgentConfig:
    api_base_url: str
    credential_path: Path
    request_timeout_seconds: float = 10.0

    def __post_init__(self) -> None:
        if not self.api_base_url.startswith("https://"):
            raise ValueError("api_base_url must use HTTPS")
        if self.request_timeout_seconds <= 0 or self.request_timeout_seconds > 60:
            raise ValueError("request_timeout_seconds is out of range")


@dataclass(frozen=True, slots=True)
class EnvironmentReport:
    valid: bool
    errors: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class PolicyClient:
    user_id: str
    policy_revision: int
    client_id: str
    tier: Tier
    speed_kbps: int | None


@dataclass(frozen=True, slots=True)
class Policy:
    revision: int
    valid_until: datetime
    clients: tuple[PolicyClient, ...]


@dataclass(frozen=True, slots=True)
class ManagedClient:
    client_id: str
    tier: Tier
    speed_kbps: int | None


@dataclass(frozen=True, slots=True)
class ApplyResult:
    applied: bool
    disabled: bool
    reason: str
    revision: int | None


@dataclass(frozen=True, slots=True)
class ObservedActivity:
    client_id: str
    window_id: str
    seconds: int
    timestamp: datetime
    observed_from: datetime | None = None
    observed_to: datetime | None = None
    session_id: str | None = None


@dataclass(frozen=True, slots=True)
class UsageReport:
    client_id: str
    window_id: str
    sequence: int
    seconds: int
    timestamp: datetime
    observed_from: datetime | None = None
    observed_to: datetime | None = None
    session_id: str | None = None
