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
- `privateKeyPath`: `/etc/madar-sales-runner/runner-private.pem`

Run `v2/runner/attach_existing.py` as root with the existing runner's Python.
It only creates `/etc/madar-v2-runner/runner.json` and the separate
`madar-v2-runner.service`. It refuses foreign/preexisting config. It never
changes V1 config, service or key. An authenticated V2 lease deletes the
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
