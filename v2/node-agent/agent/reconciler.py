"""Guarded local Xray configuration deployment for a dedicated V2 node.

No network download or arbitrary shell command. Accept a preinstalled,
SHA256-pinned Xray binary and a trusted, locally generated configuration.
This service can be used ONLY after an operator provisions an isolated test
VPS and establishes systemd privileges for the fixed unit name.
"""
import fcntl
import hashlib
import json
import os
import stat
import subprocess
import tempfile
from pathlib import Path

from .xray_config import compile_config, encode

UNIT_NAME="madar-v2-xray.service"


class ReconcileError(RuntimeError):
    """An untrusted or unsuccessful deployment must not claim readiness."""


def verify_xray_binary(executable,sha256):
    if not isinstance(sha256,str) or len(sha256)!=64 or any(
        c not in "0123456789abcdef" for c in sha256
    ):
        raise ReconcileError("binary digest must be an approved sha256 hex")
    path=Path(executable)
    try:
        info=path.lstat()
    except FileNotFoundError:
        raise ReconcileError("pinned Xray binary missing") from None
    if not stat.S_ISREG(info.st_mode) or not info.st_mode & stat.S_IXUSR:
        raise ReconcileError("Xray binary must be executable regular file")
    hashing=hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            block=stream.read(65536)
            if not block: break
            hashing.update(block)
    if hashing.hexdigest()!=sha256:
        raise ReconcileError("pinned Xray binary digest mismatch")
    return str(path.resolve(strict=True))


def subprocess_runner(args,timeout=20):
    try:
        completed=subprocess.run(args,check=False,timeout=timeout,
            stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,env={"PATH":"/usr/bin:/bin"})
        return completed.returncode==0
    except (OSError,subprocess.TimeoutExpired):
        return False


def _safe_config_root(root):
    path=Path(root)
    info=path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022:
        raise ReconcileError("config directory is not a safe directory")
    if info.st_uid!=os.geteuid():
        raise ReconcileError("config directory ownership mismatch")
    if path.is_symlink():
        raise ReconcileError("config root cannot be a symlink")
    return path


def _safe_existing_file(path):
    try: info=path.lstat()
    except FileNotFoundError: return False
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ReconcileError("existing config must be a mode-0600 regular file")
    return True


def _atomic_file(directory,prefix,text):
    fd,name=tempfile.mkstemp(prefix=prefix,dir=directory)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,"w",encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        return Path(name)
    except BaseException:
        Path(name).unlink(missing_ok=True)
        raise


def apply_config(root,config,*,binary,sha256,runner=subprocess_runner):
    """Replace a config only after pinned-binary test, rollback on restart failure.

    Result deliberately says 'service_configured', never 'route_ready'.
    This is not an operator field-acceptance result.
    """
    xray=verify_xray_binary(binary,sha256)
    directory=_safe_config_root(root)
    current=directory/"config.json"
    previous=directory/"previous.json"
    lock_file=directory/"agent.lock"
    lock_fd=os.open(lock_file,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    staged=None
    try:
        os.fchmod(lock_fd,0o600)
        with os.fdopen(lock_fd,"r+") as locked:
            fcntl.flock(locked.fileno(),fcntl.LOCK_EX)
            had_current=_safe_existing_file(current)
            _safe_existing_file(previous)
            staged=_atomic_file(directory,".candidate-",encode(config))
            if not runner([xray,"run","-test","-config",str(staged)],timeout=20):
                raise ReconcileError("Xray config validation failed; existing service unchanged")
            if previous.exists():
                previous.unlink()
            if had_current:
                os.replace(current,previous)
            os.replace(staged,current)
            staged=None
            try:
                if not runner(["/usr/bin/systemctl","restart",UNIT_NAME],timeout=30):
                    raise ReconcileError("service restart failed")
                # A running service is not a functioning tunnel and not a route
                # that can be sold. Real client traffic is tested elsewhere.
                if not runner(["/usr/bin/systemctl","is-active","--quiet",UNIT_NAME],timeout=5):
                    raise ReconcileError("service not active")
            except ReconcileError:
                current.unlink(missing_ok=True)
                if had_current and previous.exists():
                    os.replace(previous,current)
                    runner(["/usr/bin/systemctl","restart",UNIT_NAME],timeout=30)
                raise
            return {"status":"service_configured","field_verified":False,
                    "client_count":sum(len(x["settings"]["users"]) for x in config["inbounds"])}
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)
        os.close(lock_fd) if False else None


def compile_trusted_local_secrets(path):
    """Compile only from a root-owned 0600 local file. Never HTTP/Telegram input."""
    secret_file=Path(path)
    info=secret_file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid!=os.geteuid():
        raise ReconcileError("local secrets must be owned, 0600 regular file")
    if info.st_size>8192:
        raise ReconcileError("local secrets too large")
    raw=secret_file.read_text(encoding="utf-8")
    settings=json.loads(raw)
    if not isinstance(settings,dict) or set(settings)!={"clients","reality","websocket"}:
        raise ReconcileError("unexpected local secrets format")
    return compile_config(**settings)
