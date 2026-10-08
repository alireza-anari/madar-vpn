from __future__ import annotations

import signal
import sys
import time
from threading import Event

from .api import ControlPlaneClient, PermanentApiError
from .config import load_config
from .retry import RetryExhausted


STOP = Event()


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
