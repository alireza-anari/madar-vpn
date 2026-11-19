# V2 on the existing runner host

The V1 service continues polling its V1 queue. The V2 consumer uses the same
reviewed `sales-runner/runner.py` API client, `credential_envelope.py` and
`ssh_transport.py`; it never calls the V1 installer. A separate service on
the same host polls only `madar-v2-staging`. No new execution server or
per-node GitHub secret is needed.

The V2 Mini App verifies Telegram owner initData, probes SSH before asking
for credentials, pins the confirmed fingerprint, and encrypts credentials
in the browser to the existing runner's public RSA key. Ciphertext expires
after 15 minutes and is erased on failure or completion. Neither SSH keys
nor passwords are sent in Telegram messages.

## Operator attachment (not a step when adding a VPN node)

Deploy this exact reviewed checkout to a separate root-owned directory on
the existing execution host. Do not overwrite `/opt/madar-sales-runner`.
The existing `madar-sales-runner` account and Python environment must exist;
V1 must already be active. No new SSH private key is generated or exported.

Provision independent `RUNNER_SERVICE_SECRET`, `SUBSCRIPTION_CREDENTIAL_KEY`
and the existing public `RUNNER_PUBLIC_KEY` on the staging Worker. Store only
an RSA-OAEP/AES-GCM sealed V2 config in `v2_runner_pairing` with id
`existing-runner` and a short expiry. Its plaintext fields are:

- `baseUrl`: `https://madar-v2-staging.alirezaanari117.workers.dev`
- `runnerId`: `existing-host-v2`
- `serviceSecret`: V2's independent runner secret
- `privateKeyPath`: `/etc/madar-v2-runner/runner-private.pem` (local mode-0400 copy owned by `madar-sales-runner`)

Run `v2/runner/attach_existing.py` as root with the existing runner's Python.
It creates `/etc/madar-v2-runner/runner.json`, a mode-0400 local copy of the
existing RSA private key owned by `madar-sales-runner`, and the separate
`madar-v2-runner.service`. V1's original key, config and service remain unchanged. An authenticated V2 lease deletes the
sealed pairing envelope. Verify both services active and a fresh
`v2_runner_presence.last_seen_ms` in staging D1 before calling attachment
successful. Rollback is stopping/disabling only `madar-v2-runner.service`.

## Acceptance

Open `/admin` in the V2 bot, choose Add server, open the secure form, probe,
confirm fingerprint, provide password or key in the form and submit. Poll
the job in the same form. Missing runner heartbeat shows offline and does
not enqueue an installation. Aria cutover is restricted to `test-aria01`
at `86.54.42.66`; it uses the existing reversible V2 installer and preserves
the 8443 inbound keys and UUIDs. Fresh hosts use the V2-only bootstrap.

Listener checks and passing unit tests do not prove external egress, mobile
carrier reachability or metered shared-quota enforcement. Test trial feeds
are not commercial subscriptions. This change does not mark those gates
passed or enable sales.

Development checks:

```
cd v2/control && npm run check && npm test
python -B v2/control/test/schema.test.py
python -B -m unittest discover -s v2/runner
```

Python uses the same pinned dependencies as sales-runner: Paramiko 5.0.0
and cryptography 50.0.2. The remote V2 installers require Linux.

## Resident-runner restoration (2026-11, one-time setup)

The V2 Worker must use `V2_EXECUTOR_BACKEND=resident` and the **public**
RSA JWK corresponding to the existing V1 runner private key. V1 code,
secret, cron, service, and database are not changed. The private key never
leaves its existing host. V2 uses a separate Cloudflare D1, Worker, service
identity, and `RUNNER_SERVICE_SECRET`. **Do not copy V1's secret.**

The Telegram owner opens Add Server, expands "فعال‌سازی یک‌باره سرویس نصب
V2", and requests a sealed pairing; it lasts 10 minutes. On the **runner
host** (the host where `madar-sales-runner.service` is running, not an
arbitrary VPN node), an operator performs exactly one trusted checkout and
runs `v2/runner/attach_existing.py` as root. The script refuses to touch
the existing V1 service and uses the pre-existing V1 RSA private key only
on-host to unwrap the V2-specific config. Only the V2 service is installed.

For an authenticated operator using AWS Systems Manager Run Command, use
a short, pinned-code workflow to stage the V2 checkout. Run on the correct
runner host only, after verifying `systemctl is-active madar-sales-runner`.
Do not run V2 on an arbitrary node with port 443 serving clients.

No one-time pairing step is repeated for future node enrollments. Every
future fresh server uses only the Telegram V2 form (SSH fingerprint,
encrypted credentials, and quota limits). The V2 runner becomes online
after its first signed lease. Absence of its heartbeat fails closed with
`RUNNER_OFFLINE`, rather than dispatching SSH attempts via dynamic
GitHub Actions IP ranges.

Keep `SHOP_ENABLED=false`, `SUBSCRIPTION_LINKS_ENABLED=false`, and
`PROVISIONING_ENABLED=false` pending real end-to-end verification.
