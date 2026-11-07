"""Fail-closed CI proof for no-restart auxiliary port controller."""
import hashlib
import hmac
import json
import subprocess
from types import SimpleNamespace

import pytest

from secondary_sidecar import Secondary, live_clients, validate_config
from install_secondary import UNIT_SOURCE, fetch_and_verify

ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
UUID = "11111111-1111-4111-8111-111111111111"
CONFIG = {
    "baseUrl": "https://madar.test",
    "nodeId": "node",
    "nodeToken": "x" * 48,
    "policyKey": "s" * 32,
    "protocolVersion": 2,
    "shared443": True,
    "frontendManaged": True,
    "port": 443,
    "bridgeKey": "a" * 64,
    "privateKey": "test",
    "shortId": "1234567890abcdef",
    "sni": "www.cloudflare.com",
}
CLIENT = {
    "accountId": ACCOUNT,
    "uuid": UUID,
    "listenPort": 20000,
    "validUntil": 300,
    "quotaEpoch": 1,
    "quotaBytes": 1000000,
    "usedBytes": 0,
    "generation": ACCOUNT + ":1",
    "flow": "",
}


class FakeFrontend:
    instances = []

    def __init__(self, config, ports, binary, base):
        self.ports = ports
        self.clients = {}
        self.closed = False
        self.instances.append(self)

    def attach(self, client):
        self.clients[client["accountId"]] = (client["uuid"], client["listenPort"])

    def detach(self, client):
        self.clients.pop(client["accountId"], None)

    def ready_for(self, processes):
        return not self.closed and bool(processes) and all(
            self.clients.get(ident) == (
                proc.client["uuid"], proc.client["listenPort"]
            ) for ident, proc in processes.items()
        )

    def stop(self):
        self.closed = True
        self.clients.clear()


def signed(policy):
    payload = json.dumps(policy)
    return {
        "payload": payload,
        "signature": hmac.new(
            CONFIG["policyKey"].encode(), payload.encode(), hashlib.sha256,
        ).hexdigest(),
    }


def policy(ports=[2053, 8443], clients=None):
    return {
        "version": 2, "nodeId": "node", "revision": 5,
        "expiresAt": 400, "realityAltPorts": ports,
        "clients": clients if clients is not None else [CLIENT],
    }


def test_controller_only_starts_optional_frontend_after_signed_policy_and_backend(tmp_path):
    from secondary_sidecar import Secondary
    obj = Secondary(CONFIG, base=tmp_path, frontend_factory=FakeFrontend)
    assert not obj.apply(policy(), 100, port_checker=lambda p: False)  # raises instead


def test_controller_optional_port_lifecycle_and_shared_identity(tmp_path):
    obj = Secondary(CONFIG, base=tmp_path, frontend_factory=FakeFrontend)
    assert obj.apply(policy(), 100, port_checker=lambda p: True)
    assert obj.ports == [2053, 8443]
    assert obj.router.clients[ACCOUNT] == (UUID, 20000)
    first = obj.router
    assert obj.apply(policy(), 100, port_checker=lambda p: True)
    assert obj.router is first
    assert obj.apply(policy(ports=[8443]), 100, port_checker=lambda p: True)
    assert first.closed
    assert obj.ports == [8443]
    assert obj.apply(policy(ports=None), 100, port_checker=lambda p: True) is False


def test_signed_policy_step_rejects_forgery_and_does_not_report_readiness(tmp_path, monkeypatch):
    import secondary_sidecar as module
    obj = Secondary(CONFIG, base=tmp_path, frontend_factory=FakeFrontend)
    requests = []
    envelope = signed(policy())

    def fake_request(config, endpoint, body=None):
        requests.append((endpoint, body))
        if endpoint == "policy-v2":
            return envelope
        return {"ok": True}

    monkeypatch.setattr(module, "request", fake_request)
    assert obj.step(100, port_checker=lambda p: True)
    assert requests[-1][0] == "secondary-ack"
    assert requests[-1][1] == {
        "revision": 5, "ports": [2053, 8443], "healthy": True,
    }
    assert obj.router is not None
    envelope["signature"] = "0" * 64
    assert not obj.step(101, port_checker=lambda p: True)
    assert obj.router is None
    assert sum(kind == "secondary-ack" for kind, _ in requests) == 1


def test_revoke_and_backend_loss_never_leave_sidecar_running(tmp_path, monkeypatch):
    import secondary_sidecar as module
    obj = Secondary(CONFIG, base=tmp_path, frontend_factory=FakeFrontend)
    assert obj.apply(policy(), 100, port_checker=lambda p: True)
    old = obj.router
    monkeypatch.setattr(module, "request", lambda conf, endpoint, body=None: signed(policy()))
    assert not obj.step(101, port_checker=lambda p: False)
    assert old.closed
    assert obj.router is None


def test_expired_accounts_do_not_appear_in_controller(tmp_path):
    assert live_clients(policy(), 100, lambda p: True) == {ACCOUNT: CLIENT}
    expired = {**CLIENT, "validUntil": 99}
    assert live_clients(policy(clients=[expired]), 100, lambda p: True) == {}
    exhausted = {**CLIENT, "usedBytes": CLIENT["quotaBytes"]}
    assert live_clients(policy(clients=[exhausted]), 100, lambda p: True) == {}


def test_secondary_install_requires_pinned_sources_and_own_service(tmp_path, monkeypatch):
    import install_secondary as installer
    assert "ExecStopPost" not in UNIT_SOURCE
    assert "madar-sales-node.service" not in [
        line for line in UNIT_SOURCE.splitlines() if line.startswith("ExecStart=")
    ]
    manifest = {name: hashlib.sha256(b"x=1\n").hexdigest()
                for name in installer.SOURCE_FILES}
    raw = json.dumps(manifest).encode()
    monkeypatch.setattr(
        installer, "download",
        lambda ref, path: raw if path == "secondary-source-manifest.json" else b"x=1\n",
    )
    assert set(fetch_and_verify("a" * 40, hashlib.sha256(raw).hexdigest())) == set(
        installer.SOURCE_FILES,
    )
    with pytest.raises(ValueError, match="SECONDARY_MANIFEST_HASH_MISMATCH"):
        fetch_and_verify("a" * 40, "0" * 64)
