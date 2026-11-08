"""Owned, optional VLESS/REALITY direct ports into the SAME quota-controlled backend.

Separate Xray child process: NEVER binds or restarts the existing REALITY :443
frontend. Its only egress is loopback per-account VLESS. No freedom outbound.
The node ACKs reality-alt-metered only when every active account is attached.
"""
import pathlib
import re
import socket
import subprocess
import time

from shared443 import bridge_uuid
from xray import atomic_write

API_PORT = 18091
API_TAG = "madar-reality-alt-api"
ALLOWED_PORTS = (2053, 8443)
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$", re.I)


def validate_ports(value):
    if (not isinstance(value, list) or not 1 <= len(value) <= 2 or
            any(type(p) is not int or p not in ALLOWED_PORTS for p in value) or
            len(set(value)) != len(value)):
        raise ValueError("INVALID_REALITY_ALT_PORTS")
    return sorted(value)


def render_reality_alt(settings, ports, *, account_ports=range(20000, 21000)):
    ports = validate_ports(ports)
    if (settings.get("shared443") is not True or
        settings.get("frontendManaged") is not True or
        not isinstance(settings.get("bridgeKey"), str) or
        len(settings["bridgeKey"]) != 64 or
        not settings.get("sni") or
        not settings.get("privateKey") or
        not settings.get("shortId")):
        raise ValueError("ALT_FRONTEND_NOT_OWNED")
    inbounds = []
    for port in ports:
        inbounds.append({
            "listen": "0.0.0.0", "port": port,
            "tag": f"madar-reality-{port}", "protocol": "vless",
            "settings": {"clients": [], "decryption": "none"},
            "streamSettings": {
                "network": "tcp", "security": "reality",
                "realitySettings": {
                    "show": False, "dest": settings["sni"] + ":443",
                    "xver": 0, "serverNames": [settings["sni"]],
                    "privateKey": settings["privateKey"],
                    "shortIds": [settings["shortId"]],
                },
            },
        })
    inbounds.append({
        "listen": "127.0.0.1", "port": API_PORT,
        "tag": API_TAG, "protocol": "dokodemo-door",
        "settings": {"address": "127.0.0.1"},
    })
    config = {
        "log": {"loglevel": "warning"},
        "api": {"tag": API_TAG, "services": ["HandlerService"]},
        "inbounds": inbounds,
        # Fail-closed default: unmatched authenticated users must NEVER be
        # routed through some other account's loopback worker.
        "outbounds": [{"tag": "madar-deny-unmatched", "protocol": "blackhole"}],
        "routing": {"rules": [
            {"type": "field", "inboundTag": [API_TAG], "outboundTag": API_TAG},
        ]},
    }
    inbound_tags = [f"madar-reality-{p}" for p in ports]
    for port in account_ports:
        label = f"madar-{port}"
        config["outbounds"].append({
            "tag": label, "protocol": "vless",
            "settings": {"vnext": [{
                "address": "127.0.0.1", "port": port,
                "users": [{
                    "id": bridge_uuid(settings["bridgeKey"], port),
                    "encryption": "none", "flow": "",
                }],
            }]},
            "streamSettings": {"network": "tcp", "security": "none"},
            "mux": {"enabled": False},
        })
        config["routing"]["rules"].append({
            "type": "field", "inboundTag": inbound_tags,
            "user": [label], "outboundTag": label,
        })
    config["routing"]["rules"].append({
        "type": "field", "inboundTag": inbound_tags,
        "outboundTag": "madar-deny-unmatched",
    })
    return config


def wait_socket(port, process, host="127.0.0.1"):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise ValueError("ALT_XRAY_EXITED")
        try:
            with socket.create_connection((host, port), timeout=.1):
                return
        except OSError:
            time.sleep(.05)
    raise ValueError("ALT_XRAY_NOT_READY")


class ManagedRealityAltFrontend:
    def __init__(self, settings, ports, binary, base):
        self.settings = settings
        self.ports = validate_ports(ports)
        self.binary = binary
        self.base = pathlib.Path(base)
        self.path = self.base / "secondary-reality.json"
        self.process = None
        self.clients = {}
        config = render_reality_alt(settings, self.ports)
        atomic_write(self.path, config)
        subprocess.run(
            [binary, "run", "-test", "-c", str(self.path)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=15,
        )
        try:
            self.process = subprocess.Popen(
                [binary, "run", "-c", str(self.path)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            wait_socket(API_PORT, self.process)
            for port in self.ports:
                wait_socket(port, self.process)
        except Exception:
            self.stop()
            raise

    def check(self):
        if self.process is None or self.process.poll() is not None:
            raise ValueError("ALT_FRONTEND_DOWN")
        return True

    def attach(self, client):
        self.check()
        ident = client["accountId"]
        port = client["listenPort"]
        key = (client["uuid"], port)
        if self.clients.get(ident) == key:
            return
        if (not UUID.fullmatch(client["uuid"]) or
            type(port) is not int or not 20000 <= port <= 20999 or
            not UUID.fullmatch(ident)):
            raise ValueError("INVALID_REALITY_ALT_CLIENT")
        if ident in self.clients:
            self.detach(client)
        path = self.base / (ident + ".alt-user.json")
        atomic_write(path, {
            "inbounds": [{
                "tag": f"madar-reality-{public_port}", "port": public_port,
                "protocol": "vless",
                "settings": {"decryption": "none", "clients": [{
                    "id": client["uuid"], "email": f"madar-{port}",
                    "flow": "", "level": 0,
                }]},
            } for public_port in self.ports],
        })
        try:
            result = subprocess.run(
                [self.binary, "api", "adu",
                 "--server=127.0.0.1:" + str(API_PORT), "-timeout", "2",
                 str(path)],
                capture_output=True, text=True, check=True, timeout=3,
            )
            expected = f"Added {len(self.ports)} user(s) in total."
            if expected not in result.stdout:
                raise ValueError("ALT_USER_NOT_REGISTERED")
            self.clients[ident] = key
        finally:
            path.unlink(missing_ok=True)

    def detach(self, client):
        ident = client["accountId"]
        existing = self.clients.pop(ident, None)
        if existing is None:
            return
        if self.process is None or self.process.poll() is not None:
            return
        try:
            for public_port in self.ports:
                subprocess.run(
                    [self.binary, "api", "rmu",
                     "--server=127.0.0.1:" + str(API_PORT), "-timeout", "1",
                     "-tag=" + f"madar-reality-{public_port}",
                     f"madar-{existing[1]}"],
                    check=True, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, timeout=3,
                )
        except Exception:
            # Partial deregistration must kill this entire optional frontend;
            # an old UUID must not inherit a newly reused backend port.
            self.stop()
            raise ValueError("REALITY_ALT_REVOCATION_UNCONFIRMED") from None

    def ready_for(self, processes):
        try:
            self.check()
            if not processes:
                return False
            return all(
                ident in self.clients and
                self.clients[ident] == (proc.client["uuid"], proc.client["listenPort"])
                for ident, proc in processes.items()
            )
        except Exception:
            return False

    def stop(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        self.clients.clear()
        self.path.unlink(missing_ok=True)
