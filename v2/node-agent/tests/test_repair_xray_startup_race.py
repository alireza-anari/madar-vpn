import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import repair_xray_startup_race as repair


class GuardedStartupPatchTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        root=pathlib.Path(folder.name)
        self.code=root/'runtime.py'
        self.metadata=root/'public-route-metadata.json'
        self.ledger=root/'quota.sqlite'
        self.unit=root/'madar-v2-runtime.service'
        self.node='Amazon-hanie'
        self.metadata.write_text(json.dumps({'node_id':self.node}))
        self.unit.write_text(
            'Description=Madar V2 isolated node quota and client reconciler\n'
            'ExecStart=/usr/bin/python3 -m agent.runtime --node-id Amazon-hanie\n'
            'Environment=PYTHONPATH=/opt/madar-v2/runtime\n'
        )
        self.unit.chmod(0o644)
        with sqlite3.connect(self.ledger) as db:
            db.executescript('CREATE TABLE accounts('
              'installed INTEGER,counter INTEGER,total INTEGER,used INTEGER,'
              'sequence INTEGER,reported_seq INTEGER);')
            db.execute('INSERT INTO accounts VALUES(0,0,0,0,0,0)')
        # This legacy patcher intentionally recognizes only the old runtime.
        old='def store_marker(root,document):\n    pass\n\n'
        old+='def legacy_apply(self,ledger,active):\n'+repair.OLD+'\n'
        old+="active=[{'subscription_id':row['id'],'uuid':row['uuid']} for row in []]\n"
        self.code.write_text(old)
        self.original=old
        for path in (self.code,self.metadata,self.ledger):path.chmod(0o600)
        self.patches=[
            patch.object(repair.os,'geteuid',return_value=0),
            patch.object(repair,'safe_regular',side_effect=lambda path,*args:path)
        ]
        for x in self.patches:
            x.start();self.addCleanup(x.stop)
        self.kwargs={'code':self.code,'metadata':self.metadata,
            'ledger':self.ledger,'unit':self.unit}

    def test_dry_run_reports_ready_without_modifying_source_or_ledger(self):
        self.assertEqual(repair.repair(self.node,**self.kwargs),
                         'PATCH_READY_NO_CHANGES')
        self.assertEqual(self.code.read_text(),self.original)
        self.assertEqual(list(self._ledger()),[(0,0,0,0,0,0)])

    def _ledger(self):
        with sqlite3.connect(self.ledger) as db:
            return db.execute('SELECT * FROM accounts').fetchall()

    def test_nonzero_usage_and_installed_customer_fail_closed(self):
        with sqlite3.connect(self.ledger) as db:
            db.execute('UPDATE accounts SET installed=1,total=12')
        with self.assertRaisesRegex(repair.RepairBlocked,
                                    'EXISTING_CUSTOMER_OR_UNRESOLVED_LEDGER'):
            repair.repair(self.node,apply=True,**self.kwargs)
        self.assertEqual(self.code.read_text(),self.original)

    def test_unrecognized_runtime_source_is_not_rewritten(self):
        self.code.write_text(self.original.replace(
           'def store_marker(root,document):','def different(root,document):'))
        with self.assertRaisesRegex(repair.RepairBlocked,'UNKNOWN_RUNTIME_GENERATION'):
            repair.repair(self.node,**self.kwargs)

    def test_apply_preserves_ledger_and_creates_private_backup(self):
        operations=[]
        class Result:
            returncode=0
        def fake_runner(args,**kw):
            operations.append(args[1])
            return Result()
        result=repair.repair(self.node,apply=True,runner=fake_runner,**self.kwargs)
        self.assertEqual(result,'PATCH_APPLIED_WAIT_FOR_FRESH_SIGNED_HEALTH')
        self.assertEqual(operations,['stop','start'])
        fixed=self.code.read_text()
        self.assertIn('def wait_for_xray_readiness(',fixed)
        self.assertNotIn(repair.OLD,fixed)
        compile(fixed,str(self.code),'exec')
        self.assertEqual(list(self._ledger()),[(0,0,0,0,0,0)])
        backup=self.code.with_name('runtime.py.xray-readiness-backup')
        self.assertEqual(backup.read_text(),self.original)
        self.assertEqual(backup.stat().st_mode&0o777,0o600)
        self.assertEqual(repair.repair(self.node,**self.kwargs),'ALREADY_PATCHED')

    def test_restart_failure_restores_original_source(self):
        operations=[]
        class Result:
            def __init__(self,code):self.returncode=code
        def fake_runner(args,**kw):
            operations.append(args[1])
            if operations==['stop','start']:return Result(1)
            return Result(0)
        with self.assertRaisesRegex(repair.RepairBlocked,'AGENT_START_FAILED'):
            repair.repair(self.node,apply=True,runner=fake_runner,**self.kwargs)
        self.assertEqual(self.code.read_text(),self.original)
        self.assertEqual(operations,['stop','start','start'])


if __name__=='__main__':unittest.main()
