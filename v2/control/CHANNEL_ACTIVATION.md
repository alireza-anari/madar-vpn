# Madar Telegram channel activation

Android login and the customer bot menu require a recorded Telegram bot activation.
The V2 bot verifies channel membership with Telegram's `getChatMember` API before
recording activation. The app then opens the bot deep link; once activation succeeds,
the bot sends the six-digit one-time login code to that same private Telegram account.

## Required Worker variables

Set these non-secret variables for the V2 Worker:

- `MADAR_CHANNEL_ID`: the public channel username (for example `@YourChannel`) or
  the numeric Telegram channel ID (usually starts with `-100`).
- `MADAR_CHANNEL_URL`: the channel's public URL or private invite URL, such as
  `https://t.me/YourChannel` or its official invite link.

Do not guess either value. Use the exact official Madar announcement channel.

## Bot permissions

Add the V2 bot configured by `BOT_TOKEN` (currently `Madar_v2_bot`) as an
administrator of the Madar announcement channel. It needs sufficient access for
Telegram to return other members' status through `getChatMember`; it does not
need posting or deletion permissions for this check.

After setting the variables and channel permissions, verify:

- `GET /health/ready` returns `{"status":"ready"}`.
- A non-member receives a join-channel button and a membership-check button.
- A member is recorded in `telegram_bot_activations`.
- The app login challenge receives an OTP only after activation and an active
  subscription are both confirmed.

Apply D1 migration `0021_telegram_bot_activation.sql` before enabling the flow.
