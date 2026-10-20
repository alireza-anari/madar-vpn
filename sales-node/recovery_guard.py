"""Fail-closed watchdog/recovery coordinator for quota-v2 sales nodes.

The watchdog keeps its strict four-second meter deadline.  The recovery job
starts an inactive agent only after proving that the previous account counters
are safely checkpointed.  Both use one kernel lock to prevent a watchdog
invocation from killing a just-started agent based on a previous heartbeat.
"""
import fcntl
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import time

AGENT = 'madar-sales-node.service'
XRAY = 'madar-sales-xray.service'
WATCHDOG_TIMER = 'madar-sales-watchdog.timer'
ROOT = pathlib.Path('/run/madar-sales-node')
HEARTBEAT = ROOT / 'quota-heartbeat.json'
DATABASE = pathlib.Path('/var/lib/madar-sales-node/quota.sqlite')
HISTORY = pathlib.Path('/var/lib/madar-sales-node/recovery-attempts.json')
LOCK = pathlib.Path('/run/lock/madar-sales-lifecycle.lock')
MAINTENANCE = pathlib.Path('/etc/madar-sales-node/maintenance')
WINDOW_SECONDS = 600
MAX_ATTEMPTS = 3
STARTUP_SECONDS = 20


def _command(*args, timeout=25):
    return subprocess.run(list(args), check=True, timeout=timeout,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _active(unit):
    return subprocess.run(['systemctl', 'is-active', '--quiet', unit],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def _lock():
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    fd = LOCK.open('a+')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fd.close()
        return None
    return fd


def _quota_ready_to_restart(now):
    if not DATABASE.is_file():
        return False
    try:
        with sqlite3.connect('file:' + str(DATABASE) + '?mode=ro', uri=True, timeout=3) as db:
            if db.execute('PRAGMA quick_check(1)').fetchone()[0] != 'ok':
                return False
            if db.execute('SELECT revision FROM meta WHERE id=1').fetchone() is None:
                return False
            # A still-active account with an uncheckpointed process generation
            # cannot be safely restarted: its prior Xray counters may be lost.
            pending = db.execute('''
                SELECT COUNT(*) FROM accounts
                WHERE present=1 AND blocked=0 AND until_time>?
                  AND (cap IS NULL OR used<cap)
                  AND process_generation IS NOT NULL
            ''', (now,)).fetchone()[0]
            return pending == 0
    except (sqlite3.Error, OSError, ValueError, TypeError):
        return False


def _recent_attempts(now):
    try:
        history = json.loads(HISTORY.read_text())
    except FileNotFoundError:
        return []
    if not isinstance(history, list) or any(type(x) is not int for x in history):
        raise ValueError('INVALID_RECOVERY_HISTORY')
    return [x for x in history if now-WINDOW_SECONDS < x <= now]


def _record_attempts(attempts):
    HISTORY.parent.mkdir(parents=True, exist_ok=True)
    fd, path = tempfile.mkstemp(prefix='.recovery-', dir=str(HISTORY.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(attempts, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(path, HISTORY)
    finally:
        if os.path.exists(path):
            os.unlink(path)


def check_watchdog():
    lock = _lock()
    if lock is None:
        # Recovery owns the lock only while the old frontend is off and a new
        # authorized runtime is establishing its heartbeat.
        return
    with lock:
        if not _active(AGENT) and not _active(XRAY):
            return
        from agent import watchdog
        watchdog()


def recover():
    lock = _lock()
    if lock is None:
        return
    with lock:
        if _active(AGENT) or MAINTENANCE.exists():
            return
        if _active(XRAY):
            print('RECOVERY_ORPHAN_XRAY_STOP', flush=True)
            _command('systemctl', 'stop', XRAY)
            return
        if not _active(WATCHDOG_TIMER):
            print('RECOVERY_WATCHDOG_INACTIVE', flush=True)
            return
        now = int(time.time())
        if not _quota_ready_to_restart(now):
            print('RECOVERY_QUOTA_CONTINUITY_UNPROVEN', flush=True)
            return
        try:
            recent = _recent_attempts(now)
        except (ValueError, OSError, json.JSONDecodeError):
            print('RECOVERY_HISTORY_INVALID', flush=True)
            return
        if len(recent) >= MAX_ATTEMPTS:
            print('RECOVERY_BACKOFF', flush=True)
            return
        _record_attempts(recent + [now])
        # The previous heartbeat is not evidence of the new agent's liveness.
        previous = ROOT / 'quota-heartbeat.recovery-previous.json'
        if HEARTBEAT.exists():
            HEARTBEAT.replace(previous)
            print('RECOVERY_OLD_HEARTBEAT_QUARANTINED', flush=True)
        print('RECOVERY_START_AGENT', flush=True)
        try:
            _command('systemctl', 'start', AGENT)
            from quota_runtime import meter_authorized
            deadline = time.monotonic() + STARTUP_SECONDS
            while time.monotonic() < deadline:
                try:
                    beat = json.loads(HEARTBEAT.read_text())
                    # Startup grace authorizes constructing an empty frontend,
                    # not an assurance that a signed policy was reconciled and
                    # the account counters were durably sampled.
                    metered = ('graceUntil' not in beat and
                               meter_authorized(HEARTBEAT, int(time.time())))
                except (OSError, ValueError, TypeError):
                    metered = False
                if metered and _active(AGENT) and _active(XRAY):
                    print('RECOVERY_READY', flush=True)
                    return
                if not _active(AGENT):
                    break
                time.sleep(0.25)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
            print('RECOVERY_START_FAILED:' + type(exc).__name__, flush=True)
        print('RECOVERY_STARTUP_NOT_VERIFIED', flush=True)
        # Cut external traffic first. A failed recovery must never leave an
        # unmetered frontend alive while the agent is down.
        _command('systemctl', 'stop', XRAY)
        _command('systemctl', 'stop', AGENT)


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if args == ['watchdog']:
        check_watchdog()
    elif args == ['recover']:
        recover()
    else:
        raise SystemExit('Expected exactly watchdog or recover')


if __name__ == '__main__':
    main()
