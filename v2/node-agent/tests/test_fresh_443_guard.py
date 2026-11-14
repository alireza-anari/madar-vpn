"""Protect existing V1 listeners before any fresh V2 installation writes."""
import unittest
from unittest.mock import patch
from agent import bootstrap

class TestFreshPortGuard(unittest.TestCase):
    def test_detects_occupied_443_for_reality_only_plan(self):
        ports=[]
        def guard(address,port):
            ports.append(port)
            if port==443:
                raise bootstrap.BootstrapError('local TCP port already in use')
        with patch.object(bootstrap,'_port_available',side_effect=guard):
            with self.assertRaises(bootstrap.BootstrapError):
                bootstrap._probe_ports({'reality_port':8443,'wss_domain':None})
        self.assertEqual(ports,[8443,443])

    def test_clean_reality_only_plan_checks_both_ports(self):
        ports=[]
        with patch.object(bootstrap,'_port_available',side_effect=lambda addr,port:ports.append(port)):
            bootstrap._probe_ports({'reality_port':8443,'wss_domain':None})
        self.assertEqual(ports,[8443,443])

if __name__=='__main__':unittest.main()
