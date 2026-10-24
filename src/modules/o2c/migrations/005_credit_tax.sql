-- The tax inside a credit note (salestax 0.1): a return or a correction gives back tax that was
-- charged, so the liability for it goes down by exactly that. Write-offs keep 0: the tax on a bad
-- debt stays owed unless the accountant claims relief, which is outside these books.
ALTER TABLE credit_note ADD COLUMN tax_total INTEGER NOT NULL DEFAULT 0;
-- Returns already on record: the tax at each returned line's invoiced rate, as the credit was computed.
UPDATE credit_note SET tax_total = COALESCE((
  SELECT SUM(ROUND(rl.qty * ol.unit_price * COALESCE((SELECT il.tax_rate_bp FROM invoice_line il WHERE il.order_line_id = rl.order_line_id ORDER BY il.id DESC LIMIT 1), it.tax_rate_bp, 0) / 10000.0))
  FROM return_line rl JOIN order_line ol ON ol.id = rl.order_line_id JOIN item it ON it.id = ol.item_id WHERE rl.return_id = credit_note.return_id), 0)
WHERE kind = 'return';
-- Corrections and goodwill against an invoice: the invoice's own share of tax.
UPDATE credit_note SET tax_total = COALESCE((SELECT ROUND(credit_note.total * i.tax_total * 1.0 / i.total) FROM invoice i WHERE i.id = credit_note.invoice_id AND i.total > 0), 0)
WHERE kind IN ('correction', 'goodwill') AND invoice_id IS NOT NULL;
