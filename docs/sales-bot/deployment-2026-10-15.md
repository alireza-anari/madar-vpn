# Sales bot deployment — 2026-10-15

- Source published to branch `impl/telegram-sales-bot`: `cbe7ee0680a0522b6e55e087b4d4b6580add9b61` (same tree as local `78dcad4`). GitHub connector publication was used because local git push had no credentials.
- Worker `madar-sales-bot` deployed to the connected Cloudflare account; version `0c629666-6eba-4517-8daa-2c73fd0a71d8` at 100%, deployment `cc29966c-8204-48fd-aebd-58bf024b9f91`.
- Existing independent D1 `madar-sales-bot-db` bound as `SALES_DB`; no website database or runtime changed.
- workers.dev enabled; cron `* * * * *` configured. Invocation logging disabled and query strings redacted.
- Live HTTPS health returned 200 with `{"status":"prepared","telegram":"disabled"}`. Unauthenticated webhook POST returned 401 UNAUTHORIZED.
- BOT_TOKEN and other activation secrets have not been set. Admin allowlist and Runner key remain unset. No webhook registration, real Telegram acceptance, permanent Runner installation, or real VPS enrollment was performed.
- Fresh local verification: 41 Worker tests PASS, typecheck PASS, dry-run build PASS. Existing Runner/Agent and workspace results remain historical at their recorded scope.
- GitHub CI runs at the code source: sales bot 38685446299 and full CI 38685446272. Their final status must be checked before claiming CI success.
- Previous publication approval blockers in acceptance.md are historical and superseded by the user's explicit destination approval and this successful publication.

Next: owner enters BOT_TOKEN as a Cloudflare Secret; configure admin numeric Telegram ID and remaining activation secrets securely; select permanent Runner host and disposable Ubuntu target; execute the real acceptance gates in acceptance.md. Sales readiness is not established by deployment alone.
