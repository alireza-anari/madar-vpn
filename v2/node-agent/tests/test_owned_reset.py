"""No production service or ledger is touched by these test fixtures."""
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

from agent.account_policy import LocalLedger
from agent.bootstrap import xray_unit
from agent.installer import MARKER_TEXT
from agent.owned_reset import reset, ResetBlocked

NODE='test-reset01'
IP='8.8.8.8'
BOOT='12345678-1234-4123-8123-123456789012'
CLIENT='12345678-1234-4123-8123-123456789013'


def fixture(folder,commercial=False,used=False):
    top=Path(folder)
    etc=top/'etc'/'madar-v2'
    app=top/'opt'/'madar-v2'
    data=top/'var'/'lib'/'madar-v2'
    units=top/'etc'/'systemd'/'system'
    etc.mkdir(parents=True)
    (app/'bin').mkdir(parents=True)
    (data/'runtime').mkdir(parents=True)
    units.mkdir(parents=True)
    (etc/'STAGING-ONLY').write_text(MARKER_TEXT)
    (etc/'public-route-metadata.json').write_text(json.dumps({'node_id':NODE,'public_ip':IP}))
    (etc/'local-secrets.json').write_text(json.dumps({'clients':[BOOT]}))
    (etc/'config.json').write_text(json.dumps({'inbounds':[{
        'protocol':'vless','settings':{'users':[{'id':CLIENT if commercial else BOOT}]}
    }]}))
    (app/'bin'/'xray').write_text('fake-binary')
    (units/'madar-v2-xray.service').write_text(xray_unit())
    ledger=LocalLedger(data/'runtime'/'quota.sqlite')
    ledger.reconcile([{
        'subscription_id':'sub-pending','uuid':CLIENT,
        'expires_at':1800000120000,'quota_bytes':1000,
        'used_bytes':0,'remaining_bytes':1000,
    }],1800000000000)
    if used:
        ledger.mark_installed(['sub-pending'])
        ledger.observe({'sub-pending':10},1800000000000)
    ledger.close()
    external=top/'external-service'
    external.write_text('untouched')
    return {'etc':etc,'app':app,'data':data,'units':units},external


class ScopedResetTests(unittest.TestCase):
    def setUp(self):
        # In CI fixtures are owned by the runner. Production root ownership
        # and symlink checks stay enabled and are never altered.
        root=patch('agent.owned_reset.os.geteuid',return_value=0)
        real=__import__('agent.owned_reset',fromlist=['_owned'])._owned
        def inspect(path,kind=None):
            path=Path(path)
            st=path.lstat()
            if path.is_symlink() or st.st_mode & 0o022:
                raise ResetBlocked('UNTRUSTED_V2_PATH')
            if kind=='file' and not stat.S_ISREG(st.st_mode):
                raise ResetBlocked('UNTRUSTED_V2_FILE')
            if kind=='dir' and not stat.S_ISDIR(st.st_mode):
                raise ResetBlocked('UNTRUSTED_V2_DIRECTORY')
            return path
        own=patch('agent.owned_reset._owned',side_effect=inspect)
        root.start();own.start()
        self.addCleanup(own.stop)
        self.addCleanup(root.stop)

    def test_pending_uninstalled_account_may_be_reset_without_touching_external_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths,external=fixture(tmp)
            self.assertEqual(reset(NODE,IP,**paths),'RESET_PREFLIGHT_OK')
            before=external.read_text()
            def runner(args,**kwargs):
                return Mock(returncode=1 if args[1]=='is-active' else 0)
            self.assertEqual(reset(NODE,IP,apply=True,runner=runner,**paths),'RESET_COMPLETED')
            for p in paths.values():
                if p.name=='system':self.assertFalse((p/'madar-v2-xray.service').exists())
                else:self.assertFalse(p.exists())
            self.assertEqual(external.read_text(),before)

    def test_real_account_uuid_in_xray_refuses_reset(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths,_=fixture(tmp,commercial=True)
            with self.assertRaisesRegex(ResetBlocked,'COMMERCIAL_XRAY_UUID_PRESENT'):
                reset(NODE,IP,apply=True,runner=Mock(),**paths)
            self.assertTrue(paths['etc'].exists())

    def test_used_bytes_or_installed_account_refuses_reset(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths,_=fixture(tmp,used=True)
            with self.assertRaisesRegex(ResetBlocked,'CUSTOMER_USAGE_OR_INSTALL_PRESENT'):
                reset(NODE,IP,apply=True,runner=Mock(),**paths)
            self.assertTrue(paths['etc'].exists())

    def test_unrecognized_v2_state_refuses_reset(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths,_=fixture(tmp)
            (paths['etc']/'unknown-app-data').write_text('do not delete me')
            with self.assertRaisesRegex(ResetBlocked,'UNKNOWN_V2_CONFIG'):
                reset(NODE,IP,apply=True,runner=Mock(),**paths)
            self.assertTrue((paths['etc']/'unknown-app-data').exists())

    def test_node_id_ip_and_unit_binding_refuse_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths,_=fixture(tmp)
            for node,ip in [('test-wrong01',IP),(NODE,'1.1.1.1')]:
                with self.assertRaisesRegex(ResetBlocked,'V2_IDENTITY_MISMATCH'):
                    reset(node,ip,apply=True,runner=Mock(),**paths)
            (paths['units']/'madar-v2-xray.service').write_text('Unrelated systemd service')
            with self.assertRaisesRegex(ResetBlocked,'UNKNOWN_V2_SYSTEMD_UNIT'):
                reset(NODE,IP,apply=True,runner=Mock(),**paths)


if __name__=='__main__':
    unittest.main()
