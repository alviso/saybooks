-- Credit cards (purchases 0.8): what a card statement prints besides its rows, kept as printed;
-- and refunds tied to the purchase they reverse.
CREATE TABLE IF NOT EXISTS purch_card_statement (
  source_id         TEXT PRIMARY KEY REFERENCES purch_source(id),
  minimum_due       INTEGER,                   -- minor units, as printed
  due_date          TEXT,                      -- payment due date, as printed
  credit_limit      INTEGER,
  apr_bp            INTEGER,                   -- purchase rate in basis points: 2499 = 24.99%
  correction_reason TEXT,                      -- set when facts already recorded are changed
  recorded_by       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purch_refund (
  id            TEXT PRIMARY KEY,              -- RFD-0001
  refund_tx     TEXT NOT NULL REFERENCES purch_transaction(id),
  purchase_tx   TEXT NOT NULL REFERENCES purch_transaction(id),
  refund_was    TEXT NOT NULL,                 -- the refund row's review before linking, JSON
  reason        TEXT NOT NULL,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  unlinked_at   TEXT,
  unlink_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_prefund_purchase ON purch_refund(purchase_tx);
