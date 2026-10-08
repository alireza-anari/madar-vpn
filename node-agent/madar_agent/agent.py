from __future__ import annotations

import os
import stat
from datetime import datetime
from typing import Callable, Protocol

from .environment import SystemEnvironment
from .models import (
    AgentConfig,
    ApplyResult,
    EnvironmentReport,
    ManagedClient,
    ObservedActivity,
    Policy,
    UsageReport,
)
from .xray import XrayAdapter


class ControlPlaneApi(Protocol):
    def fetch_policy(self, known_revision: int) -> Policy | None: ...


class EnvironmentProbe(Protocol):
    def operating_system(self) -> tuple[str, str]: ...

    def architecture(self) -> str: ...


SUPPORTED_UBUNTU_LTS = frozenset({"22.04", "24.04", "26.04"})
SUPPORTED_ARCHITECTURES = frozenset({"x86_64", "amd64", "aarch64", "arm64"})


class NodeAgent:
    def __init__(
        self,
        config: AgentConfig,
        *,
        api: ControlPlaneApi,
        xray: XrayAdapter,
        environment: EnvironmentProbe | None = None,
        now: Callable[[], datetime],
    ) -> None:
        self.config = config
        self.api = api
        self.xray = xray
        self.environment = environment or SystemEnvironment()
        self._now = now
        self._current_policy: Policy | None = None
        self._window_sequences: dict[str, int] = {}

    def validate_environment(self) -> EnvironmentReport:
        errors: list[str] = []
        distro, version = self.environment.operating_system()
        if distro.lower() != "ubuntu" or version not in SUPPORTED_UBUNTU_LTS:
            errors.append("unsupported_ubuntu")

        if self.environment.architecture().lower() not in SUPPORTED_ARCHITECTURES:
            errors.append("unsupported_architecture")

        path = self.config.credential_path
        try:
            metadata = path.stat()
        except OSError:
            errors.append("credential_missing")
        else:
            mode = stat.S_IMODE(metadata.st_mode)
            if not stat.S_ISREG(metadata.st_mode) or path.is_symlink() or mode & 0o077:
                errors.append("credential_permissions")
            if metadata.st_uid != os.geteuid():
                errors.append("credential_owner")

        return EnvironmentReport(valid=not errors, errors=tuple(errors))

    def fetch_policy(self) -> Policy | None:
        known_revision = self._current_policy.revision if self._current_policy else 0
        policy = self.api.fetch_policy(known_revision)
        if policy is None and self._current_policy is not None and not self.is_authorization_fresh(self._now()):
            self.xray.disable_managed_access()
        return policy

    def apply_policy(self, policy: Policy) -> ApplyResult:
        self._current_policy = policy
        if not self.is_authorization_fresh(self._now()):
            self.xray.disable_managed_access()
            return ApplyResult(
                applied=False,
                disabled=True,
                reason="stale_policy",
                revision=policy.revision,
            )

        managed: list[ManagedClient] = []
        for client in policy.clients:
            if client.tier == "free":
                if client.speed_kbps is None or client.speed_kbps <= 0:
                    self.xray.disable_managed_access()
                    return ApplyResult(
                        applied=False,
                        disabled=True,
                        reason="invalid_policy",
                        revision=policy.revision,
                    )
                speed_kbps = client.speed_kbps
            else:
                if client.speed_kbps is not None:
                    self.xray.disable_managed_access()
                    return ApplyResult(
                        applied=False,
                        disabled=True,
                        reason="invalid_policy",
                        revision=policy.revision,
                    )
                speed_kbps = None

            managed.append(
                ManagedClient(
                    client_id=client.client_id,
                    tier=client.tier,
                    speed_kbps=speed_kbps,
                )
            )

        self.xray.apply_clients(managed)
        return ApplyResult(
            applied=True,
            disabled=False,
            reason="applied",
            revision=policy.revision,
        )

    def collect_usage(self) -> list[UsageReport]:
        reports: list[UsageReport] = []
        for activity in self.xray.collect_observed_activity():
            self._validate_activity(activity)
            sequence = self._window_sequences.get(activity.window_id, 0) + 1
            self._window_sequences[activity.window_id] = sequence
            reports.append(
                UsageReport(
                    client_id=activity.client_id,
                    window_id=activity.window_id,
                    sequence=sequence,
                    seconds=activity.seconds,
                    timestamp=activity.timestamp,
                    observed_from=activity.observed_from,
                    observed_to=activity.observed_to,
                    session_id=activity.session_id,
                )
            )
        return reports

    def is_authorization_fresh(self, now: datetime) -> bool:
        return self._current_policy is not None and now < self._current_policy.valid_until

    @staticmethod
    def _validate_activity(activity: ObservedActivity) -> None:
        if not activity.client_id or not activity.window_id:
            raise ValueError("observed activity identity is required")
        if activity.seconds < 0 or activity.seconds > 86_400:
            raise ValueError("observed activity seconds are out of range")
