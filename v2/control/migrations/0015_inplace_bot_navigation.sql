-- V2 Telegram panels can edit the message that owns an inline keyboard.
-- A null target keeps normal sendMessage/sendPhoto behavior for fresh messages.
ALTER TABLE telegram_outbox ADD COLUMN edit_message_id INTEGER;
ALTER TABLE telegram_outbox ADD COLUMN edit_kind TEXT
  CHECK (edit_kind IS NULL OR edit_kind IN ('text','caption'));
