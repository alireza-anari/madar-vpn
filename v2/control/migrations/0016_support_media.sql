-- V2 staging only: an optional Telegram file ID for support screenshots.
-- Existing text-only support conversations remain valid. No receipt schema changes.
ALTER TABLE support_messages ADD COLUMN telegram_file_id TEXT
  CHECK (telegram_file_id IS NULL OR length(telegram_file_id) BETWEEN 5 AND 512);
