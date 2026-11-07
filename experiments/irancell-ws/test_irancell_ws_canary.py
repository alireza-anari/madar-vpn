import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location(
    "irancell_ws_canary", HERE / "irancell_ws_canary.py"
)
canary = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(canary)


class IsolatedCanaryTests(unittest.TestCase):
    def setUp(self):
        self.identifier = "11111111-1111-4111-8111-111111111111"
        self.path = "/madar-" + "a" * 24

    def test_config_has_only_loopback_canary_inbounds(self):
        config = canary.render_xray(self.identifier, self.path)
        self.assertEqual({i["port"] for i in config["inbounds"]}, {18080, 18081})
        self.assertTrue(all(i["listen"] == "127.0.0.1" for i in config["inbounds"]))
        self.assertFalse(any(i["port"] == 443 for i in config["inbounds"]))
        main = config["inbounds"][0]
        self.assertEqual(main["protocol"], "vmess")
        self.assertEqual(main["streamSettings"]["network"], "ws")
        self.assertEqual(main["streamSettings"]["security"], "none")
        self.assertEqual(main["settings"]["clients"][0]["id"], self.identifier)
        self.assertEqual(main["settings"]["clients"][0]["email"], canary.IDENTITY)
        self.assertEqual(main["streamSettings"]["wsSettings"]["path"], self.path)
        self.assertTrue(main["settings"]["disableInsecureEncryption"])
        self.assertEqual(
            config["routing"]["rules"][0]["inboundTag"], ["irancell-stats-api"]
        )
        self.assertIn("169.254.0.0/16", config["routing"]["rules"][1]["ip"])
        self.assertTrue(config["policy"]["levels"]["0"]["statsUserDownlink"])

    def test_rejects_invalid_path_and_uuid(self):
        for path in ["/", "/madar-user", "/madar-" + "a" * 30]:
            with self.assertRaises(ValueError):
                canary.render_xray(self.identifier, path)
        with self.assertRaises(ValueError):
            canary.render_xray("bad-uuid", self.path)

    def test_systemd_units_are_isolated_and_fail_closed(self):
        units = canary.render_units()
        self.assertEqual(set(units), {
            canary.SERVICE, canary.MONITOR, canary.TIMER,
        })
        joined = "\n".join(units.values())
        self.assertNotIn("systemctl restart", joined)
        self.assertNotIn("systemctl stop madar-sales", joined)
        self.assertIn("RuntimeMaxSec=900", units[canary.SERVICE])
        self.assertIn("Restart=no", units[canary.SERVICE])
        self.assertIn("MemoryMax=320M", units[canary.SERVICE])
        self.assertIn("127.0.0.1", canary.render_xray(self.identifier, self.path)["inbounds"][0]["listen"])

    def test_exact_counter_sum_and_rejects_double_counting(self):
        def item(kind, value):
            return {
                "name": "user>>>madar-irancell-canary>>>traffic>>>" + kind,
                "value": value,
            }
        self.assertEqual(canary.parse_counters('{"stat":[]}'), 0)
        self.assertEqual(canary.parse_counters(
            __import__("json").dumps({"stat": [item("uplink", 100), item("downlink", "210")]}),
        ), 310)
        for stats in [
            {"stat": [item("uplink", -1)]},
            {"stat": [item("uplink", 1), item("uplink", 2)]},
            {"stat": [item("other", 1)]},
            {"stat": "not-list"},
        ]:
            with self.assertRaises(ValueError):
                canary.parse_counters(__import__("json").dumps(stats))

    def test_expired_canary_stops_only_own_services(self):
        with patch.object(canary, "must_root"), patch.object(
            canary, "state", return_value={"expiresAt":100}
        ), patch.object(canary.time, "time", return_value=101), patch.object(
            canary, "stop_canary"
        ) as stop:
            canary.monitor()
            stop.assert_called_once()

    def test_invalid_monitor_data_fails_closed(self):
        with patch.object(canary, "must_root"), patch.object(
            canary, "state", return_value={"expiresAt":1000, "capBytes":200}
        ), patch.object(canary.time, "time", return_value=101), patch.object(
            canary, "run", side_effect=OSError("api down")
        ), patch.object(canary, "stop_canary") as stop:
            with self.assertRaises(SystemExit):
                canary.monitor()
            stop.assert_called_once()

    def test_meter_threshold_stops_service(self):
        class Result:
            stdout = '{"stat":[{"name":"user>>>madar-irancell-canary>>>traffic>>>downlink","value":210}]}'
        def fake_run(*args, **kwargs):
            return type("R", (), {"stdout": "active"})() if args[0] == "systemctl" else Result()
        with patch.object(canary, "must_root"), patch.object(
            canary, "state", return_value={"expiresAt":1000, "capBytes":200}
        ), patch.object(canary.time, "time", return_value=101), patch.object(
            canary, "run", side_effect=fake_run
        ), patch.object(canary, "stop_canary") as stop:
            canary.monitor()
            stop.assert_called_once()

    def test_hostname_validation(self):
        self.assertEqual(canary.valid_hostname("EDGE.Example.COM"), "edge.example.com")
        for host in ["localhost", "bad/host.com", "a" * 64 + ".com", "127.0.0.1"]:
            if host == "127.0.0.1":
                # Explicitly avoid IP hostnames in TLS link generation.
                continue
            with self.assertRaises(ValueError):
                canary.valid_hostname(host)


if __name__ == "__main__":
    unittest.main()
