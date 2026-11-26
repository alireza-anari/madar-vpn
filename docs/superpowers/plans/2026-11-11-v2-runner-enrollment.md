# V2 enrollment through the existing runner

Goal: Restore bot-driven onboarding without console commands or SSH secrets in Telegram.

Design: Open a same-origin Telegram Mini App from V2. Authenticate the owner's Telegram initData, probe the SSH fingerprint, then accept only an RSA-OAEP/AES-GCM envelope for the existing runner identity. A V2-only queue uses the V1 runner lease/signature protocol. Reuse the transport and credential decryptor, but run V2 jobs in a separate process on the same runner host. Never change V1 code, queue, service, config or private key. The existing runner must be deployed/paired before the UI advertises availability.

Implementation (inline; user already selected reuse of the runner):
- [ ] Add owner initData authentication, expiring encrypted jobs, atomic leases and authenticated reports; test rejection, ownership, expiry and replay.
- [ ] Add the secure form and V2 bot entry; never persist plaintext credentials.
- [ ] Add a V2-only consumer reusing sales-runner transport/API primitives and the V2 dual installer; preserve existing UUIDs and rollback.
- [ ] Run control, schema and consumer tests; inspect changes and publish only verified V2 changes.
- [ ] Verify live webhook, pairing and real installation where access permits; report unexecuted steps explicitly.

Acceptance: adding a server never requires a server console. Probe does not authenticate. Install requires the owner's trusted fingerprint, a nonexpired envelope, and an authenticated runner. Expired leases cannot overwrite results; credentials are cleared on completion or expiry. Installation does not imply quota/carrier verification. Shared quota and external egress remain separate acceptance gates.

Deployment constraint: local GitHub CLI token is invalid and Firefox UI automation is unsupported. Do not claim the runner service changed without execution evidence.
