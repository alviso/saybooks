-- Every invoice keeps its document link for life: drafts (preview), issued, paid and void
-- (stamped). Invoices from before this rule — drafts before preview links, voids whose token
-- was cleared — get one here so their documents are readable again.
UPDATE solo_invoice SET doc_token = lower(hex(randomblob(12))) WHERE doc_token IS NULL;
