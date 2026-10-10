from __future__ import annotations

import json
import stat
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import madar_agent.service as service_module
from madar_agent.agent import NodeAgent
from madar_agent.config import XrayRuntimeSettings
from madar_agent.models import AgentConfig, ManagedClient, Policy
from madar_agent.xray import PinnedXrayAdapter, RealityServerConfig, XrayRuntimeError


CLIENT_ID = "27848739-7e62-4138-9fd3-098a63964b6b"
NOW = datetime(2026, 10, 10, 16, 45, tzinfo=UTC)


def write_private_key(tmp_path: Path, value: str = "fixture-private-key") -> None:
    state_root = tmp_path / "state"
    state_root.mkdir(parents=True, exist_ok=True)
    private_path = state_root / "reality.private"
    private_path.write_text(value, encoding="utf-8")
    private_path.chmod(0o600)


def server() -> RealityServerConfig:
    return RealityServerConfig(
        port=443,
        target="www.example.com:443",
        server_names=("www.example.com",),
        short_ids=("0123456789abcdef",),
    )


def managed_client() -> ManagedClient:
    return ManagedClient(client_id=CLIENT_ID, tier="premium", speed_kbps=None)


def adapter_with_lifecycle(
    tmp_path: Path,
    *,
    run,
    authorize_runtime,
    revoke_runtime_authorization,
    restart,
    is_active,
    disable_runtime,
    logs: list[str] | None = None,
) -> PinnedXrayAdapter:
    return PinnedXrayAdapter(
        install_root=tmp_path / "runtime",
        state_root=tmp_path / "state",
        download=lambda _url: b"",
        run=run,
        log=(logs or []).append,
        binary=tmp_path / "runtime" / "26.3.27" / "xray",
        server=server(),
        authorize_runtime=authorize_runtime,
        revoke_runtime_authorization=revoke_runtime_authorization,
        reload=restart,
        is_active=is_active,
        disable_runtime=disable_runtime,
    )


def test_apply_clients_grants_authorization_only_after_promotion_then_verifies_started_runtime(tmp_path: Path) -> None:
    write_private_key(tmp_path)
    state_root = tmp_path / "state"
    candidate = state_root / "xray-config.candidate.json"
    live = state_root / "xray-config.json"
    events: list[str] = []

    def run(argv: list[str]):
        config_path = Path(argv[-1])
        if config_path == candidate:
            events.append("validate")
        elif config_path == live:
            events.append("health")
        else:
            raise AssertionError(f"unexpected Xray config path: {config_path}")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    def authorize() -> None:
        assert live.is_file(), "authorization must happen after live config promotion"
        assert not candidate.exists(), "promotion must consume the candidate before authorization"
        payload = json.loads(live.read_text(encoding="utf-8"))
        assert payload["inbounds"][0]["settings"]["clients"][0]["id"] == CLIENT_ID
        events.append("authorize")

    def restart() -> None:
        events.append("restart")

    def active() -> bool:
        events.append("active")
        return True

    adapter = adapter_with_lifecycle(
        tmp_path,
        run=run,
        authorize_runtime=authorize,
        revoke_runtime_authorization=lambda: events.append("revoke"),
        restart=restart,
        is_active=active,
        disable_runtime=lambda: events.append("disable"),
    )

    adapter.apply_clients([managed_client()])

    assert events == ["validate", "authorize", "restart", "active", "health"]
    assert stat.S_IMODE(live.stat().st_mode) == 0o600


def test_candidate_validation_failure_never_grants_runtime_authorization(tmp_path: Path) -> None:
    write_private_key(tmp_path)
    events: list[str] = []

    def run(_argv: list[str]):
        events.append("validate")
        return SimpleNamespace(returncode=1, stdout="sensitive raw config detail", stderr="fixture failure")

    adapter = adapter_with_lifecycle(
        tmp_path,
        run=run,
        authorize_runtime=lambda: events.append("authorize"),
        revoke_runtime_authorization=lambda: events.append("revoke"),
        restart=lambda: events.append("restart"),
        is_active=lambda: True,
        disable_runtime=lambda: events.append("disable"),
    )

    with pytest.raises(XrayRuntimeError):
        adapter.apply_clients([managed_client()])

    assert events == ["validate"]
    assert not (tmp_path / "state" / "xray-config.json").exists()


def test_activation_failure_revokes_authorization_disables_runtime_and_redacts_callback_error(tmp_path: Path) -> None:
    private_key = "fixture-private-key-must-not-leak"
    write_private_key(tmp_path, private_key)
    events: list[str] = []
    logs: list[str] = []

    def run(_argv: list[str]):
        events.append("validate")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    def restart() -> None:
        events.append("restart")
        raise RuntimeError(f"restart detail {private_key} {CLIENT_ID}")

    adapter = adapter_with_lifecycle(
        tmp_path,
        run=run,
        authorize_runtime=lambda: events.append("authorize"),
        revoke_runtime_authorization=lambda: events.append("revoke"),
        restart=restart,
        is_active=lambda: True,
        disable_runtime=lambda: events.append("disable"),
        logs=logs,
    )

    with pytest.raises(XrayRuntimeError) as raised:
        adapter.apply_clients([managed_client()])

    assert events == ["validate", "authorize", "restart", "revoke", "disable"]
    assert private_key not in str(raised.value)
    assert CLIENT_ID not in str(raised.value)
    assert all(private_key not in line and CLIENT_ID not in line for line in logs)


def test_post_start_health_failure_revokes_authorization_and_disables_runtime(tmp_path: Path) -> None:
    write_private_key(tmp_path)
    events: list[str] = []

    def run(_argv: list[str]):
        events.append("validate")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    def active() -> bool:
        events.append("active")
        return False

    adapter = adapter_with_lifecycle(
        tmp_path,
        run=run,
        authorize_runtime=lambda: events.append("authorize"),
        revoke_runtime_authorization=lambda: events.append("revoke"),
        restart=lambda: events.append("restart"),
        is_active=active,
        disable_runtime=lambda: events.append("disable"),
    )

    with pytest.raises(XrayRuntimeError):
        adapter.apply_clients([managed_client()])

    assert events == ["validate", "authorize", "restart", "active", "revoke", "disable"]


def test_fail_closed_disable_revokes_and_stops_without_promoting_or_restarting_empty_config(tmp_path: Path) -> None:
    write_private_key(tmp_path)
    events: list[str] = []
    candidate = tmp_path / "state" / "xray-config.candidate.json"
    live = tmp_path / "state" / "xray-config.json"

    def run(argv: list[str]):
        config_path = Path(argv[-1])
        events.append("validate" if config_path == candidate else "health")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    adapter = adapter_with_lifecycle(
        tmp_path,
        run=run,
        authorize_runtime=lambda: events.append("authorize"),
        revoke_runtime_authorization=lambda: events.append("revoke"),
        restart=lambda: events.append("restart"),
        is_active=lambda: True,
        disable_runtime=lambda: events.append("disable"),
    )
    adapter.apply_clients([managed_client()])
    before = live.read_text(encoding="utf-8")
    events.clear()

    adapter.disable_managed_access()

    assert events == ["revoke", "disable"]
    assert live.read_text(encoding="utf-8") == before
    assert adapter._managed_clients == []


def test_fresh_explicit_empty_policy_is_a_normal_authorized_apply_not_fail_closed_disable(tmp_path: Path) -> None:
    credential = tmp_path / "node.credential"
    credential.write_text("test-node-credential", encoding="utf-8")
    credential.chmod(0o600)

    class FakeApi:
        def fetch_policy(self, _known_revision: int):
            return None

    class FakeXray:
        def __init__(self) -> None:
            self.applied: list[list[ManagedClient]] = []
            self.disable_calls = 0

        def apply_clients(self, clients: list[ManagedClient]) -> None:
            self.applied.append(list(clients))

        def disable_managed_access(self) -> None:
            self.disable_calls += 1

        def collect_observed_activity(self):
            return []

    runtime = FakeXray()
    agent = NodeAgent(
        AgentConfig(api_base_url="https://control.example.test", credential_path=credential),
        api=FakeApi(),
        xray=runtime,
        now=lambda: NOW,
    )
    empty = Policy(revision=9, valid_until=NOW + timedelta(minutes=5), clients=())

    result = agent.apply_policy(empty)

    assert result.applied is True
    assert result.disabled is False
    assert runtime.applied == [[]]
    assert runtime.disable_calls == 0


def test_build_agent_service_wires_one_supplied_lifecycle_into_all_xray_runtime_callbacks(monkeypatch, tmp_path: Path) -> None:
    credential_path = tmp_path / "etc" / "madar-node-agent" / "node.credential"
    binary = tmp_path / "opt" / "madar-xray" / "26.3.27" / "xray"
    agent_config = AgentConfig(
        api_base_url="https://control.example.test",
        credential_path=credential_path,
        request_timeout_seconds=10.0,
    )
    runtime_config = XrayRuntimeSettings(
        binary=binary,
        version="26.3.27",
        port=443,
        server_name="edge.example.test",
        reality_target="origin.example.test:443",
        reality_short_id="0123456789abcdef",
        max_clients=128,
    )
    created: dict[str, object] = {}
    lifecycle_events: list[str] = []

    class FakeLifecycle:
        def grant_authorization(self) -> None:
            lifecycle_events.append("grant")

        def revoke_authorization(self) -> None:
            lifecycle_events.append("revoke")

        def restart_authorized(self) -> None:
            lifecycle_events.append("restart")

        def is_active(self) -> bool:
            lifecycle_events.append("active")
            return True

        def disable(self) -> None:
            lifecycle_events.append("disable")

    lifecycle = FakeLifecycle()

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
            pass

        def read_user_traffic_counters(self):
            return {}

    class FakeNodeAgent:
        def __init__(self, config, *, api, xray, environment=None, now, outbox=None) -> None:
            created["agent"] = self
            self.config = config
            self.api = api
            self.xray = xray
            self.outbox = outbox

    monkeypatch.setattr(service_module, "load_config", lambda: agent_config)
    monkeypatch.setattr(service_module, "load_runtime_config", lambda: runtime_config)
    monkeypatch.setattr(service_module, "ControlPlaneClient", FakeClient)
    monkeypatch.setattr(service_module, "PinnedXrayAdapter", FakeXray)
    monkeypatch.setattr(service_module, "NodeAgent", FakeNodeAgent)

    built = service_module.build_agent_service(lifecycle=lifecycle)

    assert built._agent is created["agent"]
    kwargs = created["xray_kwargs"]
    kwargs["authorize_runtime"]()
    kwargs["revoke_runtime_authorization"]()
    kwargs["reload"]()
    assert kwargs["is_active"]() is True
    kwargs["disable_runtime"]()
    assert lifecycle_events == ["grant", "revoke", "restart", "active", "disable"]


def test_build_xray_lifecycle_uses_the_shared_process_runner(monkeypatch) -> None:
    created: dict[str, object] = {}

    class FakeLifecycle:
        def __init__(self, **kwargs) -> None:
            created.update(kwargs)

    monkeypatch.setattr(service_module, "SystemdXrayLifecycle", FakeLifecycle)

    built = service_module.build_xray_lifecycle()

    assert isinstance(built, FakeLifecycle)
    assert created["run"] is service_module._run_process
