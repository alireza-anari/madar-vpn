"""Optional WS/VMess ingress to the SAME per-account quota-controlled Xray workers.

Never owns public :443. Never meters traffic separately: the common loopback
backend is the sole quota enforcement and accounting boundary. No commercial
traffic can use this unless BOTH the node opts in and a signed QuotaPolicy v2
advertises a valid, approved permanent endpoint.
"""
import json
import pathlib
import re
import socket
import subprocess
import time
from shared443 import bridge_uuid
from xray import atomic_write

WS_PORT = 18080
API_PORT = 18081
TAG = "madar-secondary-ws"
API_TAG = "madar-secondary-api"
HOST_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
PATH = re.compile(r"^/madar-[a-f0-9]{24}$")
UUID = re.compile(
    r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
    re.I,
)


def validate_endpoint(value):
    if not isinstance(value, dict) or value.get("type") != "vmess-ws-aead":
        raise ValueError("INVALID_WS_ENDPOINT")
    hostname = value.get("hostname")
    path = value.get("path")
    if not isinstance(hostname, str) or not 4 <= len(hostname) <= 253:
        raise ValueError("INVALID_WS_HOST")
    if hostname != hostname.lower() or hostname.endswith((".trycloudflare.com", ".cfargotunnel.com", ".localhost")):
        raise ValueError("INVALID_WS_HOST")
    labels = hostname.split(".")
    if (
        len(labels) < 2 or not re.fullmatch(r"[a-z]{2,63}", labels[-1]) or
        any(not HOST_LABEL.fullmatch(label) for label in labels)
    ):
        raise ValueError("INVALID_WS_HOST")
    if not isinstance(path, str) or not PATH.fullmatch(path):
        raise ValueError("INVALID_WS_PATH")
    return {"type": "vmess-ws-aead", "hostname": hostname, "path": path}


def render_ws_frontend(settings, endpoint, *, ports=range(20000, 21000)):
    endpoint = validate_endpoint(endpoint)
    key = settings.get("bridgeKey")
    if (
        settings.get("shared443") is not True or
        settings.get("frontendManaged") is not True or
        not isinstance(key, str)
    ):
        raise ValueError("WS_NOT_OPTED_IN")
    conf = {
        "log": {"loglevel": "warning"},
        "api": {"tag": API_TAG, "services": ["HandlerService"]},
        "inbounds": [
            {
                "tag": TAG,
                "listen": "127.0.0.1", "port": WS_PORT,
                "protocol": "vmess",
                "settings": {"clients": [], "disableInsecureEncryption": True},
                "streamSettings": {
                    "network": "ws", "security": "none",
                    "wsSettings": {"path": endpoint["path"]},
                },
            },
            {
                "tag": API_TAG, "listen": "127.0.0.1", "port": API_PORT,
                "protocol": "dokodemo-door",
                "settings": {"address": "127.0.0.1"},
            },
        ],
        "outbounds": [],
        "routing": {
            "rules": [
                {"type": "field", "inboundTag": [API_TAG], "outboundTag": API_TAG},
            ],
        },
    }
    for port in ports:
        name = f"madar-{port}"
        conf["outbounds"].append({
            "tag": name,
            "protocol": "vless",
            "settings": {
                "vnext": [{
                    "address": "127.0.0.1",
                    "port": port,
                    "users": [{
                        "id": bridge_uuid(key, port),
                        "encryption": "none",
                        "flow": "",
                    }],
                }],
            },
            "streamSettings": {"network": "tcp", "security": "none"},
            "mux": {"enabled": False},
        })
        conf["routing"]["rules"].append({
            "type": "field",
            "inboundTag": [TAG],
            "user": [name],
            "outboundTag": name,
        })
    return conf


def wait_for_local(port, process):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise ValueError("WS_XRAY_EXITED")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=.1):
                return
        except OSError:
            time.sleep(.05)
    raise ValueError("WS_XRAY_NOT_READY")


class ManagedWsFrontend:
    def __init__(self, settings, endpoint, binary, base):
        self.settings = settings
        self.endpoint = validate_endpoint(endpoint)
        self.binary = binary
        self.base = pathlib.Path(base)
        self.clients = {}
        self.process = None
        self.path = self.base / "secondary-ws.json"
        config = render_ws_frontend(settings, self.endpoint)
        # A failed Xray test MUST occur before a listener starts.
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
            wait_for_local(API_PORT, self.process)
            wait_for_local(WS_PORT, self.process)
        except Exception:
            self.stop()
            raise

    def check(self):
        if self.process is None or self.process.poll() is not None:
            raise ValueError("WS_FRONTEND_DOWN")
        return True

    def attach(self, client):
        self.check()
        ident = client["accountId"]
        port = client["listenPort"]
        key = (client["uuid"], port)
        if self.clients.get(ident) == key:
            return
        if (
            not isinstance(ident, str) or
            not UUID.fullmatch(client["uuid"]) or
            type(port) is not int or not 20000 <= port <= 20999
        ):
            raise ValueError("INVALID_WS_CLIENT")
        if ident in self.clients:
            self.detach(client)
        path = self.base / (ident + ".ws-user.json")
        atomic_write(path, {
            "inbounds": [{
                "tag": TAG,
                "port": WS_PORT,
                "protocol": "vmess",
                "settings": {
                    "clients": [{
                        "id": client["uuid"],
                        "email": f"madar-{port}",
                        "alterId": 0,
                        "level": 0,
                    }],
                },
            }],
        })
        try:
            output = subprocess.run(
                [self.binary, "api", "adu",
                 "--server=127.0.0.1:" + str(API_PORT), "-timeout", "1",
                 str(path)],
                check=True, capture_output=True, text=True, timeout=3,
            )
            if "Added 1 user(s) in total." not in output.stdout:
                raise ValueError("WS_USER_NOT_REGISTERED")
            self.clients[ident] = key
        finally:
            path.unlink(missing_ok=True)

    def detach(self, client):
        ident = client["accountId"]
        existing = self.clients.pop(ident, None)
        if existing is None:
            return
        try:
            if self.process is not None and self.process.poll() is None:
                subprocess.run(
                    [self.binary, "api", "rmu",
                     "--server=127.0.0.1:" + str(API_PORT),
                     "-timeout", "1", "-tag=" + TAG, f"madar-{existing[1]}"],
                    check=True, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, timeout=3,
                )
        except Exception:
            # The owned backend process has already been terminated or will be
            # terminated by QuotaRuntime. A frontend user can never bypass it.
            pass

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
