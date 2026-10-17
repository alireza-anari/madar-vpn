import signal


def test_quota_agent_installs_sigterm_handler_before_runtime_runs(monkeypatch):
    import agent, quota_runtime

    handlers = {}
    events = []

    class Runtime:
        def __init__(self, *args, **kwargs):
            class Stop:
                def set(self):
                    events.append("stopping")
            self.stopping = Stop()

        def run(self):
            events.append("run")
            handlers[signal.SIGTERM](signal.SIGTERM, None)

    monkeypatch.setattr(quota_runtime, "QuotaRuntime", Runtime)
    monkeypatch.setattr(signal, "signal", lambda sig, fn: handlers.__setitem__(sig, fn))
    monkeypatch.setattr(agent.pathlib.Path, "read_text", lambda self: '{"protocolVersion":2}')
    monkeypatch.setattr("sys.argv", ["agent.py"])

    agent.main()

    assert signal.SIGTERM in handlers
    assert events == ["run", "stopping"]
