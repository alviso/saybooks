-- solo: freelancer invoicing. Money is INTEGER cents. Not o2c-lite: no orders, no
-- fulfilment, no credit gate — a different calibration (see specs/solo/spec.md §9 of o2c
-- for what stayed behind and why here nothing needed to).
CREATE TABLE IF NOT EXISTS solo_invoice (
  id          TEXT PRIMARY KEY,            -- INV-0001 (per-workspace; solo spaces never mount o2c)
  customer_id TEXT NOT NULL REFERENCES customer(id),
  status      TEXT NOT NULL DEFAULT 'draft',   -- draft|issued|paid|void
  subtotal    INTEGER NOT NULL DEFAULT 0,  -- cents
  tax_total   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  due_in_days INTEGER,                     -- from the client agreement; freezes into due_at at issue
  issued_at   TEXT,
  due_at      TEXT,
  void_reason TEXT,
  notes       TEXT,                        -- printed on the document
  seller_json TEXT,                        -- frozen at issuance (S-3)
  doc_token   TEXT,                        -- minted at issuance; /doc/<ws>/<token>
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS solo_invoice_line (
  id          INTEGER PRIMARY KEY,
  invoice_id  TEXT NOT NULL REFERENCES solo_invoice(id),
  pos         INTEGER NOT NULL,
  description TEXT NOT NULL,
  qty         REAL NOT NULL DEFAULT 1,     -- hours can be 7.5
  rate        INTEGER NOT NULL,            -- cents per unit
  amount      INTEGER NOT NULL,            -- round(qty*rate), snapshotted
  tax_rate_bp INTEGER NOT NULL DEFAULT 0,
  tax_amount  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sline_invoice ON solo_invoice_line(invoice_id);

CREATE TABLE IF NOT EXISTS solo_payment (
  id          TEXT PRIMARY KEY,            -- P-0001
  customer_id TEXT NOT NULL REFERENCES customer(id),
  amount      INTEGER NOT NULL,
  method      TEXT,
  reference   TEXT,
  received_at TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS solo_payment_application (
  id         INTEGER PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES solo_payment(id),
  invoice_id TEXT NOT NULL REFERENCES solo_invoice(id),
  amount     INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sapp_invoice ON solo_payment_application(invoice_id);
