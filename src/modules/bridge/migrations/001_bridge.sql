-- bridge: the hand-over to the ledger of record. Saybooks owns operational truth and derives
-- balanced journal lines from it; QuickBooks, Xero or the accountant's own system owns the
-- chart, the manual journals and the close. This module maps one onto the other and records
-- what was handed over. Nothing here is posted: re-derivation stays the truth.
CREATE TABLE IF NOT EXISTS bridge_account_map (
  account    TEXT PRIMARY KEY,        -- our derivation account, e.g. 'Accounts Receivable'
  code       TEXT,                    -- their chart code (Xero AccountCode)
  name       TEXT,                    -- their account name (QuickBooks Account Name)
  tax_rate   TEXT,                    -- the tax rate label their import expects on this account
  note       TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bridge_export (
  id           TEXT PRIMARY KEY,      -- EXP-0001
  format       TEXT NOT NULL,         -- xero | qbo | csv
  period_from  TEXT,
  period_to    TEXT NOT NULL,
  entry_count  INTEGER NOT NULL,
  line_count   INTEGER NOT NULL,
  debits       INTEGER NOT NULL,
  credits      INTEGER NOT NULL,
  content      TEXT NOT NULL,         -- the file exactly as handed over
  hash         TEXT NOT NULL,
  token        TEXT NOT NULL,         -- /journal/<space>/<token>.csv
  actor        TEXT NOT NULL,
  reason       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bexport_period ON bridge_export(format, period_to);
