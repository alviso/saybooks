'use strict';
const { defineCommand, f, Rejected } = require('../../../registry.js');
const H = require('../../../db.js');
const V = require('../views.js');

const HUMAN_WHY = 'automating the relationship graph risks the human relationships (and accounts) this work depends on (CRM-4).';

defineCommand({
  name: 'crm_add_contact',
  title: 'Add contact', group: 'CRM', subject: 'account',
  permission: 'sales.write',
  summary: 'Record a person at an account — named with a source, or as a gap.',
  doctrine: `Two shapes, nothing in between (CRM-1, CRM-2). Named: name + source required — a
name without a source is not usable in a first approach, so it is refused, not warned about.
Gap: no name, gap_note required — the role exists and its holder is not publicly known, and
that absence is a finding worth recording. Guessing is the only real failure here.`,
  effects: ['contact created as named or gap'],
  guards: [ (acc) => acc.status !== 'excluded' || 'This account was deliberately excluded — its reason says why; adding people to it is not pursuit, it is drift.' ],
  args: {
    account_id: { ...f.ref('account', 'The account.'), required: true },
    role_type:  { ...f.text('The role in the deal: OPERATIONS OWNER, ECONOMIC SPONSOR, SECURITY GATE…'), required: true },
    name:  f.text('The person — only with a source.'),
    title: f.text('Their title, as the source states it.'),
    source: f.text('Where the name comes from. Mandatory for a named contact.'),
    confidence_note: f.text('How sure, and of what: "high on the person, medium on the exact title".'),
    linkedin_url: f.text("The person's public LinkedIn profile URL — a sourced fact, fine for an agent to record. The connection-path fields are a different matter."),
    email: f.text('As publicly listed or personally shared — the source covers it like everything else (CRM-1).'),
    phone: f.text('Same rule as email: listed or shared, never scraped from a paid enrichment dump without saying so.'),
    gap_note: f.note('For a gap: what is missing and what it would take to find out.'),
    notes: f.note('Working notes.'),
  },
  handler(a, { db, at }) {
    const acc = H.need('account', a.account_id, 'account');
    if (acc.status === 'excluded') throw new Rejected('This account was deliberately excluded — its reason says why; adding people to it is not pursuit, it is drift.');
    let status;
    if (a.name) {
      if (!a.source) throw new Rejected('A name without a source is not usable in a first approach — record the source, or record a gap (CRM-1).');
      status = 'named';
    } else {
      if (!a.gap_note) throw new Rejected('A gap needs a gap_note: what is missing, and what it would take to find out (CRM-2).');
      status = 'gap';
    }
    const id = H.nextId('P', 'contact');
    db.prepare(`INSERT INTO contact (id,account_id,role_type,status,name,title,source,confidence_note,linkedin_url,email,phone,gap_note,notes,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, a.account_id, a.role_type, status, a.name || null, a.title || null, a.source || null,
           a.confidence_note || null, a.linkedin_url || null, a.email || null, a.phone || null, a.gap_note || null, a.notes || null, at, at);
    return V.contactView(id);
  },
});

defineCommand({
  name: 'crm_resolve_gap',
  title: 'Resolve gap', group: 'CRM', subject: 'crm_contact',
  permission: 'sales.write',
  summary: 'Turn a gap into a named contact — with full provenance.',
  doctrine: 'The only way a gap becomes named (CRM-2), and it demands the same provenance as a fresh contact — the gap does not lower the bar. The gap_note stays on the row: what we did not know is part of how we came to know it.',
  effects: ['contact gap -> named'],
  guards: [ (c) => c.status === 'gap' || 'This contact is not a gap — correct it with an update instead.' ],
  args: {
    contact_id: { ...f.text('The gap row, e.g. P-0002.'), required: true },
    name:   { ...f.text('The person.'), required: true },
    source: { ...f.text('Where the name comes from (CRM-1).'), required: true },
    title:  f.text('Their title, as the source states it.'),
    confidence_note: f.text('How sure, and of what.'),
    linkedin_url: f.text("The person's public LinkedIn profile URL, if the source includes one."),
    email: f.text('As publicly listed or personally shared, if the source includes one.'),
    phone: f.text('Same rule as email.'),
  },
  handler(a, { db, at }) {
    const c = H.need('contact', a.contact_id, 'contact');
    if (c.status !== 'gap') throw new Rejected('This contact is not a gap — correct it with an update instead.');
    db.prepare(`UPDATE contact SET status='named', name=?, title=?, source=?, confidence_note=?, linkedin_url=?, email=?, phone=?, updated_at=? WHERE id = ?`)
      .run(a.name, a.title || null, a.source, a.confidence_note || null, a.linkedin_url || null, a.email || null, a.phone || null, at, a.contact_id);
    return V.contactView(a.contact_id);
  },
});

defineCommand({
  name: 'crm_update_contact',
  title: 'Update contact', group: 'CRM', subject: 'crm_contact',
  permission: 'sales.write', guardless: true,
  summary: 'Correct or extend a contact. The relationship-graph fields are human-only.',
  doctrine: `Ordinary fields are open: titles change, confidence firms up, people depart
(status=departed — never deleted, CRM-6). Provenance is correctable, never removable (CRM-9).
mutual_via, mutual_url and linkedin_path are entered by a person, never an agent — ask your
human to fill them in; that is correct behavior, not a limitation to route around.`,
  effects: ['contact updated'],
  args: {
    contact_id: { ...f.text('The contact, e.g. P-0001.'), required: true },
    name: f.text('Correcting a name still requires the source to cover it.'),
    title: f.text(''),
    source: f.text('Correctable, never removable (CRM-9).'),
    confidence_note: f.text(''),
    status: f.pick(['named', 'departed'], 'departed keeps the row and the history.'),
    linkedin_url: f.text("The person's public LinkedIn profile URL."),
    email: f.text('As publicly listed or personally shared.'),
    phone: f.text('Same rule as email.'),
    notes: f.note(''),
    mutual_via:    { ...f.text('Who the mutual connection is.'), human_only: HUMAN_WHY },
    mutual_url:    { ...f.text('Link to the mutual, from your own account.'), human_only: HUMAN_WHY },
    linkedin_path: { ...f.text('e.g. "2nd via Alex M." — read off your own LinkedIn.'), human_only: HUMAN_WHY },
  },
  handler(a, { db, at }) {
    const c = H.need('contact', a.contact_id, 'contact');
    if (a.source === '') throw new Rejected('source can be corrected, never removed (CRM-9).');
    if (a.status && c.status === 'gap') throw new Rejected('A gap becomes named only through resolve_gap (CRM-2).');
    if (a.name === '') throw new Rejected('A named contact keeps a name — mark them departed instead of blanking them (CRM-6).');
    const fields = ['name', 'title', 'source', 'confidence_note', 'status', 'linkedin_url', 'email', 'phone', 'notes', 'mutual_via', 'mutual_url', 'linkedin_path'];
    // An explicit empty string means CLEAR (stored as NULL); absent means untouched.
    for (const k of fields) if (a[k] !== undefined) db.prepare(`UPDATE contact SET ${k} = ?, updated_at = ? WHERE id = ?`).run(a[k] === '' ? null : a[k], at, a.contact_id);
    return V.contactView(a.contact_id);
  },
});
