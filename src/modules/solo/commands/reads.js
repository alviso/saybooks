'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const wsp = require('../../../workspace.js');
const D = require('../../../document.js');
const V = require('../views.js');
const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Invoicing read', ...def });

read({ name: 'solo_get_invoice', title: 'Invoice', summary: 'The whole document: lines, totals, frozen seller block, what is applied and open, and the shareable doc link.',
  args: { invoice_id: { ...f.text('e.g. INV-0001.'), required: true } },
  handler: (a) => V.invoiceView(a.invoice_id) });

read({ name: 'solo_get_document', title: 'Document', summary: 'The rendered document: a picture of one page to look at, and — once issued — the direct download link for the PDF.',
  doctrine: `Use this to SEE the invoice before asking whether to issue: a draft comes back as an image
stamped DRAFT, so you check the real render, not the JSON. After issue, call it again and hand the
person pdf_url — a direct, unauthenticated, one-click download of the finished PDF; they send it
themselves (S-7). Do not fetch or relay the bytes yourself: the link IS the deliverable. with_pdf=true
exists only as a fallback for a client that cannot open links at all. Pages count from 1.`,
  args: {
    invoice_id: { ...f.text('e.g. INV-0001.'), required: true },
    page: f.int('Page to render, from 1. Default 1.'),
    with_pdf: f.bool('Fallback only, for a client that cannot open links: include the PDF bytes as pdf_base64 (issued invoices only; thousands of characters). Prefer pdf_url.'),
  },
  handler: (a) => {
    // Every database read happens here, synchronously, inside the workspace; the promise below is pure rendering.
    const v = V.invoiceView(a.invoice_id);   // void renders too, stamped VOID: the record stays readable
    const logo = (H.db().prepare('SELECT logo FROM company_profile WHERE id = 1').get() || {}).logo || null;
    const ws = wsp.currentName();
    return (async () => {
      const pdf = await D.renderInvoicePdf(v, logo);
      const r = await D.rasterizePdf(pdf, a.page || 1);
      const draft = v.status === 'draft';
      const _attachments = [{ kind: 'image', mime: 'image/png', name: `${v.id}${draft ? '-draft' : ''}-p${r.page}.png`, data: r.png.toString('base64') }];
      if (!draft) _attachments.push({ kind: 'file', mime: 'application/pdf', name: `${v.id}.pdf`, uri: v.pdf_url || `saybooks://doc/${ws}/${v.doc_token}.pdf`, description: `${v.id} as a PDF — direct download, no sign-in` });
      const wantPdf = !draft && a.with_pdf === true;
      return {
        id: v.id, status: v.status, customer_name: v.customer_name, total_display: v.total_display, open_display: v.open_display,
        issued_at: v.issued_at, due_at: v.due_at, page: r.page, pages: r.pages,
        doc_url: v.doc_url, pdf_url: v.pdf_url, doc_path: v.doc_path, pdf_path: v.pdf_path,
        note: draft ? `Rendered as it stands, stamped DRAFT. Preview link: ${v.doc_url || v.doc_path}. The PDF exists once it is issued.`
          : v.status === 'void' ? `Void${v.void_reason ? ` — ${String(v.void_reason).replace(/[.\s]+$/, '')}` : ''}. Stamped VOID; nothing is collectible. Kept for the record at ${v.pdf_url || v.pdf_path}.`
          : wantPdf ? `pdf_base64 is the file ${v.id}.pdf (${pdf.length} bytes decoded) — fallback; the same file is a one-click download at ${v.pdf_url || v.pdf_path}.`
          : `Issued. Hand the person this direct download link for the PDF: ${v.pdf_url || v.pdf_path} (no sign-in needed). They send it themselves.`,
        ...(wantPdf ? { pdf_filename: `${v.id}.pdf`, pdf_bytes: pdf.length, pdf_base64: pdf.toString('base64') } : {}),
        _attachments,
      };
    })();
  } });

read({ name: 'solo_outstanding', title: 'Outstanding', summary: 'Who owes what: issued, unpaid invoices oldest first, with days overdue and the total open.',
  doctrine: 'This is the morning read. Chasing is the freelancer’s act — the system never sends anything.',
  args: {}, handler: () => V.outstanding() });

read({ name: 'solo_statement', title: 'Statement', summary: 'One client, chronological: every invoice and payment with a running balance.',
  args: { customer_id: { ...f.ref('customer', 'The client.'), required: true } },
  handler: (a) => V.statement(a.customer_id) });
