"""Offline regression for guarded, no-ledger-reset first-client repair."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from agent.account_policy import LocalLedger
from agent.runtime_install import render_runtime_units
from repair_first_client import OLD,NEW,check,repair,RepairBlocked

NODE='test-repair01'
UUID='12345678-1234-4123-8123-123456789012'
NOW=1800000000000


def fixture(root):
    root=Path(root)
    pkg=root/'opt'/'agent'
    pkg.mkdir(parents=True)
    src=pkg/'runtime.py'
    text=("def run(ledger,policy,now_ms):\n"+OLD+"\n" +
          "    return None\n")
    src.write_text(text)
    src.chmod(0o600)
    metadata=root/'public-route-metadata.json'
    metadata.write_text(json.dumps({'node_id':NODE}))
    metadata.chmod(0o600)
    unit=root/'madar-v2-runtime.service'
    unit.write_text(render_runtime_units(NODE)['madar-v2-runtime.service'])
    unit.chmod(0o644)
    dbfile=root/'quota.sqlite'
    ledger=LocalLedger(dbfile)
    ledger.reconcile([{'subscription_id':'sub-first','uuid':UUID,
       'quota_bytes':1000,'used_bytes':0,'remaining_bytes':1000,
       'expires_at':NOW+600000}],NOW)
    ledger.close()
    return {'code':src,'metadata':metadata,'unit':unit,'ledger':dbfile}


class BoundedRecoveryTests(unittest.TestCase):
    def test_dry_run_and_repair_do_not_rewrite_usage_ledger(self):
        with tempfile.TemporaryDirectory() as path:
            files=fixture(path)
            before=hashlib.sha256(files['ledger'].read_bytes()).digest()
            first=files['code'].read_text()
            self.assertEqual(repair(NODE,**files),'PATCH_APPLICABLE_NO_CHANGES')
            self.assertEqual(files['code'].read_text(),first)
            runner=Mock(return_value=Mock(returncode=0))
            self.assertEqual(
                repair(NODE,apply=True,runner=runner,**files),
                'PATCH_APPLIED_WAIT_FOR_SIGNED_CLIENT_ACK')
            repaired=files['code'].read_text()
            self.assertNotIn(OLD,repaired)
            self.assertIn(NEW,repaired)
            self.assertEqual(
                files['code'].with_name('runtime.py.first-client-backup').read_text(),
                first)
            self.assertEqual(hashlib.sha256(files['ledger'].read_bytes()).digest(),before)
            self.assertEqual(runner.call_count,2)
            self.assertEqual(repair(NODE,**files),'ALREADY_PATCHED')

    def test_recovery_refuses_any_commercial_account_already_installed(self):
        with tempfile.TemporaryDirectory() as path:
            files=fixture(path)
            ledger=LocalLedger(files['ledger'])
            ledger.mark_installed(['sub-first'])
            ledger.close()
            original=files['code'].read_text()
            with self.assertRaisesRegex(RepairBlocked,'COMMERCIAL_ACCOUNTS_INSTALLED'):
                repair(NODE,apply=True,runner=Mock(),**files)
            self.assertEqual(files['code'].read_text(),original)

    def test_wrong_node_and_changed_source_fail_closed(self):
        with tempfile.TemporaryDirectory() as path:
            files=fixture(path)
            with self.assertRaisesRegex(RepairBlocked,'NODE_MISMATCH'):
                repair('another-node',**files)
            files['code'].write_text("print('unreviewed')\n")
            with self.assertRaisesRegex(RepairBlocked,'UNKNOWN_RUNTIME_GENERATION'):
                repair(NODE,**files)

    def test_failed_service_restart_restores_original_python_source(self):
        with tempfile.TemporaryDirectory() as path:
            files=fixture(path)
            original=files['code'].read_text()
            runner=Mock(return_value=Mock(returncode=1))
            with self.assertRaisesRegex(RepairBlocked,'RESTART_FAILED_OR_ROLLED_BACK'):
                repair(NODE,apply=True,runner=runner,**files)
            self.assertEqual(files['code'].read_text(),original)
            self.assertTrue(files['code'].with_name('runtime.py.first-client-backup').exists())


if __name__=='__main__':
    unittest.main()
