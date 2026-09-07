-- purchases: what you buy, from statements the AGENT read. Money is INTEGER minor units,
-- signed. Nothing here parses a file: a source is the agent's account of one file, checked
-- against the control totals it printed, and every transaction remembers its row.
CREATE TABLE IF NOT EXISTS purch_source (
  id              TEXT PRIMARY KEY,        -- SRC-0001
  name            TEXT NOT NULL,           -- file name as given
  hash            TEXT NOT NULL UNIQUE,    -- content hash or a stable statement id the agent supplies
  kind            TEXT NOT NULL,           -- bank | card | other
  account         TEXT,                    -- the account label as printed
  currency        TEXT NOT NULL,
  period_start    TEXT NOT NULL,
  period_end      TEXT NOT NULL,
  opening_balance INTEGER NOT NULL,
  closing_balance INTEGER NOT NULL,
  row_count       INTEGER NOT NULL,
  rows_in         INTEGER NOT NULL,
  rows_skipped    INTEGER NOT NULL DEFAULT 0,
  imported_by     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purch_vendor (
  id          TEXT PRIMARY KEY,            -- V-0001
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purch_vendor_alias (
  alias       TEXT PRIMARY KEY COLLATE NOCASE,   -- the statement's spelling
  vendor_id   TEXT NOT NULL REFERENCES purch_vendor(id)
);
CREATE TABLE IF NOT EXISTS purch_transaction (
  id           TEXT PRIMARY KEY,           -- T-0001
  source_id    TEXT NOT NULL REFERENCES purch_source(id),
  row_index    INTEGER NOT NULL,
  date         TEXT NOT NULL,
  amount       INTEGER NOT NULL,           -- signed minor units: spending negative, money in positive
  currency     TEXT NOT NULL,
  description  TEXT NOT NULL,              -- as printed
  counterparty TEXT,
  raw          TEXT,                       -- the line as the agent read it
  status       TEXT NOT NULL DEFAULT 'unreviewed',   -- unreviewed | purchase | transfer | income | fee | ignored
  category     TEXT,
  vendor_id    TEXT REFERENCES purch_vendor(id),
  note         TEXT,
  reviewed_at  TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(source_id, row_index)
);
CREATE INDEX IF NOT EXISTS idx_ptx_date ON purch_transaction(date);
CREATE INDEX IF NOT EXISTS idx_ptx_dedupe ON purch_transaction(currency, date, amount);
CREATE TABLE IF NOT EXISTS purch_receipt (
  id             TEXT PRIMARY KEY,         -- R-0001
  name           TEXT NOT NULL,
  hash           TEXT NOT NULL UNIQUE,
  vendor         TEXT,
  date           TEXT NOT NULL,
  total          INTEGER NOT NULL,         -- positive minor units
  currency       TEXT NOT NULL,
  transaction_id TEXT UNIQUE REFERENCES purch_transaction(id),
  note           TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purch_subscription (
  id            TEXT PRIMARY KEY,          -- SUB-0001
  vendor_id     TEXT NOT NULL REFERENCES purch_vendor(id),
  cadence       TEXT NOT NULL,             -- weekly | monthly | yearly
  amount        INTEGER NOT NULL,          -- expected charge, positive minor units
  currency      TEXT NOT NULL,
  tolerance_bp  INTEGER NOT NULL DEFAULT 1000,   -- 10%: prices creep
  start         TEXT NOT NULL,             -- first expected charge date
  status        TEXT NOT NULL DEFAULT 'active',  -- active | cancelled (lapsed is derived, never stored)
  cancel_reason TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
