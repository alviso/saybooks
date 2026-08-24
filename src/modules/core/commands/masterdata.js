'use strict';
const { defineCommand, f, Rejected, MODULES } = require('../../../registry.js');
const H = require('../../../db.js');
const api = () => MODULES.find(m => m.name === 'core').api;

defineCommand({
  name: 'core_create_customer',
  permission: 'sales.write',
  title: 'New customer', group: 'Master data', subject: 'customer', scope: 'collection',
  summary: 'Create a customer we can sell to.',
  doctrine: `A credit limit of 0 means prepay only — that is a real position, not a missing value.
Do not invent a limit to make an order go through; if the limit is wrong, someone with the
authority to change it changes it, and that change is its own logged command.`,
  effects: ['customer created'],
  args: {
    name:         { ...f.text('Legal or trading name as it will appear on the invoice.', { label: 'Customer name' }), required: true },
    email:        f.text('Billing email.'),
    terms:        f.pick(['immediate', 'net15', 'net30', 'net60'], 'Payment terms. Drives the invoice due date.'),
    credit_limit: f.money('How much unpaid exposure we will carry for this customer.'),
  },
  handler(a, { db, at }) {
    return api().createCustomer(db, a, at);
  },
});

defineCommand({
  name: 'core_create_item',
  permission: 'sales.write',
  title: 'New item', group: 'Master data', subject: 'item', scope: 'collection',
  summary: 'Create a sellable item.',
  doctrine: 'Set stocked=false for services and anything that cannot run out; those lines never check inventory and never deplete it.',
  effects: ['item created'],
  args: {
    sku:        { ...f.text('The SKU, your own identifier. Becomes the item id.'), required: true },
    name:       { ...f.text('What it is called on the quote and invoice.'), required: true },
    unit_price: { ...f.money('List price per unit.'), required: true },
    on_hand:    f.int('Opening quantity on hand.'),
    stocked:    f.bool('False for services — never depletes, never blocks a shipment.'),
    tax_rate_bp: f.int('Default tax rate in basis points (875 = 8.75%). 0 or omitted = untaxed. Billing snapshots this rate per line.'),
  },
  handler(a, { db, at }) {
    if (H.get('item', a.sku)) throw new Rejected(`Item ${a.sku} already exists.`);
    if (a.unit_price < 0) throw new Rejected('unit_price cannot be negative.');
    db.prepare('INSERT INTO item (id,name,unit_price,on_hand,stocked,tax_rate_bp,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(a.sku, a.name, a.unit_price, a.on_hand || 0, a.stocked === false ? 0 : 1, a.tax_rate_bp || 0, at);
    return H.get('item', a.sku);
  },
});

defineCommand({
  name: 'core_receive_stock',
  permission: 'fulfil.write',
  title: 'Receive stock', group: 'Master data', subject: 'item',
  summary: 'Increase quantity on hand for a stocked item.',
  doctrine: 'Receipts are additive and never retroactive. To correct a count, receive the difference — a negative qty is allowed for that and is visible as a correction in the log.',
  effects: ['item.on_hand adjusted'],
  guards: [ (item) => item.stocked ? true : 'This is a service item; it has no quantity on hand.' ],
  args: {
    item_id: { ...f.ref('item', 'The item received.'), required: true },
    qty:     { ...f.int('Units received. Negative to correct an overstated count.'), required: true },
    note:    f.text('Why — a PO number, a cycle-count reference.'),
  },
  handler(a, { db }) {
    const item = H.need('item', a.item_id, 'item');
    if (!item.stocked) throw new Rejected('This is a service item; it has no quantity on hand.');
    // Through the same door every other module uses; one rule about negative stock, one place.
    return api().adjustStock(db, a.item_id, a.qty, a.note || 'receipt');
  },
});

defineCommand({
  name: 'core_set_price',
  permission: 'sales.write',
  title: 'Set list price', group: 'Master data', subject: 'item',
  summary: 'Change an item\'s list price.',
  doctrine: `Takes effect for documents raised from now on. Everything already raised keeps the
price it was raised with — a quote accepted after this change still becomes an order at the
quoted price (INV-19), and issued invoices never move. That is why this is a logged act and
not a field edit: the moment the price changed is part of the record.`,
  effects: ['item.unit_price changed for future documents only'],
  guardless: true,   // no business rule blocks a price change; the log is the control
  args: {
    item_id:    { ...f.ref('item', 'The item.'), required: true },
    unit_price: { ...f.money('The new list price per unit.'), required: true },
  },
  handler(a, { db }) {
    const item = H.need('item', a.item_id, 'item');
    if (a.unit_price < 0) throw new Rejected('unit_price cannot be negative.');
    db.prepare('UPDATE item SET unit_price = ? WHERE id = ?').run(a.unit_price, a.item_id);
    return { ...H.get('item', a.item_id), previous_price: item.unit_price };
  },
});

defineCommand({
  name: 'core_set_credit_limit',
  permission: 'credit.authority',
  title: 'Set credit limit', group: 'Master data', subject: 'customer',
  summary: 'Change how much unpaid exposure we will carry for a customer.',
  doctrine: `This is the human decision the credit gate's refusal points to. When o2c refuses to
confirm an order, the answer is never to route around the gate — it is for someone with the
authority to change this number to change it, here, with a reason that will be read back. A
limit of 0 means prepay only. Lowering a limit never touches already-confirmed orders; it
tightens the gate for the next one.`,
  effects: ['customer.credit_limit changed for future confirmations'],
  guardless: true,   // no rule blocks it; the mandatory reason and the log are the control
  args: {
    customer_id:  { ...f.ref('customer', 'The customer.'), required: true },
    credit_limit: { ...f.money('The new limit.'), required: true },
    reason:       { ...f.note('Why — approved by whom, on what basis. This is the audit answer to "who raised it".'), required: true },
  },
  handler(a, { db }) {
    const c = H.need('customer', a.customer_id, 'customer');
    if (a.credit_limit < 0) throw new Rejected('credit_limit cannot be negative. 0 means prepay only.');
    db.prepare('UPDATE customer SET credit_limit = ? WHERE id = ?').run(a.credit_limit, a.customer_id);
    return { ...H.get('customer', a.customer_id), previous_limit: c.credit_limit };
  },
});

defineCommand({
  name: 'core_hold_customer',
  permission: 'credit.authority',
  title: 'Credit hold', group: 'Master data', subject: 'customer',
  summary: 'Put a customer on credit hold: no new orders confirm until released.',
  doctrine: `A hold outranks the limit: however much room the numbers show, nothing confirms
while it is on. Already-confirmed orders are not touched — fulfil and bill them as agreed; the
hold is about taking on NEW exposure. Holds are for judgment the formula cannot see: a bounced
check, a dispute turning sour, news about the customer.`,
  effects: ['customer.on_hold set', 'o2c_confirm_order refuses while held'],
  guards: [ (c) => !c.on_hold || 'Already on credit hold.' ],
  args: {
    customer_id: { ...f.ref('customer', 'The customer.'), required: true },
    reason:      { ...f.note('Why. Shown whenever the hold blocks something.'), required: true },
  },
  handler(a, { db }) {
    const c = H.need('customer', a.customer_id, 'customer');
    if (c.on_hold) throw new Rejected('Already on credit hold.');
    db.prepare('UPDATE customer SET on_hold = 1 WHERE id = ?').run(a.customer_id);
    return H.get('customer', a.customer_id);
  },
});

defineCommand({
  name: 'core_release_customer',
  permission: 'credit.authority',
  title: 'Release hold', group: 'Master data', subject: 'customer',
  summary: 'Release a customer from credit hold.',
  doctrine: 'The release is its own logged act with its own reason — "who released it and why" is exactly the question that gets asked later. The limit applies again from the next confirmation.',
  effects: ['customer.on_hold cleared'],
  guards: [ (c) => !!c.on_hold || 'This customer is not on hold.' ],
  args: {
    customer_id: { ...f.ref('customer', 'The customer.'), required: true },
    reason:      { ...f.note('Why the hold is lifted.'), required: true },
  },
  handler(a, { db }) {
    const c = H.need('customer', a.customer_id, 'customer');
    if (!c.on_hold) throw new Rejected('This customer is not on hold.');
    db.prepare('UPDATE customer SET on_hold = 0 WHERE id = ?').run(a.customer_id);
    return H.get('customer', a.customer_id);
  },
});

defineCommand({
  name: 'core_set_company_profile',
  permission: 'workspace.admin',
  title: 'Company profile', group: 'Master data', subject: 'company_profile', scope: 'collection',
  summary: "The business's own identity: seller block, tax id, payment instructions. One per workspace.",
  doctrine: `The invoice document's seller comes from here — a document without it is incomplete,
not wrong (INV-22). Patch semantics: only the fields you pass change; the name is required
only the first time.`,
  effects: ['company profile written'],
  args: {
    name: f.text('Legal or trading name, as it should appear on documents.'),
    address: f.note('Postal address, as it should print.'),
    tax_id: f.text('EIN / VAT id — printed on documents where present.'),
    payment_instructions: f.note('How customers pay: bank details, reference format. Printed on every invoice.'),
    footer_note: f.note('One line at the document foot (returns policy, thanks, registration no).'),
  },
  handler(a, { db, at }) {
    const cur = db.prepare('SELECT * FROM company_profile WHERE id = 1').get();
    if (!cur && !a.name) throw new Rejected('The first write must carry the company name.');
    if (a.name === '') throw new Rejected('The company keeps a name.');
    const next = { ...cur };
    for (const k of ['name', 'address', 'tax_id', 'payment_instructions', 'footer_note']) {
      if (a[k] !== undefined) next[k] = a[k] === '' ? null : a[k];
    }
    db.prepare(`INSERT INTO company_profile (id,name,address,tax_id,payment_instructions,footer_note,updated_at)
                VALUES (1,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, address=excluded.address, tax_id=excluded.tax_id,
                  payment_instructions=excluded.payment_instructions, footer_note=excluded.footer_note, updated_at=excluded.updated_at`)
      .run(next.name, next.address ?? null, next.tax_id ?? null, next.payment_instructions ?? null, next.footer_note ?? null, at);
    return db.prepare('SELECT * FROM company_profile WHERE id = 1').get();
  },
});
