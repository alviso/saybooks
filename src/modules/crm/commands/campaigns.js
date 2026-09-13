'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

// Why the claim lists are a person's to write, said once and shown on both fields.
const CLAIM_WHY = "what this business may assert about itself is the business's decision, not an agent's. An agent choosing which claims it is allowed to make is the check marking its own homework (CRM-17).";

defineCommand({
  name: 'crm_create_campaign',
  title: 'New campaign', group: 'CRM', subject: 'campaign', scope: 'collection',
  permission: 'sales.write',
  summary: 'Open a campaign: a named goal that accounts will be pursued under.',
  doctrine: `The goal is required (CRM-13) and it is not a label — it is the brief. A research
session reads it before adding a single account, and every account's why_them must argue
against it. A campaign without a stated thesis is a folder, not a pursuit.

Check crm_campaigns before creating: if an existing goal covers the ask, work under it. When
you (an agent) open a NEW campaign, derive the goal from what your human asked for and confirm
it with them before filling the list — the goal decides what belongs.`,
  effects: ['campaign created as active'],
  args: {
    name: { ...f.text('Short name, e.g. "Craft brewery expansion Q3".'), required: true },
    goal: { ...f.note('The thesis: who qualifies, why now, what winning looks like. Agents will read this verbatim.'), required: true },
    target_profile: f.note('Optional sharpening: the shape of a qualifying company.'),
  },
  handler(a, { db, at }) {
    if (db.prepare('SELECT id FROM campaign WHERE lower(name) = lower(?)').get(a.name)) {
      throw new Rejected(`A campaign named ${a.name} already exists.`);
    }
    const id = H.nextId('CAM', 'campaign');
    db.prepare('INSERT INTO campaign (id,name,goal,target_profile,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, a.name, a.goal, a.target_profile || null, 'active', at, at);
    return V.campaignView(id);
  },
});

defineCommand({
  name: 'crm_update_campaign',
  title: 'Update campaign', group: 'CRM', subject: 'campaign',
  permission: 'sales.write', guardless: true,
  summary: 'Sharpen a campaign. The goal can be corrected, never blanked.',
  doctrine: `Same rule as provenance (CRM-9 in spirit): the goal is load-bearing — sharpen it
freely, remove it never.

CLAIMS ARE HUMAN-ONLY (CRM-17). claims_allowed is what this business has decided it may say
about itself; claims_refused is the words and phrases no draft on this campaign may contain.
Both are typed by a person, and both replace the previous list whole. Agents read them before
drafting (crm_get_campaign) and are refused at write time by the second list, but the gate
cannot catch an overstatement of a claim that is itself allowed — so a draft has to stay
inside what the claim actually says, not merely mention the same subject.`,
  effects: ['campaign updated', 'claim lists replaced when passed'],
  args: {
    campaign_id: { ...f.ref('campaign', 'The campaign.'), required: true },
    name: f.text(''),
    goal: f.note('Correcting, not blanking.'),
    target_profile: f.note(''),
    claims_allowed: { ...f.lines({
      text: { ...f.text('The claim, worded as it may be put.'), required: true },
      note: f.text('Where it was cleared, or what it must not be stretched into.'),
    }, 'What a draft on this campaign may assert. Replaces the list whole; empty list clears it.'), human_only: CLAIM_WHY },
    claims_refused: { ...f.lines({
      text: { ...f.text('A word or phrase no draft may contain. Matched case-insensitively anywhere in the text.'), required: true },
      note: f.text('Why, in the refusal an agent will read.'),
    }, 'What no draft on this campaign may say. Replaces the list whole; empty list clears it.'), human_only: CLAIM_WHY },
  },
  handler(a, ctx) {
    const { db, at } = ctx;
    H.need('campaign', a.campaign_id, 'campaign');
    if (a.goal === '') throw new Rejected('The goal can be sharpened, never removed (CRM-13).');
    if (a.name === '') throw new Rejected('A campaign keeps its name.');
    for (const k of ['name', 'goal', 'target_profile']) {
      if (a[k] !== undefined) db.prepare(`UPDATE campaign SET ${k} = ?, updated_at = ? WHERE id = ?`).run(a[k] === '' ? null : a[k], at, a.campaign_id);
    }
    for (const [arg, kind] of [['claims_allowed', 'allowed'], ['claims_refused', 'refused']]) {
      if (a[arg] === undefined) continue;
      db.prepare('DELETE FROM campaign_claim WHERE campaign_id = ? AND kind = ?').run(a.campaign_id, kind);
      for (const c of a[arg] || []) {
        const text = String(c.text || '').trim();
        if (!text) throw new Rejected(`${arg}: an empty ${kind} claim says nothing.`);
        db.prepare('INSERT INTO campaign_claim (campaign_id,kind,text,note,added_by,created_at) VALUES (?,?,?,?,?,?)')
          .run(a.campaign_id, kind, text, c.note || null, ctx.actor || 'unknown', at);
      }
    }
    return V.campaignView(a.campaign_id);
  },
});

defineCommand({
  name: 'crm_set_campaign_status',
  title: 'Campaign status', group: 'CRM', subject: 'campaign',
  permission: 'sales.write',
  summary: 'Pause, resume or conclude a campaign.',
  doctrine: `Pausing and concluding require a reason — a goal someone stops pursuing is a
decision that gets asked about later (CRM-7 extended). Concluded is terminal: the accounts
stay fully readable (CRM-6), but the campaign takes no new targets.`,
  effects: ['campaign.status moved, reason kept'],
  guards: [ (c) => c.status !== 'concluded' || 'Concluded is final — the record stays; a new pursuit is a new campaign.' ],
  args: {
    campaign_id: { ...f.ref('campaign', 'The campaign.'), required: true },
    status: { ...f.pick(['active', 'paused', 'concluded'], 'Where it moves.'), required: true },
    reason: f.note('Required for paused and concluded.'),
  },
  handler(a, { db, at }) {
    const c = H.need('campaign', a.campaign_id, 'campaign');
    if (c.status === 'concluded') throw new Rejected('Concluded is final — the record stays; a new pursuit is a new campaign.');
    if (['paused', 'concluded'].includes(a.status) && !a.reason) {
      throw new Rejected(`Moving to ${a.status} requires a reason — a goal someone stops pursuing is a decision that gets asked about later (CRM-7).`);
    }
    db.prepare('UPDATE campaign SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?')
      .run(a.status, a.reason || null, at, a.campaign_id);
    return V.campaignView(a.campaign_id);
  },
});
