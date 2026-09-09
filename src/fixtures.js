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
  let n = 0;
  for (const [command, args, reason, actor, actor_kind, expect] of steps) {
    if (allow && byName[command] && !allow.has(byName[command].module)) continue;
    try {
      execute(command, args || {}, { workspace, actor: actor || 'fixture', actor_kind: actor_kind || 'human',
        session: `fixture:${name}`, reason: reason || `fixture ${name}` });
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
