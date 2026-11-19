import base64
import hashlib
import unittest
from unittest.mock import patch
from probe import parse_ws_reply, probe, WS_GUID


class ProbeTests(unittest.TestCase):
    def test_websocket_upgrade_validation(self):
        key = base64.b64encode(b"0" * 16).decode()
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        reply = ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                 "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept
                 + "\r\n\r\n").encode()
        self.assertTrue(parse_ws_reply(reply, key))
        self.assertFalse(parse_ws_reply(reply, "wrong"))
        self.assertFalse(parse_ws_reply(b"HTTP/1.1 200 OK\r\n\r\n", key))

    @patch("probe.socket.getaddrinfo", side_effect=OSError("DNS"))
    def test_dns_failure_not_reported_as_cloudflare_failure(self, _resolve):
        result = probe("invalid.example", 443, transport="wss")
        self.assertEqual(result["status"], "DNS_RESOLUTION_FAILED")
        self.assertEqual(result["tcp"], "untested")

    def test_unsupported_udp_probe_does_not_claim_udp_works(self):
        self.assertEqual(probe("example.com", 443, transport="hysteria2")["status"],
                         "UNSUPPORTED_PROBE")


if __name__ == "__main__":
    unittest.main()
