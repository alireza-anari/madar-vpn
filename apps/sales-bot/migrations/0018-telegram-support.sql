CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('connection','payment','renewal','usage','other')),
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
  created_update_id INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX support_tickets_user_updated ON support_tickets(user_id,updated_at DESC);
CREATE INDEX support_tickets_open_updated ON support_tickets(state,updated_at DESC);

CREATE TABLE support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  sender_id TEXT NOT NULL,
  sender_role TEXT NOT NULL CHECK(sender_role IN ('customer','admin')),
  message_text TEXT,
  file_id TEXT,
  file_kind TEXT CHECK(file_kind IN ('photo','document')),
  telegram_update_id INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK ((message_text IS NOT NULL AND file_id IS NULL AND file_kind IS NULL)
    OR (message_text IS NULL AND file_id IS NOT NULL AND file_kind IS NOT NULL))
);
CREATE INDEX support_messages_ticket_id ON support_messages(ticket_id,id DESC);
