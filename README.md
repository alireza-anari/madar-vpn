# مدار — Madar VPN

Clean-start implementation of Madar. This repository intentionally does not reuse code, infrastructure credentials, database state, or VPN architecture from the previous project.

## Current status

Implementation is in progress. A feature is not considered operational until its required integration/E2E gate has passed. VPN connectivity, providers, Web Push, and production readiness must not be inferred from source code or preview UI alone.

## Development

Requirements:

- Node.js 22+
- pnpm 12.9.1 via Corepack
- Python is introduced when the node-agent phase begins

Commands:

```bash
corepack enable
corepack prepare pnpm@12.9.1 --activate
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

Never commit `.env`, provider credentials, subscription tokens, node credentials, VAPID private keys, REALITY private keys, or administrator secrets.

Architecture and execution documents live under `docs/superpowers/`.
