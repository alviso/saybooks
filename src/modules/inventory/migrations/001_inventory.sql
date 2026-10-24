-- What one unit of stock that came in without a cost was worth (opening stock, a correction
-- received by hand), stated once per item with a reason. Everything else about cost is derived
-- from core's stock moves (STK-3).
CREATE TABLE IF NOT EXISTS inv_opening_cost (
  item_id    TEXT PRIMARY KEY REFERENCES item(id),
  unit_cost  INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  set_by     TEXT,
  set_at     TEXT NOT NULL
);
