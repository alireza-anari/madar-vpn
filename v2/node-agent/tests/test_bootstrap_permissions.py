"""Reproduce the restrictive umask used by the SSH package executor."""
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from agent import bootstrap


class BootstrapPermissionsTests(unittest.TestCase):
    def test_service_binary_is_traversable_under_remote_umask(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            binary_dir = root/'opt'/'madar-v2'/'bin'
            binary_dir.parent.parent.mkdir()
            base = root/'etc-madar'
            units = root/'units'
            units.mkdir()
            def command(args, **kwargs):
                from types import SimpleNamespace
                return SimpleNamespace(stdout='PrivateKey: '+ 'A'*43 +'\nPassword: '+ 'B'*43)
            previous = os.umask(0o077)
            try:
                with patch.multiple(bootstrap, BIN=binary_dir, BASE=base, UNITS=units), \
                     patch.object(bootstrap, '_guard_fresh_system'), \
                     patch.object(bootstrap, '_probe_ports'), \
                     patch.object(bootstrap.releases, 'verified_release', return_value=(b'binary', 'a'*64)), \
                     patch.object(bootstrap, 'command', side_effect=command), \
                     patch.object(bootstrap, '_make_user'), \
                     patch.object(bootstrap, '_is_active', return_value=True):
                    bootstrap.install_test_node(bootstrap.plan_node(node_id='test-permissions', public_ip='8.8.4.4'))
            finally:
                os.umask(previous)
            for directory in (binary_dir.parent, binary_dir):
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE((base/'local-secrets.json').stat().st_mode), 0o600)
