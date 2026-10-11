from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import socket
import stat
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from .models import ManagedClient, SpeedRouteCredential


INT64_MAX = (1 << 63) - 1
MAX_SPEED_KBPS = INT64_MAX // 125
DEFAULT_STATE_ROOT = Path("/etc/madar-node-agent")
DEFAULT_BINARY = Path("/opt/madar-speed-enforcer/madar-speed-enforcer")
DEFAULT_HEALTH_SOCKET = Path("/run/madar-node-agent/speed-enforcer.sock")
DEFAULT_LISTENER = "127.0.0.1:10808"
SECRET_NAME = "speed-identity.key"
LIVE_CONFIG_NAME = "speed-enforcer.json"
CANDIDATE_CONFIG_NAME = "speed-enforcer.json.candidate"


class SpeedEnforcerError(RuntimeError):
    pass


class ProcessResult(Protocol):
    returncode: int
    stdout: str
    stderr: str


Run = Callable[[list[str]], ProcessResult]
LifecycleAction = Callable[[], None]
ActiveCheck = Callable[[], bool]
Log = Callable[[str], None]
HealthProbe = Callable[[int], bool]


def _base64url_unpadded(payload: bytes) -> str:
    return base64.urlsafe_b64encode(payload).rstrip(b"=").decode("ascii")


def derive_speed_identity(secret: bytes, client_id: str) -> SpeedRouteCredential:
    if not isinstance(secret, bytes) or len(secret) != 32:
        raise ValueError("speed identity secret must be exactly 32 bytes")
    if not isinstance(client_id, str) or not client_id:
        raise ValueError("client_id must be a non-empty string")
    encoded_id = client_id.encode("utf-8")
    alias_digest = hmac.new(secret, b"alias-v1\x00" + encoded_id, hashlib.sha256).digest()
    password_digest = hmac.new(secret, b"password-v1\x00" + encoded_id, hashlib.sha256).digest()
    return SpeedRouteCredential(
        client_id=client_id,
        alias=_base64url_unpadded(alias_digest[:16]),
        password=_base64url_unpadded(password_digest),
    )


def password_verifier(alias: str, password: str) -> str:
    if not isinstance(alias, str) or not alias or not isinstance(password, str) or not password:
        raise ValueError("alias and password must be non-empty strings")
    payload = b"verifier-v1\x00" + alias.encode("ascii") + b"\x00" + password.encode("ascii")
    return hashlib.sha256(payload).hexdigest()


def speed_kbps_to_limits(speed_kbps: int) -> tuple[int, int]:
    if isinstance(speed_kbps, bool) or not isinstance(speed_kbps, int):
        raise ValueError("speedKbps must be an integer")
    if speed_kbps < 1 or speed_kbps > MAX_SPEED_KBPS:
        raise ValueError("speedKbps is out of range")
    bytes_per_second = speed_kbps * 125
    burst = max(1, bytes_per_second // 2)
    return bytes_per_second, burst


def _validate_private_directory(path: Path, *, create: bool) -> None:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        if not create:
            raise SpeedEnforcerError("speed state directory is unavailable") from None
        try:
            os.mkdir(path, 0o700)
        except OSError as exc:
            raise SpeedEnforcerError("speed state directory could not be created") from exc
        info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise SpeedEnforcerError("speed state path is not a secure directory")
    if stat.S_IMODE(info.st_mode) != 0o700:
        raise SpeedEnforcerError("speed state directory permissions are unsafe")
    if info.st_uid != os.geteuid():
        raise SpeedEnforcerError("speed state directory owner is unsafe")


def _read_existing_secret(path: Path) -> bytes:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        raise
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise SpeedEnforcerError("speed identity secret is not a regular file")
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise SpeedEnforcerError("speed identity secret permissions are unsafe")
    if info.st_uid != os.geteuid():
        raise SpeedEnforcerError("speed identity secret owner is unsafe")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise SpeedEnforcerError("speed identity secret could not be opened") from exc
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_ino != info.st_ino or opened.st_dev != info.st_dev:
            raise SpeedEnforcerError("speed identity secret changed during open")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(fd, 64)
            if not chunk:
                break
            chunks.append(chunk)
            if sum(map(len, chunks)) > 32:
                break
        secret = b"".join(chunks)
    finally:
        os.close(fd)
    if len(secret) != 32:
        raise SpeedEnforcerError("speed identity secret has invalid length")
    return secret


def ensure_speed_identity_secret(path: Path) -> bytes:
    path = Path(path)
    _validate_private_directory(path.parent, create=True)
    try:
        return _read_existing_secret(path)
    except FileNotFoundError:
        pass

    secret = os.urandom(32)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError:
        return _read_existing_secret(path)
    except OSError as exc:
        raise SpeedEnforcerError("speed identity secret could not be created") from exc
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(secret)
        written = 0
        while written < len(view):
            count = os.write(fd, view[written:])
            if count <= 0:
                raise OSError("short secret write")
            written += count
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        try:
            path.unlink()
        except OSError:
            pass
        raise
    else:
        os.close(fd)
    return _read_existing_secret(path)


def _default_run(args: list[str]) -> ProcessResult:
    return subprocess.run(args, capture_output=True, text=True, check=False)


class SpeedEnforcerAdapter:
    def __init__(
        self,
        *,
        state_root: Path = DEFAULT_STATE_ROOT,
        binary: Path = DEFAULT_BINARY,
        health_socket: Path = DEFAULT_HEALTH_SOCKET,
        listener: str = DEFAULT_LISTENER,
        run: Run | None = None,
        authorize_runtime: LifecycleAction | None = None,
        revoke_runtime_authorization: LifecycleAction | None = None,
        reload: LifecycleAction | None = None,
        is_active: ActiveCheck | None = None,
        disable_runtime: LifecycleAction | None = None,
        log: Log | None = None,
        health_timeout_seconds: float = 1.0,
        health_probe: HealthProbe | None = None,
    ) -> None:
        self.state_root = Path(state_root)
        self.binary = Path(binary)
        self.health_socket = Path(health_socket)
        self.listener = listener
        self._run = run or _default_run
        self._authorize_runtime = authorize_runtime
        self._revoke_runtime_authorization = revoke_runtime_authorization
        self._reload = reload
        self._is_active = is_active
        self._disable_runtime = disable_runtime
        self._log = log or (lambda _message: None)
        if health_timeout_seconds <= 0 or health_timeout_seconds > 10:
            raise ValueError("health_timeout_seconds is out of range")
        self._health_timeout_seconds = health_timeout_seconds
        self._health_probe = health_probe
        self._required = False

    @property
    def required(self) -> bool:
        return self._required

    @property
    def live_config_path(self) -> Path:
        return self.state_root / LIVE_CONFIG_NAME

    @property
    def candidate_config_path(self) -> Path:
        return self.state_root / CANDIDATE_CONFIG_NAME

    @property
    def secret_path(self) -> Path:
        return self.state_root / SECRET_NAME

    def apply_clients(
        self,
        clients: list[ManagedClient],
        generation: int,
    ) -> dict[str, SpeedRouteCredential]:
        if isinstance(generation, bool) or not isinstance(generation, int) or generation <= 0:
            raise SpeedEnforcerError("speed config generation must be a positive integer")

        free_clients = self._validate_clients(clients)
        if not free_clients:
            self.disable_managed_access()
            return {}
        self._require_lifecycle()

        previous_required = self._required
        routes: dict[str, SpeedRouteCredential] = {}
        config_clients: list[dict[str, object]] = []
        try:
            secret = ensure_speed_identity_secret(self.secret_path)
            for client in sorted(free_clients, key=lambda item: item.client_id):
                assert client.speed_kbps is not None
                bytes_per_second, burst = speed_kbps_to_limits(client.speed_kbps)
                credential = derive_speed_identity(secret, client.client_id)
                routes[client.client_id] = credential
                config_clients.append(
                    {
                        "alias": credential.alias,
                        "passwordVerifier": password_verifier(credential.alias, credential.password),
                        "uploadBytesPerSecond": bytes_per_second,
                        "uploadBurstBytes": burst,
                        "downloadBytesPerSecond": bytes_per_second,
                        "downloadBurstBytes": burst,
                    }
                )
            payload = json.dumps(
                {
                    "generation": generation,
                    "listener": self.listener,
                    "healthSocket": str(self.health_socket),
                    "clients": config_clients,
                },
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            )
            self._write_private_candidate(payload)
            result = self._run(
                [str(self.binary), "--config", str(self.candidate_config_path), "--test"]
            )
            if result.returncode != 0:
                self._log("Speed Enforcer candidate configuration validation failed")
                raise SpeedEnforcerError("Speed Enforcer candidate configuration validation failed")
            self._promote_candidate()
            assert self._authorize_runtime is not None
            assert self._reload is not None
            self._authorize_runtime()
            self._reload()
            if not self.health(generation):
                raise SpeedEnforcerError("Speed Enforcer runtime health verification failed")
            self._required = True
            return routes
        except Exception as exc:
            self.candidate_config_path.unlink(missing_ok=True)
            self._best_effort_close_runtime()
            self._required = previous_required
            if isinstance(exc, SpeedEnforcerError):
                raise
            self._log("Speed Enforcer managed runtime activation failed")
            raise SpeedEnforcerError("Speed Enforcer managed runtime activation failed") from None

    def disable_managed_access(self) -> None:
        if self._revoke_runtime_authorization is None or self._disable_runtime is None:
            raise SpeedEnforcerError("Speed Enforcer managed lifecycle is not fully configured")
        failed = False
        try:
            self._revoke_runtime_authorization()
        except Exception:
            failed = True
        try:
            self._disable_runtime()
        except Exception:
            failed = True
        self._required = False
        if failed:
            self._log("Speed Enforcer managed access disable failed")
            raise SpeedEnforcerError("Speed Enforcer managed access disable failed") from None

    def health(self, expected_generation: int) -> bool:
        if isinstance(expected_generation, bool) or not isinstance(expected_generation, int) or expected_generation <= 0:
            return False
        if self._is_active is not None:
            try:
                if not self._is_active():
                    return False
            except Exception:
                return False
        if self._health_probe is not None:
            try:
                return self._health_probe(expected_generation) is True
            except Exception:
                return False
        return self._probe_health_socket(expected_generation)

    def _validate_clients(self, clients: list[ManagedClient]) -> list[ManagedClient]:
        seen: set[str] = set()
        free: list[ManagedClient] = []
        for client in clients:
            if not isinstance(client.client_id, str) or not client.client_id or client.client_id in seen:
                raise SpeedEnforcerError("managed Client identity is invalid or duplicated")
            seen.add(client.client_id)
            if client.tier == "free":
                try:
                    speed_kbps_to_limits(client.speed_kbps)  # type: ignore[arg-type]
                except ValueError as exc:
                    raise SpeedEnforcerError("Free Client speed policy is invalid") from exc
                free.append(client)
            elif client.tier == "premium":
                if client.speed_kbps is not None:
                    raise SpeedEnforcerError("Premium Client must not have a Madar speed cap")
            else:
                raise SpeedEnforcerError("managed Client tier is invalid")
        return free

    def _require_lifecycle(self) -> None:
        if (
            self._authorize_runtime is None
            or self._revoke_runtime_authorization is None
            or self._reload is None
            or self._is_active is None
            or self._disable_runtime is None
        ):
            raise SpeedEnforcerError("Speed Enforcer managed configuration is not fully configured")

    def _write_private_candidate(self, content: str) -> None:
        _validate_private_directory(self.state_root, create=True)
        path = self.candidate_config_path
        try:
            existing = os.lstat(path)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            if stat.S_ISLNK(existing.st_mode) or not stat.S_ISREG(existing.st_mode):
                raise SpeedEnforcerError("Speed Enforcer candidate path is unsafe")
            if existing.st_uid != os.geteuid():
                raise SpeedEnforcerError("Speed Enforcer candidate owner is unsafe")
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            fd = os.open(path, flags, 0o600)
        except OSError as exc:
            raise SpeedEnforcerError("Speed Enforcer candidate could not be written") from exc
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            path.unlink(missing_ok=True)
            raise

    def _promote_candidate(self) -> None:
        live = self.live_config_path
        try:
            existing = os.lstat(live)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            if stat.S_ISLNK(existing.st_mode) or not stat.S_ISREG(existing.st_mode):
                raise SpeedEnforcerError("Speed Enforcer live config path is unsafe")
            if stat.S_IMODE(existing.st_mode) != 0o600 or existing.st_uid != os.geteuid():
                raise SpeedEnforcerError("Speed Enforcer live config permissions are unsafe")
        try:
            self.candidate_config_path.replace(live)
            live.chmod(0o600)
        except OSError as exc:
            raise SpeedEnforcerError("Speed Enforcer candidate promotion failed") from exc

    def _best_effort_close_runtime(self) -> None:
        if self._revoke_runtime_authorization is not None:
            try:
                self._revoke_runtime_authorization()
            except Exception:
                pass
        if self._disable_runtime is not None:
            try:
                self._disable_runtime()
            except Exception:
                pass

    def _probe_health_socket(self, expected_generation: int) -> bool:
        try:
            info = os.lstat(self.health_socket)
        except OSError:
            return False
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISSOCK(info.st_mode):
            return False
        if stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.geteuid():
            return False
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(self._health_timeout_seconds)
        try:
            client.connect(str(self.health_socket))
            client.sendall(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = client.recv(4096)
                if not chunk:
                    break
                total += len(chunk)
                if total > 8192:
                    return False
                chunks.append(chunk)
        except (OSError, TimeoutError):
            return False
        finally:
            client.close()
        raw = b"".join(chunks)
        try:
            head, body = raw.split(b"\r\n\r\n", 1)
            status = head.split(b"\r\n", 1)[0]
            if status not in (b"HTTP/1.1 200 OK", b"HTTP/1.0 200 OK"):
                return False
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            return False
        if not isinstance(payload, dict) or set(payload) != {"generation", "ready"}:
            return False
        generation = payload.get("generation")
        ready = payload.get("ready")
        if isinstance(generation, bool) or not isinstance(generation, int):
            return False
        return generation == expected_generation and ready is True
