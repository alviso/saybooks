/**
 * Does a plain-spoken person get their books kept by a local model?
 *
 * The contract suite proves the rules. The smoke test proves the screens. Neither says whether
 * a model that is not Claude, handed these tools and a person talking the way people talk,
 * gets the books right. This does. It runs a script of plain prompts, one conversation, against
 * a model served by LM Studio, executes every tool call through the real registry on a scratch
 * set of books, and after each prompt checks the books rather than the model's prose.
 *
 *   npm run local -- --model qwen/qwen3-30b-a3b-2507 --script plain-statement
 *   npm run local -- --model gemma-4-26b-a4b-it-qat-mlx --script plain-invoicing --instructions off
 *
 * --instructions on   the server's connect-time instructions go in the system prompt, as Claude sees them
 * --instructions off  only the per-tool descriptions, as a client that drops instructions shows them
 * --load              unload everything in LM Studio and load this model alone, one slot, 32k context
 *
 * A step passes on what is in the database afterwards. The tool names the model chose, the
 * refusals it hit and what it said are all recorded, because the point of a failure is to read
 * why, and the answer is usually a sentence in a description that could have been clearer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? (process.argv[i + 1] ?? true) : d; };
const MODEL = arg('model'); const SCRIPT = arg('script'); const URL_ = arg('url', 'http://127.0.0.1:1234');
const INSTR = arg('instructions', 'on') !== 'off'; const LOAD = process.argv.includes('--load');
if (!MODEL || !SCRIPT) { console.error('usage: --model <id> --script <name> [--instructions on|off] [--load]'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saybooks-local-'));
process.env.SAYBOOKS_DATA = tmp;
const require = createRequire(import.meta.url);
const R = require(path.join(ROOT, 'src/registry.js')); R.loadModules();
const H = require(path.join(ROOT, 'src/db.js'));
const wsp = require(path.join(ROOT, 'src/workspace.js'));
const BASE = require(path.join(ROOT, 'src/base-doctrine.js'));
const script = (await import(path.join(ROOT, 'test/local/scripts', `${SCRIPT}.mjs`))).default;

if (LOAD) {
  const lms = path.join(os.homedir(), '.lmstudio/bin/lms');
  execSync(`"${lms}" unload --all`, { stdio: 'ignore' });
  execSync(`"${lms}" load "${MODEL}" --context-length 32768 --parallel 1 -y`, { stdio: 'ignore' });
}

// Preflight: a server that is not there produces one clear line, not a failure per prompt.
try { const r = await fetch(`${URL_}/v1/models`, { signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ids = (await r.json()).data.map(m => m.id); if (!ids.includes(MODEL)) console.log(`note: ${MODEL} is not in LM Studio's model list (${ids.join(', ')}); it will be loaded on first request if it exists.`); }
catch (e) { console.error(`LM Studio's API server is not reachable at ${URL_} (${e.message}). Start it with: ~/.lmstudio/bin/lms server start`); process.exit(2); }

const WS = 'local';
const mount = { modules: script.mounts };
const tools = R.mcpTools(mount).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
const ctx = { workspace: WS, actor: MODEL, actor_kind: 'agent', role: 'owner', session: 'local-harness', modules: script.mounts };
const system = INSTR ? R.instructions(BASE, mount)
  : 'You keep the books for one small company through the tools provided. Money is integer cents.';
const messages = [{ role: 'system', content: system }];
const report = { model: MODEL, script: SCRIPT, instructions: INSTR, tools: tools.length,
  schema_tokens_est: Math.round(JSON.stringify(tools).length / 4), started: new Date().toISOString(), steps: [] };

const chat = async () => {
  const r = await fetch(`${URL_}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(600000),
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', temperature: 0.2, max_tokens: 4000 }) });
  const j = await r.json(); if (!r.ok) throw new Error(`LM Studio ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
};

// The same envelope the MCP doors hand back, so a refusal reads the same here as there.
const execute = (name, args) => {
  const { _reason, ...rest } = args;
  try { return { ok: true, text: JSON.stringify(R.execute(name, rest, { ...ctx, reason: _reason })).slice(0, 6000) }; }
  catch (e) { return { ok: false, text: `REFUSED, nothing was written: ${e.message}` }; }
};

const allCalls = [];   // every call so far: a check may ask "did it ever read the vocabulary"
const say = async (step, i) => {
  const t0 = Date.now(); const calls = []; const turns = []; let prose = ''; let usage = null; let finish = null; let nudges = 0;
  // A step may carry an image (a receipt photo, a PDF page), the way a chat client attaches a
  // file. Sent as a data URL alongside the words; only vision models can read it.
  messages.push({ role: 'user', content: step.image
    ? [{ type: 'text', text: step.say }, { type: 'image_url', image_url: { url: `data:${step.image.mime};base64,${fs.readFileSync(step.image.path).toString('base64')}` } }]
    : step.say });
  for (let hop = 0; hop < 10; hop++) {
    const j = await chat(); usage = j.usage; const m = j.choices[0].message; messages.push(m); finish = j.choices[0].finish_reason;
    if (m.content && m.content.trim()) turns.push({ hop, finish, chars: m.content.length, text: m.content.trim().slice(0, 700) });
    if (!m.tool_calls?.length) {
      prose = (m.content || '').trim();
      // An empty turn: no words, no calls. A person in the chat window types "continue" and the
      // model usually does; the harness does the same, once, and says so in the report.
      if (!prose && nudges === 0) { nudges++; messages.push({ role: 'user', content: 'continue' }); continue; }
      break;
    }
    for (const c of m.tool_calls) {
      let args = {}; try { args = JSON.parse(c.function.arguments || '{}'); } catch { }
      const out = execute(c.function.name, args);
      const rec = { name: c.function.name, ok: out.ok, args: JSON.stringify(args).slice(0, 600), refusal: out.ok ? null : out.text.slice(0, 200) };
      calls.push(rec); allCalls.push(rec);
      messages.push({ role: 'tool', tool_call_id: c.id, content: out.text });
    }
  }
  const verdict = wsp.use(WS, () => step.check(H.db(), calls, allCalls));
  const row = { n: i + 1, say: step.say.split('\n')[0].slice(0, 100), pass: verdict === true, why: verdict === true ? null : String(verdict),
    seconds: Math.round((Date.now() - t0) / 10) / 100, prompt_tokens: usage?.prompt_tokens ?? null, completion_tokens: usage?.completion_tokens ?? null,
    finish_reason: finish, nudges, calls, turns, prose: prose.slice(0, 400) };
  report.steps.push(row);
  const line = `${row.pass ? 'ok  ' : 'FAIL'} ${row.n}. ${row.say}  [${row.seconds}s, ${calls.length} call${calls.length === 1 ? '' : 's'}, finish ${finish}${nudges ? `, ${nudges} nudge` : ''}]`;
  console.log(line);
  for (const c of calls) console.log(`       ${c.ok ? '->' : 'XX'} ${c.name}(${c.args})${c.refusal ? `\n          ${c.refusal}` : ''}`);
  if (!row.pass) console.log(`       why: ${row.why}`);
  if (prose) console.log(`       model: ${prose.replace(/\s+/g, ' ').slice(0, 220)}`);
};

console.log(`${MODEL} · ${SCRIPT} · instructions ${INSTR ? 'on' : 'off'} · ${tools.length} tools (~${report.schema_tokens_est} tokens of schema)\n`);
for (let i = 0; i < script.steps.length; i++) {
  try { await say(script.steps[i], i); }
  catch (e) { report.steps.push({ n: i + 1, say: script.steps[i].say.split('\n')[0].slice(0, 100), pass: false, why: `request failed: ${e.message}`, calls: [], turns: [] }); console.log(`FAIL ${i + 1}. request failed: ${e.message}`); }
}
const passed = report.steps.filter(s => s.pass).length;
report.passed = passed; report.total = report.steps.length; report.finished = new Date().toISOString();
report.audit = wsp.use(WS, () => H.db().prepare('SELECT command, ok, error FROM command_log ORDER BY id').all());
const out = path.join(ROOT, 'test/local/reports', `${MODEL.replace(/[^a-z0-9]+/gi, '-')}--${SCRIPT}--instr-${INSTR ? 'on' : 'off'}--${report.started.slice(0, 16).replace(/[:T]/g, '')}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 1));
console.log(`\n${passed}/${report.total} steps pass · ${report.audit.filter(a => !a.ok).length} refusals on the trail · report: ${path.relative(ROOT, out)}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(passed === report.total ? 0 : 1);
