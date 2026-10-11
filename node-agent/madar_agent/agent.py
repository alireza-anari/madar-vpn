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
    SpeedRouteCredential,
    UsageReport,
)
from .speed import MAX_SPEED_KBPS
from .xray import XrayAdapter


class ControlPlaneApi(Protocol):
    def fetch_policy(self, known_revision: int) -> Policy | None: ...


class EnvironmentProbe(Protocol):
    def operating_system(self) -> tuple[str, str]: ...

    def architecture(self) -> str: ...


class TelemetryOutboxApi(Protocol):
    def prepare_reports(self) -> list[UsageReport]: ...

    def acknowledge(self, reports: list[UsageReport]) -> None: ...


class SpeedEnforcerRuntime(Protocol):
    @property
    def required(self) -> bool: ...

    def apply_clients(
        self,
        clients: list[ManagedClient],
        generation: int,
    ) -> dict[str, SpeedRouteCredential]: ...

    def disable_managed_access(self) -> None: ...

    def health(self, expected_generation: int) -> bool: ...


SUPPORTED_UBUNTU_LTS = frozenset({"22.04", "24.04", "26.04"})
SUPPORTED_ARCHITECTURES = frozenset({"x86_64", "amd64", "aarch64", "arm64"})


class NodeAgent:
    def __init__(
        self,
        config: AgentConfig,
        *,
        api: ControlPlaneApi,
        xray: XrayAdapter,
        speed_enforcer: SpeedEnforcerRuntime,
        environment: EnvironmentProbe | None = None,
        now: Callable[[], datetime],
        outbox: TelemetryOutboxApi | None = None,
    ) -> None:
        self.config = config
        self.api = api
        self.xray = xray
        self.speed_enforcer = speed_enforcer
        self.environment = environment or SystemEnvironment()
        self._now = now
        self._outbox = outbox
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
        # Persisted runtime state is not authorization after a service restart.
        # Expired state must close before a network call can block or retry.
        disabled = not self.is_authorization_fresh(self._now())
        if disabled:
            self.disable_managed_access()
        try:
            return self.api.fetch_policy(known_revision)
        finally:
            # The deadline can pass during the HTTP/retry budget, including
            # when that operation raises and the service skips its heartbeat.
            if not disabled and not self.is_authorization_fresh(self._now()):
                self.disable_managed_access()

    def apply_policy(self, policy: Policy) -> ApplyResult:
        # Candidate freshness is checked directly. The current policy must not
        # advance until both managed runtimes and the final sidecar prune pass.
        if self._now() >= policy.valid_until:
            self.disable_managed_access()
            return ApplyResult(
                applied=False,
                disabled=True,
                reason="stale_policy",
                revision=policy.revision,
            )

        try:
            candidate = self._managed_clients(policy)
        except ValueError:
            self.disable_managed_access()
            return ApplyResult(
                applied=False,
                disabled=True,
                reason="invalid_policy",
                revision=policy.revision,
            )

        # Normative two-phase sidecar membership:
        #   current_free ∪ candidate_free -> Xray switch -> candidate_free only.
        # This keeps the previous capped identity usable until Xray no longer
        # accepts/routes it, while preparing every new Free identity first.
        staged_free = self._staged_free_clients(candidate)
        try:
            staged_routes = self.speed_enforcer.apply_clients(
                staged_free,
                policy.revision,
            )
            candidate_free_ids = {
                client.client_id for client in candidate if client.tier == "free"
            }
            candidate_routes = {
                client_id: credential
                for client_id, credential in staged_routes.items()
                if client_id in candidate_free_ids
            }
            if set(candidate_routes) != candidate_free_ids:
                raise RuntimeError("candidate Free speed routes are incomplete")

            self.xray.apply_clients(candidate, candidate_routes)

            # Prune old aliases only after Xray has switched. Re-applying the
            # candidate policy with the same generation is intentional.
            self.speed_enforcer.apply_clients(candidate, policy.revision)
            if not self._candidate_runtime_health(policy.revision):
                raise RuntimeError("candidate managed runtime health verification failed")
        except Exception:
            self.disable_managed_access()
            raise

        self._current_policy = policy
        return ApplyResult(
            applied=True,
            disabled=False,
            reason="applied",
            revision=policy.revision,
        )

    def disable_managed_access(self) -> None:
        # Xray closes first so a Free route cannot become a direct/uncapped path
        # while the limiter is being removed. Always attempt both shutdowns.
        xray_error: Exception | None = None
        speed_error: Exception | None = None
        try:
            self.xray.disable_managed_access()
        except Exception as exc:
            xray_error = exc
        try:
            self.speed_enforcer.disable_managed_access()
        except Exception as exc:
            speed_error = exc
        if xray_error is not None or speed_error is not None:
            raise RuntimeError("managed runtime shutdown could not be verified") from None

    def runtime_health(self) -> bool:
        try:
            if not self.xray.health():
                return False
        except Exception:
            return False
        if not self.speed_enforcer.required:
            return True
        policy = self._current_policy
        if policy is None:
            return False
        try:
            return self.speed_enforcer.health(policy.revision) is True
        except Exception:
            return False

    def collect_usage(self) -> list[UsageReport]:
        if self._outbox is not None:
            return self._outbox.prepare_reports()

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

    def acknowledge_usage(self, reports: list[UsageReport]) -> None:
        if self._outbox is not None:
            self._outbox.acknowledge(reports)

    def is_authorization_fresh(self, now: datetime) -> bool:
        return self._current_policy is not None and now < self._current_policy.valid_until

    def _managed_clients(self, policy: Policy) -> list[ManagedClient]:
        managed: list[ManagedClient] = []
        seen: set[str] = set()
        for client in policy.clients:
            if not isinstance(client.client_id, str) or not client.client_id or client.client_id in seen:
                raise ValueError("managed Client identity is invalid or duplicated")
            seen.add(client.client_id)

            if client.tier == "free":
                value = client.speed_kbps
                if (
                    isinstance(value, bool)
                    or not isinstance(value, int)
                    or value < 1
                    or value > MAX_SPEED_KBPS
                ):
                    raise ValueError("Free Client speed policy is invalid")
                speed_kbps: int | None = value
            elif client.tier == "premium":
                if client.speed_kbps is not None:
                    raise ValueError("Premium Client must not have a Madar speed cap")
                speed_kbps = None
            else:
                raise ValueError("managed Client tier is invalid")

            managed.append(
                ManagedClient(
                    client_id=client.client_id,
                    tier=client.tier,
                    speed_kbps=speed_kbps,
                )
            )
        return managed

    def _staged_free_clients(self, candidate: list[ManagedClient]) -> list[ManagedClient]:
        by_id: dict[str, ManagedClient] = {}
        if self._current_policy is not None:
            for client in self._managed_clients(self._current_policy):
                if client.tier == "free":
                    by_id[client.client_id] = client
        # Candidate values win when the identity is unchanged but the rate is
        # updated; rotated identities remain alongside their predecessor.
        for client in candidate:
            if client.tier == "free":
                by_id[client.client_id] = client
        return [by_id[client_id] for client_id in sorted(by_id)]

    def _candidate_runtime_health(self, revision: int) -> bool:
        try:
            if not self.xray.health():
                return False
        except Exception:
            return False
        if not self.speed_enforcer.required:
            return True
        try:
            return self.speed_enforcer.health(revision) is True
        except Exception:
            return False

    @staticmethod
    def _validate_activity(activity: ObservedActivity) -> None:
        if not activity.client_id or not activity.window_id:
            raise ValueError("observed activity identity is required")
        if activity.seconds < 0 or activity.seconds > 86_400:
            raise ValueError("observed activity seconds are out of range")
