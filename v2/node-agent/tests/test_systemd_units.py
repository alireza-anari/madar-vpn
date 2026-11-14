import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from agent.systemd_units import render_units,install_staging_units
from agent.installer import MARKER_TEXT
from agent.reconciler import ReconcileError

class UnitTests(unittest.TestCase):
    def test_credentials_not_world_readable_and_only_v2_units(self):
        units=render_units("/opt/madar-v2/bin/xray","/opt/madar-v2/bin/caddy",
                           "/var/lib/madar-v2-staging")
        self.assertEqual(set(units),{"madar-v2-xray.service","madar-v2-caddy.service"})
        self.assertIn("LoadCredential=config.json:",units["madar-v2-xray.service"])
        self.assertIn("LoadCredential=Caddyfile:",units["madar-v2-caddy.service"])
        self.assertIn("DynamicUser=yes",units["madar-v2-xray.service"])
        self.assertIn("CapabilityBoundingSet=CAP_NET_BIND_SERVICE",units["madar-v2-caddy.service"])
        self.assertNotIn("madar-sales-bot",repr(units))

    def test_path_injection_refused(self):
        with self.assertRaises(ReconcileError):
            render_units("/bin/xray;rm","/usr/bin/caddy","/var/lib/madar-v2-staging")
        with self.assertRaises(ReconcileError):
            render_units("/bin/xray","/usr/bin/caddy","/etc/../etc")
        with self.assertRaises(ReconcileError):
            render_units("/bin/bash","/usr/bin/caddy","/var/lib/madar-v2-staging")

    def test_explicit_marker_before_unit_install(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)/"safe"
            root.mkdir()
            units=Path(td)/"systemd"
            units.mkdir()
            with patch("agent.systemd_units.current_euid",return_value=0):
                with self.assertRaisesRegex(ReconcileError,"marker"):
                    install_staging_units(root,unit_dir=units,
                        xray_path="/opt/madar-v2/bin/xray",
                        caddy_path="/opt/madar-v2/bin/caddy",runner=lambda *args,**kw: True)
            self.assertEqual(list(units.iterdir()),[])

    def test_failed_daemon_reload_removes_new_units(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)/"safe"
            root.mkdir()
            (root/"STAGING-ONLY").write_text(MARKER_TEXT)
            os.chmod(root/"STAGING-ONLY",0o600)
            units=Path(td)/"systemd"
            units.mkdir()
            with patch("agent.systemd_units.current_euid",return_value=0):
                with self.assertRaisesRegex(ReconcileError,"systemd refused"):
                    install_staging_units(root,unit_dir=units,
                        xray_path="/opt/madar-v2/bin/xray",
                        caddy_path="/opt/madar-v2/bin/caddy",
                        runner=lambda *args,**kw: False)
            self.assertEqual(list(units.iterdir()),[])

if __name__=="__main__":unittest.main()
