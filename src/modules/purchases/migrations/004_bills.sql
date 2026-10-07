-- A bill: what a vendor says the person owes. A record, never a payment (P-12): Saybooks never
-- pays anything. A person approves paying it; the payment happens in their bank and is recorded
-- here after the fact, ideally linked to the statement row that shows it. Bills count on a cash
-- basis: the statement row that paid one is what reaches the books.
CREATE TABLE IF NOT EXISTS purch_bill (
  id             TEXT PRIMARY KEY,                 -- B-0001
  vendor_id      TEXT NOT NULL REFERENCES purch_vendor(id),
  number         TEXT,                             -- the vendor's own invoice number
  bill_date      TEXT NOT NULL,
  due_date       TEXT NOT NULL,
  amount         INTEGER NOT NULL,                 -- positive minor units
  currency       TEXT NOT NULL,
  category       TEXT,
  description    TEXT,
  file_name      TEXT,                             -- the file stays with the person (P-9)
  file_hash      TEXT,
  status         TEXT NOT NULL DEFAULT 'open',     -- open | approved | paid | rejected
  approved_by    TEXT,
  approved_at    TEXT,
  pay_by         TEXT,
  approval_note  TEXT,
  paid_at        TEXT,
  paid_method    TEXT,
  paid_reference TEXT,
  transaction_id TEXT REFERENCES purch_transaction(id),
  reject_reason  TEXT,
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pbill_status ON purch_bill(status, due_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pbill_number ON purch_bill(vendor_id, number COLLATE NOCASE) WHERE number IS NOT NULL;
