'use strict';
/**
 * Standing rules (P-11): something the person says ahead of time, "I'm at the Texas
 * conference the next five days, book it to travel", kept by the books. A rule suggests;
 * it never books. Matching unreviewed rows carry the suggestion until a person's review
 * confirms it, and ending a rule takes its suggestions away without touching a reviewed row.
 */
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

// recurring is left to review: it needs a vendor and declares a subscription, which is a
// decision about one shop, not a window of days.
const RULE_STATUSES = ['purchase', 'transfer', 'income', 'fee', 'ignored'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

defineCommand({
  name: 'purch_add_rule',
  permission: 'cash.write',
  title: 'Add standing rule', group: 'Purchases', subject: 'purch_rule', scope: 'collection',
  summary: 'Remember something ahead of time ("the next five days are the Texas conference, book it to travel"): matching rows get a suggested category until someone reviews them.',
  doctrine: `When the person tells you about spending before it shows up on a statement (a trip, an
event, a project, "everything from this shop is office supplies"), record it as a standing rule.
Turn relative dates into real ones from today ("the next five days" from 2026-10-05 is
2026-10-05 to 2026-10-09) and say them back. A rule needs a window, words the statement line
will contain, or a vendor; the category is the person's word. A rule SUGGESTS: it never books a
row. Rows it matches show the suggestion and stay unreviewed until the person confirms them,
in review or with purch_accept_suggestions.`,
  effects: ['rule recorded', 'matching unreviewed rows carry its suggestion'],
  args: {
    label: { ...f.text('The person\'s name for it: "Texas conference", "Q4 office move".'), required: true },
    category: { ...f.text('The category matching rows are suggested as, in the person\'s words (travel, office supplies).'), required: true },
    from: f.date('First day it applies.'),
    to: f.date('Last day it applies, inclusive.'),
    match: f.text('Words the statement line contains, any case (UBER, MARRIOTT). Optional.'),
    vendor: f.text('Only rows already named to this vendor. Optional.'),
    status: f.pick(RULE_STATUSES, 'What matching rows are suggested as. Defaults to purchase.'),
    currency: f.text('Only rows in this currency (ISO 4217). Optional.'),
    reason: f.text('What the person said, in their words.'),
  },
  handler(a, { db, at, actor }) {
    const label = String(a.label || '').trim(), category = String(a.category || '').trim();
    if (!label) throw new Rejected('A rule needs a label: the person\'s name for it, such as "Texas conference".');
    if (!category) throw new Rejected('A rule needs the category it suggests, in the person\'s words.');
    for (const k of ['from', 'to']) if (a[k] && !ISO.test(a[k])) throw new Rejected(`${k} must be a date as YYYY-MM-DD; got "${a[k]}".`);
    if (a.from && a.to && a.to < a.from) throw new Rejected(`The rule ends before it starts: ${a.to} is before ${a.from}.`);
    const match = a.match && a.match.trim() ? a.match.trim() : null;
    let vendorId = null;
    if (a.vendor && a.vendor.trim()) {
      const v = db.prepare('SELECT id FROM purch_vendor WHERE name = ? COLLATE NOCASE').get(a.vendor.trim());
      if (!v) throw new Rejected(`No vendor is named "${a.vendor.trim()}" yet. Name it on a row first, or use match with the words its statement line contains.`);
      vendorId = v.id;
    }
    if (!a.from && !a.to && !match && !vendorId) throw new Rejected('A rule that matches every row is a category, not a rule. Give it dates (from, to), words the statement line contains (match), or a vendor.');
    const status = a.status || 'purchase';
    const dup = db.prepare("SELECT id FROM purch_rule WHERE state = 'active' AND label = ? COLLATE NOCASE").get(label);
    if (dup) throw new Rejected(`There is already an active rule called "${label}" (${dup.id}). End it first, or give this one another name.`);
    const id = H.nextId('RL', 'purch_rule');
    db.prepare(`INSERT INTO purch_rule (id,label,category,status,date_from,date_to,match,vendor_id,currency,reason,state,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?)`).run(id, label, category, status, a.from || null, a.to || null, match, vendorId,
      a.currency ? a.currency.trim().toUpperCase() : null, a.reason || null, actor || null, at);
    const r = V.ruleView(id);
    return { id, rule_id: id, label, category, status, window: r.window, suggesting: r.suggesting, rows: r.rows.slice(0, 20),
      note: r.suggesting
        ? `Recorded. ${r.suggesting} unreviewed row${r.suggesting > 1 ? 's' : ''} already on record match${r.suggesting > 1 ? '' : 'es'} it and now carr${r.suggesting > 1 ? 'y' : 'ies'} the suggestion "${category}". Show them to the person; nothing is booked until they confirm.`
        : `Recorded. Nothing on record matches yet; rows from the next statement that fall in ${r.window} will carry the suggestion "${category}".` };
  },
});

defineCommand({
  name: 'purch_end_rule',
  permission: 'cash.write',
  title: 'End rule', group: 'Purchases', subject: 'purch_rule',
  summary: 'Stop a standing rule. Its suggestions go away; rows already reviewed keep what the person confirmed.',
  doctrine: 'End a rule when the person says it no longer holds, or when it was recorded wrong (then add the right one). Ending never changes a reviewed row.',
  effects: ['rule ended', 'its suggestions removed from unreviewed rows'],
  guards: [ (r) => r.state !== 'ended' || `${r.id} already ended.` ],
  args: { rule_id: { ...f.text('The rule, e.g. RL-0001.'), required: true }, reason: { ...f.text('Why it ends.'), required: true } },
  handler(a, { db, at }) {
    const r = H.need('purch_rule', a.rule_id, 'rule');
    if (r.state === 'ended') throw new Rejected(`${r.id} already ended.`);
    const was = V.ruleView(r.id).suggesting;
    db.prepare("UPDATE purch_rule SET state = 'ended', ended_at = ?, end_reason = ? WHERE id = ?").run(at, a.reason, r.id);
    return { id: r.id, rule_id: r.id, label: r.label, ended: true, suggestions_removed: was,
      note: was ? `Ended. ${was} unreviewed row${was > 1 ? 's' : ''} no longer carr${was > 1 ? 'y' : 'ies'} its suggestion; reviewed rows are unchanged.` : 'Ended. It was suggesting nothing; reviewed rows are unchanged.' };
  },
});

defineCommand({
  name: 'purch_accept_suggestions',
  permission: 'cash.write',
  title: 'Accept suggestions', group: 'Purchases', subject: 'purch_rule', scope: 'collection',
  summary: 'Confirm what standing rules suggest, in one reasoned act: every waiting row, or one rule\'s rows, minus any the person says are not part of it.',
  doctrine: `This is a review act, so it follows the person's confirmation, never the rule alone.
Show them the rows first (purch_rules lists each rule with the rows it is suggesting for), and
leave out any row they say does not belong with except. The reason is their confirmation.`,
  effects: ['status and category recorded on every row accepted'],
  args: {
    rule_id: f.text('Only this rule\'s suggestions, e.g. RL-0001. Omit for every waiting row.'),
    except: f.text('Rows to leave unreviewed, comma separated (T-0012, T-0015).'),
    reason: { ...f.text('Why: typically "confirmed by the person" plus anything they said.'), required: true },
  },
  handler(a, { db, at }) {
    if (a.rule_id) { const r = H.need('purch_rule', a.rule_id, 'rule'); if (r.state === 'ended') throw new Rejected(`${r.id} has ended, so it suggests nothing. Review its rows directly if they still need a word.`); }
    const skip = new Set(String(a.except || '').split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean));
    const rules = V.activeRules();
    const waiting = db.prepare("SELECT * FROM purch_transaction WHERE status = 'unreviewed' ORDER BY date, id").all()
      .map(t => ({ t, s: V.suggestionFor(t, rules) })).filter(x => x.s && (!a.rule_id || x.s.rule_id === a.rule_id));
    const take = waiting.filter(x => !skip.has(x.t.id.toUpperCase()));
    if (!take.length) throw new Rejected(waiting.length ? 'Every waiting row was left out with except; nothing to accept.'
      : a.rule_id ? `${a.rule_id} is suggesting nothing right now: no unreviewed row matches it.` : 'No row is waiting on a rule\'s suggestion.');
    const byRule = {};
    for (const { t, s } of take) {
      db.prepare('UPDATE purch_transaction SET status = ?, category = ?, reviewed_at = ? WHERE id = ?').run(s.status, s.category, at, t.id);
      byRule[s.rule_id] = (byRule[s.rule_id] || 0) + 1;
    }
    const left = db.prepare("SELECT COUNT(*) n FROM purch_transaction WHERE status = 'unreviewed'").get().n;
    return { reviewed: take.length, left_out: waiting.length - take.length, by_rule: byRule, rows: take.map(x => ({ id: x.t.id, date: x.t.date, description: x.t.description, status: x.s.status, category: x.s.category })),
      still_unreviewed: left, note: `${take.length} row${take.length > 1 ? 's' : ''} confirmed as the rules suggested.${left ? ` ${left} still unreviewed.` : ' Nothing left unreviewed.'}` };
  },
});

const read = (def) => defineCommand({ intent: 'read', scope: 'collection', group: 'Purchases read', ...def });
read({ name: 'purch_rules', title: 'Standing rules', summary: 'Rules the person set ahead of time, each with its window, what it suggests, and how many unreviewed rows it is suggesting for right now.',
  args: { include_ended: f.bool('Include rules that have ended.') }, handler: (a) => V.rules(a) });
read({ name: 'purch_get_rule', title: 'Standing rule', summary: 'One rule with the unreviewed rows it is suggesting for.', args: { rule_id: { ...f.text('e.g. RL-0001.'), required: true } }, handler: (a) => V.ruleView(a.rule_id) });
