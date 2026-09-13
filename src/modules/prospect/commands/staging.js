'use strict';
const R = require('../../../registry.js');
const { defineCommand, f, Rejected } = R;
const H = require('../../../db.js');
const V = require('../views.js');
// crm loads before prospect alphabetically, but requiring it at load time still couples the
// two modules' load order. Lazy: the account API is only needed inside a promotion.
const crm = () => (R.MODULES.find(m => m.name === 'crm') || {}).api;

const ROW = {
  company:     { ...f.text('Company name, exactly as the pull spells it.'), required: true },
  website:     f.text('Company URL, if the row carries one.'),
  industry:    f.text('The industry label the pull assigned. A label, not evidence.'),
  employees:   f.int('Headcount as the row states it.'),
  city:        f.text('City.'),
  state:       f.text('State or region.'),
  country:     f.text('Country.'),
  description: f.text('The seller\'s blurb, verbatim. Not your summary of it.'),
  row_index:   f.int('Position in the pull, from 1. Defaults to the order you hand them in.'),
  raw:         f.text('The line as you read it. Provenance.'),
};

defineCommand({
  name: 'pros_import_rows',
  permission: 'sales.write',
  title: 'Import a pull', group: 'Prospects', subject: 'pros_source', scope: 'collection',
  summary: 'Hand over one pulled list: what it was bought or scraped under, and its rows. These are not accounts and never become accounts here.',
  doctrine: `You read the file; this records it. Nothing here parses and nothing here qualifies.

CRITERIA IS MANDATORY AND IT IS THE POINT (PRO-2). Write the brief this pull was actually
made under: the size band, the geography, the industries asked for. A pull whose criteria
nobody wrote down cannot have its verdicts checked against anything afterwards, and rows
judged against a brief that was never stated are judged against your memory of it.

The same hash is refused twice (PRO-1). Rows whose company name is already staged, or already
an account, are skipped and listed back — say so to the person. The batch is accepted whole or
refused: if the file says a row count and you hand over a different number, re-read it.

Hand over the seller's own description verbatim rather than your summary of it. Your reading
of the row belongs in a verdict, where it is attributed to you and can be argued with.`,
  effects: ['pull recorded with its criteria', 'rows staged with provenance', 'duplicates skipped and listed'],
  args: {
    label:       { ...f.text('What this pull was, in your human\'s words — "Phoenix metro, 200-1000 staff".'), required: true },
    hash:        { ...f.text('Content hash of the file, or a stable id it carries (vendor + list id + date).'), required: true },
    criteria:    { ...f.note('The brief this pull was made under: size band, geography, industries asked for. Mandatory, and read later by whoever checks the verdicts.'), required: true },
    row_count:   { ...f.int('How many rows the file holds.'), required: true },
    rows:        { ...f.lines(ROW, 'Every row, in the file\'s order.'), required: true },
    campaign_id: f.ref('campaign', 'The campaign this pull was made for, if that is already decided.'),
  },
  handler(a, { db, at, actor }) {
    const hash = String(a.hash).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._:-]{7,79}$/.test(hash)) throw new Rejected('hash: 8–80 characters, letters, digits, . _ : - (a content hash, or the vendor list id plus date).');
    const dup = db.prepare('SELECT id, label, created_at FROM pros_source WHERE hash = ?').get(hash);
    if (dup) throw new Rejected(`This pull is already staged as ${dup.id} (${dup.label}, ${dup.created_at.slice(0, 10)}). The same list never lands twice (PRO-1).`);
    const rows = a.rows || [];
    if (!rows.length) throw new Rejected('A pull with no rows is not a pull.');
    if (rows.length !== a.row_count) throw new Rejected(`The file says ${a.row_count} rows; you handed over ${rows.length}. Re-read it and pass every row.`);
    if (String(a.criteria).trim().length < 12) throw new Rejected('criteria: write the actual brief this pull was made under (PRO-2). A word is not a brief.');
    if (a.campaign_id) H.need('campaign', a.campaign_id, 'campaign');
    rows.forEach((r, i) => { if (!String(r.company || '').trim()) throw new Rejected(`Row ${i + 1}: company is required. A row with no company is not a prospect.`); });

    const id = H.nextId('PUL', 'pros_source');
    db.prepare(`INSERT INTO pros_source (id,label,hash,criteria,campaign_id,row_count,rows_in,rows_skipped,imported_by,created_at)
                VALUES (?,?,?,?,?,?,0,0,?,?)`)
      .run(id, a.label, hash, String(a.criteria).trim(), a.campaign_id || null, a.row_count, actor || 'unknown', at);

    const staged = db.prepare('SELECT id, source_id FROM pros_row WHERE lower(company) = lower(?) LIMIT 1');
    const known = db.prepare('SELECT id FROM account WHERE lower(name) = lower(?) LIMIT 1');
    const skipped = []; let n = 0;
    rows.forEach((r, i) => {
      const idx = r.row_index || i + 1;
      const have = staged.get(r.company);
      if (have) { skipped.push({ row_index: idx, company: r.company, reason: `already staged as row ${have.id} in ${have.source_id}` }); return; }
      const acc = known.get(r.company);
      if (acc) { skipped.push({ row_index: idx, company: r.company, reason: `already an account (${acc.id})` }); return; }
      db.prepare(`INSERT INTO pros_row (source_id,row_index,company,website,industry,employees,city,state,country,description,raw,created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, idx, r.company, r.website || null, r.industry || null,
             Number.isInteger(r.employees) ? r.employees : null,
             r.city || null, r.state || null, r.country || null, r.description || null, r.raw || null, at);
      n++;
    });
    db.prepare('UPDATE pros_source SET rows_in = ?, rows_skipped = ? WHERE id = ?').run(n, skipped.length, id);
    return { pull: id, label: a.label, criteria: String(a.criteria).trim(), rows_in: n, rows_skipped: skipped.length, skipped,
      note: `${n} rows staged as ${id}.${skipped.length ? ` ${skipped.length} skipped (already staged or already accounts, listed).` : ''} They are accounts in no sense yet and appear in no pipeline. Judge them with pros_qualify; a person promotes what survives.` };
  },
});

defineCommand({
  name: 'pros_qualify',
  permission: 'sales.write',
  title: 'Qualify staged rows', group: 'Prospects', subject: 'pros_source', scope: 'collection',
  summary: 'Record a judgement on staged rows. Never creates an account. One row or a whole pull in a single call.',
  doctrine: `READ THE PULL'S CRITERIA FIRST (pros_sources). A verdict is a judgement against a
stated brief, not against your general sense of a good customer.

THE REASON IS THE PRODUCT (PRO-3). It is read by a person deciding whether to overrule you,
and by somebody months later asking why this company was dropped. "Hospitality, no desk-based
back office to measure" is useful. "Not a fit" is not, and is refused. Cite a source_url when
the answer came from the company's own site rather than the row.

AN INDUSTRY LABEL IS NOT EVIDENCE. The seller's label covers two different businesses more
often than not; read the description and the site before deciding.

USE "unclear" RATHER THAN GUESSING. If the row does not say what you need, that is a real
finding and leaves the row for a person. A confident wrong rejection is invisible: nobody ever
audits the companies that were dropped.

A bad row does not discard the rest — each is applied on its own and the response reports what
failed. Qualifying is not promoting: you cannot create an account from a bought list, and that
is deliberate (PRO-5).`,
  effects: ['verdicts recorded against staged rows, per row'],
  guardless: true,
  args: {
    verdicts: { ...f.lines({
      row_id:     { ...f.int('The staged row, from pros_rows.'), required: true },
      verdict:    { ...f.pick(V.VERDICTS, 'qualified, rejected, or unclear.'), required: true },
      reason:     { ...f.text('Why, in terms a person can overrule. Required on every one.'), required: true },
      source_url: f.text('Where the answer came from, when it came from outside the row.'),
    }, 'The judgements. One row is a batch of one; a whole metro is one pass.'), required: true },
  },
  handler(a, { db, at, actor }) {
    const list = a.verdicts || [];
    if (!list.length) throw new Rejected('No verdicts handed over.');
    if (list.length > 200) throw new Rejected(`${list.length} verdicts in one call; the cap is 200. Send them in pages.`);
    const applied = []; const failed = [];
    for (const v of list) {
      try {
        const row = db.prepare('SELECT * FROM pros_row WHERE id = ?').get(v.row_id);
        if (!row) throw new Rejected(`No staged row ${v.row_id}.`);
        if (row.account_id) throw new Rejected(`Row ${v.row_id} (${row.company}) was already promoted to ${row.account_id}. Judge the account, not the row it came from.`);
        if (!V.VERDICTS.includes(v.verdict)) throw new Rejected(`verdict must be one of ${V.VERDICTS.join(', ')}.`);
        const reason = String(v.reason || '').trim();
        if (reason.length < 12) throw new Rejected(`Row ${v.row_id}: the reason is the product (PRO-3). "${reason}" tells a person nothing and cannot be overruled.`);
        db.prepare('UPDATE pros_row SET verdict = ?, verdict_reason = ?, verdict_source_url = ?, verdict_by = ?, verdict_at = ? WHERE id = ?')
          .run(v.verdict, reason, v.source_url || null, actor || 'unknown', at, v.row_id);
        applied.push({ row_id: v.row_id, company: row.company, verdict: v.verdict });
      } catch (e) { failed.push({ row_id: v.row_id, error: e.message }); }
    }
    const q = applied.filter(x => x.verdict === 'qualified').length;
    return { applied: applied.length, failed: failed.length, verdicts: applied, errors: failed,
      note: `${applied.length} judged${failed.length ? `, ${failed.length} refused (listed)` : ''}. ${q ? `${q} qualified and now await a person: promotion is pros_promote, and an agent cannot call it.` : 'Nothing qualified in this batch.'}` };
  },
});

defineCommand({
  name: 'pros_promote',
  permission: 'sales.write',
  human_only: 'the curated list is the asset, and an agent that could fill it from a bought list would empty the curation of meaning.',
  title: 'Promote to accounts', group: 'Prospects', subject: 'pros_source', scope: 'collection',
  summary: 'Turn qualified staged rows into real accounts under a campaign. A person\'s act, always.',
  doctrine: `This is the door between a bought list and a curated one, and it opens from one
side only. An agent may stage rows and judge them; a person decides which become accounts.

Only rows with a 'qualified' verdict promote. Each becomes an account carrying the verdict's
reason as its why_them and the row's own source as its source_url, so the account arrives with
the provenance CRM-3 demands rather than an invented justification. Read the verdicts first:
promoting is agreeing with them.

A row promotes once. What it became is recorded on the row, so the pull keeps saying what came
of it long after the rows stop mattering.`,
  effects: ['crm accounts created from qualified rows', 'rows marked promoted with the account they became'],
  guardless: true,
  args: {
    campaign_id: { ...f.ref('campaign', 'The campaign these accounts pursue.'), required: true },
    row_ids:     { ...f.lines({ row_id: { ...f.int('A qualified staged row.'), required: true } }, 'The rows to promote.'), required: true },
    tier:        f.int('Tier for the new accounts, if they share one.'),
  },
  handler(a, { db, at }) {
    H.need('campaign', a.campaign_id, 'campaign');
    const ids = (a.row_ids || []).map(r => r.row_id);
    if (!ids.length) throw new Rejected('No rows handed over.');
    const made = []; const failed = [];
    for (const rid of ids) {
      try {
        const row = db.prepare('SELECT * FROM pros_row WHERE id = ?').get(rid);
        if (!row) throw new Rejected(`No staged row ${rid}.`);
        if (row.account_id) throw new Rejected(`Row ${rid} (${row.company}) is already account ${row.account_id}.`);
        if (row.verdict !== 'qualified') throw new Rejected(`Row ${rid} (${row.company}) is ${row.verdict || 'unjudged'}, not qualified. Judge it first, or leave it.`);
        const acc = crm().createAccount(db, {
          campaign_id: a.campaign_id, name: row.company, tier: a.tier,
          why_them: row.verdict_reason,
          source_url: row.verdict_source_url || row.website || `staged row ${row.id} of ${row.source_id}`,
          owner_note: `Promoted from ${row.source_id} row ${row.row_index}.`,
        }, at);
        db.prepare('UPDATE pros_row SET account_id = ?, promoted_by = ?, promoted_at = ? WHERE id = ?')
          .run(acc.id, 'human', at, rid);
        made.push({ row_id: rid, company: row.company, account_id: acc.id });
      } catch (e) { failed.push({ row_id: rid, error: e.message }); }
    }
    return { promoted: made.length, failed: failed.length, accounts: made, errors: failed,
      note: `${made.length} account${made.length === 1 ? '' : 's'} created under ${a.campaign_id}${failed.length ? `; ${failed.length} refused (listed)` : ''}. They are in the pipeline from now on.` };
  },
});

defineCommand({
  name: 'pros_discard_pull',
  permission: 'workspace.admin',
  title: 'Discard a pull', group: 'Prospects', subject: 'pros_source',
  summary: 'Throw out one staged pull and every unpromoted row from it, with a reason, so it can be re-read and staged again.',
  doctrine: `A wrong pull means a wrong file: staged rows are never edited, the pull is
discarded and handed over again from a fresh read. Rows that already became accounts are NOT
removed and are listed back — an account is a real thing now and deleting the row behind it
would leave the account with no provenance. The hash is free again afterwards.`,
  effects: ['pull and its unpromoted rows deleted', 'promoted rows kept and listed', 'hash free to stage again'],
  guards: [ () => true ],
  args: {
    source_id: { ...f.text('The pull, e.g. PUL-0001.'), required: true },
    reason:    { ...f.text('Why — the wrong file, a misread column, a re-pull.'), required: true },
  },
  handler(a, { db }) {
    const s = H.need('pros_source', a.source_id, 'pull');
    const kept = db.prepare('SELECT id, company, account_id FROM pros_row WHERE source_id = ? AND account_id IS NOT NULL').all(s.id);
    const gone = db.prepare('DELETE FROM pros_row WHERE source_id = ? AND account_id IS NULL').run(s.id).changes;
    if (!kept.length) db.prepare('DELETE FROM pros_source WHERE id = ?').run(s.id);
    return { discarded: s.id, label: s.label, hash: s.hash, rows_removed: gone,
      rows_kept: kept.map(r => ({ company: r.company, account_id: r.account_id })),
      note: kept.length
        ? `${gone} unjudged or unpromoted rows removed from ${s.label}. ${kept.length} already became accounts and stay, with the pull, so those accounts keep their provenance.`
        : `${s.label} discarded with ${gone} rows. Stage it again from a fresh read; the hash ${s.hash} is free.` };
  },
});
