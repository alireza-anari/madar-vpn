"""Independent managed REALITY alternative-port sidecar (no primary restart).

Run only via the pinned secondary installer. It reads the pre-existing node's
identity WITHOUT changing the original agent, quota DB, 443 config or service.
Its only per-user outbound is the existing local quota-metered Xray worker.
"""
import json
import pathlib
import signal
import socket
import sys
import threading
import time
import urllib.request

from policy import verify_policy
from reality_alt import ManagedRealityAltFrontend, validate_ports

NODE_CONFIG = pathlib.Path("/etc/madar-sales-node/config.json")
FRONTEND_BINARY = "/opt/madar-sales-node/xray"
SECONDARY_RUNTIME = pathlib.Path("/run/madar-sales-secondary")
INTERVAL = 3


def request(config, endpoint, body=None):
    base = config["baseUrl"]
    if not isinstance(base, str) or not base.startswith("https://"):
        raise ValueError("HTTPS_REQUIRED")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        base.rstrip("/") + "/api/node/" + endpoint,
        data=data,
        headers={
            "Authorization": "Bearer " + config["nodeToken"],
            "Content-Type": "application/json",
            "User-Agent": "MadarSecondary/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=6) as response:
        result = json.loads(response.read(262144))
    return result


def validate_config(config):
    if not isinstance(config, dict) or config.get("protocolVersion") != 2 or \
       config.get("shared443") is not True or \
       config.get("frontendManaged") is not True or \
       config.get("port") != 443 or \
       not isinstance(config.get("nodeId"), str) or \
       len(config.get("bridgeKey", "")) != 64 or \
       any(not config.get(key) for key in (
           "privateKey", "shortId", "sni", "nodeToken", "policyKey"
       )):
        raise ValueError("NOT_AN_OWNED_MADAR_SHARED443_NODE")
    # No direct node configuration or secrets are ever written out.
    return config


def backend_online(port, timeout=0.15):
    if type(port) is not int or not 20000 <= port <= 20999:
        return False
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def live_clients(policy, now, port_checker=backend_online):
    result = {}
    for client in policy["clients"]:
        if client["validUntil"] <= now or (
            client.get("quotaBytes") is not None and
            client["usedBytes"] >= client["quotaBytes"]
        ):
            continue
        if not port_checker(client["listenPort"]):
            raise ValueError("METERED_BACKEND_UNREACHABLE")
        result[client["accountId"]] = client
    return result


class Secondary:
    def __init__(self, config, base=SECONDARY_RUNTIME, frontend_factory=ManagedRealityAltFrontend):
        self.config = validate_config(config)
        self.base = pathlib.Path(base)
        self.base.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.factory = frontend_factory
        self.router = None
        self.ports = None
        self.last_revision = 0
        self.stopping = threading.Event()
        self.policy_deadline = 0

    def stop(self):
        if self.router is not None:
            try:
                self.router.stop()
            finally:
                self.router = None
                self.ports = None

    def apply(self, policy, now, port_checker=backend_online):
        if policy.get("version") != 2 or policy["expiresAt"] <= now:
            self.stop()
            return False
        ports = policy.get("realityAltPorts")
        if ports is None:
            self.stop()
            return False
        ports = validate_ports(ports)
        clients = live_clients(policy, now, port_checker)
        # An empty account set means no secondary route can yet be confirmed.
        # Await the first test account rather than advertising a fictional route.
        if not clients:
            self.stop()
            return False
        if self.router is None or ports != self.ports:
            self.stop()
            self.router = self.factory(
                self.config, ports, FRONTEND_BINARY, self.base,
            )
            self.ports = ports
        # All clients are authoritative only until this signed policy expires.
        for ident in list(self.router.clients):
            if ident not in clients:
                self.router.detach({"accountId": ident})
        for client in clients.values():
            self.router.attach(client)
        if not self.router.ready_for({
            ident: type("ProcessRef", (), {"client": client})()
            for ident, client in clients.items()
        }):
            raise ValueError("SECONDARY_CLIENTS_NOT_READY")
        return True

    def step(self, now=None, port_checker=backend_online):
        now = int(time.time()) if now is None else now
        try:
            envelope = request(self.config, "policy-v2")
            policy = verify_policy(
                envelope, self.config["policyKey"],
                self.config["nodeId"], now, -1,
            )
            self.policy_deadline = policy["expiresAt"]
            ready = self.apply(policy, now, port_checker)
            self.last_revision = policy["revision"]
            if ready:
                request(self.config, "secondary-ack", {
                    "revision": policy["revision"],
                    "ports": self.ports,
                    "healthy": True,
                })
            return ready
        except Exception:
            # Never continue serving with a policy that we cannot authenticate
            # or a backend that we cannot verify. Only secondary child stops.
            self.stop()
            return False

    def run(self):
        try:
            while not self.stopping.is_set():
                self.step()
                self.stopping.wait(INTERVAL)
        finally:
            self.stop()


def main():
    config = json.loads(NODE_CONFIG.read_text())
    secondary = Secondary(config)
    def terminate(*_):
        secondary.stopping.set()
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    secondary.run()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never print node credentials or configuration.
        print("MADAR_SECONDARY_STOPPED", file=sys.stderr)
        raise SystemExit(1) from None
