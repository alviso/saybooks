-- crm 0.4: things that will happen, as opposed to the activity trail, which is things that
-- did. A workshop the research agent found, a call somebody agreed to, a deadline a form
-- published. Every one carries where its date came from: a date is a fact, and a fact the
-- agent could not source is a fact the agent made up (CRM-20).
CREATE TABLE IF NOT EXISTS crm_event (
  id            TEXT PRIMARY KEY,          -- EV-0001
  account_id    TEXT NOT NULL REFERENCES account(id),
  contact_id    TEXT REFERENCES contact(id),
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'other',   -- meeting | call | workshop | deadline | other
  date          TEXT NOT NULL,              -- YYYY-MM-DD
  time          TEXT,                       -- HH:MM, local to the place, or NULL when the source gives none
  location      TEXT,
  url           TEXT,
  source        TEXT NOT NULL,              -- CRM-20: the page the date is on, or who said it and when
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'planned',   -- planned | done | cancelled
  status_reason TEXT,
  outcome       TEXT,                       -- what came of it, once it is done
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_account ON crm_event(account_id);
CREATE INDEX IF NOT EXISTS idx_event_date ON crm_event(status, date);
