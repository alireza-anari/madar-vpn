from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import madar_agent.service as service_module
from madar_agent.config import XrayRuntimeSettings
from madar_agent.models import AgentConfig
from madar_agent.service import AgentService
from madar_agent.xray import RealityServerConfig


def test_build_agent_service_wires_control_plane_node_agent_and_pinned_xray(monkeypatch, tmp_path: Path) -> None:
    credential_path = tmp_path / "etc" / "madar-node-agent" / "node.credential"
    binary = tmp_path / "opt" / "madar-xray" / "26.3.27" / "xray"
    agent_config = AgentConfig(
        api_base_url="https://control.example.test",
        credential_path=credential_path,
        request_timeout_seconds=10.0,
    )
    runtime = XrayRuntimeSettings(
        binary=binary,
        version="26.3.27",
        port=443,
        server_name="edge.example.test",
        reality_target="origin.example.test:443",
        reality_short_id="0123456789abcdef",
        max_clients=128,
    )
    created: dict[str, object] = {}

    class FakeClient:
        def __init__(self, config) -> None:
            created["client_config"] = config

    class FakeXray:
        def __init__(self, **kwargs) -> None:
            created["xray"] = self
            created["xray_kwargs"] = kwargs

        def health(self) -> bool:
            return True

        def disable_managed_access(self) -> None:
            created["disabled"] = True

    class FakeNodeAgent:
        def __init__(self, config, *, api, xray, environment=None, now, outbox=None) -> None:
            self.config = config
            self.api = api
            self.xray = xray
            self.now = now
            self.outbox = outbox
            created["agent"] = self

    monkeypatch.setattr(service_module, "load_config", lambda: agent_config)
    monkeypatch.setattr(service_module, "load_runtime_config", lambda: runtime, raising=False)
    monkeypatch.setattr(service_module, "ControlPlaneClient", FakeClient)
    monkeypatch.setattr(service_module, "PinnedXrayAdapter", FakeXray, raising=False)
    monkeypatch.setattr(service_module, "NodeAgent", FakeNodeAgent, raising=False)

    built = service_module.build_agent_service()

    assert isinstance(built, AgentService)
    assert created["client_config"] == agent_config
    xray_kwargs = created["xray_kwargs"]
    assert xray_kwargs["binary"] == binary
    assert xray_kwargs["state_root"] == credential_path.parent
    assert xray_kwargs["install_root"] == binary.parents[1]
    assert callable(xray_kwargs["run"])
    assert callable(xray_kwargs["reload"])
    assert callable(xray_kwargs["is_active"])
    assert xray_kwargs["server"] == RealityServerConfig(
        port=443,
        target="origin.example.test:443",
        server_names=("edge.example.test",),
        short_ids=("0123456789abcdef",),
    )
    agent = created["agent"]
    assert agent.config == agent_config
    assert agent.api is built._control_plane
    assert agent.xray is created["xray"]
    assert agent.outbox is not None
    assert built._versions == {"agent": "0.1.0", "xray": "26.3.27"}
    assert built._max_clients == 128


def test_main_runs_real_agent_service_cycle_instead_of_placeholder_heartbeat(monkeypatch) -> None:
    calls: list[object] = []

    class FakeStop:
        def __init__(self) -> None:
            self.checks = 0

        def is_set(self) -> bool:
            self.checks += 1
            return self.checks > 1

        def wait(self, seconds: float) -> None:
            calls.append(("wait", seconds))

    class FakeService:
        def run_cycle(self) -> None:
            calls.append("cycle")

    monkeypatch.setattr(service_module, "STOP", FakeStop())
    monkeypatch.setattr(service_module.signal, "signal", lambda *_args: None)
    monkeypatch.setattr(service_module, "build_agent_service", lambda: FakeService())
    monkeypatch.setattr(
        service_module,
        "load_config",
        lambda: (_ for _ in ()).throw(AssertionError("placeholder path must not be used")),
    )

    assert service_module.main() == 0
    assert calls == ["cycle", ("wait", 30.0)]
