-- Procure to pay (p2p 0.2): purchase orders, goods received against them, and the lines of
-- a vendor bill recorded against an order. The bill itself is the purchases area's bill
-- (B-0001); this area keeps only what the 3-way match needs. Nothing here pays anything.
CREATE TABLE IF NOT EXISTS p2p_po (
  id             TEXT PRIMARY KEY,                 -- PO-0001
  vendor_id      TEXT NOT NULL,                    -- the purchases area's vendor (V-0001)
  status         TEXT NOT NULL DEFAULT 'draft',    -- draft | issued | received | closed_short | cancelled
  currency       TEXT NOT NULL,
  expected_date  TEXT,
  vendor_ref     TEXT,                             -- the vendor's quote or order reference
  note           TEXT,
  issued_at      TEXT,
  issued_by      TEXT,
  closed_at      TEXT,
  closed_reason  TEXT,                             -- why it was closed short or cancelled
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_p2p_po_status ON p2p_po(status);

CREATE TABLE IF NOT EXISTS p2p_po_line (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id       TEXT NOT NULL REFERENCES p2p_po(id),
  pos         INTEGER NOT NULL,
  item_id     TEXT NOT NULL,                       -- core's item
  qty         INTEGER NOT NULL,
  unit_price  INTEGER NOT NULL,                    -- the vendor's price, frozen at issue
  stocked     INTEGER NOT NULL,                    -- copied from the item: services are never received
  UNIQUE (po_id, item_id)
);

-- A goods receipt is an immutable fact: what arrived, when, under which packing slip.
CREATE TABLE IF NOT EXISTS p2p_receipt (
  id           TEXT PRIMARY KEY,                   -- GR-0001
  po_id        TEXT NOT NULL REFERENCES p2p_po(id),
  received_at  TEXT NOT NULL,
  reference    TEXT,
  note         TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS p2p_receipt_line (
  receipt_id  TEXT NOT NULL REFERENCES p2p_receipt(id),
  po_line_id  INTEGER NOT NULL REFERENCES p2p_po_line(id),
  item_id     TEXT NOT NULL,
  qty         INTEGER NOT NULL,
  unit_cost   INTEGER NOT NULL,                    -- the order's price at receipt
  PRIMARY KEY (receipt_id, po_line_id)
);

-- What a bill on an order says, line by line, as printed.
CREATE TABLE IF NOT EXISTS p2p_bill_line (
  bill_id     TEXT NOT NULL,                       -- the purchases area's bill (B-0001)
  po_id       TEXT NOT NULL REFERENCES p2p_po(id),
  po_line_id  INTEGER NOT NULL REFERENCES p2p_po_line(id),
  item_id     TEXT NOT NULL,
  qty         INTEGER NOT NULL,
  unit_price  INTEGER NOT NULL,
  PRIMARY KEY (bill_id, po_line_id)
);
CREATE INDEX IF NOT EXISTS idx_p2p_bill_line_po ON p2p_bill_line(po_line_id);

-- The match tolerance and anything else this area is configured with, with who set it and why.
CREATE TABLE IF NOT EXISTS p2p_setting (
  key     TEXT PRIMARY KEY,
  value   TEXT NOT NULL,
  set_by  TEXT,
  set_at  TEXT,
  reason  TEXT
);
