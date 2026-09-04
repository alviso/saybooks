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

read({ name: 'solo_get_document', title: 'Document', summary: 'The rendered document itself: a picture of one page to look at, and — once issued — the PDF file to hand over.',
  doctrine: `Use this to SEE the invoice before asking whether to issue: a draft comes back as an image
stamped DRAFT, so you check the real render, not the JSON. After issue, call it again — the PDF is
attached as a link, and with_pdf=true the bytes come back as pdf_base64 — write them to a file and give it
to the person, they send it themselves (S-7). Pages count from 1.`,
  args: {
    invoice_id: { ...f.text('e.g. INV-0001.'), required: true },
    page: f.int('Page to render, from 1. Default 1.'),
    with_pdf: f.bool('Issued invoices only: include the PDF bytes as pdf_base64 in the result, to write to a file and hand over. Off by default — it is a few thousand characters.'),
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
      if (!draft) _attachments.push({ kind: 'file', mime: 'application/pdf', name: `${v.id}.pdf`, uri: `saybooks://doc/${ws}/${v.doc_token}.pdf`, description: `${v.id} as a PDF — also at ${v.pdf_path}` });
      const wantPdf = !draft && a.with_pdf === true;
      return {
        id: v.id, status: v.status, customer_name: v.customer_name, total_display: v.total_display, open_display: v.open_display,
        issued_at: v.issued_at, due_at: v.due_at, page: r.page, pages: r.pages, doc_path: v.doc_path, pdf_path: v.pdf_path,
        note: draft ? 'Rendered as it stands, stamped DRAFT. The PDF exists once it is issued.'
          : v.status === 'void' ? `Void${v.void_reason ? ` — ${v.void_reason}` : ''}. Stamped VOID; nothing is collectible. ${wantPdf ? 'pdf_base64 is the stamped file.' : 'with_pdf=true for the stamped file.'}`
          : wantPdf ? `pdf_base64 is the file ${v.id}.pdf (${pdf.length} bytes decoded) — write it out and hand it to the person; they send it themselves.`
          : 'Issued. Call again with with_pdf=true for the file bytes, or use pdf_path.',
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
