-- One statement row can be several things at once: a payroll run is wages, employer taxes and
-- the processor's fee; a warehouse receipt is half office supplies and half groceries. The row
-- itself never changes — amount, date and provenance are what the statement said. A split says
-- how that one amount breaks down, and the legs must add up to it exactly.
CREATE TABLE IF NOT EXISTS purch_split (
  id             INTEGER PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES purch_transaction(id),
  pos            INTEGER NOT NULL,
  amount         INTEGER NOT NULL,          -- positive minor units; the legs sum to the row's amount
  category       TEXT NOT NULL,
  note           TEXT,
  UNIQUE(transaction_id, pos)
);
CREATE INDEX IF NOT EXISTS idx_psplit_tx ON purch_split(transaction_id);
