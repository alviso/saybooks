'use strict';
/**
 * solo — freelancer invoicing. The fourth area, deliberately tiny, and the first whose
 * doctrine is written as an INTERACTIVE GUIDE: in a solo space the chat agent is often the
 * only interface, so the module teaches the agent to walk a person through their first
 * invoice one question at a time, and the refusals steer it back on script.
 *
 * NOT o2c-lite: no orders, no fulfilment, no credit gate — a different calibration. The
 * freelancer's agreement with their client IS the policy (S-5).
 */
const R = require('../../registry.js');
const H = require('../../db.js');
const V = require('./views.js');

const mod = R.defineModule({
  name: 'solo', prefix: 'solo',
  tables: ['solo_invoice', 'solo_invoice_line', 'solo_payment', 'solo_payment_application'],
  ids: { invoice: 'INV-0001', payment: 'P-0001' },
  lifecycles: {
    invoice: 'draft (editable) -> issued (immutable; seller frozen, doc link minted) -> paid | void (reasoned, number burned)',
    payment: 'recorded (unapplied is a valid state) -> applied to invoices, bounded both sides',
  },
  rules: [
    'Invoice timing is the client agreement — ahead, partial, or after; recorded, never gatekept.',
    'Issued invoices are immutable; mistakes are void-and-reissue on the record.',
    'The seller block freezes at issuance; no profile means issuing is refused with the guide sentence.',
    'Documents are produced, never sent; payments are recorded, never moved.',
  ],
  doctrine: `Freelancer invoicing: no orders, no fulfilment, no credit gate — the client
agreement IS the policy (S-5). Invoice ahead of the work, partially along the way, or after;
the books record, they never gatekeep terms.

BE THE GUIDE. You are often the only interface, and the person may be invoicing for the
first time. When something is missing, do not fail and stop — gather it conversationally,
ONE question at a time:
- No company profile? Ask for the company (or personal trading) name; then the address as it
  should print; then how clients pay them (bank details, payment instructions) — then call
  core_set_company_profile. Issuing is refused until this exists (S-3).
- New client? Ask the client's name; then email (optional); then what payment terms were
  agreed (net 30? on receipt?) — then core_create_customer. Terms live in their agreement:
  record them, never enforce them.
- The invoice: gather lines as they describe the work (description, quantity or hours,
  rate). Draft it, SHOW every number — lines, subtotal, tax, total, due date — and issue
  only after they confirm — solo_get_document shows you the real render first. Then call
  solo_get_document with with_pdf=true: the PDF bytes come back; hand the file over, they
  send it themselves (S-7).
Never invent an amount, a rate, a date, or terms (S-6).`,
  implements: {
    area: 'solo', spec: '0.1',
    argmap: { customer: 'customer_id', invoice: 'invoice_id', payment: 'payment_id' },
    acts: {
      draft_invoice: 'solo_draft_invoice', update_draft: 'solo_update_draft',
      issue_invoice: 'solo_issue_invoice', void_invoice: 'solo_void_invoice',
      record_payment: 'solo_record_payment', apply_payment: 'solo_apply_payment',
      invoice: 'solo_get_invoice', document: 'solo_get_document', outstanding: 'solo_outstanding', statement: 'solo_statement',
    },
  },
  search: (like) => ({
    solo_invoices: H.db().prepare(`SELECT i.id, i.status, i.total, c.name AS customer FROM solo_invoice i JOIN customer c ON c.id = i.customer_id
      WHERE i.id LIKE ? OR i.notes LIKE ? OR c.name LIKE ? LIMIT 10`).all(like, like, like),
  }),
  api: { views: V },
});

R.inModule(mod, () => {
  require('./commands/invoices.js');
  require('./commands/reads.js');
});

R.defineSubject('solo_invoice', {
  load: V.invoiceView,
  ctx: () => ({ has_profile: !!H.db().prepare('SELECT 1 FROM company_profile WHERE id = 1').get() }),
});
R.defineSubject('solo_payment', { load: (id) => H.need('solo_payment', id, 'payment') });

module.exports = mod;
