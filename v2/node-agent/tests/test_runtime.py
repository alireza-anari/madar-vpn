import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent.runtime import read_marker,store_marker,watchdog,Runtime,stats_snapshot
from agent.runtime_install import render_runtime_units


class RuntimeSafetyTests(unittest.TestCase):
    def test_watchdog_only_stops_owned_runtime_after_expired_commercial_heartbeat(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            stopped=[]
            self.assertFalse(watchdog(root,100000,stop=lambda:stopped.append(1)))
            self.assertEqual(stopped,[])
            store_marker(root,{'mode':'commercial','pid':1234,'checked_ms':90000})
            self.assertTrue(watchdog(root,100000,stop=lambda:stopped.append(1)))
            self.assertEqual(stopped,[])
            self.assertFalse(watchdog(root,136000,stop=lambda:stopped.append(1)))
            self.assertEqual(stopped,[1])
            self.assertEqual(read_marker(root)['pid'],1234)

    def test_rendered_units_are_isolated_and_include_independent_watchdog(self):
        units=render_runtime_units('test-node01')
        self.assertEqual(len(units),3)
        service=units['madar-v2-runtime.service']
        self.assertIn(' --node-id test-node01 ',service)
        self.assertIn('ExecStart=/usr/bin/python3 -m agent.runtime',service)
        self.assertIn('NoNewPrivileges=yes',service)
        self.assertIn('UMask=0077',service)
        timer=units['madar-v2-runtime-watchdog.timer']
        self.assertIn('OnUnitActiveSec=15s',timer)
        self.assertNotIn('madar-sales-node',service)
        for invalid in ('node1','prod-01','test node','../etc'):
            with self.assertRaises(Exception):render_runtime_units(invalid)

    def test_prevent_leaking_secrets_or_publishing_raw_stats_service(self):
        units=render_runtime_units('test-safe01')
        text=''.join(units.values())
        self.assertNotIn('NODE_MASTER_KEY',text)
        self.assertNotIn('0.0.0.0:10085',text)
        self.assertNotIn('nodeToken',text)


if __name__=='__main__':
    unittest.main()
