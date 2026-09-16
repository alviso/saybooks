'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

/** A wrong transaction id, refused in a way the caller can act on: the shape ids take here,
    the range this space holds, and the id they probably meant when only the padding is off.
    Models copy their own earlier guesses ("T-001") rather than the id a result just handed
    them; a refusal that only says "does not exist" leaves them guessing again. */
function needTx(id, where = '') {
  const t = H.get('purch_transaction', id);
  if (t) return t;
  const db = H.db();
  const m = /^t-0*(\d+)$/i.exec(String(id || '').trim());
  const meant = m ? db.prepare('SELECT id FROM purch_transaction WHERE id = ?').get(`T-${String(m[1]).padStart(4, '0')}`) : null;
  const range = db.prepare('SELECT MIN(id) lo, MAX(id) hi, COUNT(*) n FROM purch_transaction').get();
  const hint = meant ? ` Did you mean ${meant.id}? Ids are four digits.`
    : range.n ? ` Ids here run ${range.lo} to ${range.hi}, four digits, as the import result lists them.` : ' No statement has been imported yet.';
  throw new Rejected(`${where}transaction ${id} does not exist.${hint}`);
}

const STATUSES = ['purchase', 'recurring', 'transfer', 'income', 'fee', 'ignored'];
const SPENDING = new Set(['purchase', 'recurring']);
const CADENCES = ['weekly', 'monthly', 'yearly'];

/** Find or create a vendor by proper name; the description becomes its alias, applied to every unassigned row spelt that way. */
function nameVendor(db, at, t, name) {
  let v = db.prepare('SELECT * FROM purch_vendor WHERE name = ? COLLATE NOCASE').get(name);
  if (!v) { const id = H.nextId('V', 'purch_vendor'); db.prepare('INSERT INTO purch_vendor (id,name,created_at) VALUES (?,?,?)').run(id, name, at); v = { id, name }; }
  db.prepare('INSERT OR REPLACE INTO purch_vendor_alias (alias, vendor_id) VALUES (?,?)').run(t.description, v.id);
  const applied = db.prepare('UPDATE purch_transaction SET vendor_id = ? WHERE vendor_id IS NULL AND lower(description) = lower(?)').run(v.id, t.description).changes;
  db.prepare('UPDATE purch_transaction SET vendor_id = ? WHERE id = ?').run(v.id, t.id);
  return { vendor: v, applied };
}
/** A row reviewed as recurring declares the vendor's subscription when none is active (P-6: the person said it recurs). */
function ensureSubscription(db, at, t, vendorId, cadence) {
  // One vendor may carry several plans (a monthly fee and a yearly one): a subscription is the
  // vendor + currency + cadence + an amount within tolerance, not the vendor alone.
  const cad = cadence || 'monthly';
  const have = db.prepare("SELECT id, amount, tolerance_bp FROM purch_subscription WHERE vendor_id = ? AND currency = ? AND cadence = ? AND status = 'active'").all(vendorId, t.currency, cad)
    .find(s => Math.abs(-t.amount - s.amount) <= Math.round(s.amount * (s.tolerance_bp || 0) / 10000));
  if (have) return { id: have.id, declared: false };
  const first = db.prepare('SELECT MIN(date) d FROM purch_transaction WHERE vendor_id = ? AND currency = ? AND amount < 0 AND ABS(-amount - ?) <= ?').get(vendorId, t.currency, -t.amount, Math.round(-t.amount * 0.1)).d || t.date;
  const id = H.nextId('SUB', 'purch_subscription');
  db.prepare('INSERT INTO purch_subscription (id,vendor_id,cadence,amount,currency,tolerance_bp,start,status,created_at,updated_at) VALUES (?,?,?,?,?,1000,?,?,?,?)')
    .run(id, vendorId, cadence || 'monthly', -t.amount, t.currency, first, 'active', at, at);
  return { id, declared: true };
}
const checkSign = (t, status) => {
  if (SPENDING.has(status) && t.amount > 0) throw new Rejected(`${t.id} is money in (${H.money(t.amount, t.currency)}); ${status} is spending. Income, transfer or ignored?`);
  if (status === 'income' && t.amount < 0) throw new Rejected(`${t.id} is spending (${H.money(t.amount, t.currency)}); income is money in.`);
};

defineCommand({
  name: 'purch_review_transaction',
  permission: 'cash.write',
  title: 'Review', group: 'Purchases', subject: 'purch_transaction',
  summary: 'Say what a row is — purchase, recurring, transfer, income, fee, ignored — with a category, a vendor and a reason. Amount and date never change.',
  doctrine: `A reasoned act (P-5). Read purch_vocabulary first and propose from the person's own
categories and vendors. purchase is one-off spending; recurring is spending that repeats
(rent, streaming, insurance) — name the vendor and the subscription is declared for you, then
confirmed month by month (P-6). A transfer is money moving between the person's own accounts
(card payoffs, brokerage, savings, an owner draw): give it a category saying WHERE it went, so
the ledger's bank balance still ties to the statement. Leave that blank only when the money is
already recorded elsewhere in these books, such as a client payment against an invoice you
issued; those rows are then listed as not posted rather than counted twice. A fee is the bank's
charge; income is money in; ignored is a row that is not theirs to track. Never alter the amount or the date — a wrong row means a
wrong source, re-read and re-imported.`,
  effects: ['status, category, vendor, note recorded', 'subscription declared for a recurring row with a vendor'],
  guardless: true,   // any row may be re-reviewed; the sign checks live in the handler with their reasons
  args: {
    transaction_id: { ...f.text('The row, e.g. T-0012.'), required: true },
    status: { ...f.pick(STATUSES, 'What it is.'), required: true },
    category: f.text('The person\'s own word for it (groceries, software, travel). Empty beats guessed.'),
    vendor: f.text('The vendor\'s proper name; the row\'s description becomes its alias. Required for recurring.'),
    cadence: f.pick(CADENCES, 'For recurring: how often. Defaults to monthly.'),
    note: f.note('Anything the person said about it.'),
    reason: f.text('Why — part of the record.'),
  },
  handler(a, { db, at }) {
    const t = needTx(a.transaction_id);
    checkSign(t, a.status);
    if (a.status === 'recurring' && !(a.vendor && a.vendor.trim()) && !t.vendor_id) throw new Rejected(`${t.id}: a recurring charge needs its vendor named, so the subscription can be declared and confirmed.`);
    db.prepare('UPDATE purch_transaction SET status = ?, category = COALESCE(?, category), note = COALESCE(?, note), reviewed_at = ? WHERE id = ?')
      .run(a.status, a.category ? a.category.trim() : null, a.note || null, at, t.id);
    let sub = null;
    if (a.vendor && a.vendor.trim()) nameVendor(db, at, t, a.vendor.trim());
    if (a.status === 'recurring') sub = ensureSubscription(db, at, t, H.get('purch_transaction', t.id).vendor_id, a.cadence);
    return { ...V.transactionView(t.id), subscription: sub ? sub.id : null, subscription_declared: !!(sub && sub.declared) };
  },
});

defineCommand({
  name: 'purch_set_vendor',
  permission: 'cash.write',
  title: 'Name the vendor', group: 'Purchases', subject: 'purch_transaction',
  summary: 'Name the shop behind a row once; its statement spelling becomes an alias for every later row.',
  doctrine: 'One vendor, many spellings. The alias is the description as printed; pass it (or let it default to the row\'s description) so the next statement names the shop by itself.',
  effects: ['vendor created if new', 'alias recorded', 'vendor set on every unassigned row with that description'],
  guardless: true,   // naming a shop is always allowed
  args: {
    transaction_id: { ...f.text('The row.'), required: true },
    vendor: { ...f.text('The vendor\'s proper name (Netflix, Countdown).'), required: true },
    alias: f.text('The statement spelling to remember. Defaults to the row\'s description.'),
    reason: f.text('Why — optional.'),
  },
  handler(a, { db, at }) {
    const t = needTx(a.transaction_id);
    const name = a.vendor.trim(); if (!name) throw new Rejected('A vendor needs a name.');
    let v = db.prepare('SELECT * FROM purch_vendor WHERE name = ? COLLATE NOCASE').get(name);
    if (!v) { const id = H.nextId('V', 'purch_vendor'); db.prepare('INSERT INTO purch_vendor (id,name,created_at) VALUES (?,?,?)').run(id, name, at); v = { id, name }; }
    const alias = (a.alias || t.description).trim();
    db.prepare('INSERT OR REPLACE INTO purch_vendor_alias (alias, vendor_id) VALUES (?,?)').run(alias, v.id);
    const applied = db.prepare('UPDATE purch_transaction SET vendor_id = ? WHERE vendor_id IS NULL AND lower(description) = lower(?)').run(v.id, alias).changes;
    db.prepare('UPDATE purch_transaction SET vendor_id = ? WHERE id = ?').run(v.id, t.id);
    return { ...V.transactionView(t.id), vendor_id: v.id, alias, applied_to: applied };
  },
});

defineCommand({
  name: 'purch_rename_category',
  permission: 'cash.write',
  title: 'Rename category', group: 'Purchases', subject: 'purch_transaction', scope: 'collection',
  summary: 'Change a category word on every row that carries it, in one act.',
  doctrine: 'Categories are the person\'s words; when the word changes, every row follows in one reasoned act rather than a re-review. Renaming onto an existing word merges the two.',
  effects: ['category replaced on every row that carried it'],
  args: { from: { ...f.text('The word as it is now.'), required: true }, to: { ...f.text('The word it becomes.'), required: true }, reason: f.text('Why.') },
  handler(a, { db }) {
    const to = a.to.trim(); if (!to) throw new Rejected('The new word cannot be empty.');
    const n = db.prepare('UPDATE purch_transaction SET category = ? WHERE category = ? COLLATE NOCASE').run(to, a.from.trim()).changes;
    if (!n) throw new Rejected(`No row carries the category "${a.from}".`);
    return { from: a.from, to, rows: n };
  },
});

const REVIEW_ROW = {
  transaction_id: { ...f.text('The row, e.g. T-0012.'), required: true },
  status: { ...f.pick(STATUSES, 'What it is.'), required: true },
  category: f.text('The person\'s word for it. Empty beats guessed.'),
  vendor: f.text('The vendor\'s proper name; the row\'s description becomes its alias. Required for recurring.'),
  cadence: f.pick(CADENCES, 'For recurring: how often. Defaults to monthly.'),
  note: f.text('Anything the person said about it.'),
};

defineCommand({
  name: 'purch_review_batch',
  permission: 'cash.write',
  title: 'Review many', group: 'Purchases', subject: 'purch_transaction', scope: 'collection',
  summary: 'Review a whole statement in one act: status, category and vendor per row, one reason. Checked whole; refused whole.',
  doctrine: `The same rules as purch_review_transaction, once for many rows: the person has
looked at your proposal and said which words to use — write it all in one act with their
confirmation as the reason. Every row is validated before any is written; a row you cannot
name stays out of the batch and unreviewed, never guessed. Up to 200 rows.`,
  effects: ['status, category, vendor recorded on every row listed'],
  args: {
    rows: { ...f.lines(REVIEW_ROW, 'The rows and what they are.'), required: true },
    reason: f.text('Why — typically "confirmed by the person" plus anything they said.'),
  },
  handler(a, { db, at }) {
    const rows = a.rows || [];
    if (!rows.length) throw new Rejected('Nothing to review.');
    if (rows.length > 200) throw new Rejected('Up to 200 rows per batch.');
    const seen = new Set();
    const plan = rows.map((r, i) => {
      if (seen.has(r.transaction_id)) throw new Rejected(`Row ${i + 1}: ${r.transaction_id} appears twice in the batch.`);
      seen.add(r.transaction_id);
      const t = needTx(r.transaction_id, `Row ${i + 1}: `);
      checkSign(t, r.status);
      if (r.status === 'recurring' && !(r.vendor && r.vendor.trim()) && !t.vendor_id) throw new Rejected(`${t.id}: a recurring charge needs its vendor named.`);
      return { t, r };
    });
    let vendorsNamed = 0, aliased = 0; const declared = [];
    for (const { t, r } of plan) {
      db.prepare('UPDATE purch_transaction SET status = ?, category = COALESCE(?, category), note = COALESCE(?, note), reviewed_at = ? WHERE id = ?')
        .run(r.status, r.category ? r.category.trim() : null, r.note || null, at, t.id);
      if (r.vendor && r.vendor.trim()) { aliased += nameVendor(db, at, t, r.vendor.trim()).applied; vendorsNamed++; }
      if (r.status === 'recurring') { const s = ensureSubscription(db, at, t, H.get('purch_transaction', t.id).vendor_id, r.cadence); if (s.declared) declared.push(s.id); }
    }
    const by = {};
    for (const { r } of plan) by[r.status] = (by[r.status] || 0) + 1;
    const left = db.prepare("SELECT COUNT(*) n FROM purch_transaction WHERE status = 'unreviewed'").get().n;
    return { reviewed: plan.length, by_status: by, vendors_named: vendorsNamed, rows_aliased: aliased, subscriptions_declared: declared, still_unreviewed: left,
      note: `${plan.length} rows reviewed in one act.${declared.length ? ` ${declared.length} subscription${declared.length > 1 ? 's' : ''} declared (${declared.join(', ')}) — the record confirms them from here.` : ''}${left ? ` ${left} still unreviewed — ask for their words.` : ' Nothing left unreviewed.'}` };
  },
});
