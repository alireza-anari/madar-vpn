# Madar V2 — short-lived GitHub Actions executor (staging only)

This alternative **does not use the resident AWS runner**, does not export or
reuse its RSA private key, and never touches V1 Worker, D1, cron or service.
The only remote SSH targets are explicitly enrolled disposable V2 test nodes.

## One-time security setup (never when adding a server)

1. Use a brand-new independent RSA-OAEP 3072-bit keypair. Store its PEM private
   key in the GitHub **madar-v2-staging** environment secret
   `MADAR_V2_RUNNER_PRIVATE_KEY_PEM`. Never reuse the V1 runner private key.
2. Store the corresponding public JWK in staging Worker `RUNNER_PUBLIC_KEY`,
   with `kid: "madar-v2-github-actions"`. Check it matches the GitHub private key
   **before enabling**. Do not copy any private key to Worker variables.
3. Copy V2-only `RUNNER_SERVICE_SECRET` securely into the same GitHub environment
   as `MADAR_V2_RUNNER_SERVICE_SECRET`; never use the V1 queue secret.
4. Create a fine-grained GitHub token restricted to this repository, with only
   **Actions: Read and write** for workflow dispatch. Store it as staging Worker
   secret `GITHUB_ACTIONS_DISPATCH_TOKEN`; never expose it in Telegram.
5. Add new workflow `.github/workflows/v2-on-demand-executor.yml` to the repo's
   **default branch** as well: GitHub accepts workflow_dispatch only when the
   workflow exists on the default branch. The job itself is pinned to
   `rewrite/madar-v2-20261110` and runs the code from the dispatched commit.
6. Once GitHub environment approval and secrets are confirmed, set Worker var
   `V2_EXECUTOR_BACKEND=github-actions` (the default remains existing-runner).
   Do not switch without verifying the two matching RSA halves.

## Normal enrollment (no VPS console)

Admin enters SSH target in the existing V2 Telegram Mini App. The Worker
checks signed Telegram initData, dispatches an ephemeral GitHub-hosted job
with only its opaque ID, and tracks the existing D1 queue. The GitHub runner
claims **only that exact job ID**, checks its signed HMAC lease, probes SSH
fingerprint, and executes the pinned V2 installer after credential encryption.
Failed dispatches fail closed and discard encrypted credentials. Per-job
GitHub runtimes terminate automatically; no permanent execution VPS is used.

**AWS-specific caveats:** GitHub-hosted runner egress IPs are not stable.
SSH:22 and REALITY:443/8443 must be reachable under AWS security-group policy.
This implementation NEVER edits EC2 security groups from GitHub Actions.
Do not broaden SSH publicly just to make this work; prefer a narrow trusted
network path or a verified temporary access policy. AWS nodes currently used
by V1 on 443 **must not be overwritten**. Fresh bootstrap rejects occupied
443 before writing files and rejects pre-existing Xray/Caddy installations.

## Unpassed gates

This code is not proof of a deployed GitHub executor, working SSH on AWS,
REALITY connections, or metered shared quotas. Keep
`SHOP_ENABLED=false`, `SUBSCRIPTION_LINKS_ENABLED=false`, and customer
issuance disabled until end-to-end field tests pass.
