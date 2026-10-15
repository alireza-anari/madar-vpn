# Runner field pairing — 2026-10-15

Owner screenshots witnessed pinned shell checksum success, background bootstrap launch on retained Node1, dependency installation, local RSA key generation, and the dedicated pairing unit launch after the HTTP User-Agent correction. The public fingerprint in the screenshot exactly matched the Node1-IP-restricted D1 candidate. No private key was uploaded or printed.

RUNNER_SERVICE_SECRET and POLICY_SIGNING_SECRET were generated cryptographically and registered as Cloudflare Secrets without printing their values. The approved public RSA JWK was configured as RUNNER_PUBLIC_KEY while preserving all other bindings. Only an RSA-OAEP SHA256 / AES-256-GCM encrypted Runner configuration was delivered through the temporary pairing endpoint. It was bound to the exact key fingerprint and HTTPS Worker origin.

A temporary observation wrapper recorded successful authenticated POST /api/runner/lease from Node1 at epoch 1792056970 and again at 1792057005. The progressing observation proves the Runner loop reached the authenticated control API; it does not prove real Ubuntu node provisioning, SSH reachability to future nodes, reboot recovery, or VPN egress. No installation job or VPN node was created by this step.

Canonical Worker index.js was restored at version 40146ed5-7a7d-4deb-8cf7-6619561d7f8b; temporary pairing/observation modules were removed. Both runner_bootstrap_candidate and runner_bootstrap_envelope settings were deleted; remaining count verified zero. A safe last-seen timestamp remains as historical evidence. Permanent Runner config/key intentionally remain on Node1. No website runtime, existing Xray service, SSH/firewall setting or VPS lifecycle action was modified.

Remaining acceptance: real fresh-Ubuntu node enrollment through the admin form; SSH fingerprint and encrypted credential workflow; installer/Agent ACK/readiness; customer test/import/internet egress; payment, renewal, expiry and revoke. Existing Madar/Xray nodes intentionally fail the sales-node installer preflight and must not be overwritten implicitly.
