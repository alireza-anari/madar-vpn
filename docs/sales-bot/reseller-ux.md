# Reseller delivery and trial UX

New deliveries use escaped Telegram HTML with a complete VLESS URI in a preformatted block. Usage capabilities appear only in the private status button, not in message text. A CopyTextButton is included when the complete URI fits Telegram’s 256-character limit; longer URIs remain complete in the code block. URI fragments use a short account reference to keep normal REALITY configurations copyable. Historical sent messages are not edited.

Every new trial has 1,000,000,000 bytes and 1,800 seconds. Legacy pending confirmations with a null quota are accepted but receive this server-side cap. Separate requests create separate identities; retries remain idempotent. Migration 0006 caps older trials without resetting usage, expiry or terminal states.

Seller flows accept Persian, Arabic and ASCII digits, provide cancellation and request-status navigation, and paginate accounts with ownership checks. Account details show recorded consumption and report time. Administrators see assigned server purposes and must confirm account revocation.

Release: run sales-bot tests, typecheck and build; apply migration 0006; deploy the Worker preserving existing bindings, schedules and secrets. No node reinstall is needed. Verify a fresh delivery in Telegram; old forwarded messages retain their previous appearance.
