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
 * --api openai        talk OpenAI chat completions (LM Studio, or Ollama's /v1); the default
 * --api ollama        talk Ollama's native /api/chat, the only door where thinking can be switched
 * --think on|off      let the model think before it answers (ollama api only; LM Studio decides itself)
 * --max-tokens N      generation budget per hop (default 4000; a 20-row import needs more with thinking on)
 * --tag word          a word for the report filename, so two setups do not overwrite each other
 * A step may carry `attach: { name, text }`: a file the person handed over, pasted into the message
 * the way a chat client pastes it. (A host that passes files by reference is a different program.)
 *
 * A step passes on what is in the database afterwards. The tool names the model chose, the
 * refusals it hit and what it said are all recorded, because the point of a failure is to read
 * why, and the answer is usually a sentence in a description that could have been clearer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? (process.argv[i + 1] ?? true) : d; };
const MODEL = arg('model'); const SCRIPT = arg('script'); const URL_ = arg('url', 'http://127.0.0.1:1234');
const INSTR = arg('instructions', 'on') !== 'off'; const LOAD = process.argv.includes('--load');
const API = arg('api', 'openai'); const THINK = arg('think', 'on') !== 'off'; const MAXTOK = Number(arg('max-tokens', 4000)); const TAG = arg('tag', '');
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
// The scripts are about keeping books, not onboarding. The scratch books start set up, so a model
// that follows the doctrine and checks core_setup_status first is told "ready" instead of being
// handed the first onboarding question, which no script can answer. A script that is about
// onboarding says `books: 'blank'` and starts empty.
if (script.books !== 'blank') R.execute('core_set_company_profile', { name: 'Harborline Studio LLC', address: '1200 NW Marshall St, Portland, OR 97209', country: 'US', currency: 'USD', currencies: 'USD',
  tax_registered: false, tax_id: '12-3456789', tax_id_label: 'EIN', payment_instructions: 'ACH to Harborline Studio LLC, Umpqua Bank, routing 123456789, account 987654321. Quote the invoice number.' },
  { ...ctx, actor: 'harness', reason: 'scratch books start set up' });
const system = INSTR ? R.instructions(BASE, mount)
  : 'You keep the books for one small company through the tools provided. Money is integer cents.';
const messages = [{ role: 'system', content: system }];
const report = { model: MODEL, script: SCRIPT, instructions: INSTR, api: API, think: API === 'ollama' ? THINK : null, max_tokens: MAXTOK, tools: tools.length,
  schema_tokens_est: Math.round(JSON.stringify(tools).length / 4), started: new Date().toISOString(), steps: [] };

// Messages are kept in the OpenAI shape. Ollama's native door wants tool arguments as objects,
// tool results named rather than id-linked, images as a sibling field, and it hands thinking back
// as its own field; the two converters below keep that at the edge so the loop reads the same.
const toOllama = (ms) => { const names = {}; return ms.map(m => {
  if (m.role === 'assistant') { for (const c of m.tool_calls || []) names[c.id] = c.function.name;
    return { role: 'assistant', content: m.content || '', ...(m.reasoning ? { thinking: m.reasoning } : {}),
      ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map(c => ({ id: c.id, function: { name: c.function.name, arguments: (() => { try { return JSON.parse(c.function.arguments || '{}'); } catch { return {}; } })() } })) } : {}) }; }
  if (m.role === 'tool') return { role: 'tool', tool_name: names[m.tool_call_id] || 'unknown', content: m.content };
  if (Array.isArray(m.content)) return { role: m.role, content: m.content.filter(p => p.type === 'text').map(p => p.text).join('\n'),
    images: m.content.filter(p => p.type === 'image_url').map(p => p.image_url.url.replace(/^data:[^,]*,/, '')) };
  return { role: m.role, content: m.content };
}); };
let callSeq = 0;
const fromOllama = (j) => { const m = j.message || {}; const calls = (m.tool_calls || []).map(c => ({ id: c.id || `call_${++callSeq}`, type: 'function',
    function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } }));
  return { choices: [{ message: { role: 'assistant', content: m.content || '', ...(m.thinking ? { reasoning: m.thinking } : {}), ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: calls.length ? 'tool_calls' : (j.done_reason || 'stop') }],
    usage: { prompt_tokens: j.prompt_eval_count ?? null, completion_tokens: j.eval_count ?? null, eval_ms: Math.round((j.eval_duration || 0) / 1e6), prompt_ms: Math.round((j.prompt_eval_duration || 0) / 1e6) } }; };
// Plain http rather than fetch: a 26B model can take longer than five minutes on one hop, and
// fetch's default headers timeout turns that into "fetch failed" with nothing to read.
const post = (url, body) => new Promise((resolve, reject) => {
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 1800000 }, res => {
    let data = ''; res.setEncoding('utf8'); res.on('data', d => data += d);
    res.on('end', () => { try { resolve({ ok: res.statusCode < 300, status: res.statusCode, json: JSON.parse(data) }); } catch { resolve({ ok: false, status: res.statusCode, json: { raw: data.slice(0, 300) } }); } });
  });
  req.on('timeout', () => req.destroy(new Error('no response in 30 minutes'))); req.on('error', reject); req.end(JSON.stringify(body));
});
const chat = async () => {
  const native = API === 'ollama';
  const r = await post(native ? `${URL_}/api/chat` : `${URL_}/v1/chat/completions`, native
      ? { model: MODEL, messages: toOllama(messages), tools, think: THINK, stream: false, options: { temperature: 0.2, num_predict: MAXTOK, num_ctx: 32768 } }
      : { model: MODEL, messages, tools, tool_choice: 'auto', temperature: 0.2, max_tokens: MAXTOK });
  if (!r.ok) throw new Error(`${native ? 'Ollama' : 'server'} ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
  return native ? fromOllama(r.json) : r.json;
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
  let say = step.say;
  if (step.attach) say += `\n\n${step.attach.text}`;
  messages.push({ role: 'user', content: step.image
    ? [{ type: 'text', text: say }, { type: 'image_url', image_url: { url: `data:${step.image.mime};base64,${fs.readFileSync(step.image.path).toString('base64')}` } }]
    : say });
  for (let hop = 0; hop < 10; hop++) {
    const j = await chat(); usage = j.usage; const m = j.choices[0].message; messages.push(m); finish = j.choices[0].finish_reason;
    if ((m.content && m.content.trim()) || m.reasoning) turns.push({ hop, finish, chars: (m.content || '').length, thinking_chars: (m.reasoning || '').length, text: (m.content || '').trim().slice(0, 700), thinking: (m.reasoning || '').slice(0, 300) });
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
      const rec = { name: c.function.name, ok: out.ok, args: JSON.stringify(args).slice(0, out.ok ? 600 : 20000), refusal: out.ok ? null : out.text.slice(0, 400) };
      calls.push(rec); allCalls.push(rec);
      messages.push({ role: 'tool', tool_call_id: c.id, content: out.text });
    }
  }
  const verdict = wsp.use(WS, () => step.check(H.db(), calls, allCalls));
  const row = { n: i + 1, say: step.say.split('\n')[0].slice(0, 100), pass: verdict === true, why: verdict === true ? null : String(verdict),
    seconds: Math.round((Date.now() - t0) / 10) / 100, prompt_tokens: usage?.prompt_tokens ?? null, completion_tokens: usage?.completion_tokens ?? null,
    finish_reason: finish, gen_ms: usage?.eval_ms ?? null, prompt_ms: usage?.prompt_ms ?? null, nudges, calls, turns, prose: prose.slice(0, 400) };
  report.steps.push(row);
  const line = `${row.pass ? 'ok  ' : 'FAIL'} ${row.n}. ${row.say}  [${row.seconds}s, ${calls.length} call${calls.length === 1 ? '' : 's'}, finish ${finish}${nudges ? `, ${nudges} nudge` : ''}]`;
  console.log(line);
  for (const c of calls) console.log(`       ${c.ok ? '->' : 'XX'} ${c.name}(${c.args})${c.refusal ? `\n          ${c.refusal}` : ''}`);
  if (!row.pass) console.log(`       why: ${row.why}`);
  if (prose) console.log(`       model: ${prose.replace(/\s+/g, ' ').slice(0, 220)}`);
};

console.log(`${MODEL} · ${SCRIPT} · instructions ${INSTR ? 'on' : 'off'} · ${API}${API === 'ollama' ? ` think ${THINK ? 'on' : 'off'}` : ''} · max ${MAXTOK} · ${tools.length} tools (~${report.schema_tokens_est} tokens of schema)\n`);
for (let i = 0; i < script.steps.length; i++) {
  try { await say(script.steps[i], i); }
  catch (e) { report.steps.push({ n: i + 1, say: script.steps[i].say.split('\n')[0].slice(0, 100), pass: false, why: `request failed: ${e.message}`, calls: [], turns: [] }); console.log(`FAIL ${i + 1}. request failed: ${e.message}`); }
}
const passed = report.steps.filter(s => s.pass).length;
report.passed = passed; report.total = report.steps.length; report.finished = new Date().toISOString();
report.audit = wsp.use(WS, () => H.db().prepare('SELECT command, ok, error FROM command_log ORDER BY id').all());
const out = path.join(ROOT, 'test/local/reports', `${MODEL.replace(/[^a-z0-9]+/gi, '-')}--${SCRIPT}--instr-${INSTR ? 'on' : 'off'}${API === 'ollama' ? `--think-${THINK ? 'on' : 'off'}` : ''}${TAG ? `--${TAG}` : ''}--${report.started.slice(0, 16).replace(/[:T]/g, '')}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 1));
console.log(`\n${passed}/${report.total} steps pass · ${report.audit.filter(a => !a.ok).length} refusals on the trail · report: ${path.relative(ROOT, out)}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(passed === report.total ? 0 : 1);
