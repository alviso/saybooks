'use strict';
/** jobhunt read models — including the two signature pieces ported from huntctrl:
 *  the duplicate guard (JH-3/JH-5) and the due list (JH-6/JH-7). */
const H = require('../../db.js');
const { db, need, get } = H;

const cfg = (k, d) => Number((db().prepare('SELECT value FROM hunt_config WHERE key = ?').get(k) || {}).value ?? d);
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
// Tokens with no discriminating power in a job title: seniority prefixes and the role nouns
// that appear in nearly everything. (Short domain tags like "sap" already fall to the >3 filter.)
const TITLE_STOP = new Set(['senior', 'junior', 'lead', 'staff', 'principal', 'chief', 'head',
  'developer', 'engineer', 'engineering', 'architect', 'consultant', 'manager', 'analyst',
  'specialist', 'administrator', 'director', 'coordinator', 'technician', 'associate',
  'technical', 'solution', 'solutions', 'software', 'professional']);
const toks = (s) => norm(s).split(' ').filter(w => w.length > 3 && !TITLE_STOP.has(w));

/** The guard: same req id, same end client + similar title, or same URL. Returns warnings
 *  to SURFACE — never to act on (JH-3). */
const normJd = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// Sentence set for fuzzy JD comparison: reordering and reheading survive, boilerplate headers
// (< 30 chars) fall out. Overlap is measured against the SMALLER set, so an added section
// cannot dilute a reformatted copy's score.
const jdSentences = (s) => new Set((s || '').toLowerCase().split(/[.\n•;]+/)
  .map(x => x.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(x => x.length >= 30));

function duplicateWarnings({ title, end_client_id, company_id, req_id, url, jd_text, exclude_id }) {
  const warnings = [];
  const rows = db().prepare('SELECT p.*, ec.name AS end_client_name, c.name AS company_name FROM hunt_posting p LEFT JOIN hunt_company ec ON ec.id = p.end_client_id JOIN hunt_company c ON c.id = p.company_id').all()
    .filter(p => p.id !== exclude_id);
  // For a direct posting the company IS the end client — the guard falls back to it on both
  // sides (JH-3), otherwise same-title-same-employer sails through whenever req and url are null.
  const candidateEC = end_client_id || company_id || null;
  for (const p of rows) {
    if (req_id && p.req_id && norm(p.req_id) === norm(req_id)) {
      warnings.push(`${p.id} (${p.title} via ${p.company_name}) carries the same req id ${p.req_id} — same requisition; applying to both risks a double submission.`);
      continue;
    }
    if (url && p.url && p.url === url) { warnings.push(`${p.id} has the same URL.`); continue; }
    // Identical body under a different title is the STRONGEST duplicate signal — agencies
    // retitle the same req routinely, and title similarity misses exactly those.
    if (jd_text && p.jd_text) {
      const ja = normJd(jd_text), jb = normJd(p.jd_text);
      if (ja.length >= 200 && jb.length >= 200 && (ja === jb || ja.includes(jb) || jb.includes(ja))) {
        warnings.push(`${p.id} (${p.title} via ${p.company_name}) carries a matching job description under a different title — retitled same req; applying to both risks a double submission.`);
        continue;
      }
      // Reordered into another agency's template: same sentences, new headings, maybe a typo
      // fixed. High-bar sentence overlap, and the warning STATES its evidence — "shares 85%"
      // reads differently from "matching", and the person weighs it (JH-3).
      const A = jdSentences(jd_text), B = jdSentences(p.jd_text);
      if (A.size >= 5 && B.size >= 5) {
        const [small, big] = A.size <= B.size ? [A, B] : [B, A];
        let hit = 0; for (const x of small) if (big.has(x)) hit++;
        const ratio = hit / small.size;
        if (ratio >= 0.8) {
          warnings.push(`${p.id} (${p.title} via ${p.company_name}) shares ${hit} of ${small.size} description sentences (${Math.round(ratio * 100)}%) — likely the same req reformatted into another template; weigh it before applying (JH-3).`);
          continue;
        }
      }
    }
    const postingEC = p.end_client_id || p.company_id;
    if (candidateEC && postingEC === candidateEC) {
      const a = norm(title), b = norm(p.title);
      // Similarity counts only tokens that discriminate: seniority prefixes and ubiquitous
      // role nouns describe nearly every title in a focused hunt, and counting them makes
      // the guard fire on most same-employer pairs — which teaches people to stop reading it.
      const ta = toks(title), tb = toks(p.title);
      const shared = ta.filter(w => tb.includes(w));
      const overlap = a && b && (a.includes(b) || b.includes(a)
        || shared.length >= 2
        || (shared.length >= 1 && (shared.length === ta.length || shared.length === tb.length))
        || (ta.length === 0 && tb.length === 0 && a.split(' ').filter(w => w.length > 3 && b.includes(w)).length >= 1));
      const label = (end_client_id && p.end_client_id) ? 'end client' : 'employer';
      if (overlap) warnings.push(`${p.id} (${p.title} via ${p.company_name}) targets the same ${label} with a similar title — likely the same role through another door.`);
    }
  }
  return warnings;
}

const openAction = (postingId) => db().prepare(
  "SELECT * FROM hunt_interaction WHERE posting_id = ? AND next_action_state = 'open' LIMIT 1").get(postingId);

function postingView(id) {
  const p = need('hunt_posting', id, 'posting');
  const app = db().prepare('SELECT * FROM hunt_application WHERE posting_id = ?').get(id);
  return {
    ...p,
    // The posting keeps its own lifecycle (lead|evaluated|skipped|applied — guards read it);
    // stage is the DERIVED truth a reader wants: the application's state once one exists.
    stage: app ? app.status : p.status,
    company_name: get('hunt_company', p.company_id).name,
    end_client_name: p.end_client_id ? get('hunt_company', p.end_client_id).name : null,
    resume_version_label: p.resume_version_id ? (get('hunt_resume_version', p.resume_version_id) || {}).label : null,
    application: app ? { ...app, interviews: db().prepare('SELECT * FROM hunt_interview WHERE application_id = ? ORDER BY round').all(app.id) } : null,
    interactions: db().prepare('SELECT * FROM hunt_interaction WHERE posting_id = ? ORDER BY at DESC LIMIT 30').all(id),
    open_next_action: (openAction(id) || {}).next_action || null,
  };
}

const pipeline = (status) => db().prepare(`
  SELECT p.id, p.title, p.status AS posting_status, p.fit_score, c.name AS company_name, ec.name AS end_client_name,
         a.id AS application_id, a.status AS app_status, a.applied_at,
         (SELECT MAX(at) FROM hunt_interaction i WHERE i.posting_id = p.id) AS last_touch,
         (SELECT next_action FROM hunt_interaction i WHERE i.posting_id = p.id AND i.next_action_state = 'open') AS open_next_action,
         (SELECT next_action_due FROM hunt_interaction i WHERE i.posting_id = p.id AND i.next_action_state = 'open') AS next_action_due
  FROM hunt_posting p JOIN hunt_company c ON c.id = p.company_id
  LEFT JOIN hunt_company ec ON ec.id = p.end_client_id
  LEFT JOIN hunt_application a ON a.posting_id = p.id
  WHERE (? IS NULL OR p.status = ? OR a.status = ?)
    AND (? IS NOT NULL OR (p.status <> 'skipped' AND (a.status IS NULL OR a.status NOT IN ('accepted','rejected','withdrawn','ghosted'))))
  ORDER BY a.status IS NULL, p.updated_at DESC`).all(status || null, status || null, status || null, status || null);

/** The daily view (JH-7: it suggests; nothing here sends anything). */
function due(horizonDays = 7) {
  const today = H.today();
  const horizon = H.addDays(today, horizonDays);
  const followUp = cfg('follow_up_days', 5), ghost = cfg('ghost_days', 21), stale = cfg('stale_days', 14);
  const open = db().prepare(`
    SELECT i.*, p.title, c.name AS company_name FROM hunt_interaction i
    JOIN hunt_posting p ON p.id = i.posting_id JOIN hunt_company c ON c.id = p.company_id
    WHERE i.next_action_state = 'open' ORDER BY i.next_action_due`).all();
  const active = db().prepare(`
    SELECT a.id, a.status, p.id AS posting_id, p.title, c.name AS company_name,
      (SELECT MAX(at) FROM hunt_interaction i WHERE i.posting_id = p.id AND i.direction = 'out') AS last_out,
      (SELECT MAX(at) FROM hunt_interaction i WHERE i.posting_id = p.id AND i.direction = 'in') AS last_in
    FROM hunt_application a JOIN hunt_posting p ON p.id = a.posting_id JOIN hunt_company c ON c.id = p.company_id
    WHERE a.status IN ('submitted','screening','interviewing','offer')`).all();
  const days = (d) => d ? Math.floor((Date.parse(today) - Date.parse(String(d).slice(0, 10))) / 864e5) : null;
  return {
    overdue: open.filter(i => i.next_action_due && i.next_action_due < today),
    upcoming: open.filter(i => !i.next_action_due || (i.next_action_due >= today && i.next_action_due <= horizon)),
    open_actions_count: open.length,
    nudges: active.filter(a => { const dl = days(a.last_out ?? a.last_in); return dl !== null && dl >= followUp && (days(a.last_in) === null || days(a.last_in) >= followUp); })
      .map(a => ({ ...a, days_quiet: days(a.last_in ?? a.last_out) })),
    suggest_ghosted: active.filter(a => {
      if (!['submitted', 'screening'].includes(a.status)) return false;
      const latest = [a.last_in, a.last_out].filter(Boolean).sort().pop();
      const dl = days(latest);
      return dl !== null && dl >= ghost;
    }).map(a => ({ ...a, days_silent: days([a.last_in, a.last_out].filter(Boolean).sort().pop()) })),
    stale_leads: db().prepare(`SELECT p.id, p.title, c.name AS company_name, p.updated_at FROM hunt_posting p JOIN hunt_company c ON c.id = p.company_id
      WHERE p.status IN ('lead','evaluated') AND julianday('now') - julianday(p.updated_at) > ?`).all(stale),
    missing_end_client: db().prepare(`SELECT p.id, p.title, c.name AS company_name FROM hunt_posting p JOIN hunt_company c ON c.id = p.company_id
      WHERE p.end_client_id IS NULL AND c.kind IN ('staffing_agency','consultancy','rpo') AND p.status <> 'skipped'`).all(),
    missing_end_client_count: db().prepare(`SELECT COUNT(*) n FROM hunt_posting p JOIN hunt_company c ON c.id = p.company_id
      WHERE p.end_client_id IS NULL AND c.kind IN ('staffing_agency','consultancy','rpo') AND p.status <> 'skipped'`).get().n,
    upcoming_interviews: db().prepare(`SELECT iv.*, p.title, c.name AS company_name FROM hunt_interview iv
      JOIN hunt_application a ON a.id = iv.application_id JOIN hunt_posting p ON p.id = a.posting_id JOIN hunt_company c ON c.id = p.company_id
      WHERE iv.outcome = 'pending' ORDER BY iv.scheduled_at`).all(),
  };
}

const contacts = (relationship) => db().prepare(`
  SELECT hc.*, co.name AS company_name,
    (SELECT MAX(at) FROM hunt_interaction i WHERE i.contact_id = hc.id) AS last_touch
  FROM hunt_contact hc LEFT JOIN hunt_company co ON co.id = hc.company_id
  WHERE (? IS NULL OR hc.relationship = ?) ORDER BY hc.name`).all(relationship || null, relationship || null);

const resumeVersions = () => db().prepare(`
  SELECT rv.*, (SELECT COUNT(*) FROM hunt_application a WHERE a.resume_version_id = rv.id) AS applications
  FROM hunt_resume_version rv ORDER BY rv.created_at`).all();

function contactView(id) {
  const r = need('hunt_contact', id, 'contact');
  const interactions = db().prepare(`
    SELECT i.*, p.title, c.name AS company_name FROM hunt_interaction i
    LEFT JOIN hunt_posting p ON p.id = i.posting_id LEFT JOIN hunt_company c ON c.id = p.company_id
    WHERE i.contact_id = ? ORDER BY i.at DESC LIMIT 50`).all(id);
  const postings = db().prepare(`
    SELECT DISTINCT p.id, p.title, p.status AS posting_status, c.name AS company_name, a.status AS app_status
    FROM hunt_posting p JOIN hunt_company c ON c.id = p.company_id
    LEFT JOIN hunt_application a ON a.posting_id = p.id
    WHERE p.id IN (SELECT posting_id FROM hunt_interaction WHERE contact_id = ? AND posting_id IS NOT NULL)
       OR a.via_contact_id = ?
    ORDER BY p.updated_at DESC`).all(id, id);
  return {
    ...r, status: r.relationship,
    company_name: r.company_id ? (get('hunt_company', r.company_id) || {}).name : null,
    postings, interactions,
    last_touch: interactions.length ? interactions[0].at : null,
  };
}

function resumeView(id) {
  const rv = need('hunt_resume_version', id, 'resume version');
  const applications = db().prepare(`
    SELECT a.id, a.status, a.applied_at, a.channel, p.id AS posting_id, p.title, c.name AS company_name
    FROM hunt_application a JOIN hunt_posting p ON p.id = a.posting_id JOIN hunt_company c ON c.id = p.company_id
    WHERE a.resume_version_id = ? ORDER BY a.created_at DESC`).all(id);
  const planned = db().prepare(`
    SELECT p.id, p.title, p.status AS posting_status, c.name AS company_name
    FROM hunt_posting p JOIN hunt_company c ON c.id = p.company_id
    WHERE p.resume_version_id = ?
      AND p.id NOT IN (SELECT posting_id FROM hunt_application WHERE resume_version_id = ?)
    ORDER BY p.updated_at DESC`).all(id, id);
  return { ...rv, name: rv.label, applications, planned };
}

/** Companies are created implicitly by name — one door, like core.adjustStock. */
function ensureCompany(dbh, name, kind, at) {
  const hit = dbh.prepare('SELECT * FROM hunt_company WHERE lower(name) = lower(?)').get(name);
  if (hit) return hit;
  const id = H.nextId('CO', 'hunt_company');
  dbh.prepare('INSERT INTO hunt_company (id,name,kind,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, name, kind || null, at, at);
  return get('hunt_company', id);
}

/** The closest JD in the book by sentence overlap — evidence for a person, not a verdict.
 *  A 74% near-miss the guard stays silent on is exactly the thing worth seeing. */
function closestJd(jd_text, excludeId) {
  const A = jdSentences(jd_text);
  if (A.size < 5) return null;
  let best = null;
  const rows = db().prepare("SELECT p.id, p.title, c.name AS company_name, p.jd_text FROM hunt_posting p JOIN hunt_company c ON c.id = p.company_id WHERE p.jd_text IS NOT NULL AND p.jd_text <> ''").all();
  for (const r of rows) {
    if (r.id === excludeId) continue;
    const B = jdSentences(r.jd_text);
    if (B.size < 5) continue;
    const [small, big] = A.size <= B.size ? [A, B] : [B, A];
    let hit = 0; for (const x of small) if (big.has(x)) hit++;
    const ratio = hit / small.size;
    if (!best || ratio > best.overlap) best = { posting_id: r.id, title: r.title, company: r.company_name, shared_sentences: hit, of: small.size, overlap: +ratio.toFixed(2) };
  }
  return best;
}

module.exports = { duplicateWarnings, closestJd, openAction, postingView, contactView, resumeView, pipeline, due, contacts, resumeVersions, ensureCompany, cfg };
