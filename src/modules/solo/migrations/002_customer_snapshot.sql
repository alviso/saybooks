-- The bill-to block freezes at issue exactly like the seller block (S-3): a client that
-- moves later never reprints history. Drafts show the live customer.
ALTER TABLE solo_invoice ADD COLUMN customer_json TEXT;
