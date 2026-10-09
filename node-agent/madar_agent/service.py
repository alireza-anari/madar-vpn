from __future__ import annotations

import signal
import subprocess
import sys
from datetime import UTC, datetime
from threading import Event
from typing import Callable

from .agent import NodeAgent
from .api import ControlPlaneClient, PermanentApiError
from .config import load_config, load_runtime_config
from .retry import RetryExhausted
from .xray import PinnedXrayAdapter, RealityServerConfig


STOP = Event()
AGENT_VERSION = "0.1.0"
XRAY_SERVICE_NAME = "madar-xray.service"


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

        reports = self._agent.collect_usage()
        if reports:
            self._control_plane.post_telemetry(reports)

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


def _xray_is_active() -> bool:
    return _run_process(["systemctl", "is-active", "--quiet", XRAY_SERVICE_NAME]).returncode == 0


def _runtime_download_forbidden(_url: str) -> bytes:
    raise RuntimeError("Xray runtime download is installer-only")


def build_agent_service() -> AgentService:
    config = load_config()
    runtime = load_runtime_config()
    client = ControlPlaneClient(config)
    server = RealityServerConfig(
        port=runtime.port,
        target=runtime.reality_target,
        server_names=(runtime.server_name,),
        short_ids=(runtime.reality_short_id,),
    )
    xray = PinnedXrayAdapter(
        install_root=runtime.binary.parents[1],
        state_root=config.credential_path.parent,
        download=_runtime_download_forbidden,
        run=_run_process,
        binary=runtime.binary,
        server=server,
        reload=_restart_xray,
        is_active=_xray_is_active,
    )
    now = lambda: datetime.now(UTC)
    agent = NodeAgent(
        config,
        api=client,
        xray=xray,
        now=now,
    )
    return AgentService(
        agent=agent,
        control_plane=client,
        runtime_health=xray.health,
        disable_access=xray.disable_managed_access,
        now=now,
        versions={"agent": AGENT_VERSION, "xray": runtime.version},
        max_clients=runtime.max_clients,
    )


def _stop(_signum, _frame) -> None:
    STOP.set()


def main() -> int:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    service = build_agent_service()

    while not STOP.is_set():
        try:
            service.run_cycle()
        except PermanentApiError as error:
            print(f"node-agent cycle rejected: HTTP {error.status}", file=sys.stderr)
            return 2
        except RetryExhausted:
            print("node-agent cycle temporarily unavailable", file=sys.stderr)

        STOP.wait(30.0)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
