-- Sales tax (salestax 0.1): the filings people record and the payments that follow. The return
-- itself is derived from what was invoiced and credited, never stored except as each filing kept it.
CREATE TABLE IF NOT EXISTS tax_filing (
  id                 TEXT PRIMARY KEY,           -- TF-0001
  period_from        TEXT NOT NULL,
  period_to          TEXT NOT NULL,
  label              TEXT,                       -- September 2026, Q3 2026
  currency           TEXT NOT NULL,
  agency             TEXT,                       -- who it was filed with, in the person's words
  computed_due       INTEGER NOT NULL,           -- what the return said at filing
  filed_amount       INTEGER NOT NULL,           -- what the person filed
  difference_reason  TEXT,                       -- required when the two differ
  filed_on           TEXT NOT NULL,
  reference          TEXT,                       -- the agency's confirmation number
  kept_json          TEXT NOT NULL,              -- the return as it stood
  hash               TEXT NOT NULL,
  reason             TEXT NOT NULL,
  filed_by           TEXT,
  created_at         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tax_payment (
  id         TEXT PRIMARY KEY,                   -- TP-0001
  filing_id  TEXT NOT NULL REFERENCES tax_filing(id),
  amount     INTEGER NOT NULL,
  currency   TEXT NOT NULL,
  paid_on    TEXT NOT NULL,
  method     TEXT,
  reference  TEXT,
  reason     TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
