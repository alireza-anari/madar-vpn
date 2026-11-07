import pathlib
import subprocess
from types import SimpleNamespace

import pytest
from quota import QuotaStore
from quota_runtime import QuotaRuntime
from shared443 import bridge_uuid, build_fresh_frontend
from ws_fallback import (
    ManagedWsFrontend, render_ws_frontend, validate_endpoint,
)

UUID = "11111111-1111-4111-8111-111111111111"
ENDPOINT = {
    "type": "vmess-ws-aead",
    "hostname": "edge.madar.example.com",
    "path": "/madar-" + "a" * 24,
}
SETTINGS = {
    "bridgeKey": "a" * 64,
    "shared443": True,
    "frontendManaged": True,
    "frontendService": "madar-sales-xray.service",
    "nodeId": "node",
    "sni": "www.cloudflare.com",
    "privateKey": "private",
    "shortId": "abcd",
    "port": 443,
}


def test_all_ws_listeners_are_local_and_route_into_same_metered_bridge():
    ws = render_ws_frontend(SETTINGS, ENDPOINT, ports=range(20000, 20002))
    primary, _ = build_fresh_frontend(
        SETTINGS, ports=range(20000, 20002)
    )
    assert {i["port"] for i in ws["inbounds"]} == {18080, 18081}
    assert all(i["listen"] == "127.0.0.1" for i in ws["inbounds"])
    assert ws["inbounds"][0]["protocol"] == "vmess"
    assert ws["inbounds"][0]["streamSettings"]["network"] == "ws"
    assert ws["inbounds"][0]["settings"]["disableInsecureEncryption"] is True
    for port in [20000, 20001]:
        label = "madar-" + str(port)
        secondary = next(x for x in ws["outbounds"] if x["tag"] == label)
        main = next(x for x in primary["outbounds"] if x["tag"] == label)
        user = secondary["settings"]["vnext"][0]["users"][0]["id"]
        assert user == main["settings"]["vnext"][0]["users"][0]["id"]
        assert user == bridge_uuid(SETTINGS["bridgeKey"], port)
        assert secondary["settings"]["vnext"][0]["address"] == "127.0.0.1"
        rule = next(x for x in ws["routing"]["rules"] if x.get("user") == [label])
        assert rule["inboundTag"] == ["madar-secondary-ws"]
        assert rule["outboundTag"] == label
    assert len(ws["outbounds"]) == 3
    assert ws["outbounds"][0] == {"tag": "madar-deny-unmatched", "protocol": "blackhole"}
    assert ws["routing"]["rules"][-1] == {"type": "field", "inboundTag": ["madar-secondary-ws"], "outboundTag": "madar-deny-unmatched"}
    assert ws["api"]["services"] == ["HandlerService"]


@pytest.mark.parametrize("hostname", [
    "foo.trycloudflare.com", "foo.cfargotunnel.com", "127.0.0.1",
    "localhost", "https://example.com", "UPPER.example.com",
    "a" * 64 + ".example.com", "foo.example.com/bad",
])
def test_forbids_unsafe_hosts(hostname):
    with pytest.raises(ValueError):
        validate_endpoint({**ENDPOINT, "hostname": hostname})


def test_endpoint_and_opt_in_are_mandatory():
    for invalid in [
        {**ENDPOINT, "path": "/"},
        {**ENDPOINT, "path": "/madar-" + "a" * 23},
        {**ENDPOINT, "type": "no-tls"},
    ]:
        with pytest.raises(ValueError):
            validate_endpoint(invalid)
    with pytest.raises(ValueError, match="WS_NOT_OPTED_IN"):
        render_ws_frontend({**SETTINGS, "frontendManaged": False}, ENDPOINT)


def test_dynamically_registers_shared_account_user_and_revokes_it(tmp_path, monkeypatch):
    router = object.__new__(ManagedWsFrontend)
    router.settings = SETTINGS
    router.endpoint = ENDPOINT
    router.binary = "xray"
    router.base = tmp_path
    router.clients = {}
    router.process = SimpleNamespace(poll=lambda: None)
    router.path = tmp_path / "secondary-ws.json"
    client = {"accountId": "account", "uuid": UUID, "listenPort": 20000}
    calls = []

    def run(args, **kw):
        calls.append(args)
        if "adu" in args:
            conf = __import__("json").loads(pathlib.Path(args[-1]).read_text())
            assert conf["inbounds"][0]["settings"]["clients"][0]["email"] == "madar-20000"
            return subprocess.CompletedProcess(args, 0, stdout="Added 1 user(s) in total.")
        return subprocess.CompletedProcess(args, 0, stdout="")

    monkeypatch.setattr(subprocess, "run", run)
    router.attach(client)
    assert router.ready_for({"account": SimpleNamespace(client=client)})
    assert len([x for x in calls if "adu" in x]) == 1
    router.attach(client)  # idempotent, does not trigger duplicate API insert
    assert len([x for x in calls if "adu" in x]) == 1
    router.detach(client)
    assert not router.ready_for({"account": SimpleNamespace(client=client)})
    assert any("rmu" in x for x in calls)
    assert not list(tmp_path.iterdir())


def test_inability_to_register_ws_does_not_lose_mci_capability(tmp_path, monkeypatch):
    class Primary:
        def check(self):
            return True

    class DummyRouter:
        def __init__(self, config, endpoint, binary, base):
            self.endpoint = endpoint
            self.clients = {}
            self.live = True
        def check(self):
            if not self.live:
                raise ValueError("WS_DOWN")
        def attach(self, client):
            raise OSError("NO_WS_REGISTER")
        def stop(self):
            self.live = False
        def ready_for(self, processes):
            return False

    import ws_fallback
    monkeypatch.setattr(ws_fallback, "ManagedWsFrontend", DummyRouter)
    db = tmp_path / "quota.sqlite"
    QuotaStore(db).close()
    controller = QuotaRuntime(
        SETTINGS, None, None, base=tmp_path / "run",
        database=db, frontend_factory=lambda *args: Primary(),
    )
    controller.policy = {"wsFallback": ENDPOINT}
    controller.processes["a"] = SimpleNamespace(
        client={"accountId": "a", "uuid": UUID, "listenPort": 20000}
    )
    controller.configure_ws_router(controller.policy)
    controller.attach_ws_accounts()
    assert "shared-443" in controller.capabilities()
    assert "ws-metered" not in controller.capabilities()
    assert controller.ws_router is None
    controller.store.close()


def test_ws_capability_requires_all_registered_accounts(tmp_path, monkeypatch):
    class Primary:
        def check(self):
            return True

    class Router:
        def __init__(self, config, endpoint, binary, base):
            self.connected = set()
        def check(self):
            return True
        def attach(self, client):
            self.connected.add(client["accountId"])
        def ready_for(self, processes):
            return bool(processes) and self.connected == set(processes)
        def stop(self):
            self.connected.clear()

    import ws_fallback
    monkeypatch.setattr(ws_fallback, "ManagedWsFrontend", Router)
    db = tmp_path / "quota.sqlite"
    QuotaStore(db).close()
    controller = QuotaRuntime(
        SETTINGS, None, None, base=tmp_path / "run",
        database=db, frontend_factory=lambda *args: Primary(),
    )
    controller.policy = {"wsFallback": ENDPOINT}
    controller.configure_ws_router(controller.policy)
    assert "ws-metered" not in controller.capabilities()
    for name, port in [("a", 20000), ("b", 20001)]:
        controller.processes[name] = SimpleNamespace(
            client={"accountId": name, "uuid": UUID, "listenPort": port}
        )
    controller.ws_router.attach(controller.processes["a"].client)
    assert "ws-metered" not in controller.capabilities()
    controller.attach_ws_accounts()
    assert "ws-metered" in controller.capabilities()
    controller.configure_ws_router({"wsFallback": {**ENDPOINT, "path": "/madar-" + "b" * 24}})
    assert "ws-metered" not in controller.capabilities()
    assert "shared-443" in controller.capabilities()
    controller.ws_router.stop()
    controller.store.close()



def test_ws_revocation_api_timeout_stops_only_secondary_frontend(tmp_path, monkeypatch):
    router = object.__new__(ManagedWsFrontend)
    router.base = tmp_path
    router.binary = "xray"
    router.process = SimpleNamespace(poll=lambda: None)
    router.clients = {"account": (UUID, 20000)}
    stopped = []
    router.stop = lambda: stopped.append("ws-frontend")
    def failing_run(args, **kwargs):
        raise subprocess.TimeoutExpired(args, timeout=3)
    monkeypatch.setattr(subprocess, "run", failing_run)
    with pytest.raises(ValueError, match="WS_REVOCATION_UNCONFIRMED"):
        router.detach({"accountId": "account", "uuid": UUID, "listenPort": 20000})
    assert stopped == ["ws-frontend"]
    assert "account" not in router.clients
