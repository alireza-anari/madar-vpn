"""Regression tests for second/third REALITY port bound to same per-account meter."""
import hashlib
import hmac
import json
import pathlib
import subprocess
from types import SimpleNamespace

import pytest

from quota import QuotaStore
from quota_runtime import QuotaRuntime
from policy import verify_policy
from shared443 import bridge_uuid, build_fresh_frontend
from reality_alt import (
    ManagedRealityAltFrontend,
    render_reality_alt,
    validate_ports,
)

UUID = "11111111-1111-4111-8111-111111111111"
ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
SETTINGS = {
    "bridgeKey": "a" * 64,
    "privateKey": "private-key-for-fixture",
    "shortId": "1234567890abcdef",
    "sni": "www.cloudflare.com",
    "port": 443,
    "shared443": True,
    "frontendManaged": True,
    "nodeId": "node",
}
CLIENT = {"accountId": ACCOUNT, "uuid": UUID, "listenPort": 20000}


@pytest.mark.parametrize("ports", [[443], [18080], [20000], [], [8443, 8443],
                                    [2053, 8443, 2053], ["8443"], [True], [0]])
def test_port_allowlist_rejects_conflicts_and_unapproved_ports(ports):
    with pytest.raises(ValueError, match="INVALID_REALITY_ALT_PORTS"):
        validate_ports(ports)


def test_alternative_port_frontend_forwards_only_to_existing_quota_workers():
    ports = [2053, 8443]
    config = render_reality_alt(SETTINGS, ports, account_ports=range(20000, 20002))
    primary, _ = build_fresh_frontend(SETTINGS, ports=range(20000, 20002))
    public = [inbound for inbound in config["inbounds"] if inbound["port"] != 18091]
    assert [inbound["port"] for inbound in public] == ports
    assert 443 not in [inbound["port"] for inbound in config["inbounds"]]
    assert all(inbound["listen"] == "0.0.0.0" for inbound in public)
    assert all(inbound["protocol"] == "vless" for inbound in public)
    assert all(inbound["streamSettings"]["security"] == "reality" for inbound in public)
    assert config["inbounds"][-1]["listen"] == "127.0.0.1"
    assert config["api"]["services"] == ["HandlerService"]
    assert len(config["outbounds"]) == 2
    for port in [20000, 20001]:
        tag = "madar-" + str(port)
        downstream = next(o for o in config["outbounds"] if o["tag"] == tag)
        original = next(o for o in primary["outbounds"] if o["tag"] == tag)
        user = downstream["settings"]["vnext"][0]["users"][0]["id"]
        assert user == bridge_uuid(SETTINGS["bridgeKey"], port)
        assert user == original["settings"]["vnext"][0]["users"][0]["id"]
        assert downstream["settings"]["vnext"][0]["address"] == "127.0.0.1"
        route = next(r for r in config["routing"]["rules"] if r.get("user") == [tag])
        assert set(route["inboundTag"]) == {"madar-reality-2053", "madar-reality-8443"}
        assert route["outboundTag"] == tag
    assert all(outbound["protocol"] == "vless" for outbound in config["outbounds"])


def test_single_account_is_attached_to_both_ports_and_removed_safely(tmp_path, monkeypatch):
    router = object.__new__(ManagedRealityAltFrontend)
    router.settings = SETTINGS
    router.ports = [2053, 8443]
    router.binary = "xray"
    router.base = tmp_path
    router.path = tmp_path / "secondary-reality.json"
    router.process = SimpleNamespace(poll=lambda: None)
    router.clients = {}
    cmds = []

    def fake_run(args, **kwargs):
        cmds.append(args)
        if "adu" in args:
            config = json.loads(pathlib.Path(args[-1]).read_text())
            assert len(config["inbounds"]) == 2
            assert all(x["settings"]["clients"][0]["id"] == UUID
                       for x in config["inbounds"])
            assert all(x["settings"]["clients"][0]["email"] == "madar-20000"
                       for x in config["inbounds"])
            return subprocess.CompletedProcess(args, 0, stdout="Added 2 user(s) in total.")
        return subprocess.CompletedProcess(args, 0, stdout="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    router.attach(CLIENT)
    assert router.ready_for({ACCOUNT: SimpleNamespace(client=CLIENT)})
    router.attach(CLIENT)
    assert sum("adu" in args for args in cmds) == 1
    router.detach(CLIENT)
    assert not router.ready_for({ACCOUNT: SimpleNamespace(client=CLIENT)})
    assert sum("rmu" in args for args in cmds) == 2
    assert not list(tmp_path.iterdir())


def test_signed_policy_rejects_out_of_allowlist_ports():
    key = "secret"
    policy = {"version": 2, "nodeId": "node", "revision": 1, "expiresAt": 110,
              "clients": [], "realityAltPorts": [443]}
    body = json.dumps(policy)
    envelope = {
        "payload": body,
        "signature": hmac.new(key.encode(), body.encode(), hashlib.sha256).hexdigest(),
    }
    with pytest.raises(ValueError, match="INVALID_REALITY_ALT_PORTS"):
        verify_policy(envelope, key, "node", 100, 0)
    policy["realityAltPorts"] = [8443]
    body = json.dumps(policy)
    envelope = {
        "payload": body,
        "signature": hmac.new(key.encode(), body.encode(), hashlib.sha256).hexdigest(),
    }
    assert verify_policy(envelope, key, "node", 100, 0)["realityAltPorts"] == [8443]


def test_unavailable_extra_frontend_cannot_disrupt_original_primary(tmp_path, monkeypatch):
    class Primary:
        def check(self):
            return True
    class Failing:
        def __init__(self, *args):
            raise ValueError("PORT_BUSY")

    import reality_alt
    monkeypatch.setattr(reality_alt, "ManagedRealityAltFrontend", Failing)
    database = tmp_path / "quota.sqlite"
    QuotaStore(database).close()
    runtime = QuotaRuntime(
        SETTINGS, None, None, base=tmp_path / "run",
        database=database, frontend_factory=lambda *args: Primary(),
    )
    runtime.policy = {"realityAltPorts": [8443]}
    runtime.configure_reality_router(runtime.policy)
    assert "shared-443" in runtime.capabilities()
    assert "reality-alt-metered" not in runtime.capabilities()
    assert runtime.reality_router is None
    runtime.store.close()


def test_optional_port_capability_requires_all_accounts_attached(tmp_path, monkeypatch):
    class Primary:
        def check(self):
            return True
    class Alt:
        def __init__(self, config, ports, binary, base):
            self.clients = set()
            self.ports = ports
        def check(self):
            return True
        def attach(self, client):
            self.clients.add(client["accountId"])
        def ready_for(self, processes):
            return bool(processes) and self.clients == set(processes)
        def stop(self):
            self.clients.clear()

    import reality_alt
    monkeypatch.setattr(reality_alt, "ManagedRealityAltFrontend", Alt)
    database = tmp_path / "quota.sqlite"
    QuotaStore(database).close()
    runtime = QuotaRuntime(
        SETTINGS, None, None, base=tmp_path / "run",
        database=database, frontend_factory=lambda *args: Primary(),
    )
    runtime.policy = {"realityAltPorts": [2053, 8443]}
    runtime.configure_reality_router(runtime.policy)
    assert "reality-alt-metered" not in runtime.capabilities()
    for name, port in [(ACCOUNT, 20000),
                       ("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 20001)]:
        runtime.processes[name] = SimpleNamespace(
            client={"accountId": name, "uuid": UUID, "listenPort": port},
        )
    runtime.reality_router.attach(CLIENT)
    assert "reality-alt-metered" not in runtime.capabilities()
    runtime.attach_reality_accounts()
    assert "reality-alt-metered" in runtime.capabilities()
    runtime.configure_reality_router({"realityAltPorts": [8443]})
    assert "reality-alt-metered" not in runtime.capabilities()
    assert "shared-443" in runtime.capabilities()
    runtime.reality_router.stop()
    runtime.store.close()
