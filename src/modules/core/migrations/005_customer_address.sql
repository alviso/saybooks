-- The customer's own facts for the document's bill-to block. A solo invoice cannot be issued
-- without an address (the document would be incomplete); o2c keeps it optional at 0.2.
ALTER TABLE customer ADD COLUMN address TEXT;
ALTER TABLE customer ADD COLUMN tax_id TEXT;
