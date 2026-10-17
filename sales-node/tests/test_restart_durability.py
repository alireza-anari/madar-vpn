import pathlib


def test_clean_runtime_shutdown_checkpoints_usage_and_leaves_account_restartable(tmp_path, monkeypatch):
    import quota_runtime as runtime
    from quota import QuotaStore

    database = tmp_path / "quota.sqlite"
    QuotaStore(database).close()
    ticks = [0]
    stopped = []

    class Process:
        def __init__(self, config, client, base):
            self.client = client
            self.generation = "before-restart"

        def sample(self):
            return 50

        def stop(self):
            stopped.append(self.client["accountId"])

    monkeypatch.setattr(runtime.time, "time", lambda: 100 + ticks[0])
    controller = runtime.QuotaRuntime(
        {"policyKey": "k", "nodeId": "n"},
        None,
        lambda policy, *args: policy,
        base=tmp_path / "run",
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

    def stop_after_first_tick(delay):
        ticks[0] += 1
        controller.stopping.set()

    monkeypatch.setattr(runtime.time, "sleep", stop_after_first_tick)
    controller.run()

    store = QuotaStore(database)
    row = store.db.execute("SELECT * FROM accounts WHERE id='a'").fetchone()
    assert stopped == ["a"]
    assert row["used"] == 50
    assert row["blocked"] == 0
    assert row["process_generation"] is None
    assert row["counter"] is None
    assert store.allowed("a", 102)
    store.close()
