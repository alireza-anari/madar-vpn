import copy
import unittest
from agent.fresh_dual import build_fresh_dual
from agent.reconciler import ReconcileError

class FreshDualTests(unittest.TestCase):
    def test_dual_clones_8443_no_identity_or_secret_changes(self):
        row={'tag':'madar-reality','listen':'0.0.0.0','port':8443,'protocol':'vless',
            'settings':{'users':[{'id':'uuid','flow':'xtls-rprx-vision'}]},
            'streamSettings':{'security':'reality','network':'raw','realitySettings':{'privateKey':'secret'}}}
        old={'inbounds':[row],'outbounds':[]}
        frozen=copy.deepcopy(old)
        c=build_fresh_dual(old)
        self.assertEqual(old,frozen)
        self.assertEqual(c['inbounds'][0],row)
        self.assertEqual(c['inbounds'][1]['port'],443)
        self.assertEqual(c['inbounds'][1]['settings'],row['settings'])
    def test_refuses_non_bootstrapped_layout(self):
        for x in ({}, {'inbounds':[]}, {'inbounds':[{'port':443}]}, {'inbounds':[{},{}]}):
            with self.assertRaises(ReconcileError):build_fresh_dual(x)
