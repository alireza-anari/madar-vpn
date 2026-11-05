# One-time guarded Madar Worker release — VLESS delivery fix PR #37

Reviewed source commit: `8d1cd74dc6d0dd20453be1a083914e638dd2c162`.
Reviewed source tree: `53b2fe0ea6987164621df6208a407d046b1c84c4`.
Protected production rollback version: `0b7510ac-92d8-4c1c-b25c-579a32186340`.

This one-time trigger is approved to deploy only the Telegram sales Worker code that validates VLESS/Reality config delivery. All existing Cloudflare bindings, secrets, D1 data, schedules and routes must remain intact. The guarded workflow checks its exact source tree and unchanged production version before deploying, smoke-tests the live Worker, and restores the previous Worker version on failure.

No database migration, node opt-in, AWS EC2 update, Xray restart, personal VPN change or test account creation is part of this release.
