from __future__ import annotations

import sys
from pathlib import Path
from threading import Event

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import madar_agent.service as service_module
from madar_agent.config import XrayRuntimeSettings
from madar_agent.models import AgentConfig, UserTrafficCounters


def test_background_sampler_invalidates_failed_observation_and_keeps_running() -> None:
    worker_cls = getattr(service_module, "ActivitySamplerWorker", None)
    assert worker_cls is not None, "service runtime must expose ActivitySamplerWorker"

    succeeded = Event()

    class FakeSource:
        def __init__(self) -> None:
            self.samples = 0
            self.invalidations = 0

        def sample(self) -> None:
            self.samples += 1
            if self.samples == 1:
                raise RuntimeError("fixture Xray observation failure")
            succeeded.set()

        def invalidate(self) -> None:
            self.invalidations += 1

    source = FakeSource()
    worker = worker_cls(source=source, interval_seconds=0.01)

    worker.start()
    assert succeeded.wait(1.0), "sampler must continue after an observation failure"
    worker.stop()

    assert source.invalidations == 1
    assert source.samples >= 2
    assert worker.running is False


def test_build_agent_service_wires_xray_counter_source_drain_and_one_second_worker(monkeypatch, tmp_path: Path) -> None:
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
            created["client"] = self
            created["client_config"] = config

    class FakeSource:
        def __init__(self, *, read_counters, now, max_gap_seconds=2.5, record_activity=None) -> None:
            self.read_counters = read_counters
            self.now = now
            self.max_gap_seconds = max_gap_seconds
            self.record_activity = record_activity
            created["source"] = self

        def sample(self) -> None:
            return None

        def invalidate(self) -> None:
            return None

        def drain(self):
            return []

    class FakeXray:
        def __init__(self, **kwargs) -> None:
            self.kwargs = kwargs
            created["xray"] = self
            created["xray_kwargs"] = kwargs

        def read_user_traffic_counters(self):
            return {"fixture-client": UserTrafficCounters(uplink_bytes=1, downlink_bytes=2)}

        def health(self) -> bool:
            return True

        def disable_managed_access(self) -> None:
            return None

    class FakeWorker:
        def __init__(self, *, source, interval_seconds) -> None:
            self.source = source
            self.interval_seconds = interval_seconds
            created["worker"] = self

        def start(self) -> None:
            return None

        def stop(self) -> None:
            return None

    class FakeNodeAgent:
        def __init__(self, config, *, api, xray, environment=None, now, outbox=None) -> None:
            self.outbox = outbox
            created["agent"] = self

    monkeypatch.setattr(service_module, "load_config", lambda: agent_config)
    monkeypatch.setattr(service_module, "load_runtime_config", lambda: runtime)
    monkeypatch.setattr(service_module, "ControlPlaneClient", FakeClient)
    monkeypatch.setattr(service_module, "XrayTrafficActivitySource", FakeSource, raising=False)
    monkeypatch.setattr(service_module, "PinnedXrayAdapter", FakeXray)
    monkeypatch.setattr(service_module, "ActivitySamplerWorker", FakeWorker, raising=False)
    monkeypatch.setattr(service_module, "NodeAgent", FakeNodeAgent)

    built = service_module.build_agent_service()

    source = created["source"]
    xray = created["xray"]
    worker = created["worker"]
    agent = created["agent"]
    assert source.read_counters() == {
        "fixture-client": UserTrafficCounters(uplink_bytes=1, downlink_bytes=2)
    }
    assert callable(source.record_activity)
    assert xray.kwargs["activity_source"]() == []
    assert getattr(xray.kwargs["activity_source"], "__self__", None) is source
    assert worker.source is source
    assert worker.interval_seconds == 1.0
    assert agent.outbox is getattr(source.record_activity, "__self__", None)
    assert built._activity_worker is worker


def test_main_starts_and_stops_activity_sampling_around_control_plane_loop(monkeypatch) -> None:
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
        def start_activity_sampling(self) -> None:
            calls.append("start-sampling")

        def stop_activity_sampling(self) -> None:
            calls.append("stop-sampling")

        def run_cycle(self) -> None:
            calls.append("cycle")

    monkeypatch.setattr(service_module, "STOP", FakeStop())
    monkeypatch.setattr(service_module.signal, "signal", lambda *_args: None)
    monkeypatch.setattr(service_module, "_stop_xray", lambda: None)
    monkeypatch.setattr(service_module, "build_agent_service", lambda: FakeService())

    assert service_module.main() == 0
    assert calls == [
        "start-sampling",
        "cycle",
        ("wait", 30.0),
        "stop-sampling",
    ]
