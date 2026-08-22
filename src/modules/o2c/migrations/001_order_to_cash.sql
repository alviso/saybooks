-- o2c: quote -> order -> delivery -> invoice -> cash.
-- References core-owned customer/item by id; reads are free, writes go through core's api.
CREATE TABLE IF NOT EXISTS quote (
  id          TEXT PRIMARY KEY,          -- Q-0001
  customer_id TEXT NOT NULL REFERENCES customer(id),
  status      TEXT NOT NULL,             -- draft|sent|accepted|expired
  valid_until TEXT,
  order_id    TEXT REFERENCES "order"(id),
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quote_line (
  id         INTEGER PRIMARY KEY,
  quote_id   TEXT NOT NULL REFERENCES quote(id),
  item_id    TEXT NOT NULL REFERENCES item(id),
  qty        INTEGER NOT NULL,
  unit_price INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "order" (
  id          TEXT PRIMARY KEY,          -- SO-0001
  customer_id TEXT NOT NULL REFERENCES customer(id),
  status      TEXT NOT NULL,             -- draft|confirmed|shipped|closed|cancelled
  quote_id    TEXT REFERENCES quote(id),
  po_ref      TEXT,                      -- customer's own PO number
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_line (
  id           INTEGER PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES "order"(id),
  item_id      TEXT NOT NULL REFERENCES item(id),
  qty          INTEGER NOT NULL,
  unit_price   INTEGER NOT NULL,
  qty_shipped  INTEGER NOT NULL DEFAULT 0,
  qty_invoiced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ol_order ON order_line(order_id);

CREATE TABLE IF NOT EXISTS delivery (
  id         TEXT PRIMARY KEY,           -- D-0001
  order_id   TEXT NOT NULL REFERENCES "order"(id),
  carrier    TEXT,
  tracking   TEXT,
  shipped_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_line (
  id            INTEGER PRIMARY KEY,
  delivery_id   TEXT NOT NULL REFERENCES delivery(id),
  order_line_id INTEGER NOT NULL REFERENCES order_line(id),
  qty           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice (
  id          TEXT PRIMARY KEY,          -- INV-0001
  customer_id TEXT NOT NULL REFERENCES customer(id),
  order_id    TEXT NOT NULL REFERENCES "order"(id),
  delivery_id TEXT REFERENCES delivery(id),
  status      TEXT NOT NULL,             -- open|paid|void
  total       INTEGER NOT NULL,          -- cents
  issued_at   TEXT NOT NULL,
  due_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoice_line (
  id            INTEGER PRIMARY KEY,
  invoice_id    TEXT NOT NULL REFERENCES invoice(id),
  order_line_id INTEGER NOT NULL REFERENCES order_line(id),
  item_id       TEXT NOT NULL REFERENCES item(id),
  qty           INTEGER NOT NULL,
  unit_price    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment (
  id           TEXT PRIMARY KEY,         -- P-0001
  customer_id  TEXT NOT NULL REFERENCES customer(id),
  amount       INTEGER NOT NULL,         -- cents received
  method       TEXT,                     -- ach|wire|check|card
  reference    TEXT,
  received_at  TEXT NOT NULL
);
-- Cash application is its own fact. A payment is not an invoice being paid; it becomes
-- that only when somebody says which invoice it settles, and unapplied cash is a real
-- balance the business carries.
CREATE TABLE IF NOT EXISTS payment_application (
  id         INTEGER PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payment(id),
  invoice_id TEXT NOT NULL REFERENCES invoice(id),
  amount     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_invoice ON payment_application(invoice_id);
