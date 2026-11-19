"""Regression tests for the redacted, read-only G1 generation audit."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from agent.generation_audit import inspect


class GenerationAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.state = self.root / "state"
        self.state.mkdir()
        self.config = self.root / "config.json"

    def tearDown(self):
        self.tmp.cleanup()

    def write_marker(self, pid):
        (self.state / "heartbeat.json").write_text(json.dumps({
            "mode": "commercial", "pid": pid, "checked_ms": 123,
            "policy_until_ms": 456
        }))

    def write_ledger(self):
        path = self.state / "quota.sqlite"
        db = sqlite3.connect(path)
        db.execute("""CREATE TABLE accounts(
            id TEXT, uuid TEXT, installed INTEGER, present INTEGER,
            total INTEGER, sequence INTEGER, reported_seq INTEGER)""")
        db.execute("""INSERT INTO accounts VALUES(
            'secret-account','123e4567-e89b-42d3-a456-426614174000',1,1,1234,5,3)""")
        db.commit()
        db.close()
        return path

    def write_config(self):
        self.config.write_text(json.dumps({
            "inbounds": [
                {"protocol": "vless", "port": 443,
                 "settings": {"users": [{"id": "SECRET-UUID"}]}},
                {"protocol": "vless", "port": 8443,
                 "settings": {"users": [{"id": "SECRET-UUID"}]}},
                {"protocol": "dokodemo-door", "port": 10085,
                 "settings": {"address": "127.0.0.1"}}
            ]
        }))

    def test_mismatch_is_fail_closed_and_does_not_modify_evidence(self):
        self.write_marker(123)
        path = self.write_ledger()
        self.write_config()
        before_ledger = path.read_bytes()
        before_marker = (self.state / "heartbeat.json").read_bytes()
        before_config = self.config.read_bytes()
        report = inspect(self.state, self.config, pid_reader=lambda: 124)
        self.assertEqual(report["process_generation"], "generation_mismatch")
        self.assertEqual(report["G1"], "PENDING_LOCAL_COUNTER_RECONCILIATION")
        self.assertFalse(report["safe_to_reset_ledger_or_marker"])
        self.assertFalse(report["safe_to_issue_customer_configs_from_this_report"])
        self.assertEqual(report["ledger"]["marked_installed"], 1)
        self.assertEqual(report["ledger"]["cumulative_metered_bytes"], 1234)
        self.assertEqual(report["xray_config"]["vless_profiles_443"], 1)
        self.assertEqual(report["xray_config"]["vless_profiles_8443"], 1)
        redacted = json.dumps(report)
        self.assertNotIn("SECRET-UUID", redacted)
        self.assertNotIn("secret-account", redacted)
        self.assertNotIn("123e4567", redacted)
        self.assertNotIn('"pid":', redacted)
        self.assertEqual(path.read_bytes(), before_ledger)
        self.assertEqual((self.state / "heartbeat.json").read_bytes(), before_marker)
        self.assertEqual(self.config.read_bytes(), before_config)

    def test_match_is_not_mistaken_for_proof_of_safe_launch(self):
        self.write_marker(123)
        report = inspect(self.state, self.config, pid_reader=lambda: 123)
        self.assertEqual(report["process_generation"], "pid_marker_match_only")
        self.assertEqual(report["G1"], "PENDING_USAGE_CONTINUITY_VERIFICATION")
        self.assertFalse(report["safe_to_issue_customer_configs_from_this_report"])

    def test_missing_or_changing_process_never_suggests_reset(self):
        self.write_marker(123)
        pids = iter((123, 124))
        changing = inspect(self.state, self.config, pid_reader=lambda: next(pids))
        self.assertEqual(changing["process_generation"], "unverifiable_or_changing")
        missing = inspect(self.state, self.config, pid_reader=lambda: 0)
        self.assertEqual(missing["process_generation"], "not_running")
        marker = self.state / "heartbeat.json"
        marker.unlink()
        unknown = inspect(self.state, self.config, pid_reader=lambda: 123)
        self.assertEqual(unknown["process_generation"], "marker_missing_or_invalid")
        for report in (changing, missing, unknown):
            self.assertFalse(report["safe_to_reset_ledger_or_marker"])


if __name__ == "__main__":
    unittest.main()
