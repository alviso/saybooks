-- Receipts and the year (purchases 1.0): what a receipt says about returns and warranty; work expenses
-- waiting to be paid back and the money that paid them back; a tax tag on a category.
ALTER TABLE purch_receipt ADD COLUMN return_by TEXT;          -- as the receipt states it
ALTER TABLE purch_receipt ADD COLUMN warranty_until TEXT;     -- as the receipt or the box states it
ALTER TABLE purch_transaction ADD COLUMN reimbursable_by TEXT; -- who pays this back: "Acme Corp (employer)"
ALTER TABLE purch_transaction ADD COLUMN claim_ref TEXT;       -- the expense report or claim it went on
CREATE TABLE IF NOT EXISTS purch_reimbursement (
  id          TEXT PRIMARY KEY,                -- RB-0001
  in_tx       TEXT NOT NULL REFERENCES purch_transaction(id),   -- the money in that paid it back
  in_was      TEXT NOT NULL,                   -- that row's review before linking, JSON
  reason      TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  unlinked_at TEXT,
  unlink_reason TEXT
);
CREATE TABLE IF NOT EXISTS purch_reimbursement_item (
  reimbursement_id TEXT NOT NULL REFERENCES purch_reimbursement(id),
  transaction_id   TEXT NOT NULL REFERENCES purch_transaction(id),
  amount           INTEGER NOT NULL,           -- positive: what that expense was
  PRIMARY KEY (reimbursement_id, transaction_id)
);
CREATE TABLE IF NOT EXISTS purch_category_tag (
  category  TEXT PRIMARY KEY COLLATE NOCASE,
  tag       TEXT NOT NULL,                     -- medical | charitable | business | home_office | education | childcare
  reason    TEXT,
  set_by    TEXT,
  set_at    TEXT NOT NULL
);
