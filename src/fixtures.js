'use strict';
/**
 * Fixtures are command scripts, not SQL dumps: a JSON array of [command, args, reason?]
 * replayed through execute(). Same registry, same guards, same audit trail — a seeded
 * workspace is indistinguishable from one built by hand, because it was built the same way.
 * That also means a fixture that violates a business rule fails loudly instead of planting
 * impossible state for someone to debug later.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'fixtures');

function load(name, workspace, opts = {}) {
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`invalid fixture name ${name}`);
  const file = path.join(DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`no fixture ${name} — available: ${fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).join(', ') || 'none'}`);
  const steps = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { execute, byName } = require('./registry.js');
  // A space that carries only some modules replays only their steps (core always).
  const allow = opts.mounts ? new Set(['core', ...opts.mounts]) : null;
  const H = require('./db.js');
  // Dates relative to the day the fixture is loaded, so sample books stay current: "{{today}}",
  // "{{today-12}}", "{{today+30}}". A seventh element, "-45d", runs that step as if it were that
  // many days ago (an invoice issued six weeks back is overdue today, as it would be for real).
  const realToday = H.today();
  const rel = (v, base) => typeof v === 'string' ? v.replace(/\{\{today([+-]\d+)?\}\}/g, (_, d) => H.addDays(base, d ? Number(d) : 0))
    : Array.isArray(v) ? v.map(x => rel(x, base)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rel(x, base)])) : v;
  let n = 0;
  for (const [command, args, reason, actor, actor_kind, expect, when] of steps) {
    if (allow && byName[command] && !allow.has(byName[command].module)) continue;
    const m = /^([+-]\d+)d$/.exec(when || '');
    const day = m ? H.addDays(realToday, Number(m[1])) : null;
    try {
      H.withClock(day, () => execute(command, rel(args || {}, realToday), { workspace, actor: actor || 'fixture', actor_kind: actor_kind || 'human',
        session: `fixture:${name}`, reason: reason || `fixture ${name}` }));
      if (expect === 'refused') throw new Error(`fixture ${name}: ${command} was expected to be refused but succeeded`);
    } catch (e) {
      // A step marked expect:'refused' is PART of the story — the refusal lands in the
      // audit trail like any other, and seeding continues. Anything else still fails loudly.
      if (expect !== 'refused' || /expected to be refused/.test(e.message)) throw e;
    }
    n++;
  }
  return n;
}

module.exports = { load, DIR };
