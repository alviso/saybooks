-- The month-end close (gl 0.1): adjusting entries the accountant or the agent records with a
-- reason, and closes that keep a period's journal as it stood. Corrections for later changes are
-- derived, never stored.
CREATE TABLE IF NOT EXISTS gl_entry (
  id           TEXT PRIMARY KEY,                    -- JE-0001
  date         TEXT NOT NULL,
  memo         TEXT NOT NULL,
  reason       TEXT NOT NULL,
  reverse_on   TEXT,                                -- an accrual's reversal day: the 1st of the next month
  voided_at    TEXT,
  void_reason  TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gl_entry_line (
  entry_id  TEXT NOT NULL REFERENCES gl_entry(id),
  pos       INTEGER NOT NULL,
  account   TEXT NOT NULL,
  kind      TEXT NOT NULL,                          -- asset | liability | equity | income | expense
  debit     INTEGER NOT NULL DEFAULT 0,
  credit    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id, pos)
);
CREATE TABLE IF NOT EXISTS gl_close (
  id             TEXT PRIMARY KEY,                  -- CL-0001
  through        TEXT NOT NULL,
  reason         TEXT NOT NULL,
  closed_by      TEXT,
  closed_at      TEXT NOT NULL,
  entry_count    INTEGER NOT NULL,
  debits         INTEGER NOT NULL,
  hash           TEXT NOT NULL,
  reopened_at    TEXT,
  reopened_by    TEXT,
  reopen_reason  TEXT
);
-- The journal of the closed period, as it stood at the close.
CREATE TABLE IF NOT EXISTS gl_closed_entry (
  close_id    TEXT NOT NULL REFERENCES gl_close(id),
  seq         INTEGER NOT NULL,
  date        TEXT NOT NULL,
  memo        TEXT,
  customer    TEXT,
  currency    TEXT NOT NULL,
  lines_json  TEXT NOT NULL,
  PRIMARY KEY (close_id, seq)
);
