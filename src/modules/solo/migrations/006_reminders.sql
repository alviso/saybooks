-- A payment reminder for an overdue invoice: words the agent drafts, a person sends from their
-- own mailbox, and a record of when it went (S-13). Saybooks never sends it (S-7).
CREATE TABLE IF NOT EXISTS solo_reminder (
  id            TEXT PRIMARY KEY,                  -- REM-0001
  invoice_id    TEXT NOT NULL REFERENCES solo_invoice(id),
  customer_id   TEXT NOT NULL REFERENCES customer(id),
  stage         INTEGER NOT NULL,                  -- 1 first, 2 second, 3 and up final
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  open_at_draft INTEGER NOT NULL,                  -- the open amount the words were written against
  currency      TEXT NOT NULL,
  due_at        TEXT,
  days_overdue  INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',     -- draft | sent | discarded
  sent_at       TEXT,
  discard_reason TEXT,
  soon_because  TEXT,                              -- why a second reminder went within seven days
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  closed_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_srem_invoice ON solo_reminder(invoice_id, status);
