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

function load(name, workspace) {
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`invalid fixture name ${name}`);
  const file = path.join(DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`no fixture ${name} — available: ${fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).join(', ') || 'none'}`);
  const steps = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { execute } = require('./registry.js');
  let n = 0;
  for (const [command, args, reason] of steps) {
    execute(command, args || {}, { workspace, actor: 'fixture', actor_kind: 'human', session: `fixture:${name}`, reason: reason || `fixture ${name}` });
    n++;
  }
  return n;
}

module.exports = { load, DIR };
