# Continuous counters — 2026-10-15

Pinned executable: Xray 26.3.27, build d2758a0. Probe: `python sales-node/tests/probe_live_stats.py /path/to/xray`.

The probe uses a real VLESS/REALITY client/server, a temporary local TLS 1.3 destination and an open HTTP download. Configs and generated test keys are temporary and never printed. Per-user upload plus download counters must increase on four samples before the stream closes. The quota path uses empty VLESS flow consistently at both ends; legacy retail Vision flow is preserved. This avoids depending on Vision splice counter timing.

StatsService binds only 127.0.0.1. Query uses argv, non-resetting API, 1-second API timeout, 2-second process timeout and bounded output. Missing/unknown/duplicate/negative counters fail closed.

References: https://xtls.github.io/en/config/stats.html and the pinned executable's `xray help api statsquery`. The attempted pinned source web retrieval was unavailable; executable behavior is the measured evidence. Local transport proof does not establish Iranian ISP reachability or production throughput.

Measured result: PASS. Four cumulative totals during the still-open stream: 1,015,927; 1,998,967; 3,014,775; 3,997,815 bytes. Download receiver had 4,030,542 bytes before closing. A readiness TLS handshake is required before starting the transfer (the initial fixture raced destination initialization). API and REALITY server remain separate loopback ports in this probe; production render binds the API only to loopback. No production traffic was changed.
