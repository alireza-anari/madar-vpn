#!/usr/bin/env python3
"""Read-only transport checks run FROM the affected network.

These are not VPN connection tests: only an actual authenticated client
with tunneled traffic may report success. Do not report REALITY readiness
from a conventional TLS ClientHello.
"""
import argparse
import base64
import hashlib
import json
import os
import socket
import ssl
import time
from urllib.parse import urlsplit

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def parse_ws_reply(raw, challenge):
    head = raw.partition(b"\r\n\r\n")[0].decode("latin1", errors="replace")
    lines = head.split("\r\n")
    if not lines or len(lines[0].split()) < 2 or lines[0].split()[1] != "101":
        return False
    headers = {}
    for line in lines[1:]:
        key, sep, value = line.partition(":")
        if sep:
            headers[key.strip().lower()] = value.strip()
    expected = base64.b64encode(hashlib.sha1((challenge + WS_GUID).encode()).digest()).decode()
    return (headers.get("sec-websocket-accept") == expected
            and headers.get("upgrade", "").lower() == "websocket"
            and "upgrade" in headers.get("connection", "").lower())


def probe(host, port, *, transport, tls_name=None, path="/", timeout=4.0):
    result = {"host": host, "port": port, "transport": transport,
              "dns": "untested", "tcp": "untested", "tls": "untested",
              "websocket": "untested", "proxy": "unverified", "traffic": "unverified"}
    if transport not in ("reality", "wss"):
        return {**result, "status": "UNSUPPORTED_PROBE"}
    started = time.monotonic()
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        result["dns"] = "ok"
    except OSError:
        return {**result, "dns": "failed", "status": "DNS_RESOLUTION_FAILED"}
    peer = None
    for family, kind, proto, _canon, sockaddr in addresses:
        try:
            conn = socket.socket(family, kind, proto)
            conn.settimeout(timeout)
            conn.connect(sockaddr)
            peer = conn
            break
        except OSError:
            conn.close()
    if peer is None:
        return {**result, "tcp": "failed", "status": "IP_OR_TCP_UNREACHABLE"}
    result["tcp"] = "ok"
    try:
        if transport == "reality":
            result["status"] = "TCP_OK_PROXY_HANDSHAKE_UNVERIFIED"
            return result
        context = ssl.create_default_context()
        try:
            secured = context.wrap_socket(peer, server_hostname=tls_name or host)
        except (ssl.SSLError, ValueError, OSError):
            result["tls"] = "failed"
            result["status"] = "TLS_HANDSHAKE_FAILED"
            return result
        peer = secured
        result["tls"] = "ok"
        if not path.startswith("/") or "\r" in path or "\n" in path:
            return {**result, "status": "INVALID_WS_PATH"}
        challenge = base64.b64encode(os.urandom(16)).decode()
        request = (f"GET {path} HTTP/1.1\r\n"
                   f"Host: {tls_name or host}\r\n"
                   "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {challenge}\r\n"
                   "Sec-WebSocket-Version: 13\r\n\r\n")
        peer.sendall(request.encode("ascii"))
        received = b""
        while b"\r\n\r\n" not in received and len(received) < 16_384:
            next_chunk = peer.recv(4096)
            if not next_chunk:
                break
            received += next_chunk
        result["websocket"] = "ok" if parse_ws_reply(received, challenge) else "failed"
        result["status"] = ("WSS_UPGRADE_OK_TUNNEL_UNVERIFIED"
                            if result["websocket"] == "ok" else "WEBSOCKET_UPGRADE_FAILED")
        return result
    except (OSError, UnicodeEncodeError):
        result["status"] = "PROBE_TRANSPORT_ERROR"
        return result
    finally:
        peer.close()
        result["elapsed_ms"] = round((time.monotonic() - started) * 1000)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, help="origin IP or domain being tested")
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--transport", choices=("reality", "wss"), required=True)
    parser.add_argument("--tls-name", help="domain used for TLS SNI and HTTP Host for WSS")
    parser.add_argument("--path", default="/", help="WSS WebSocket path (not an URL)")
    parser.add_argument("--timeout", type=float, default=4.0)
    args = parser.parse_args()
    if not 0 < args.port <= 65535 or not 0 < args.timeout <= 20:
        parser.error("invalid port or timeout")
    result = probe(args.host, args.port, transport=args.transport,
                   tls_name=args.tls_name, path=args.path, timeout=args.timeout)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["status"] in (
        "TCP_OK_PROXY_HANDSHAKE_UNVERIFIED", "WSS_UPGRADE_OK_TUNNEL_UNVERIFIED"
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
