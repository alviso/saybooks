-- The seller block freezes onto the invoice at issuance (INV-19's spirit): changing the
-- company profile must never silently reprint historical invoices with new bank details.
ALTER TABLE invoice ADD COLUMN seller_json TEXT;
