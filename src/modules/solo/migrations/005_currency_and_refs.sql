-- 0.2: an invoice carries its currency (from the space's set); a payment too, so cash and
-- invoices never mix currencies by accident. Lines may carry a reference (a ticket id), the
-- invoice a subject line (project, period) — both print on the document.
ALTER TABLE solo_invoice ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE solo_invoice ADD COLUMN subject TEXT;
ALTER TABLE solo_invoice_line ADD COLUMN ref TEXT;
ALTER TABLE solo_payment ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
