from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path
from time import sleep as default_sleep
from typing import Callable, Protocol, TypeVar


XRAY_SERVICE_NAME = "madar-xray.service"
SPEED_ENFORCER_SERVICE_NAME = "madar-speed-enforcer.service"
_AUTHORIZATION_CONTENT = "authorized\n"


class ProcessResult(Protocol):
    returncode: int
    stdout: str
    stderr: str


class XrayLifecycleError(RuntimeError):
    pass


class SpeedEnforcerLifecycleError(RuntimeError):
    pass


LifecycleError = TypeVar("LifecycleError", bound=RuntimeError)


class _SystemdManagedLifecycle:
    def __init__(
        self,
        *,
        run: Callable[[list[str]], ProcessResult],
        service_name: str,
        marker_path: Path,
        runtime_label: str,
        error_type: type[RuntimeError],
        sleep: Callable[[float], None] = default_sleep,
        poll_attempts: int = 3,
        poll_interval_seconds: float = 0.1,
    ) -> None:
        if poll_attempts <= 0:
            raise ValueError("poll_attempts must be positive")
        if poll_interval_seconds < 0:
            raise ValueError("poll_interval_seconds must be non-negative")
        self._run = run
        self._service_name = service_name
        self._marker_path = Path(marker_path)
        self._runtime_label = runtime_label
        self._error_type = error_type
        self._sleep = sleep
        self._poll_attempts = poll_attempts
        self._poll_interval_seconds = poll_interval_seconds

    def _error(self, message: str) -> RuntimeError:
        return self._error_type(message)

    def grant_authorization(self) -> None:
        parent = self._marker_path.parent
        try:
            parent_metadata = parent.lstat()
        except OSError as exc:
            raise self._error(
                f"{self._runtime_label} runtime authorization directory unavailable"
            ) from exc
        if not stat.S_ISDIR(parent_metadata.st_mode) or parent.is_symlink():
            raise self._error(
                f"{self._runtime_label} runtime authorization directory unavailable"
            )

        try:
            existing = self._marker_path.lstat()
        except FileNotFoundError:
            existing = None
        except OSError as exc:
            raise self._error(
                f"{self._runtime_label} runtime authorization marker unavailable"
            ) from exc
        if existing is not None and (
            stat.S_ISLNK(existing.st_mode) or not stat.S_ISREG(existing.st_mode)
        ):
            raise self._error(
                f"{self._runtime_label} runtime authorization marker unavailable"
            )

        fd = -1
        temporary: Path | None = None
        try:
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self._marker_path.name}.",
                dir=parent,
            )
            temporary = Path(temporary_name)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                fd = -1
                handle.write(_AUTHORIZATION_CONTENT)
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(self._marker_path)
            self._marker_path.chmod(0o600)
        except OSError as exc:
            raise self._error(
                f"{self._runtime_label} runtime authorization marker unavailable"
            ) from exc
        finally:
            if fd >= 0:
                os.close(fd)
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def revoke_authorization(self) -> None:
        try:
            metadata = self._marker_path.lstat()
        except FileNotFoundError:
            return
        except OSError as exc:
            raise self._error(
                f"{self._runtime_label} runtime authorization marker unavailable"
            ) from exc

        if stat.S_ISDIR(metadata.st_mode):
            raise self._error(
                f"{self._runtime_label} runtime authorization marker unavailable"
            )
        try:
            self._marker_path.unlink()
        except FileNotFoundError:
            return
        except OSError as exc:
            raise self._error(
                f"{self._runtime_label} runtime authorization marker unavailable"
            ) from exc

    def authorization_granted(self) -> bool:
        try:
            metadata = self._marker_path.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                return False
            if stat.S_IMODE(metadata.st_mode) & 0o077:
                return False
            return self._marker_path.read_text(encoding="utf-8") == _AUTHORIZATION_CONTENT
        except OSError:
            return False

    def is_active(self) -> bool:
        try:
            result = self._run(
                [
                    "systemctl",
                    "show",
                    self._service_name,
                    "--property=ActiveState",
                    "--property=SubState",
                    "--property=MainPID",
                    "--no-pager",
                ]
            )
        except Exception:
            raise self._error(
                f"managed {self._runtime_label} state unavailable"
            ) from None

        if result.returncode != 0:
            raise self._error(f"managed {self._runtime_label} state unavailable")

        values: dict[str, str] = {}
        for line in result.stdout.splitlines():
            if "=" not in line:
                raise self._error(f"managed {self._runtime_label} state unavailable")
            key, value = line.split("=", 1)
            if key in values:
                raise self._error(f"managed {self._runtime_label} state unavailable")
            values[key] = value

        if set(values) != {"ActiveState", "SubState", "MainPID"}:
            raise self._error(f"managed {self._runtime_label} state unavailable")
        try:
            main_pid = int(values["MainPID"], 10)
        except ValueError:
            raise self._error(f"managed {self._runtime_label} state unavailable") from None
        if main_pid < 0:
            raise self._error(f"managed {self._runtime_label} state unavailable")

        active_state = values["ActiveState"]
        if active_state in {"inactive", "failed"} and main_pid == 0:
            return False
        if active_state == "active" and main_pid > 0:
            return True
        raise self._error(f"managed {self._runtime_label} state unavailable")

    def ensure_inactive(self) -> None:
        revoke_error: RuntimeError | None = None
        try:
            self.revoke_authorization()
        except RuntimeError as exc:
            revoke_error = exc

        try:
            self._run(["systemctl", "stop", self._service_name])
        except Exception:
            pass

        if self._verified_inactive():
            if revoke_error is not None:
                raise self._error(
                    f"managed {self._runtime_label} authorization could not be revoked"
                )
            return

        try:
            self._run(
                [
                    "systemctl",
                    "kill",
                    "--kill-who=all",
                    "--signal=SIGKILL",
                    self._service_name,
                ]
            )
        except Exception:
            pass

        for attempt in range(self._poll_attempts):
            if self._verified_inactive():
                if revoke_error is not None:
                    raise self._error(
                        f"managed {self._runtime_label} authorization could not be revoked"
                    )
                return
            if attempt + 1 < self._poll_attempts:
                self._sleep(self._poll_interval_seconds)

        raise self._error(
            f"managed {self._runtime_label} shutdown could not be verified"
        )

    def restart_authorized(self) -> None:
        if not self.authorization_granted():
            raise self._error(
                f"managed {self._runtime_label} runtime is not authorized"
            )

        restart_succeeded = False
        try:
            result = self._run(["systemctl", "restart", self._service_name])
            restart_succeeded = result.returncode == 0
        except Exception:
            restart_succeeded = False

        if restart_succeeded:
            try:
                if self.is_active():
                    return
            except RuntimeError:
                pass

        try:
            self.revoke_authorization()
        except RuntimeError:
            pass
        try:
            self.ensure_inactive()
        except RuntimeError:
            pass
        raise self._error(
            f"managed {self._runtime_label} authorized restart failed"
        )

    def disable(self) -> None:
        self.ensure_inactive()

    def _verified_inactive(self) -> bool:
        try:
            return not self.is_active()
        except RuntimeError:
            return False


class SystemdXrayLifecycle(_SystemdManagedLifecycle):
    def __init__(
        self,
        *,
        run: Callable[[list[str]], ProcessResult],
        marker_path: Path = Path("/run/madar-node-agent/xray-authorized"),
        sleep: Callable[[float], None] = default_sleep,
        poll_attempts: int = 3,
        poll_interval_seconds: float = 0.1,
    ) -> None:
        super().__init__(
            run=run,
            service_name=XRAY_SERVICE_NAME,
            marker_path=marker_path,
            runtime_label="Xray",
            error_type=XrayLifecycleError,
            sleep=sleep,
            poll_attempts=poll_attempts,
            poll_interval_seconds=poll_interval_seconds,
        )


class SystemdSpeedEnforcerLifecycle(_SystemdManagedLifecycle):
    def __init__(
        self,
        *,
        run: Callable[[list[str]], ProcessResult],
        marker_path: Path = Path("/run/madar-node-agent/speed-enforcer-authorized"),
        sleep: Callable[[float], None] = default_sleep,
        poll_attempts: int = 3,
        poll_interval_seconds: float = 0.1,
    ) -> None:
        super().__init__(
            run=run,
            service_name=SPEED_ENFORCER_SERVICE_NAME,
            marker_path=marker_path,
            runtime_label="Speed Enforcer",
            error_type=SpeedEnforcerLifecycleError,
            sleep=sleep,
            poll_attempts=poll_attempts,
            poll_interval_seconds=poll_interval_seconds,
        )
