-- A standing rule: something the person says ahead of time ("I'm at the Texas conference
-- the next five days, book it to travel") that the books remember. A rule never books a row:
-- it SUGGESTS a status and category on unreviewed rows it matches, and the row stays
-- unreviewed until a review act confirms it (P-11). Suggestions are computed when the rows
-- are read, so ending a rule takes its suggestions away and leaves reviewed rows alone.
CREATE TABLE IF NOT EXISTS purch_rule (
  id          TEXT PRIMARY KEY,            -- RL-0001
  label       TEXT NOT NULL,               -- the person's name for it: "Texas conference"
  category    TEXT NOT NULL,               -- what matching rows are suggested as
  status      TEXT NOT NULL DEFAULT 'purchase',
  date_from   TEXT,                        -- the window, inclusive; open on a side when null
  date_to     TEXT,
  match       TEXT,                        -- words the description must contain, any case
  vendor_id   TEXT REFERENCES purch_vendor(id),
  currency    TEXT,
  reason      TEXT,
  state       TEXT NOT NULL DEFAULT 'active',   -- active | ended
  ended_at    TEXT,
  end_reason  TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prule_state ON purch_rule(state);
