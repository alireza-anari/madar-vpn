import json


def test_fresh_frontend_start_has_bounded_watchdog_grace(tmp_path, monkeypatch):
    import quota_runtime as runtime
    from quota import QuotaStore

    database = tmp_path / "quota.sqlite"
    QuotaStore(database).close()
    base = tmp_path / "run"
    now = [100]
    seen = []
    monkeypatch.setattr(runtime.time, "time", lambda: now[0])

    class Frontend:
        def check(self):
            return None

    def factory(*args):
        now[0] = 120
        seen.append(runtime.meter_authorized(base / "quota-heartbeat.json", now[0]))
        return Frontend()

    controller = runtime.QuotaRuntime(
        {"policyKey": "k", "nodeId": "n", "shared443": True, "frontendManaged": True},
        None,
        lambda policy, *args: policy,
        base=base,
        database=database,
        frontend_factory=factory,
    )
    assert seen == [True]
    controller.store.close()


def test_slow_account_start_gets_temporary_watchdog_grace(tmp_path, monkeypatch):
    import quota_runtime as runtime
    from quota import QuotaStore

    database = tmp_path / "quota.sqlite"
    QuotaStore(database).close()
    base = tmp_path / "run"
    now = [100]
    seen = []
    monkeypatch.setattr(runtime.time, "time", lambda: now[0])

    class Process:
        def __init__(self, config, client, process_base):
            self.client = client
            self.generation = "g"
            now[0] = 106
            seen.append(runtime.meter_authorized(base / "quota-heartbeat.json", now[0]))

        def sample(self):
            return 0

        def stop(self):
            return None

    controller = runtime.QuotaRuntime(
        {"policyKey": "k", "nodeId": "n"},
        None,
        lambda policy, *args: policy,
        base=base,
        database=database,
        process_factory=Process,
    )
    controller.network = lambda: None
    client = {
        "accountId": "a",
        "quotaEpoch": 1,
        "quotaBytes": 1000,
        "usedBytes": 0,
        "validUntil": 1000,
        "generation": "a:1",
        "listenPort": 20000,
    }
    controller.incoming.put(
        ("policy", {"version": 2, "revision": 1, "expiresAt": 400, "clients": [client]})
    )

    def stop_after_tick(delay):
        controller.stopping.set()

    monkeypatch.setattr(runtime.time, "sleep", stop_after_tick)
    controller.run()
    assert seen == [True]
