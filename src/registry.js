'use strict';
/**
 * The command registry.
 *
 * A command is declared once, inside a module, and four things are *derived* from that one
 * declaration rather than maintained alongside it:
 *
 *   1. the MCP tool           (name, description+doctrine, JSON Schema)   -> mcpTools()
 *   2. the UI form            (fields, widgets, labels, lookups)          -> formSpec()
 *   3. the guard evaluation   (which buttons are live, why not)           -> availableFor()
 *   4. the audit row          (actor, args, subject, result)              -> execute()
 *
 * Modules are the unit of contribution. Each declares a manifest (name, prefix, the tables
 * it owns, its doctrine) and its commands; the contract in test/contract.test.js holds every
 * module to the same rules. Nothing outside this file may call a handler: both servers call
 * execute(), which is what makes the audit log complete rather than merely well-intentioned.
 */
const fs = require('fs');
const path = require('path');
const wsp = require('./workspace.js');

const COMMANDS = [];
const byName = Object.create(null);

// ---------------------------------------------------------------- permissions
/**
 * Every write command declares a permission tag; reads default to 'read'. Roles are fixed
 * grant sets. Enforcement happens in execute() — the same choke point as everything else —
 * and a denial is a one-sentence refusal (INV-18 extended to authorization): the greyed
 * button's tooltip, the thrown error, and the agent's answer are the same string. Denials
 * are logged like any other refusal: attempted overreach is reviewable.
 *
 * Tools stay visible to every role (show-and-refuse): an agent that can see the command can
 * tell its human exactly who to ask.
 */
const PERMISSIONS = ['read', 'sales.write', 'fulfil.write', 'billing.write', 'cash.write', 'credit.authority', 'workspace.admin'];
const ROLE_GRANTS = {
  owner:      new Set(PERMISSIONS),
  controller: new Set(['read', 'sales.write', 'fulfil.write', 'billing.write', 'cash.write', 'credit.authority']),
  clerk:      new Set(['read', 'sales.write', 'fulfil.write', 'billing.write', 'cash.write']),
  viewer:     new Set(['read']),
};
const hasGrant = (role, permission) => (ROLE_GRANTS[role] || ROLE_GRANTS.viewer).has(permission);
const denial = (cmd, role) => `${cmd.title || cmd.name} needs ${cmd.permission} — your role (${role}) does not have it.`;
const MODULES = [];
const SUBJECTS = Object.create(null);   // subject type -> { load, ctx, module }
let definingModule = null;              // set while a module's files are being required

// ---------------------------------------------------------------- field helpers
// Each helper emits one object carrying BOTH the JSON Schema facts and the `ui` block.
// The two projections below split it. Add a field once; it appears in both surfaces.
const field = (type, description, ui, extra = {}) => ({ type, description, ui, ...extra });

const f = {
  text:  (description, ui = {})     => field('string',  description, { widget: 'text', ...ui }),
  note:  (description, ui = {})     => field('string',  description, { widget: 'textarea', ...ui }),
  int:   (description, ui = {})     => field('integer', description, { widget: 'number', ...ui }),
  money: (description, ui = {})     => field('integer', `${description} In cents (integer minor units) — 1250 means $12.50.`, { widget: 'money', ...ui }),
  date:  (description, ui = {})     => field('string',  `${description} ISO date, YYYY-MM-DD.`, { widget: 'date', ...ui }),
  bool:  (description, ui = {})     => field('boolean', description, { widget: 'checkbox', ...ui }),
  pick:  (values, description, ui = {}) => field('string', description, { widget: 'select', ...ui }, { enum: values }),
  // A reference renders as a searchable lookup in the UI and tells the model, in prose,
  // which id space it lives in — the single most common way an agent goes wrong.
  ref:   (entity, description, ui = {}) => field('string', `${description} An existing ${entity} id.`, { widget: 'lookup', entity, ...ui }),
  // Line items. One declaration produces an array-of-objects JSON Schema and an
  // add/remove line grid in the UI.
  lines: (of, description) => ({
    type: 'array', description,
    items: { type: 'object', properties: strip(of), required: Object.entries(of).filter(([, v]) => v.required).map(([k]) => k), additionalProperties: false },
    ui: { widget: 'lines', of },
  }),
};

const strip = (args) => Object.fromEntries(Object.entries(args).map(([k, v]) => {
  const { ui, required, human_only, ...rest } = v;
  if (human_only) rest.description = `${rest.description || ''} HUMAN-ONLY: entered by a person, never an agent — do not write this field.`.trim();
  return [k, rest];
}));

// ---------------------------------------------------------------- modules
/**
 * A module is a directory under src/modules/<name>/ whose index.js calls defineModule and
 * requires its command files. The manifest is the contract surface:
 *   name     — directory name, checked
 *   prefix   — every command in the module must be named `${prefix}_...`
 *   tables   — the tables this module owns. Only the owner writes them; other modules go
 *              through the owner's exported api. Reads (joins) across modules are allowed.
 *   doctrine — module-level prose, composed into the MCP server instructions when mounted
 *   api      — what the module offers other modules instead of its tables
 */
function defineModule(manifest) {
  if (!manifest.name || !manifest.prefix) throw new Error('module manifest needs name and prefix');
  if (MODULES.some(m => m.name === manifest.name)) throw new Error(`duplicate module ${manifest.name}`);
  if (MODULES.some(m => m.prefix === manifest.prefix)) throw new Error(`duplicate module prefix ${manifest.prefix}`);
  const mod = { tables: [], doctrine: '', api: {}, commands: [], ...manifest };
  MODULES.push(mod);
  return mod;
}

/** Subjects power availableFor()/next_actions and are declared by the module that owns the
 *  entity's read model — no central hand-maintained map to drift. */
function defineSubject(type, { load, ctx }) {
  if (SUBJECTS[type]) throw new Error(`duplicate subject ${type}`);
  SUBJECTS[type] = { load, ctx: ctx || (() => ({})), module: definingModule ? definingModule.name : null };
}

/** Discover and load every module. Contributors add a directory; nobody edits a central
 *  index — that file was a merge-conflict magnet the moment there were two of you. */
function loadModules(dir = path.join(__dirname, 'modules')) {
  wsp.registerMigrations('_base', path.join(__dirname, 'migrations'));   // command_log first
  const names = fs.readdirSync(dir).filter(n => fs.existsSync(path.join(dir, n, 'index.js'))).sort();
  for (const name of names) {
    const before = MODULES.length;
    const modPath = path.join(dir, name);
    wsp.registerMigrations(name, path.join(modPath, 'migrations'));
    // index.js calls defineModule first, then requires its commands; track attribution.
    const mod = require(path.join(modPath, 'index.js'));
    if (MODULES.length !== before + 1 || MODULES[before].name !== name) {
      throw new Error(`module directory ${name} must define exactly one module named "${name}"`);
    }
    MODULES[before].dir = modPath;
    MODULES[before].exports = mod;
  }
  return MODULES;
}

// ---------------------------------------------------------------- declaration
/**
 * defineCommand({
 *   name, title, group, subject, intent, doctrine, args, guards, effects, handler
 * })
 *
 * `doctrine` is the prose an agent reads before calling and the help text a human reads
 * above the form. It is one string because it is one rule. Where the two surfaces need
 * to say the same thing, they must not be free to say it differently.
 */
function defineCommand(def) {
  if (byName[def.name]) throw new Error(`duplicate command ${def.name}`);
  const cmd = {
    intent: 'write', scope: 'instance', args: {}, guards: [], effects: [], group: 'General',
    ...def,
    module: definingModule ? definingModule.name : null,
    required: Object.entries(def.args || {}).filter(([, v]) => v.required).map(([k]) => k),
  };
  if (!cmd.permission && cmd.intent === 'read') cmd.permission = 'read';
  if (cmd.permission && !PERMISSIONS.includes(cmd.permission)) throw new Error(`${cmd.name}: unknown permission ${cmd.permission}`);
  COMMANDS.push(cmd);
  byName[def.name] = cmd;
  if (definingModule) definingModule.commands.push(cmd.name);
  return cmd;
}

/**
 * Some arguments need the outside world before the transaction can begin — fetching a logo
 * from a URL, say. A command may declare `prepare(args) -> Promise<args>`; both surfaces call
 * it before execute(), outside the transaction. A refusal thrown here is a refusal like any
 * other, except that nothing was attempted against the books, so nothing is logged.
 */
async function prepare(name, args = {}) {
  const cmd = byName[name];
  return cmd && cmd.prepare ? cmd.prepare(args) : args;
}

/** Arguments listed in `redact` are logged by size, not content — a 300 KB image is not an audit fact. */
const logArgs = (cmd, args) => !cmd.redact ? args
  : Object.fromEntries(Object.entries(args).map(([k, v]) => [k, cmd.redact.includes(k) && v != null ? `<${String(v).length} chars, not logged>` : v]));

/** Called by a module's index.js around its requires so commands get attributed. */
function inModule(mod, fn) {
  definingModule = mod;
  try { fn(); } finally { definingModule = null; }
}

// ---------------------------------------------------------------- projection 1: MCP
const description = (c) => [c.summary, c.doctrine && `\n${c.doctrine.trim()}`, c.effects.length && `\nEffects: ${c.effects.join('; ')}.`]
  .filter(Boolean).join('');

const inMount = (c, modules) => !modules || modules.includes(c.module);

/** Pass {modules: ['core','o2c']} to mount a subset — a finance reviewer's session gets
 *  GL + AR only. Tool-count discipline is per session, not per deployment. */
const mcpTools = (opts = {}) => COMMANDS.filter(c => inMount(c, opts.modules)).map(c => ({
  name: c.name,
  description: description(c),
  inputSchema: { type: 'object', properties: strip(c.args), required: [...c.required], additionalProperties: false },
}));

/** Server instructions compose from the base doctrine plus each mounted module's. */
const instructions = (base, opts = {}) => [base.trim(),
  ...MODULES.filter(m => !opts.modules || opts.modules.includes(m.name)).filter(m => m.doctrine)
    .map(m => `## ${m.name}\n${m.doctrine.trim()}`)].join('\n\n');

// ---------------------------------------------------------------- projection 2: UI
const formSpec = (opts = {}) => COMMANDS.filter(c => inMount(c, opts.modules)).map(c => ({
  name: c.name, title: c.title, group: c.group, subject: c.subject, intent: c.intent, scope: c.scope, module: c.module, permission: c.permission,
  help: c.doctrine ? c.doctrine.trim() : '',
  effects: c.effects,
  fields: Object.entries(c.args).map(([key, a]) => ({
    key,
    label: a.ui.label || key.replace(/_/g, ' ').replace(/^./, s => s.toUpperCase()),
    widget: a.ui.widget,
    entity: a.ui.entity,
    options: a.enum,
    human_only: a.human_only || undefined,
    of: a.ui.of && Object.entries(a.ui.of).map(([k, v]) => ({
      key: k, label: v.ui.label || k.replace(/_/g, ' '), widget: v.ui.widget, entity: v.ui.entity, required: !!v.required,
    })),
    hint: a.description,
    required: !!a.required,
  })),
}));

// ---------------------------------------------------------------- projection 3: guards
/**
 * What can be done to this thing right now, and where it cannot, why not — in the
 * business's own words. The UI greys a button and shows `reason` as the tooltip; the MCP
 * next_actions tool returns the same array; a rejected command quotes the same string back.
 * There is exactly one sentence per rule in this system.
 */
function availableFor(subjectType, subject, ctx, role = 'owner') {
  return COMMANDS
    .filter(c => c.subject === subjectType && c.intent === 'write' && c.scope === 'instance')
    .map(c => {
      if (!hasGrant(role, c.permission)) return { command: c.name, title: c.title, available: false, reason: denial(c, role) };
      const failed = c.guards.map(g => g(subject, ctx)).find(r => r !== true && r != null);
      return { command: c.name, title: c.title, available: !failed, reason: failed || null };
    });
}

/** Evaluate a subject by type + id inside the current workspace. Modules declared the
 *  loaders; this is the one implementation behind both the greyed button and next_actions. */
function nextActions(subjectType, id, role = 'owner') {
  const s = SUBJECTS[subjectType];
  if (!s) throw new Error(`unknown subject ${subjectType}`);
  const subject = s.load(id);
  return { subject_type: subjectType, id, status: subject.status, actions: availableFor(subjectType, subject, s.ctx(subject), role) };
}

// ---------------------------------------------------------------- execute
class Rejected extends Error {}                      // a business rule said no — expected, logged, not a bug

function validate(cmd, args) {
  for (const k of cmd.required) {
    if (args[k] === undefined || args[k] === null || args[k] === '') throw new Rejected(`${cmd.name}: ${k} is required.`);
  }
  const unknown = Object.keys(args).filter(k => !cmd.args[k]);
  if (unknown.length) {
    throw new Rejected(`${cmd.name}: unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}. It takes: ${Object.keys(cmd.args).join(', ')}.`);
  }
  for (const [k, v] of Object.entries(args)) {
    const spec = cmd.args[k];
    if (v === undefined || v === null) continue;
    if (spec.type === 'integer' && (!Number.isInteger(v))) throw new Rejected(`${cmd.name}: ${k} must be a whole number${spec.ui.widget === 'money' ? ' of cents' : ''}.`);
    if (spec.enum && !spec.enum.includes(v)) throw new Rejected(`${cmd.name}: ${k} must be one of ${spec.enum.join(', ')}.`);
  }
}

/**
 * The single choke point. ctx = { workspace, actor, actor_kind, session, reason }.
 * The workspace is entered here and only here; the handler and its audit row commit in one
 * transaction inside it. An ERP write that is not in the log did not happen, and a log row
 * without its write is a lie. Rejections are logged too — a refused agent action is exactly
 * the thing you want to be able to see later.
 */
function execute(name, args = {}, ctx = {}) {
  const cmd = byName[name];
  if (!cmd) throw new Rejected(`unknown command ${name}`);
  if (!ctx.workspace) throw new Error(`execute(${name}): ctx.workspace is required`);
  const who = { actor: ctx.actor || 'unknown', actor_kind: ctx.actor_kind || 'human', session: ctx.session || null, reason: ctx.reason || null, modules: ctx.modules || null };
  const role = ctx.role || 'owner';
  const at = new Date().toISOString();

  return wsp.use(ctx.workspace, () => {
    const db = wsp.db();

    // Reads go through the same door — same validation, same arg names, same refusals — but
    // they are not logged. A read handler may return a promise for pure rendering work (a PDF,
    // a picture) provided every database read happened synchronously first: the workspace is
    // only current inside this call. Both servers await execute(). The audit trail answers "what changed and who changed it"; burying
    // that under every list refresh would make it useless for the one job it has.
    if (cmd.intent === 'read') {
      if (!hasGrant(role, cmd.permission)) throw new Rejected(denial(cmd, role));
      validate(cmd, args); return cmd.handler(args, { db, at, ...who });
    }

    const write = db.transaction(() => {
      if (!hasGrant(role, cmd.permission)) throw new Rejected(denial(cmd, role));
      if (who.actor_kind === 'agent') {
        for (const [k, v] of Object.entries(args)) {
          if (v !== undefined && v !== null && cmd.args[k] && cmd.args[k].human_only) {
            throw new Rejected(`${k} is human-only: entered by a person, never an agent — ${cmd.args[k].human_only}`);
          }
        }
      }
      validate(cmd, args);
      const result = cmd.handler(args, { db, at, ...who });
      db.prepare(`INSERT INTO command_log (at, command, actor_kind, actor, session, reason, subject_type, subject_id, args_json, ok, result_json)
                  VALUES (?,?,?,?,?,?,?,?,?,1,?)`)
        .run(at, name, who.actor_kind, who.actor, who.session, who.reason, cmd.subject || null,
             String(args[`${cmd.subject}_id`] || (result && result.id) || ''), JSON.stringify(logArgs(cmd, args)), JSON.stringify(result));
      return result;
    });

    try {
      return write();
    } catch (e) {
      // Outside the rolled-back transaction, so the refusal survives.
      db.prepare(`INSERT INTO command_log (at, command, actor_kind, actor, session, reason, subject_type, subject_id, args_json, ok, error)
                  VALUES (?,?,?,?,?,?,?,?,?,0,?)`)
        .run(at, name, who.actor_kind, who.actor, who.session, who.reason, cmd.subject || null,
             String(args[`${cmd.subject}_id`] || ''), JSON.stringify(logArgs(cmd, args)), e.message);
      throw e;
    }
  });
}

module.exports = { COMMANDS, byName, MODULES, SUBJECTS, defineModule, defineSubject, defineCommand, inModule,
  loadModules, f, mcpTools, formSpec, instructions, availableFor, nextActions, execute, prepare, Rejected,
  PERMISSIONS, ROLE_GRANTS, hasGrant, denial };
