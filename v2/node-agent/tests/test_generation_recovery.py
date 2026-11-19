import importlib.util
import json
import os
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

PATH=pathlib.Path(__file__).parents[1]/'zero_observed_generation_recovery.py'
SPEC=importlib.util.spec_from_file_location('zero_observed_generation_recovery',PATH)
imported=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(imported)

class BoundedGapRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name)/'etc'
        self.state=pathlib.Path(self.temp.name)/'state'
        self.root.mkdir()
        self.state.mkdir()
        self.ip='13.60.234.55'
        self.node='Amazon-hanie'
        self.uid='12345678-1234-4123-8123-123456789012'
        self.sid='pending-unit-test'
        (self.root/'public-route-metadata.json').write_text(
            json.dumps({'node_id':self.node,'public_ip':self.ip}))
        (self.root/'config.json').write_text(json.dumps({'inbounds':[
            {'protocol':'vless','port':p,'settings':{'users':[{
                'id':self.uid,'email':'v2-'+self.sid}]}} for p in (443,8443)]}))
        for k in ('local-secrets.json','node.key'):
            (self.root/k).write_text('test-only-no-private-key')
        (self.state/'heartbeat.json').write_text(
            json.dumps({'mode':'commercial','pid':99,'policy_until_ms':1,
                        'checked_ms':1}))
        self.db=self.state/'quota.sqlite'
        with sqlite3.connect(self.db) as db:
            db.executescript('CREATE TABLE accounts('
                'id TEXT PRIMARY KEY,uuid TEXT,installed INTEGER,present INTEGER,'
                'counter INTEGER,total INTEGER,used INTEGER,sequence INTEGER,'
                'reported_seq INTEGER);'
                'CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);')
            db.execute('INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?,?)',
                (self.sid,self.uid,1,1,0,0,0,0,0))
        self.patches=[
          patch.object(imported,'ROOT',self.root),
          patch.object(imported,'STATE',self.state),
          patch.object(imported,'DB',self.db),
          patch.object(imported,'MARKER',self.state/'heartbeat.json'),
          patch.object(imported.os,'geteuid',return_value=0),
          patch.object(imported,'require_regular',side_effect=lambda p,n:pathlib.Path(p)),
          patch.object(imported,'ports_are_clear',return_value=True),
        ]
        for p in self.patches:
            p.start();self.addCleanup(p.stop)

    def test_dry_run_non_mutating_and_rejects_nonzero_usage(self):
        with patch.object(imported,'service_active',side_effect=lambda s,_run: s==imported.AGENT):
            self.assertEqual(imported.preflight(self.node,self.ip)['account_id'],self.sid)
            with sqlite3.connect(self.db) as db:
                db.execute('UPDATE accounts SET total=1')
            with self.assertRaisesRegex(imported.RecoveryBlocked,'NOT_ZERO_OBSERVED_USAGE'):
                imported.preflight(self.node,self.ip)
            self.assertEqual(imported.read_accounts(self.db)[0][2],1)

    def test_applied_gap_audit_preserves_cumulative_usage_and_creates_backup(self):
        agent_running=[True]
        def is_running(name,_run):
            return agent_running[0] if name==imported.AGENT else False
        class Result:
            returncode=0
        def run(argv,**kwargs):
            if argv[:2]==['/usr/bin/systemctl','stop']:
                agent_running[0]=False
            elif argv[:2]==['/usr/bin/systemctl','start']:
                agent_running[0]=True
            return Result()
        real_mkdtemp=tempfile.mkdtemp
        with patch.object(imported,'service_active',side_effect=is_running),patch.object(
            imported.tempfile,'mkdtemp',side_effect=lambda prefix,dir:
                real_mkdtemp(prefix=prefix,dir=self.temp.name)):
            backup=pathlib.Path(imported.apply(self.node,self.ip,run=run))
        self.assertTrue((backup/'quota.sqlite').is_file())
        self.assertTrue(agent_running[0])
        with sqlite3.connect(self.db) as db:
            installed,total,counter,used=db.execute(
                'SELECT installed,total,counter,used FROM accounts').fetchone()
            self.assertEqual((installed,total,counter,used),(0,0,0,0))
            audit=db.execute('SELECT value FROM meta').fetchone()
            self.assertTrue(json.loads(audit[0])['unmetered_traffic_possible'])
        with sqlite3.connect(backup/'quota.sqlite') as db:
            self.assertEqual(db.execute('SELECT installed FROM accounts').fetchone()[0],1)
        self.assertEqual(oct((backup/'quota.sqlite').stat().st_mode&0o777),'0o600')

if __name__=='__main__':
    unittest.main()
