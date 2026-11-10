# Read-only field diagnosis

Run only from a device/network you are entitled to test:

```bash
python3 probe.py --host YOUR_SERVER_IP --port 443 --transport reality
python3 probe.py --host vpn.example.com --port 443 --transport wss --path /YOUR_WS_PATH
python3 probe.py --host YOUR_SERVER_IP --port 443 --transport wss --tls-name vpn.example.com --path /YOUR_WS_PATH
```

The third command deliberately connects to a *direct origin IP* while
validating TLS SNI for the same hostname, to compare with the edge route.
The origin must have a valid certificate for that hostname for the comparison
to be fair. No credentials, config UUIDs or private keys are needed.

Reports distinguish DNS, TCP, TLS and WebSocket upgrade failure. A successful
probe **does not mean that Xray authentication, REALITY, UDP or tunneled traffic
has passed**. Those require an actual compatible VPN client on the affected
network. Compare both paths at similar times before blaming Cloudflare.
Run tests with `cd v2/diagnostics && python3 -m unittest discover`.
