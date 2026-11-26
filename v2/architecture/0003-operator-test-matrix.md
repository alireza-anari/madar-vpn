# Operator field-acceptance test matrix

Tests must originate inside each real network. A server-side port scan
cannot establish that a user's mobile operator can reach that server.

For each node / network / transport combination collect at least:
- local timestamp, coarse operator/network category (no phone number/IMSI)
- region and test-node/provider identity, including whether edge is used
- DNS resolution, IP/TCP or UDP availability, TLS verification and WSS
  upgrade (when relevant), proxy handshake and tunneled HTTPS probe
- latency-to-connect, loss/reconnect events, 10-minute stability, download
  and upload throughput
- protocol/client version, anonymous correlation ID and error category

| Network | Direct REALITY | TLS/WSS | UDP optional | Failover |
| --- | --- | --- | --- | --- |
| Irancell | real-device test required | real-device test required | real-device test required | real-device test required |
| Hamrah-e Aval | real-device test required | real-device test required | real-device test required | real-device test required |
| Rightel | real-device test required | real-device test required | real-device test required | real-device test required |
| Fixed broadband | real-device test required | real-device test required | real-device test required | real-device test required |

Never claim compatibility with every carrier from a successful test on one
VPS, one SIM, or one time of day. Direct vs edge diagnosis requires a paired
test to the *same* origin with comparable settings. Count true tunneled
traffic as final success rather than ping or TCP alone.
