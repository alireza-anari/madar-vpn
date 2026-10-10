from __future__ import annotations

from pathlib import Path
from time import sleep as default_sleep
from typing import Callable, Protocol


class ProcessResult(Protocol):
    returncode: int
    stdout: str
    stderr: str


class XrayLifecycleError(RuntimeError):
    pass


class SystemdXrayLifecycle:
    def __init__(
        self,
        *,
        run: Callable[[list[str]], ProcessResult],
        marker_path: Path = Path("/run/madar-node-agent/xray-authorized"),
        sleep: Callable[[float], None] = default_sleep,
        poll_attempts: int = 3,
        poll_interval_seconds: float = 0.1,
    ) -> None:
        self._run = run
        self._marker_path = Path(marker_path)
        self._sleep = sleep
        self._poll_attempts = poll_attempts
        self._poll_interval_seconds = poll_interval_seconds

    def grant_authorization(self) -> None:
        raise NotImplementedError

    def revoke_authorization(self) -> None:
        raise NotImplementedError

    def authorization_granted(self) -> bool:
        raise NotImplementedError

    def is_active(self) -> bool:
        raise NotImplementedError

    def ensure_inactive(self) -> None:
        raise NotImplementedError

    def restart_authorized(self) -> None:
        raise NotImplementedError

    def disable(self) -> None:
        raise NotImplementedError
