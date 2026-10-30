import importlib.util
import json
import pathlib
import sqlite3

import pytest

CANARY = pathlib.Path(__file__).resolve().parents[2] / 'scripts' / 'canary_owned_upgrade.py'


def module():
    spec = importlib.util.spec_from_file_location('canary_owned_upgrade', CANARY)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def fixture_node(tmp_path, *, live=1, frontend_managed=True):
    root = tmp_path / 'opt'
    etc = tmp_path / 'etc'
    units = tmp_path / 'units'
    state = tmp_path / 'state'
    for p in (root, etc, units, state):
        p.mkdir()
    (root / 'manifest.json').write_text(json.dumps({'nodeId': 'node-test', 'jobId': 'job-id', 'sourceRef': 'old'}))
    (etc / 'config.json').write_text(json.dumps({
        'nodeId': 'node-test', 'protocolVersion': 2, 'shared443': True,
        'frontendManaged': frontend_managed, 'frontendService': 'madar-sales-xray.service',
        'nodeToken': 'private', 'policyKey': 'private', 'privateKey': 'private',
    }))
    for name in ('madar-sales-node.service', 'madar-sales-watchdog.service'):
        (units / name).write_text('ExecStart=/usr/bin/python3 /opt/madar-sales-node/agent.py --watchdog\\n')
    for name in module().CODE_FILES:
        (root / name).write_text('old-owned-code: ' + name)
    database = state / 'quota.sqlite'
    with sqlite3.connect(database) as db:
        db.execute('CREATE TABLE accounts(id TEXT PRIMARY KEY, epoch INTEGER, cap INTEGER, used INTEGER, blocked INTEGER, present INTEGER, until_time INTEGER)')
        for i in range(live):
            db.execute('INSERT INTO accounts VALUES(?, 1, 100, 15, 0, 1, 9999999999)', (str(i),))
    return root, etc, units, state


def test_preflight_refuses_personal_frontend_or_foreign_node(tmp_path):
    m = module()
    paths = fixture_node(tmp_path, frontend_managed=False)
    with pytest.raises(ValueError, match='CANARY_ONLY_OWNED_SHARED443'):
        m.preflight('node-test', root=paths[0], etc=paths[1], units=paths[2], state=paths[3])
    with pytest.raises(ValueError, match='OWNERSHIP_MISMATCH'):
        m.preflight('other-node', root=paths[0], etc=paths[1], units=paths[2], state=paths[3])


def test_preflight_refuses_busy_node_before_any_backup(tmp_path):
    m = module()
    paths = fixture_node(tmp_path, live=2)
    with pytest.raises(ValueError, match='BUSY_SALES_NODE'):
        m.preflight('node-test', root=paths[0], etc=paths[1], units=paths[2], state=paths[3])


def test_preflight_accepts_isolated_one_account_trial(tmp_path):
    m = module()
    paths = fixture_node(tmp_path)
    result = m.preflight('node-test', root=paths[0], etc=paths[1], units=paths[2], state=paths[3])
    assert result['liveAccounts'] == 1
    assert result['quota'] == {'0': (1, 15, 0)}


def test_backup_restore_does_not_touch_metering_database(tmp_path):
    m = module()
    paths = fixture_node(tmp_path)
    root, etc, units, state = paths
    files = [(root / 'agent.py', 'agent.py'), (etc / 'config.json', 'config.json')]
    old_code = (root / 'agent.py').read_bytes()
    old_config = (etc / 'config.json').read_bytes()
    target = state / 'canary-backups' / 'snapshot-1'
    m.backup(files, target)
    assert target.stat().st_mode & 0o077 == 0
    (root / 'agent.py').write_text('bad-code')
    (etc / 'config.json').write_text('bad-config')
    with sqlite3.connect(state / 'quota.sqlite') as db:
        db.execute('UPDATE accounts SET used=25')
    m.restore(files, target)
    assert (root / 'agent.py').read_bytes() == old_code
    assert (etc / 'config.json').read_bytes() == old_config
    with sqlite3.connect(state / 'quota.sqlite') as db:
        assert db.execute('SELECT used FROM accounts').fetchone()[0] == 25


def test_tampered_backup_rejected_before_any_restore(tmp_path):
    m = module()
    paths = fixture_node(tmp_path)
    root, _, _, state = paths
    files = [(root / 'agent.py', 'agent.py'), (root / 'quota_runtime.py', 'quota_runtime.py')]
    target = state / 'backup'
    m.backup(files, target)
    (target / 'quota_runtime.py').write_text('tampered')
    (root / 'agent.py').write_text('live-new-code')
    with pytest.raises(ValueError, match='BACKUP_CHECKSUM_MISMATCH'):
        m.restore(files, target)
    assert (root / 'agent.py').read_text() == 'live-new-code'


def test_preflight_refuses_symlinked_quota_state(tmp_path):
    m = module()
    paths = fixture_node(tmp_path)
    real_db = paths[3] / 'quota.sqlite'
    target_db = tmp_path / 'real-quota.sqlite'
    real_db.rename(target_db)
    real_db.symlink_to(target_db)
    with pytest.raises(ValueError, match='QUOTA_STATE_MISSING'):
        m.preflight('node-test', root=paths[0], etc=paths[1], units=paths[2], state=paths[3])


def test_two_account_canary_allowed_only_on_stockholm2(tmp_path):
    m = module()
    paths = fixture_node(tmp_path, live=2)
    with pytest.raises(ValueError, match='TWO_ACCOUNTS_AWS_STOCKHOLM_2_ONLY'):
        m.preflight('node-test', root=paths[0], etc=paths[1], units=paths[2],
                    state=paths[3], max_live_accounts=2)
    for file in (paths[0] / 'manifest.json', paths[1] / 'config.json'):
        values = json.loads(file.read_text())
        values['nodeId'] = m.AWS_STOCKHOLM_2_NODE_ID
        file.write_text(json.dumps(values))
    result = m.preflight(m.AWS_STOCKHOLM_2_NODE_ID, root=paths[0], etc=paths[1],
                         units=paths[2], state=paths[3], max_live_accounts=2)
    assert result['liveAccounts'] == 2
    with pytest.raises(ValueError, match='BUSY_SALES_NODE'):
        m.preflight(m.AWS_STOCKHOLM_2_NODE_ID, root=paths[0], etc=paths[1],
                    units=paths[2], state=paths[3])


def test_three_accounts_never_pass_even_with_aws_two_account_flag(tmp_path):
    m = module()
    paths = fixture_node(tmp_path, live=3)
    for file in (paths[0] / 'manifest.json', paths[1] / 'config.json'):
        values = json.loads(file.read_text())
        values['nodeId'] = m.AWS_STOCKHOLM_2_NODE_ID
        file.write_text(json.dumps(values))
    with pytest.raises(ValueError, match='BUSY_SALES_NODE'):
        m.preflight(m.AWS_STOCKHOLM_2_NODE_ID, root=paths[0], etc=paths[1],
                    units=paths[2], state=paths[3], max_live_accounts=2)
