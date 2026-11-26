-- Track actual support closure time for privacy retention; never infer it
-- from when a ticket was first opened.
ALTER TABLE support_tickets ADD COLUMN closed_at TEXT;

UPDATE support_tickets SET closed_at=CURRENT_TIMESTAMP
WHERE state='closed' AND closed_at IS NULL;

CREATE TRIGGER IF NOT EXISTS v2_stamp_support_closure
AFTER UPDATE OF state ON support_tickets
WHEN NEW.state='closed' AND OLD.state!='closed'
BEGIN
  UPDATE support_tickets SET closed_at=CURRENT_TIMESTAMP WHERE id=NEW.id;
END;
