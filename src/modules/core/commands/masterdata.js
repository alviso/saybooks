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
    address:      f.note('Billing address, as it should print in the bill-to block. Required before a solo invoice can be issued.'),
    tax_id:       f.text('Their VAT / EIN, printed on the document where present.'),
    terms:        f.pick(['immediate', 'net15', 'net30', 'net60'], 'Payment terms. Drives the invoice due date.'),
    credit_limit: f.money('How much unpaid exposure we will carry for this customer.'),
  },
  handler(a, { db, at }) {
    return api().createCustomer(db, a, at);
  },
});

defineCommand({
  name: 'core_update_customer',
  permission: 'sales.write',
  title: 'Update customer', group: 'Master data', subject: 'customer',
  guardless: true,   // contact facts are always editable; nothing about a customer's state forbids fixing an address
  summary: "Change a customer's contact facts: email, billing address, tax id, terms.",
  doctrine: `Patch semantics: only the fields you pass change. These are the customer's own facts —
ask, never guess an address. Credit limit and hold have their own commands because they are
authority, not contact details. Issued documents keep the bill-to block they were issued with.`,
  effects: ['customer record updated'],
  args: {
    customer_id: { ...f.ref('customer', 'The customer.'), required: true },
    email:   f.text('Billing email.'),
    address: f.note('Billing address, as it should print.'),
    tax_id:  f.text('Their VAT / EIN.'),
    terms:   f.pick(['immediate', 'net15', 'net30', 'net60'], 'Payment terms.'),
  },
  handler(a, { db, at }) {
    const cur = H.need('customer', a.customer_id, 'customer');
    const next = { ...cur };
    let touched = 0;
    for (const k of ['email', 'address', 'tax_id', 'terms']) if (a[k] !== undefined) { next[k] = a[k] === '' ? null : a[k]; touched++; }
    if (!touched) throw new Rejected('Nothing to change — pass email, address, tax_id or terms.');
    if (next.terms === null) throw new Rejected('terms cannot be cleared; pick one of immediate, net15, net30, net60.');
    db.prepare('UPDATE customer SET email = ?, address = ?, tax_id = ?, terms = ? WHERE id = ?').run(next.email, next.address, next.tax_id, next.terms, cur.id);
    return H.get('customer', cur.id);
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
  summary: "The business's own identity: seller block, tax id, payment instructions, country, currencies, tax scheme, numbering. One per workspace.",
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
    country: f.text('Where the business is, ISO 3166 two letters (US, NZ, CZ, HU). Sets how dates and amounts print.', { label: 'Country' }),
    currency: f.text('Default billing currency, ISO 4217 (USD, NZD, CZK, EUR). Every invoice carries one; this is the one proposed.', { label: 'Default currency' }),
    currencies: f.text('Every currency this business bills in, comma-separated (e.g. "USD, CZK"). An invoice may carry any of these and no other.', { label: 'Currencies' }),
    tax_label: f.text('What the tax is called on documents: GST, VAT, Sales tax, ÁFA, DPH.', { label: 'Tax name' }),
    tax_rate_bp: f.int('Default tax rate in basis points (1500 = 15%). Applied to every line unless the line says otherwise. Only meaningful when registered.', { label: 'Default tax rate (bp)' }),
    tax_registered: f.bool('Registered for the tax (GST/VAT)? Pass it explicitly either way — false is an answer, the setup checklist stays open until one is given. Unregistered businesses cannot put tax on a line; registered ones print TAX INVOICE and their tax id.', { label: 'Tax registered' }),
    tax_id_label: f.text('How the tax id is captioned on documents: GST No., IRD number, VAT ID, EIN. Defaults to "Tax ID".', { label: 'Tax id caption' }),
    number_format: f.text('Invoice numbering. Tokens: {NNNN} the sequence (width = number of Ns), {YYYY} or {YY} the year of issue. Default INV-{NNNN}; INV-{YYYY}-{NNN} restarts each year.', { label: 'Invoice number format' }),
  },
  handler(a, { db, at }) {
    const cur = db.prepare('SELECT * FROM company_profile WHERE id = 1').get();
    if (!cur && !a.name) throw new Rejected('The first write must carry the company name.');
    if (a.name === '') throw new Rejected('The company keeps a name.');
    const next = { ...cur };
    for (const k of ['name', 'address', 'tax_id', 'payment_instructions', 'footer_note', 'country', 'currency', 'currencies', 'tax_label', 'tax_id_label', 'number_format']) {
      if (a[k] !== undefined) next[k] = a[k] === '' ? null : (typeof a[k] === 'string' ? a[k].trim() : a[k]);
    }
    if (a.tax_rate_bp !== undefined) next.tax_rate_bp = a.tax_rate_bp;
    if (a.tax_registered !== undefined) { next.tax_registered = a.tax_registered ? 1 : 0; next.tax_decided = 1; }
    // Country and currency codes: short, upper-case, and the currency set must contain the default.
    if (next.country) { next.country = next.country.toUpperCase(); if (!/^[A-Z]{2}$/.test(next.country)) throw new Rejected('country is a two-letter ISO 3166 code, e.g. NZ.'); }
    if (next.currency) { next.currency = next.currency.toUpperCase(); if (!H.CUR_RE.test(next.currency)) throw new Rejected('currency is a three-letter ISO 4217 code, e.g. NZD.'); }
    if (next.currencies) {
      const set = [...new Set(String(next.currencies).toUpperCase().split(/[\s,;]+/).filter(Boolean))];
      for (const c of set) if (!H.CUR_RE.test(c)) throw new Rejected(`${c} is not a three-letter ISO 4217 currency code.`);
      if (!set.length) throw new Rejected('currencies needs at least one code.');
      const def = next.currency || 'USD';
      if (!set.includes(def)) set.unshift(def);
      next.currencies = JSON.stringify(set);
    } else if (a.currencies === '') next.currencies = null;
    if (next.tax_rate_bp != null && (!Number.isInteger(next.tax_rate_bp) || next.tax_rate_bp < 0 || next.tax_rate_bp > 10000)) throw new Rejected('tax_rate_bp is a whole number of basis points between 0 and 10000.');
    if (next.tax_registered && !next.tax_rate_bp) throw new Rejected('A registered business needs a default tax rate: pass tax_rate_bp (1500 = 15%) with tax_registered.');
    if (next.number_format) {
      const fmtRe = /^[A-Za-z0-9._/\-]*(\{YYYY\}|\{YY\})?[A-Za-z0-9._/\-]*\{N+\}[A-Za-z0-9._/\-]*$/;
      if (!fmtRe.test(next.number_format)) throw new Rejected('number_format needs exactly one {N…} sequence token, optionally one {YYYY} or {YY}, and letters, digits, - . / around them. Example: INV-{YYYY}-{NNN}.');
    }
    db.prepare(`INSERT INTO company_profile (id,name,address,tax_id,payment_instructions,footer_note,country,currency,currencies,tax_label,tax_rate_bp,tax_registered,tax_id_label,number_format,tax_decided,updated_at)
                VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, address=excluded.address, tax_id=excluded.tax_id,
                  payment_instructions=excluded.payment_instructions, footer_note=excluded.footer_note,
                  country=excluded.country, currency=excluded.currency, currencies=excluded.currencies, tax_label=excluded.tax_label,
                  tax_rate_bp=excluded.tax_rate_bp, tax_registered=excluded.tax_registered, tax_id_label=excluded.tax_id_label,
                  number_format=excluded.number_format, tax_decided=excluded.tax_decided, updated_at=excluded.updated_at`)
      .run(next.name, next.address ?? null, next.tax_id ?? null, next.payment_instructions ?? null, next.footer_note ?? null,
           next.country ?? null, next.currency ?? null, next.currencies ?? null, next.tax_label ?? null, next.tax_rate_bp ?? 0, next.tax_registered ? 1 : 0,
           next.tax_id_label ?? null, next.number_format ?? null, next.tax_decided ? 1 : 0, at);
    const { logo, ...profile } = db.prepare('SELECT * FROM company_profile WHERE id = 1').get();
    return { ...profile, tax_registered: !!profile.tax_registered, tax_decided: !!profile.tax_decided, currencies: H.locale().currencies, has_logo: !!logo };
  },
});

const LOGO_MAX = 300 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
function checkLogoDataUrl(d) {
  const m = /^data:(image\/(?:png|jpeg|svg\+xml|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(d || '');
  if (!m) throw new Rejected('logo_data must be a data URL of a PNG, JPEG, SVG or WebP image (data:image/png;base64,…).');
  const bytes = Math.floor(m[2].replace(/\s/g, '').length * 3 / 4);
  if (bytes > LOGO_MAX) throw new Rejected(`The logo is ${Math.round(bytes / 1024)} KB; the limit is 300 KB. Shrink it first.`);
  return { type: m[1], bytes };
}
async function fetchLogo(url) {
  let u; try { u = new URL(url); } catch { throw new Rejected('logo_url must be a full https URL.'); }
  if (u.protocol !== 'https:') throw new Rejected('logo_url must use https.');
  if (/^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[|::1$|\d+\.\d+\.\d+\.\d+$)/.test(u.hostname)) throw new Rejected('logo_url must point at a public host name.');
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
  let res;
  try { res = await fetch(u, { signal: ac.signal, redirect: 'follow' }); }
  catch (e) { throw new Rejected(`Could not fetch the logo: ${e.name === 'AbortError' ? 'timed out after 6s' : e.message}.`); }
  finally { clearTimeout(t); }
  if (!res.ok) throw new Rejected(`Could not fetch the logo: HTTP ${res.status}.`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!LOGO_TYPES.includes(type)) throw new Rejected(`logo_url must serve a PNG, JPEG, SVG or WebP image; it served ${type || 'no content type'}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > LOGO_MAX) throw new Rejected(`The logo is ${Math.round(buf.length / 1024)} KB; the limit is 300 KB. Shrink it first.`);
  return `data:${type};base64,${buf.toString('base64')}`;
}

defineCommand({
  name: 'core_set_company_logo',
  permission: 'workspace.admin',
  title: 'Company logo', group: 'Master data', subject: 'company_profile', scope: 'collection',
  summary: 'Put your logo on the invoice document. Upload a file, or give a public https URL and it is fetched once.',
  doctrine: `Branding, not a fact: the logo is NOT part of the frozen seller block, so changing it
re-brands past documents while their names, addresses and amounts stay exactly as issued.
PNG, JPEG, SVG or WebP, 300 KB at most; the image is stored, never hotlinked. Needs a company
profile first. Pass remove=true to take it off.`,
  effects: ['company logo stored (or removed)'],
  redact: ['logo_data'],
  args: {
    logo_data: f.text('The image itself as a data URL (data:image/png;base64,…). From the form: pick a file.', { widget: 'file' }),
    logo_url: f.text('Public https URL of the image. Fetched once and stored; the URL itself is not kept.'),
    remove: f.bool('Remove the current logo.'),
  },
  async prepare(a) {
    if (a.logo_url && !a.logo_data && !a.remove) return { ...a, logo_data: await fetchLogo(a.logo_url) };
    return a;
  },
  handler(a, { db, at }) {
    const cur = db.prepare('SELECT id FROM company_profile WHERE id = 1').get();
    if (!cur) throw new Rejected('Set the company profile first (core_set_company_profile, the name at least); then the logo has somewhere to live.');
    if (a.remove && !a.logo_data) {
      db.prepare('UPDATE company_profile SET logo = NULL, updated_at = ? WHERE id = 1').run(at);
      return { has_logo: false, removed: true };
    }
    if (!a.logo_data) throw new Rejected('Pass logo_data (a file, or a data URL) or logo_url — or remove=true.');
    const { type, bytes } = checkLogoDataUrl(a.logo_data);
    db.prepare('UPDATE company_profile SET logo = ?, updated_at = ? WHERE id = 1').run(a.logo_data, at);
    return { has_logo: true, logo_type: type, logo_bytes: bytes };
  },
});
