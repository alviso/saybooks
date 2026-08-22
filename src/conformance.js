'use strict';
/**
 * The conformance runner: replays the spec's scenario files against the live registry and
 * keeps the evidence.
 *
 * Three consumers, one truth:
 *   - the contract test (gate 11) fails the build when a scenario fails
 *   - the workbench Spec tab renders status, per-step evidence, and live replays
 *   - core_spec_status / core_replay_scenario give the agent the same answers
 *
 * Scenario steps speak in ACTS ("confirm_order"), never commands; the module's `implements`
 * map translates act -> command and spec arg names -> command arg names. That indirection is
 * the whole point: any implementation claiming the area runs the same files.
 *
 * Every replay runs in a scratch workspace (spec-<area>-<n>), wiped first, executed through
 * the real registry — same guards, same audit log. A replay is not a simulation; it is the
 * system doing the thing, which is why it can teach.
 */
const fs = require('fs');
const path = require('path');
const R = require('./registry.js');
const wsp = require('./workspace.js');

const SPEC_DIR = path.join(__dirname, '..', 'specs');
const EVIDENCE_DIR = path.join(wsp.DATA_DIR, 'conformance');

const specOf = (area) => JSON.parse(fs.readFileSync(path.join(SPEC_DIR, area, 'acts.json'), 'utf8'));
const scenarioFiles = (area) => fs.readdirSync(path.join(SPEC_DIR, area, 'scenarios')).filter(f => f.endsWith('.json')).sort();
const loadScenario = (area, file) => JSON.parse(fs.readFileSync(path.join(SPEC_DIR, area, 'scenarios', file), 'utf8'));

/** act -> {command, argmap} across the implementing module and every module offering env acts. */
function actTable(area) {
  const impl = R.MODULES.find(m => m.implements && m.implements.area === area);
  if (!impl) throw new Error(`no mounted module implements area ${area}`);
  const table = Object.create(null);
  for (const [act, command] of Object.entries(impl.implements.acts)) table[act] = { command, argmap: impl.implements.argmap || {} };
  for (const m of R.MODULES) {
    if (!m.env_acts) continue;
    for (const [act, command] of Object.entries(m.env_acts)) table[act] = { command, argmap: m.env_argmap || {}, env: true };
  }
  return { impl, table };
}

const mapArgs = (args, argmap) => {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    const key = argmap[k] || k;
    out[key] = Array.isArray(v) ? v.map(item => (item && typeof item === 'object') ? mapArgs(item, argmap) : item) : v;
  }
  return out;
};

/** Deep-ish subset check: every expected key matches the actual value. */
function includes(actual, expected) {
  const misses = [];
  for (const [k, v] of Object.entries(expected)) {
    if (actual == null || actual[k] !== v) misses.push(`${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(actual && actual[k])}`);
  }
  return misses;
}

const excerpt = (v, n = 400) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '…' : s;
};

/** Run one scenario file in its scratch workspace; return the step-by-step evidence. */
function runScenario(area, file, { actor = 'conformance' } = {}) {
  const scenario = loadScenario(area, file);
  const { table } = actTable(area);
  const ws = `spec-${area}-${file.replace(/\.json$/, '').replace(/[^a-z0-9_-]/gi, '')}`.toLowerCase();
  wsp.wipe(ws);
  const ctx = { workspace: ws, actor, actor_kind: 'agent', session: `conformance:${file}` };

  const evidence = [];
  let pass = true;

  const runStep = (act, args, expect, notes, phase) => {
    const entry = table[act];
    const row = { phase, act, notes: notes || null, command: entry ? entry.command : null,
      args: args || {}, expect: expect || { ok: true }, pass: false, actual: null, refusal: null };
    if (!entry) { row.refusal = `no mapping for act "${act}" — the implements map is incomplete`; evidence.push(row); pass = false; return; }
    try {
      const result = R.execute(entry.command, mapArgs(args, entry.argmap), ctx);
      row.actual = excerpt(result);
      if (expect && expect.refused) {
        row.refusal = `expected a refusal containing "${expect.refused}" but the command succeeded`;
      } else {
        const misses = expect && expect.include ? includes(result, expect.include) : [];
        if (misses.length) row.refusal = misses.join('; ');
        else row.pass = true;
      }
    } catch (e) {
      row.actual = e.message;
      if (expect && expect.refused) {
        if (e.message.includes(expect.refused)) row.pass = true;
        else row.refusal = `refused, but the message lacks "${expect.refused}": ${excerpt(e.message)}`;
      } else {
        row.refusal = `unexpected refusal: ${excerpt(e.message)}`;
      }
    }
    if (!row.pass) pass = false;
    evidence.push(row);
  };

  for (const [act, args, note] of scenario.env || []) runStep(act, args, { ok: true }, note, 'env');
  for (const step of scenario.steps || []) runStep(step.act, step.args, step.expect, step.notes, 'step');

  return { file, name: scenario.name, spec: scenario.spec, notes: scenario.notes || null,
    workspace: ws, ran_at: new Date().toISOString(), pass, steps: evidence };
}

/** Full area run: every scenario + act coverage + invariant evidence. Persists to disk. */
function runArea(area, opts = {}) {
  const spec = specOf(area);
  const { impl, table } = actTable(area);
  const scenarios = scenarioFiles(area).map(f => runScenario(area, f, opts));

  const acts = Object.entries(spec.acts).map(([act, def]) => {
    const entry = table[act];
    const command = entry && R.byName[entry.command];
    return { act, kind: def.kind, required: def.required,
      command: entry ? entry.command : null,
      implemented: !!command,
      exercised: scenarios.some(s => s.steps.some(st => st.act === act)) };
  });

  // Invariant evidence is derived, not asserted: a scenario or step that cites INV-n in its
  // notes is testimony; the static list names what the contract gates cover mechanically.
  const staticEvidence = {
    'INV-1': ['contract gate: money args declared integer, floats refused at validation'],
    'INV-9': ['contract gate: sequential ids, void keeps its number (test/contract.test.js)'],
    'INV-18': ['contract gate: guard reason === thrown refusal, verbatim'],
    'INV-21': ['contract gate: reads never log, refused writes always log'],
  };
  const invariants = spec.invariants.map(inv => {
    const cites = [];
    for (const s of scenarios) {
      if (s.notes && s.notes.includes(inv.id)) cites.push(`${s.file}: scenario notes`);
      s.steps.forEach((st, i) => { if (st.notes && st.notes.includes(inv.id)) cites.push(`${s.file} step ${i + 1} (${st.act})${st.pass ? '' : ' — FAILING'}`); });
    }
    return { ...inv, evidence: [...(staticEvidence[inv.id] || []), ...cites] };
  });

  const report = {
    area, spec: spec.spec, module: impl.name, ran_at: new Date().toISOString(),
    pass: scenarios.every(s => s.pass) && acts.every(a => a.implemented),
    acts, scenarios, invariants,
  };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, `${area}.json`), JSON.stringify(report, null, 1));
  return report;
}

const lastReport = (area) => {
  const p = path.join(EVIDENCE_DIR, `${area}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

module.exports = { specOf, scenarioFiles, runScenario, runArea, lastReport, actTable };
