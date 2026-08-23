'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

defineCommand({
  name: 'crm_create_campaign',
  title: 'New campaign', group: 'CRM', subject: 'campaign', scope: 'collection',
  permission: 'sales.write',
  summary: 'Open a campaign: a named goal that accounts will be pursued under.',
  doctrine: `The goal is required (CRM-13) and it is not a label — it is the brief. A research
session reads it before adding a single account, and every account's why_them must argue
against it. A campaign without a stated thesis is a folder, not a pursuit.`,
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
  doctrine: 'Same rule as provenance (CRM-9 in spirit): the goal is load-bearing — sharpen it freely, remove it never.',
  effects: ['campaign updated'],
  args: {
    campaign_id: { ...f.ref('campaign', 'The campaign.'), required: true },
    name: f.text(''),
    goal: f.note('Correcting, not blanking.'),
    target_profile: f.note(''),
  },
  handler(a, { db, at }) {
    H.need('campaign', a.campaign_id, 'campaign');
    if (a.goal === '') throw new Rejected('The goal can be sharpened, never removed (CRM-13).');
    if (a.name === '') throw new Rejected('A campaign keeps its name.');
    for (const k of ['name', 'goal', 'target_profile']) {
      if (a[k] !== undefined) db.prepare(`UPDATE campaign SET ${k} = ?, updated_at = ? WHERE id = ?`).run(a[k] === '' ? null : a[k], at, a.campaign_id);
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
