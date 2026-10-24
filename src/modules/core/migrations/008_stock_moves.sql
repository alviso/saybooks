-- Every change to on_hand, as a row: what moved, how many, when, why, and at what unit cost
-- when the move itself knows it (a goods receipt does; a shipment never does, its cost is the
-- moving average at that moment, derived by the inventory area). Written only by core's stock
-- door (api.adjustStock) and by item creation, so the rows always add up to on_hand.
CREATE TABLE IF NOT EXISTS stock_move (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT NOT NULL REFERENCES item(id),
  date        TEXT NOT NULL,                      -- the day it moved
  qty         INTEGER NOT NULL,                   -- signed: in positive, out negative
  kind        TEXT NOT NULL,                      -- opening | receipt | shipment | return | count | adjustment
  ref         TEXT,                               -- GR-0001, D-0003, RET-0001, ...
  unit_cost   INTEGER,                            -- cents, when the move knows its cost
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_move_item ON stock_move(item_id, date, id);
-- Books that existed before moves were kept start from what was on hand then.
INSERT INTO stock_move (item_id, date, qty, kind, note, created_at)
  SELECT id, date('now'), on_hand, 'opening', 'on hand when stock moves started being kept', datetime('now')
  FROM item WHERE stocked = 1 AND on_hand > 0 AND NOT EXISTS (SELECT 1 FROM stock_move m WHERE m.item_id = item.id);
