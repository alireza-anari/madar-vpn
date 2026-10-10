from __future__ import annotations

import signal
import subprocess
import sys
from datetime import UTC, datetime
from threading import Event, Thread
from typing import Callable

from .activity import XrayTrafficActivitySource, next_utc_second_boundary
from .agent import NodeAgent
from .api import ControlPlaneClient, PermanentApiError
from .config import load_config, load_runtime_config
from .lifecycle import SystemdXrayLifecycle
from .outbox import TelemetryOutbox
from .retry import RetryExhausted
from .xray import PinnedXrayAdapter, RealityServerConfig


STOP = Event()
AGENT_VERSION = "0.1.0"
XRAY_SERVICE_NAME = "madar-xray.service"


class ActivitySamplerWorker:
    def __init__(
        self,
        *,
        source,
        interval_seconds: float = 1.0,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if interval_seconds <= 0:
            raise ValueError("interval_seconds must be positive")
        self._source = source
        # Kept as a lifecycle timeout/compatibility bound. Sampling cadence is
        # determined from UTC wall-clock boundaries, not repeated relative waits.
        self._interval_seconds = interval_seconds
        self._now = now or (lambda: datetime.now(UTC))
        self._stop = Event()
        self._thread: Thread | None = None

    @property
    def running(self) -> bool:
        thread = self._thread
        return bool(thread is not None and thread.is_alive())

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        thread = Thread(
            target=self._run,
            name="madar-xray-activity-sampler",
            daemon=True,
        )
        self._thread = thread
        thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is None:
            return
        thread.join(timeout=max(5.0, self._interval_seconds + 1.0))
        if thread.is_alive():
            raise RuntimeError("activity sampler did not stop")
        self._thread = None

    def _run(self) -> None:
        while not self._stop.is_set():
            current = self._now()
            boundary = next_utc_second_boundary(current)
            delay = max(0.0, (boundary - current).total_seconds())
            if self._stop.wait(delay):
                return
            try:
                self._source.sample(bucket_end=boundary)
            except Exception:
                self._source.invalidate()


class AgentService:
    def __init__(
        self,
        *,
        agent,
        control_plane,
        runtime_health: Callable[[], bool],
        disable_access: Callable[[], None],
        now: Callable[[], datetime],
        versions: dict[str, object],
        max_clients: int,
        activity_worker=None,
    ) -> None:
        if max_clients <= 0:
            raise ValueError("max_clients must be positive")
        self._agent = agent
        self._control_plane = control_plane
        self._runtime_health = runtime_health
        self._disable_access = disable_access
        self._now = now
        self._versions = dict(versions)
        self._max_clients = max_clients
        self._active_clients = 0
        self._activity_worker = activity_worker

    def start_activity_sampling(self) -> None:
        if self._activity_worker is not None:
            self._activity_worker.start()

    def stop_activity_sampling(self) -> None:
        if self._activity_worker is not None:
            self._activity_worker.stop()

    def run_cycle(self) -> None:
        environment = self._agent.validate_environment()
        if not environment.valid:
            self._disable_access()
            self._active_clients = 0
            self._control_plane.heartbeat(
                health={"healthy": False, "ready": False},
                versions=self._versions,
                capacity={
                    "accepting": False,
                    "activeClients": 0,
                    "maxClients": self._max_clients,
                },
            )
            return

        policy_state_valid = True
        policy = self._agent.fetch_policy()
        if policy is not None:
            result = self._agent.apply_policy(policy)
            policy_state_valid = bool(result.applied)
            if result.applied:
                self._active_clients = len(policy.clients)
                self._control_plane.ack_policy(policy.revision)
            elif result.disabled:
                self._active_clients = 0

        reports = list(self._agent.collect_usage())
        if reports:
            has_active_second_report = any(report.active_seconds_hex is not None for report in reports)
            can_post = True
            if has_active_second_report:
                can_post = bool(self._control_plane.supports_active_second_telemetry())
            if can_post:
                self._control_plane.post_telemetry(reports)
                self._agent.acknowledge_usage(reports)

        runtime_healthy = bool(self._runtime_health())
        ready = (
            runtime_healthy
            and policy_state_valid
            and bool(self._agent.is_authorization_fresh(self._now()))
        )
        active_clients = self._active_clients if ready else 0
        self._control_plane.heartbeat(
            health={"healthy": runtime_healthy, "ready": ready},
            versions=self._versions,
            capacity={
                "accepting": ready,
                "activeClients": active_clients,
                "maxClients": self._max_clients,
            },
        )


def _run_process(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def _restart_xray() -> None:
    result = _run_process(["systemctl", "restart", XRAY_SERVICE_NAME])
    if result.returncode != 0:
        raise RuntimeError("managed Xray restart failed")


def _stop_xray() -> None:
    result = _run_process(["systemctl", "stop", XRAY_SERVICE_NAME])
    if result.returncode != 0:
        raise RuntimeError("managed Xray stop failed")


def _xray_is_active() -> bool:
    return _run_process(["systemctl", "is-active", "--quiet", XRAY_SERVICE_NAME]).returncode == 0


def build_xray_lifecycle() -> SystemdXrayLifecycle:
    return SystemdXrayLifecycle(run=_run_process)


def _runtime_download_forbidden(_url: str) -> bytes:
    raise RuntimeError("Xray runtime download is installer-only")


def build_agent_service(*, lifecycle=None) -> AgentService:
    config = load_config()
    runtime = load_runtime_config()
    client = ControlPlaneClient(config)
    server = RealityServerConfig(
        port=runtime.port,
        target=runtime.reality_target,
        server_names=(runtime.server_name,),
        short_ids=(runtime.reality_short_id,),
    )
    now = lambda: datetime.now(UTC)
    outbox = TelemetryOutbox(config.credential_path.parent / "telemetry-outbox.sqlite3")
    xray_holder: dict[str, PinnedXrayAdapter] = {}
    xray_lifecycle = lifecycle if lifecycle is not None else build_xray_lifecycle()

    def read_counters():
        return xray_holder["adapter"].read_user_traffic_counters()

    activity_source = XrayTrafficActivitySource(
        read_counters=read_counters,
        now=now,
        record_active_bucket=outbox.record_active_bucket,
    )
    xray = PinnedXrayAdapter(
        install_root=runtime.binary.parents[1],
        state_root=config.credential_path.parent,
        download=_runtime_download_forbidden,
        run=_run_process,
        binary=runtime.binary,
        server=server,
        authorize_runtime=xray_lifecycle.grant_authorization,
        revoke_runtime_authorization=xray_lifecycle.revoke_authorization,
        reload=xray_lifecycle.restart_authorized,
        is_active=xray_lifecycle.is_active,
        disable_runtime=xray_lifecycle.disable,
        activity_source=activity_source.drain,
    )
    xray_holder["adapter"] = xray
    activity_worker = ActivitySamplerWorker(
        source=activity_source,
        interval_seconds=1.0,
    )
    agent = NodeAgent(
        config,
        api=client,
        xray=xray,
        now=now,
        outbox=outbox,
    )
    return AgentService(
        agent=agent,
        control_plane=client,
        runtime_health=xray.health,
        disable_access=xray.disable_managed_access,
        now=now,
        versions={"agent": AGENT_VERSION, "xray": runtime.version},
        max_clients=runtime.max_clients,
        activity_worker=activity_worker,
    )


def _stop(_signum, _frame) -> None:
    STOP.set()


def main() -> int:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    # Persisted Xray config is never authorization for a fresh Agent process.
    # Stop the runtime before reading local state or contacting the control plane;
    # the first cycle will promote/restart only a freshly validated managed config.
    try:
        _stop_xray()
    except Exception:
        print("node-agent startup unavailable; managed Xray stop failed", file=sys.stderr)
        return 4

    try:
        service = build_agent_service()
    except Exception:
        print("node-agent startup unavailable; managed Xray disabled", file=sys.stderr)
        return 3

    start_activity_sampling = getattr(service, "start_activity_sampling", None)
    stop_activity_sampling = getattr(service, "stop_activity_sampling", None)
    if callable(start_activity_sampling):
        start_activity_sampling()

    try:
        while not STOP.is_set():
            try:
                service.run_cycle()
            except PermanentApiError as error:
                print(f"node-agent cycle rejected: HTTP {error.status}", file=sys.stderr)
                return 2
            except RetryExhausted:
                print("node-agent cycle temporarily unavailable", file=sys.stderr)

            STOP.wait(30.0)
    finally:
        if callable(stop_activity_sampling):
            stop_activity_sampling()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
