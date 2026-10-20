"""Safety tests for the systemd lifecycle watchdog/recovery coordinator."""
import importlib.util
import json
import pathlib
import sqlite3
import sys
import types
import fcntl

import pytest


def guard(tmp_path, monkeypatch):
    module_path = pathlib.Path(__file__).parents[1] / 'recovery_guard.py'
    spec = importlib.util.spec_from_file_location('recovery_guard_test', module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT = tmp_path / 'run'
    module.ROOT.mkdir()
    module.HEARTBEAT = module.ROOT / 'quota-heartbeat.json'
    module.DATABASE = tmp_path / 'quota.sqlite'
    module.HISTORY = tmp_path / 'attempts.json'
    module.LOCK = tmp_path / 'guard.lock'
    module.MAINTENANCE = tmp_path / 'maintenance'
    with sqlite3.connect(str(module.DATABASE)) as db:
        db.execute('CREATE TABLE meta(id INTEGER PRIMARY KEY,revision INTEGER)')
        db.execute('INSERT INTO meta VALUES(1,7)')
        db.execute('''CREATE TABLE accounts(
          id TEXT, present INTEGER, blocked INTEGER, until_time INTEGER,
          cap INTEGER, used INTEGER, process_generation TEXT)''')
        db.execute("INSERT INTO accounts VALUES('active',1,0,9999999999,1000,50,NULL)")
    return module


def test_quota_gate_rejects_missing_bad_and_uncheckpointed(tmp_path, monkeypatch):
    g = guard(tmp_path, monkeypatch)
    assert g._quota_ready_to_restart(100)
    with sqlite3.connect(str(g.DATABASE)) as db:
        db.execute("UPDATE accounts SET process_generation='still-running'")
    assert not g._quota_ready_to_restart(100)
    with sqlite3.connect(str(g.DATABASE)) as db:
        db.execute("UPDATE accounts SET blocked=1")
    assert g._quota_ready_to_restart(100)
    g.DATABASE.unlink()
    assert not g._quota_ready_to_restart(100)


def test_watchdog_does_not_race_recovery_under_shared_lock(tmp_path, monkeypatch):
    g = guard(tmp_path, monkeypatch)
    seen = []
    monkeypatch.setattr(g, '_active', lambda unit: True)
    monkeypatch.setitem(sys.modules, 'agent', types.SimpleNamespace(watchdog=lambda: seen.append('ran')))
    with g.LOCK.open('a+') as holder:
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        g.check_watchdog()
        assert seen == []
    g.check_watchdog()
    assert seen == ['ran']


def test_inactive_agent_skips_watchdog_when_frontend_stopped(tmp_path, monkeypatch):
    g = guard(tmp_path, monkeypatch)
    monkeypatch.setattr(g, '_active', lambda unit: False)
    monkeypatch.setitem(sys.modules, 'agent', types.SimpleNamespace(watchdog=lambda: pytest.fail('unexpected watchdog')))
    g.check_watchdog()


def test_recovery_quarantines_old_heartbeat_then_ready(tmp_path, monkeypatch):
    g = guard(tmp_path, monkeypatch)
    g.HEARTBEAT.write_text('stale')
    status = {g.AGENT: False, g.XRAY: False, g.WATCHDOG_TIMER: True}
    calls = []
    monkeypatch.setattr(g, '_active', lambda unit: status[unit])

    def command(*args, **kwargs):
        calls.append(args)
        if args[1] == 'start':
            assert not g.HEARTBEAT.exists()
            assert (g.ROOT / 'quota-heartbeat.recovery-previous.json').read_text() == 'stale'
            status[g.AGENT] = status[g.XRAY] = True
            g.HEARTBEAT.write_text('fresh')

    monkeypatch.setattr(g, '_command', command)
    monkeypatch.setitem(sys.modules, 'quota_runtime', types.SimpleNamespace(meter_authorized=lambda *args: True))
    g.recover()
    assert calls == [('systemctl', 'start', g.AGENT)]
    assert len(json.loads(g.HISTORY.read_text())) == 1
    assert (g.ROOT / 'quota-heartbeat.recovery-previous.json').read_text() == 'stale'
    with sqlite3.connect(str(g.DATABASE)) as db:
        assert db.execute("SELECT used FROM accounts WHERE id='active'").fetchone()[0] == 50


def test_invalid_policy_prevents_unverified_frontend(tmp_path, monkeypatch):
    g = guard(tmp_path, monkeypatch)
    status = {g.AGENT: False, g.XRAY: False, g.WATCHDOG_TIMER: True}
    calls = []
    monkeypatch.setattr(g, '_active', lambda unit: status[unit])

    def command(*args, **kwargs):
        calls.append(args)
        if args[1] == 'start':
            status[g.AGENT] = True
            status[g.XRAY] = True
            g.HEARTBEAT.write_text('invalid')
        elif args[1] == 'stop':
            status[args[2]] = False

    monkeypatch.setattr(g, '_command', command)
    monkeypatch.setitem(sys.modules, 'quota_runtime', types.SimpleNamespace(meter_authorized=lambda *args: False))
    reads = [0]
    original = g._active

    def unstable_active(unit):
        if unit == g.AGENT and calls:
            reads[0] += 1
            if reads[0] > 1:
                status[g.AGENT] = False
        return original(unit)

    monkeypatch.setattr(g, '_active', unstable_active)
    g.recover()
    assert calls[-2:] == [('systemctl', 'stop', g.XRAY), ('systemctl', 'stop', g.AGENT)]
    assert not status[g.XRAY]


def test_backoff_blocks_fourth_start(tmp_path, monkeypatch):
    g = guard(tmp_path, monkeypatch)
    monkeypatch.setattr(g.time, 'time', lambda: 1000)
    g.HISTORY.write_text(json.dumps([995,996,997]))
    monkeypatch.setattr(g, '_active', lambda unit: unit == g.WATCHDOG_TIMER)
    monkeypatch.setattr(g, '_command', lambda *args, **kwargs: pytest.fail('unexpected restart'))
    g.recover()
    assert g.HISTORY.read_text() == json.dumps([995,996,997])


def test_fail_closed_when_watchdog_not_running(tmp_path, monkeypatch):
    g = guard(tmp_path, monkeypatch)
    monkeypatch.setattr(g, '_active', lambda unit: False)
    monkeypatch.setattr(g, '_command', lambda *args, **kwargs: pytest.fail('unexpected start'))
    g.recover()


def test_orphan_xray_is_stopped_before_attempted_recovery(tmp_path, monkeypatch):
    g = guard(tmp_path, monkeypatch)
    actions = []
    monkeypatch.setattr(g, '_active', lambda unit: unit == g.XRAY)
    monkeypatch.setattr(g, '_command', lambda *args, **kwargs: actions.append(args))
    g.recover()
    assert actions == [('systemctl', 'stop', g.XRAY)]
    assert not g.HISTORY.exists()
