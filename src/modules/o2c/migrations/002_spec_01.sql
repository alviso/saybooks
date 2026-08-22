-- Spec 0.1 gap: dual prices (INV-2), tax snapshot (INV-14), credits & returns (INV-10..12,16),
-- refunds. Existing rows get list_price = unit_price, the honest backfill.
ALTER TABLE quote_line   ADD COLUMN list_price INTEGER;
ALTER TABLE order_line   ADD COLUMN list_price INTEGER;
UPDATE quote_line SET list_price = unit_price WHERE list_price IS NULL;
UPDATE order_line SET list_price = unit_price WHERE list_price IS NULL;

ALTER TABLE invoice_line ADD COLUMN list_price  INTEGER;
ALTER TABLE invoice_line ADD COLUMN tax_rate_bp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_line ADD COLUMN tax_amount  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice ADD COLUMN subtotal  INTEGER;
ALTER TABLE invoice ADD COLUMN tax_total INTEGER NOT NULL DEFAULT 0;
UPDATE invoice SET subtotal = total WHERE subtotal IS NULL;

-- The credit note: an AR instrument with its own open balance (spec §4.5). Applied to
-- invoices like a payment, or refunded. kind write_off closes uncollectible balances.
CREATE TABLE IF NOT EXISTS credit_note (
  id          TEXT PRIMARY KEY,          -- CN-0001
  customer_id TEXT NOT NULL REFERENCES customer(id),
  kind        TEXT NOT NULL,             -- correction|return|goodwill|write_off
  invoice_id  TEXT REFERENCES invoice(id),
  return_id   TEXT,
  total       INTEGER NOT NULL,          -- cents, tax-inclusive
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL,             -- open|settled  (derived, INV-20)
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_application (
  id             INTEGER PRIMARY KEY,
  credit_note_id TEXT NOT NULL REFERENCES credit_note(id),
  invoice_id     TEXT NOT NULL REFERENCES invoice(id),
  amount         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capp_invoice ON credit_application(invoice_id);

-- Returns are immutable facts linked to a credit note (spec §3).
CREATE TABLE IF NOT EXISTS "return" (
  id          TEXT PRIMARY KEY,          -- R-0001
  order_id    TEXT NOT NULL REFERENCES "order"(id),
  reason      TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS return_line (
  id            INTEGER PRIMARY KEY,
  return_id     TEXT NOT NULL REFERENCES "return"(id),
  order_line_id INTEGER NOT NULL REFERENCES order_line(id),
  qty           INTEGER NOT NULL,
  restock       INTEGER NOT NULL         -- INV-12: only sellable goods re-enter stock
);

-- Money returned against an unapplied balance. Records the fact; moving money is out of scope.
CREATE TABLE IF NOT EXISTS refund (
  id          TEXT PRIMARY KEY,          -- RF-0001
  source_type TEXT NOT NULL,             -- payment|credit_note
  source_id   TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  method      TEXT,
  reference   TEXT,
  recorded_at TEXT NOT NULL
);
