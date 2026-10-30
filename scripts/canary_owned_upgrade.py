"""Safe, explicit canary installer for an already owned fresh Shared-443 sales node.

Run locally on the target VPS as root. This intentionally does not offer remote
execution or reveal any node credentials. Never use on a personal Xray node.
"""
import argparse
import hashlib
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import time
import uuid

ROOT = pathlib.Path('/opt/madar-sales-node')
ETC = pathlib.Path('/etc/madar-sales-node')
UNITS = pathlib.Path('/etc/systemd/system')
STATE = pathlib.Path('/var/lib/madar-sales-node')
RUNTIME = pathlib.Path('/run/madar-sales-node')
AWS_STOCKHOLM_2_NODE_ID = 'edde0ebd-5fef-48bf-a9e5-91726324c058'

CODE_FILES = (
    'agent.py', 'policy.py', 'xray.py', 'guard.py', 'stats.py',
    'quota.py', 'quota_runtime.py', 'shared443.py', 'update_owned.py',
)
BACKUP_FILES = (
    *((ROOT / name, 'code_' + name) for name in CODE_FILES),
    (ROOT / 'manifest.json', 'manifest.json'),
    (ETC / 'config.json', 'config.json'),
    (UNITS / 'madar-sales-node.service', 'unit_madar-sales-node.service'),
    (UNITS / 'madar-sales-watchdog.service', 'unit_madar-sales-watchdog.service'),
)

def safe_file(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('NOT_AN_OWNED_FILE')
    return path.read_bytes()

def preflight(node_id, *, root=ROOT, etc=ETC, units=UNITS, state=STATE, now=None, max_live_accounts=1):
    now = int(time.time() if now is None else now)
    owner = json.loads(safe_file(root / 'manifest.json'))
    config = json.loads(safe_file(etc / 'config.json'))
    if (owner.get('nodeId') != node_id or config.get('nodeId') != node_id
            or not owner.get('jobId')):
        raise ValueError('OWNERSHIP_MISMATCH')
    if not (config.get('protocolVersion') == 2
            and config.get('shared443') is True
            and config.get('frontendManaged') is True
            and config.get('frontendService') == 'madar-sales-xray.service'):
        raise ValueError('CANARY_ONLY_OWNED_SHARED443')
    if not all(config.get(k) for k in ('privateKey', 'policyKey', 'nodeToken')):
        raise ValueError('INVALID_OWNED_CONFIG')
    for unit in ('madar-sales-node.service', 'madar-sales-watchdog.service'):
        text = safe_file(units / unit).decode()
        if 'ExecStart=/usr/bin/python3 /opt/madar-sales-node/agent.py' not in text:
            raise ValueError('UNIT_NOT_OWNED')
    for name in CODE_FILES:
        safe_file(root / name)
    database = state / 'quota.sqlite'
    if database.is_symlink() or not database.is_file():
        raise ValueError('QUOTA_STATE_MISSING')
    # Default canary is <=1 account; only Stockholm 2 may explicitly allow 2.
    if max_live_accounts not in (0, 1, 2):
        raise ValueError('INVALID_CANARY_LIMIT')
    if max_live_accounts == 2 and node_id != AWS_STOCKHOLM_2_NODE_ID:
        raise ValueError('TWO_ACCOUNTS_AWS_STOCKHOLM_2_ONLY')
    uri = 'file:' + str(database) + '?mode=ro'
    with sqlite3.connect(uri, uri=True, timeout=2) as db:
        live = db.execute('SELECT COUNT(*) FROM accounts WHERE present=1 AND blocked=0 AND until_time>? AND (cap IS NULL OR used<cap)', (now,)).fetchone()[0]
        snapshot = {ident: (epoch, used, blocked) for ident, epoch, used, blocked in db.execute('SELECT id,epoch,used,blocked FROM accounts')}
    if live > max_live_accounts:
        raise ValueError('BUSY_SALES_NODE')
    return {'nodeId': node_id, 'liveAccounts': live,
            'sourceRef': owner.get('sourceRef'), 'quota': snapshot}

def backup(files, destination):
    if destination.exists():
        raise ValueError('BACKUP_ALREADY_EXISTS')
    destination.mkdir(parents=True, mode=0o700)
    inventory = {}
    for source, name in files:
        raw = safe_file(source)
        (destination / name).write_bytes(raw)
        (destination / name).chmod(0o600)
        inventory[name] = hashlib.sha256(raw).hexdigest()
    (destination / 'checksums.json').write_text(json.dumps(inventory, sort_keys=True))
    (destination / 'checksums.json').chmod(0o600)
    return inventory

def restore(files, directory):
    checksums = json.loads(safe_file(directory / 'checksums.json'))
    if set(checksums) != {name for _, name in files}:
        raise ValueError('BACKUP_CONTENT_MISMATCH')
    # Verify *all* backup contents before touching any live file.
    data = {}
    for destination, name in files:
        raw = safe_file(directory / name)
        if hashlib.sha256(raw).hexdigest() != checksums[name]:
            raise ValueError('BACKUP_CHECKSUM_MISMATCH')
        if destination.is_symlink():
            raise ValueError('DESTINATION_SYMLINK')
        data[destination] = raw
    for destination, raw in data.items():
        old_mode = 0o600 if destination.name in ('config.json', 'manifest.json') else 0o644
        temporary = destination.with_name(destination.name + '.canary-restore')
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, old_mode)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)

def run_service(*args):
    subprocess.run(['systemctl', *args], check=True, timeout=20,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def healthy(node_id, source_ref, before, *, timeout=35):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            for unit in ('madar-sales-node.service', 'madar-sales-xray.service',
                         'madar-sales-watchdog.timer'):
                run_service('is-active', '--quiet', unit)
            owner = json.loads(safe_file(ROOT / 'manifest.json'))
            config = json.loads(safe_file(ETC / 'config.json'))
            heartbeat = json.loads(safe_file(RUNTIME / 'quota-heartbeat.json'))
            now = int(time.time())
            if owner.get('sourceRef') != source_ref or config.get('nodeId') != node_id:
                raise ValueError('POST_UPDATE_IDENTITY_MISMATCH')
            if ('graceUntil' in heartbeat or heartbeat.get('expiresAt', 0) <= now
                    or not 0 <= now - heartbeat.get('sampledAt', 0) <= 4):
                raise ValueError('STALE_QUOTA_HEARTBEAT')
            with sqlite3.connect('file:' + str(STATE / 'quota.sqlite') + '?mode=ro',
                                 uri=True, timeout=2) as db:
                after = {ident: (epoch, used, blocked) for ident, epoch, used, blocked in db.execute('SELECT id,epoch,used,blocked FROM accounts')}
            for ident, (epoch, used, blocked) in before['quota'].items():
                observed = after.get(ident)
                if (not observed or observed[0] != epoch or observed[1] < used
                        or observed[2] > blocked):
                    raise ValueError('QUOTA_CONTINUITY_LOST')
            return True
        except (OSError, ValueError, KeyError, json.JSONDecodeError,
                sqlite3.Error, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            time.sleep(1)
    raise ValueError('CANARY_HEALTH_CHECK_FAILED')

def rollback(files, directory):
    # SQLite state is intentionally *never* rolled back; doing so could grant
    # previously consumed quota for free or lose pending accounting reports.
    run_service('stop', 'madar-sales-watchdog.timer')
    run_service('stop', 'madar-sales-node.service')
    restore(files, directory)
    run_service('daemon-reload')
    run_service('reset-failed', 'madar-sales-watchdog.service')
    run_service('start', 'madar-sales-node.service')
    run_service('start', 'madar-sales-watchdog.timer')

def execute(args):
    if os.geteuid() != 0:
        raise ValueError('ROOT_REQUIRED')
    # A dry run and the actual install must enforce exactly the same account cap.
    before = preflight(args.node_id, max_live_accounts=args.max_live_accounts)
    if not args.apply:
        print('CANARY_PREFLIGHT_OK; live_accounts=' + str(before['liveAccounts']))
        return
    if before['liveAccounts'] > args.max_live_accounts:
        raise ValueError('CANARY_ACCOUNT_LIMIT')
    directory = STATE / 'canary-backups' / ('backup-' + uuid.uuid4().hex)
    files = BACKUP_FILES
    backup(files, directory)
    try:
        subprocess.run(['/usr/bin/python3', str(ROOT / 'update_owned.py'),
                        '--node-id', args.node_id,
                        '--source-ref', args.source_ref,
                        '--manifest-sha256', args.manifest_sha256],
                       check=True, timeout=160,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        healthy(args.node_id, args.source_ref, before)
    except Exception:
        try:
            rollback(files, directory)
            print('CANARY_ROLLBACK_ATTEMPTED; backup=' + str(directory))
        except Exception:
            print('CANARY_ROLLBACK_FAILED; backup=' + str(directory))
        raise ValueError('CANARY_UPDATE_FAILED') from None
    print('CANARY_UPDATE_HEALTHY; backup=' + str(directory))
    print('FIELD_ACCEPTANCE_PENDING')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node-id', required=True)
    parser.add_argument('--source-ref', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--max-live-accounts', type=int, default=1)
    parser.add_argument('--apply', action='store_true', help='Actually stop/restart owned canary services')
    args = parser.parse_args()
    import re
    if (not re.fullmatch('[a-f0-9-]{36}', args.node_id)
            or not re.fullmatch('[0-9a-f]{40}', args.source_ref)
            or not re.fullmatch('[0-9a-f]{64}', args.manifest_sha256)
            or not 0 <= args.max_live_accounts <= 2):
        raise SystemExit('INVALID_CANARY_ARGUMENTS')
    try:
        execute(args)
    except Exception as e:
        print('CANARY_FAILED:' + type(e).__name__ + ':' + str(e))
        raise SystemExit(1) from None

if __name__ == '__main__':
    main()
