-- Native Telegram support moderation and reliable customer notification.
CREATE TABLE IF NOT EXISTS support_staff_sessions (
  telegram_id TEXT PRIMARY KEY REFERENCES customers(telegram_id),
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  expires_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS support_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  sender_telegram_id TEXT NOT NULL REFERENCES customers(telegram_id),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 1000),
  role TEXT NOT NULL CHECK(role IN ('customer','support')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_v2_support_messages ON support_messages(ticket_id,created_at);

CREATE TRIGGER IF NOT EXISTS v2_no_reopen_closed_support
BEFORE UPDATE OF state ON support_tickets
WHEN OLD.state='closed' AND NEW.state!='closed'
BEGIN
  SELECT RAISE(ABORT,'SUPPORT_TICKET_CLOSED');
END;
