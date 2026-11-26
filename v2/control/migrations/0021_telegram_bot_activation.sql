-- Persist explicit Telegram bot activation after verified membership in the official Madar channel.
-- The channel membership is checked by the V2 bot using getChatMember; the bot must be a channel administrator.
CREATE TABLE IF NOT EXISTS telegram_bot_activations (
  telegram_id TEXT PRIMARY KEY REFERENCES customers(telegram_id),
  channel_id TEXT NOT NULL,
  activated_ms INTEGER NOT NULL,
  last_verified_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telegram_bot_activations_verified
  ON telegram_bot_activations(last_verified_ms);
