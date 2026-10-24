'use strict';
/**
 * p2p — procure to pay. Purchase orders, goods received against them, and vendor bills
 * recorded against an order, held to a 3-way match before a person can approve paying them.
 * o2c's mirror image. The bill itself, the vendor list and the approval are the purchases
 * area's: this area reaches them through its api, and purchases asks this area's api whether
 * a bill may be approved (billApprovalHold). Nothing here pays anything.
 */
const R = require('../../registry.js');
const V = require('./views.js');

const mod = R.defineModule({
  name: 'p2p', prefix: 'p2p',
  tables: ['p2p_po', 'p2p_po_line', 'p2p_receipt', 'p2p_receipt_line', 'p2p_bill_line', 'p2p_setting'],
  ids: { po: 'PO-0001', receipt: 'GR-0001' },
  lifecycles: {
    po: 'draft -> issued (prices freeze) -> received (every stocked line in full) | closed_short (reasoned; what arrived stays) | cancelled (reasoned; nothing arrived). Partly received is derived, never stored.',
    receipt: 'recorded once, immutable: what arrived against which order, when, at the order\'s price',
    bill: 'the purchases area\'s bill, with lines against the order: matched at approval, approved by a person only',
  },
  rules: [
    'Order prices freeze at issue; a bill\'s price differences are shown against them, never averaged away.',
    'Stock enters only through a goods receipt, by core\'s stock door; receiving more than is open is refused with the numbers.',
    'A bill on an order is approved only when it passes the 3-way match at that moment; the refusal names its numbers.',
    'Loosening the match tolerance is a person\'s act, with a reason.',
    'Nothing here pays anything: approval and payment are recorded, never executed.',
  ],
  doctrine: `Procure to pay: what the business BUYS on an order. The person tells you what to order;
you draft the order (p2p_create_po) with the vendor's quoted prices, and issue it when they say it
went out (p2p_issue_po). When goods arrive, record what was counted against the order
(p2p_receive_goods); stock goes up through core. When the vendor's invoice arrives, record it
against the order line by line as printed (p2p_record_vendor_bill): it lands in Bills, waiting for
a person to approve paying it, and it is matched against what was ordered and received. If it does
not match, say so with the numbers (p2p_bill_match) and do not suggest working around it: the
answer is a corrected bill from the vendor, or a person loosening the tolerance with a reason.
p2p_unbilled_receipts lists goods received and not yet billed. Only a person approves paying a bill;
the bank pays it; the record follows.`,
  implements: {
    area: 'p2p', spec: '0.2',
    argmap: { po: 'po_id', bill: 'bill_id' },
    acts: {
      create_po: 'p2p_create_po', issue_po: 'p2p_issue_po', cancel_po: 'p2p_cancel_po', close_po_short: 'p2p_close_po_short',
      receive_goods: 'p2p_receive_goods', record_vendor_bill: 'p2p_record_vendor_bill', set_match_tolerance: 'p2p_set_match_tolerance',
      pos: 'p2p_pos', po: 'p2p_po', goods_received: 'p2p_goods_received', unbilled_receipts: 'p2p_unbilled_receipts', bill_match: 'p2p_bill_match',
    },
  },
  api: {
    views: V,
    journalLines: V.journalLines,
    billApprovalHold: V.billApprovalHold,
    billOnAccrual: V.billOnAccrual,
    derivationAccounts: V.DERIVATION_ACCOUNTS,
  },
});

R.defineSubject('p2p_po', { load: (id) => V.poView(id) });

R.inModule(mod, () => {
  require('./commands/orders.js');
  require('./commands/bills.js');
  require('./commands/reads.js');
});

module.exports = mod;
