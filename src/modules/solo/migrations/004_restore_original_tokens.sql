-- "The same link becomes the invoice" — and stays the link through void. Invoices voided
-- under the old rule lost their token, and 003 minted a fresh one; the audit log still holds
-- the original in the issue result's doc_path. Restore it, so a link a client already received
-- shows the VOID-stamped document instead of a dead page.
UPDATE solo_invoice SET doc_token = (
  SELECT substr(json_extract(l.result_json, '$.doc_path'), -24)
  FROM command_log l
  WHERE l.command = 'solo_issue_invoice' AND l.ok = 1
    AND json_extract(l.result_json, '$.id') = solo_invoice.id
    AND json_extract(l.result_json, '$.doc_path') LIKE '/doc/%'
  ORDER BY l.at DESC LIMIT 1)
WHERE status = 'void' AND EXISTS (
  SELECT 1 FROM command_log l
  WHERE l.command = 'solo_issue_invoice' AND l.ok = 1
    AND json_extract(l.result_json, '$.id') = solo_invoice.id
    AND json_extract(l.result_json, '$.doc_path') LIKE '/doc/%');
