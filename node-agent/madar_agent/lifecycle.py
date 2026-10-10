from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path
from time import sleep as default_sleep
from typing import Callable, Protocol


XRAY_SERVICE_NAME = "madar-xray.service"
_AUTHORIZATION_CONTENT = "authorized\n"


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
        if poll_attempts <= 0:
            raise ValueError("poll_attempts must be positive")
        if poll_interval_seconds < 0:
            raise ValueError("poll_interval_seconds must be non-negative")
        self._run = run
        self._marker_path = Path(marker_path)
        self._sleep = sleep
        self._poll_attempts = poll_attempts
        self._poll_interval_seconds = poll_interval_seconds

    def grant_authorization(self) -> None:
        parent = self._marker_path.parent
        try:
            parent_metadata = parent.lstat()
        except OSError as exc:
            raise XrayLifecycleError("Xray runtime authorization directory unavailable") from exc
        if not stat.S_ISDIR(parent_metadata.st_mode) or parent.is_symlink():
            raise XrayLifecycleError("Xray runtime authorization directory unavailable")

        try:
            existing = self._marker_path.lstat()
        except FileNotFoundError:
            existing = None
        except OSError as exc:
            raise XrayLifecycleError("Xray runtime authorization marker unavailable") from exc
        if existing is not None and (
            stat.S_ISLNK(existing.st_mode) or not stat.S_ISREG(existing.st_mode)
        ):
            raise XrayLifecycleError("Xray runtime authorization marker unavailable")

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
            raise XrayLifecycleError("Xray runtime authorization marker unavailable") from exc
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
            raise XrayLifecycleError("Xray runtime authorization marker unavailable") from exc

        if stat.S_ISDIR(metadata.st_mode):
            raise XrayLifecycleError("Xray runtime authorization marker unavailable")
        try:
            self._marker_path.unlink()
        except FileNotFoundError:
            return
        except OSError as exc:
            raise XrayLifecycleError("Xray runtime authorization marker unavailable") from exc

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
                    XRAY_SERVICE_NAME,
                    "--property=ActiveState",
                    "--property=SubState",
                    "--property=MainPID",
                    "--no-pager",
                ]
            )
        except Exception:
            raise XrayLifecycleError("managed Xray state unavailable") from None

        if result.returncode != 0:
            raise XrayLifecycleError("managed Xray state unavailable")

        values: dict[str, str] = {}
        for line in result.stdout.splitlines():
            if "=" not in line:
                raise XrayLifecycleError("managed Xray state unavailable")
            key, value = line.split("=", 1)
            if key in values:
                raise XrayLifecycleError("managed Xray state unavailable")
            values[key] = value

        if set(values) != {"ActiveState", "SubState", "MainPID"}:
            raise XrayLifecycleError("managed Xray state unavailable")
        try:
            main_pid = int(values["MainPID"], 10)
        except ValueError:
            raise XrayLifecycleError("managed Xray state unavailable") from None
        if main_pid < 0:
            raise XrayLifecycleError("managed Xray state unavailable")

        active_state = values["ActiveState"]
        if active_state in {"inactive", "failed"} and main_pid == 0:
            return False
        if active_state == "active" and main_pid > 0:
            return True
        raise XrayLifecycleError("managed Xray state unavailable")

    def ensure_inactive(self) -> None:
        revoke_error: XrayLifecycleError | None = None
        try:
            self.revoke_authorization()
        except XrayLifecycleError as exc:
            revoke_error = exc

        try:
            self._run(["systemctl", "stop", XRAY_SERVICE_NAME])
        except Exception:
            pass

        if self._verified_inactive():
            if revoke_error is not None:
                raise XrayLifecycleError("managed Xray authorization could not be revoked")
            return

        try:
            self._run(
                [
                    "systemctl",
                    "kill",
                    "--kill-who=all",
                    "--signal=SIGKILL",
                    XRAY_SERVICE_NAME,
                ]
            )
        except Exception:
            pass

        for attempt in range(self._poll_attempts):
            if self._verified_inactive():
                if revoke_error is not None:
                    raise XrayLifecycleError("managed Xray authorization could not be revoked")
                return
            if attempt + 1 < self._poll_attempts:
                self._sleep(self._poll_interval_seconds)

        raise XrayLifecycleError("managed Xray shutdown could not be verified")

    def restart_authorized(self) -> None:
        if not self.authorization_granted():
            raise XrayLifecycleError("managed Xray runtime is not authorized")

        restart_succeeded = False
        try:
            result = self._run(["systemctl", "restart", XRAY_SERVICE_NAME])
            restart_succeeded = result.returncode == 0
        except Exception:
            restart_succeeded = False

        if restart_succeeded:
            try:
                if self.is_active():
                    return
            except XrayLifecycleError:
                pass

        try:
            self.revoke_authorization()
        except XrayLifecycleError:
            pass
        try:
            self.ensure_inactive()
        except XrayLifecycleError:
            pass
        raise XrayLifecycleError("managed Xray authorized restart failed")

    def disable(self) -> None:
        self.ensure_inactive()

    def _verified_inactive(self) -> bool:
        try:
            return not self.is_active()
        except XrayLifecycleError:
            return False
