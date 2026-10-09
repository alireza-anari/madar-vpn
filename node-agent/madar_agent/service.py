from __future__ import annotations

import signal
import sys
from datetime import datetime
from threading import Event
from typing import Callable

from .api import ControlPlaneClient, PermanentApiError
from .config import load_config
from .retry import RetryExhausted


STOP = Event()


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

        policy = self._agent.fetch_policy()
        if policy is not None:
            result = self._agent.apply_policy(policy)
            if result.applied:
                self._active_clients = len(policy.clients)
                self._control_plane.ack_policy(policy.revision)
            elif result.disabled:
                self._active_clients = 0

        reports = self._agent.collect_usage()
        if reports:
            self._control_plane.post_telemetry(reports)

        runtime_healthy = bool(self._runtime_health())
        ready = runtime_healthy and bool(self._agent.is_authorization_fresh(self._now()))
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


def _stop(_signum, _frame) -> None:
    STOP.set()


def main() -> int:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    config = load_config()
    client = ControlPlaneClient(config)

    while not STOP.is_set():
        try:
            client.heartbeat(
                health={"healthy": True, "ready": False},
                versions={"agent": "0.1.0", "xray": "unavailable"},
                capacity={"accepting": False, "activeClients": 0, "maxClients": 1},
            )
        except PermanentApiError as error:
            print(f"node-agent heartbeat rejected: HTTP {error.status}", file=sys.stderr)
            return 2
        except RetryExhausted:
            print("node-agent heartbeat temporarily unavailable", file=sys.stderr)

        STOP.wait(30.0)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
