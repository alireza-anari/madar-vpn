from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import madar_agent.service as service_module
from madar_agent.api import PermanentApiError
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
    assert callable(xray_kwargs["authorize_runtime"])
    assert callable(xray_kwargs["revoke_runtime_authorization"])
    assert callable(xray_kwargs["reload"])
    assert callable(xray_kwargs["is_active"])
    assert callable(xray_kwargs["disable_runtime"])
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


class FakeStop:
    def __init__(self, calls: list[object], *, loops: int = 1) -> None:
        self._calls = calls
        self._loops = loops
        self._checks = 0

    def is_set(self) -> bool:
        self._checks += 1
        return self._checks > self._loops

    def wait(self, seconds: float) -> None:
        self._calls.append(("wait", seconds))


class FakeLifecycle:
    def __init__(self, calls: list[object], *, ensure_error: Exception | None = None, disable_error: Exception | None = None) -> None:
        self.calls = calls
        self.ensure_error = ensure_error
        self.disable_error = disable_error

    def ensure_inactive(self) -> None:
        self.calls.append("ensure-inactive")
        if self.ensure_error is not None:
            raise self.ensure_error

    def disable(self) -> None:
        self.calls.append("disable")
        if self.disable_error is not None:
            raise self.disable_error


def test_main_verifies_xray_inactive_before_build_and_uses_same_lifecycle_for_shutdown(monkeypatch) -> None:
    calls: list[object] = []
    lifecycle = FakeLifecycle(calls)

    class FakeService:
        def start_activity_sampling(self) -> None:
            calls.append("start-sampler")

        def stop_activity_sampling(self) -> None:
            calls.append("stop-sampler")

        def run_cycle(self) -> None:
            calls.append("cycle")

    def build(*, lifecycle):
        assert lifecycle is lifecycle_instance
        calls.append("build")
        return FakeService()

    lifecycle_instance = lifecycle
    monkeypatch.setattr(service_module, "STOP", FakeStop(calls))
    monkeypatch.setattr(service_module.signal, "signal", lambda *_args: None)
    monkeypatch.setattr(service_module, "build_xray_lifecycle", lambda: lifecycle)
    monkeypatch.setattr(service_module, "build_agent_service", build)

    assert service_module.main() == 0
    assert calls == [
        "ensure-inactive",
        "build",
        "start-sampler",
        "cycle",
        ("wait", 30.0),
        "stop-sampler",
        "disable",
    ]


def test_main_refuses_runtime_build_when_xray_inactivity_cannot_be_proven(monkeypatch, capsys) -> None:
    calls: list[object] = []
    sensitive_detail = "fixture-systemctl-secret-should-not-leak"
    lifecycle = FakeLifecycle(calls, ensure_error=RuntimeError(sensitive_detail))

    def build(*, lifecycle):
        calls.append("build")
        raise AssertionError("runtime must not build while Xray shutdown is unverified")

    monkeypatch.setattr(service_module.signal, "signal", lambda *_args: None)
    monkeypatch.setattr(service_module, "build_xray_lifecycle", lambda: lifecycle)
    monkeypatch.setattr(service_module, "build_agent_service", build)

    assert service_module.main() == 4
    assert calls == ["ensure-inactive"]
    captured = capsys.readouterr()
    assert sensitive_detail not in captured.err
    assert captured.err.strip() == "node-agent startup unavailable; managed Xray shutdown unverified"


def test_main_build_failure_best_effort_disables_xray_without_leaking_error(monkeypatch, capsys) -> None:
    calls: list[object] = []
    sensitive_detail = "fixture-client-id-should-not-be-logged"
    lifecycle = FakeLifecycle(calls)

    def build(*, lifecycle):
        calls.append("build")
        raise RuntimeError(sensitive_detail)

    monkeypatch.setattr(service_module.signal, "signal", lambda *_args: None)
    monkeypatch.setattr(service_module, "build_xray_lifecycle", lambda: lifecycle)
    monkeypatch.setattr(service_module, "build_agent_service", build)

    assert service_module.main() == 3
    assert calls == ["ensure-inactive", "build", "disable"]
    captured = capsys.readouterr()
    assert sensitive_detail not in captured.err
    assert captured.err.strip() == "node-agent startup unavailable; managed Xray disabled"


def test_main_build_failure_still_returns_generic_error_when_cleanup_disable_also_fails(monkeypatch, capsys) -> None:
    calls: list[object] = []
    lifecycle = FakeLifecycle(
        calls,
        disable_error=RuntimeError("cleanup-secret-should-not-leak"),
    )

    def build(*, lifecycle):
        calls.append("build")
        raise RuntimeError("build-secret-should-not-leak")

    monkeypatch.setattr(service_module.signal, "signal", lambda *_args: None)
    monkeypatch.setattr(service_module, "build_xray_lifecycle", lambda: lifecycle)
    monkeypatch.setattr(service_module, "build_agent_service", build)

    assert service_module.main() == 3
    assert calls == ["ensure-inactive", "build", "disable"]
    captured = capsys.readouterr()
    assert "secret-should-not-leak" not in captured.err
    assert captured.err.strip() == "node-agent startup unavailable; managed Xray disabled"


def test_main_shutdown_disables_xray_even_when_sampler_cleanup_fails(monkeypatch, capsys) -> None:
    calls: list[object] = []
    lifecycle = FakeLifecycle(calls)

    class FakeService:
        def start_activity_sampling(self) -> None:
            calls.append("start-sampler")

        def stop_activity_sampling(self) -> None:
            calls.append("stop-sampler")
            raise RuntimeError("sampler-cleanup-secret")

        def run_cycle(self) -> None:
            calls.append("cycle")

    monkeypatch.setattr(service_module, "STOP", FakeStop(calls))
    monkeypatch.setattr(service_module.signal, "signal", lambda *_args: None)
    monkeypatch.setattr(service_module, "build_xray_lifecycle", lambda: lifecycle)
    monkeypatch.setattr(service_module, "build_agent_service", lambda *, lifecycle: FakeService())

    assert service_module.main() == 0
    assert calls[-2:] == ["stop-sampler", "disable"]
    assert "sampler-cleanup-secret" not in capsys.readouterr().err


def test_main_fatal_cycle_exit_still_disables_runtime(monkeypatch, capsys) -> None:
    calls: list[object] = []
    lifecycle = FakeLifecycle(calls)

    class FakeService:
        def start_activity_sampling(self) -> None:
            calls.append("start-sampler")

        def stop_activity_sampling(self) -> None:
            calls.append("stop-sampler")

        def run_cycle(self) -> None:
            calls.append("cycle")
            raise PermanentApiError(401, "FIXTURE_SECRET_CODE")

    monkeypatch.setattr(service_module, "STOP", FakeStop(calls, loops=10))
    monkeypatch.setattr(service_module.signal, "signal", lambda *_args: None)
    monkeypatch.setattr(service_module, "build_xray_lifecycle", lambda: lifecycle)
    monkeypatch.setattr(service_module, "build_agent_service", lambda *, lifecycle: FakeService())

    assert service_module.main() == 2
    assert calls == [
        "ensure-inactive",
        "start-sampler",
        "cycle",
        "stop-sampler",
        "disable",
    ]
    captured = capsys.readouterr()
    assert "FIXTURE_SECRET_CODE" not in captured.err
    assert captured.err.strip() == "node-agent cycle rejected: HTTP 401"
