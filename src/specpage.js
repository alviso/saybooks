'use strict';
/**
 * Public spec pages: /specs and /specs/<area>. The curated spec.md, the acts and invariants
 * from acts.json, every scenario file, and the last conformance run — rendered as plain,
 * linkable HTML. The specs are the proof behind "gets told no"; a document nobody can link
 * to proves nothing.
 */
const fs = require('fs');
const path = require('path');
const C = require('./conformance.js');

const SPEC_DIR = path.join(__dirname, '..', 'specs');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Just enough Markdown for the specs: headings, paragraphs, lists, tables, fences, inline code/bold/italic/links. */
function md(src) {
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2">$1</a>');
  const out = []; const lines = src.replace(/\r/g, '').split('\n');
  let i = 0, para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { flush(); const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { flush(); const lvl = h[1].length; const id = h[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); out.push(`<h${lvl} id="${id}">${inline(h[2])}</h${lvl}>`); i++; continue; }
    if (/^\s*\|/.test(l)) {
      flush(); const rows = []; while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const body = rows.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r));
      if (body.length) {
        const [head, ...rest] = body;
        out.push('<table><thead><tr>' + cells(head).map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
          + rest.map(r => '<tr>' + cells(r).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      }
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      flush(); const items = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*[-*]\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*[-*]\s+/, '')); else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      out.push('<ul>' + items.map(t => `<li>${inline(t)}</li>`).join('') + '</ul>'); continue;
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      flush(); const items = [];
      while (i < lines.length && (/^\s*\d+\.\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      out.push('<ol>' + items.map(t => `<li>${inline(t)}</li>`).join('') + '</ol>'); continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l.trim()); i++;
  }
  flush();
  return out.join('\n');
}

const areas = () => fs.readdirSync(SPEC_DIR).filter(a => fs.existsSync(path.join(SPEC_DIR, a, 'spec.md'))).sort();
const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);

function areaInfo(area) {
  const dir = path.join(SPEC_DIR, area);
  const spec = fs.readFileSync(path.join(dir, 'spec.md'), 'utf8');
  const acts = readJson(path.join(dir, 'acts.json'));
  const scenDir = path.join(dir, 'scenarios');
  const scenarios = fs.existsSync(scenDir) ? fs.readdirSync(scenDir).filter(f => f.endsWith('.json')).sort().map(f => ({ file: f, ...readJson(path.join(scenDir, f)) })) : [];
  let report = null; try { report = C.lastReport(area); } catch { /* no evidence yet */ }
  const title = (/^#\s+(.*)$/m.exec(spec) || [, area])[1];
  return { area, title, spec, acts, scenarios, report };
}

const SHELL = (title, body, sub) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Saybooks specs</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="description" content="${esc(sub || 'The Saybooks specifications: acts, invariants, executable scenarios, and the last conformance run.')}">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"><style>
:root{--bg:hsl(210 20% 98%);--ink:hsl(215 40% 16%);--navy:hsl(215 60% 22%);--mid:hsl(215 20% 36%);--muted:hsl(215 15% 46%);--line:hsl(215 25% 88%);--tint:hsl(210 20% 94%);--ok:hsl(152 60% 34%);--refuse:hsl(0 72% 42%);--agent:hsl(248 52% 52%)}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 'IBM Plex Sans',-apple-system,'Segoe UI',sans-serif} body::before{content:"";display:block;height:4px;background:var(--navy)}
.wrap{max-width:900px;margin:0 auto;padding:0 28px 60px} nav.top{display:flex;align-items:center;gap:22px;padding:20px 0;border-bottom:1px solid var(--line);margin-bottom:28px}
.mark{font:700 14px 'IBM Plex Sans',sans-serif;letter-spacing:.14em;color:var(--ink);text-decoration:none;margin-right:auto} nav.top a{color:var(--mid);text-decoration:none;font-size:14px;font-weight:500}
h1{font-size:34px;line-height:1.1;letter-spacing:-.015em;margin:.2em 0 .3em} h2{font-size:22px;margin:1.8em 0 .5em;letter-spacing:-.01em} h3{font-size:17px;margin:1.4em 0 .4em} h4{font-size:15px;margin:1.2em 0 .3em}
p,li{color:var(--mid)} p{margin:0 0 1em} ul,ol{padding-left:1.3em;margin:0 0 1em} li{margin-bottom:.3em}
code{font-family:'IBM Plex Mono',monospace;font-size:.88em;background:var(--tint);padding:.1em .35em;border-radius:4px} pre{background:#fff;border:1px solid var(--line);border-radius:6px;padding:12px 14px;overflow-x:auto;font-size:13px} pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;margin:0 0 1.2em;font-size:14px;background:#fff;border:1px solid var(--line);border-radius:6px;overflow:hidden} th{text-align:left;font:600 11px 'IBM Plex Sans',sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);padding:9px 12px;border-bottom:1px solid var(--line);background:var(--tint)} td{padding:9px 12px;border-bottom:1px solid hsl(215 25% 93%);vertical-align:top;color:var(--mid)} tr:last-child td{border-bottom:none}
.kicker{font:600 11.5px 'IBM Plex Sans',sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)} .status{display:inline-block;font:600 12px 'IBM Plex Mono',monospace;padding:3px 9px;border-radius:4px;background:var(--tint);color:var(--mid)} .status.pass{color:var(--ok)} .status.fail{color:var(--refuse)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px} .card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:18px 20px;text-decoration:none;color:inherit} .card:hover{border-color:var(--navy)} .card b{display:block;font-size:17px;color:var(--ink);margin-bottom:4px} .card span{font-size:13.5px;color:var(--mid)}
.toc{font-size:14px;margin:0 0 1.6em;display:flex;flex-wrap:wrap;gap:6px 16px} .toc a{color:var(--navy)} .refused{color:var(--refuse);font-weight:600} .ok{color:var(--ok);font-weight:600}
.scn{background:#fff;border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin:0 0 14px} .scn h3{margin:0 0 4px} .scn .notes{font-size:14px;color:var(--mid);margin:0 0 10px} .scn table{margin:0}
footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)} footer a{color:var(--mid)}
</style></head><body><div class="wrap">
<nav class="top"><a class="mark" href="/">SAYBOOKS</a><a href="/specs">Specs</a><a href="/docs">Docs</a><a href="https://github.com/alviso/saybooks">Source</a><a href="/app?demo=1">Demo</a></nav>
${body}
<footer>These pages are generated from the files in <code>specs/</code> in the repository; scenarios are executed by <code>src/conformance.js</code> on every build. <a href="https://github.com/alviso/saybooks">github.com/alviso/saybooks</a> · AGPL-3.0</footer>
</div></body></html>`;

function renderIndex() {
  const cards = areas().map(a => {
    const info = areaInfo(a);
    const n = info.acts ? Object.keys(info.acts.acts || {}).length : 0;
    const status = info.report ? (info.report.scenarios || []).every(s => s.pass) ? 'conformant' : 'failing' : (info.acts ? 'no run yet' : 'draft');
    return `<a class="card" href="/specs/${a}"><b>${esc(info.title)}</b><span>${info.acts ? `${info.acts.area}@${esc(info.acts.spec)} · ${n} acts · ${info.scenarios.length} scenarios · ` : 'spec only · '}<span class="status ${status === 'conformant' ? 'pass' : status === 'failing' ? 'fail' : ''}">${status}</span></span></a>`;
  }).join('');
  return SHELL('Specs', `<div class="kicker">Specifications</div><h1>The rules, written down and executed</h1>
<p>Each area of Saybooks is governed by a written spec: the acts it must support, the invariants it must keep, and scenario files that replay real sequences of acts — including the refusals — through the actual command registry. A module that claims an area must map every act and pass every scenario; the contract test fails the build otherwise. The specs speak in acts, not commands, so a competing implementation can be certified by the same files.</p>
<div class="cards">${cards}</div>`);
}

function renderArea(area) {
  if (!/^[a-z0-9]+$/.test(area) || !fs.existsSync(path.join(SPEC_DIR, area, 'spec.md'))) throw new Error('no such area');
  const info = areaInfo(area);
  const a = info.acts;
  let head = `<div class="kicker">Specification · ${esc(area)}${a ? ` @ ${esc(a.spec)}` : ''}</div><h1>${esc(info.title)}</h1>`;
  if (info.report) {
    const scen = info.report.scenarios || []; const pass = scen.filter(s => s.pass).length;
    head += `<p><span class="status ${pass === scen.length ? 'pass' : 'fail'}">last conformance run: ${pass}/${scen.length} scenarios pass · ${(info.report.acts || []).length} acts mapped</span>${info.report.ran_at ? ` <span class="status">${esc(String(info.report.ran_at).slice(0, 16).replace('T', ' '))} UTC</span>` : ''}</p>`;
  }
  const toc = `<div class="toc"><a href="#spec">Spec</a>${a ? '<a href="#acts">Acts</a><a href="#invariants">Invariants</a>' : ''}${info.scenarios.length ? '<a href="#scenarios">Scenarios</a>' : ''}</div>`;
  let body = head + toc + `<h2 id="spec">Spec</h2>` + md(info.spec.replace(/^#\s+.*\n/, ''));
  if (a) {
    body += `<h2 id="acts">Acts</h2><table><thead><tr><th>Act</th><th>Kind</th><th>Required</th></tr></thead><tbody>`
      + Object.entries(a.acts || {}).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v.kind)}</td><td>${(v.required || []).map(r => `<code>${esc(r)}</code>`).join(' ') || '—'}</td></tr>`).join('')
      + (a.env_acts ? Object.entries(a.env_acts).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>environment</td><td>${(v.required || []).map(r => `<code>${esc(r)}</code>`).join(' ') || '—'}</td></tr>`).join('') : '')
      + `</tbody></table>`;
    if (a.invariants) body += `<h2 id="invariants">Invariants</h2><table><thead><tr><th>Id</th><th>Invariant</th></tr></thead><tbody>${a.invariants.map(v => `<tr><td><code>${esc(v.id)}</code></td><td>${esc(v.title)}</td></tr>`).join('')}</tbody></table>`;
  }
  if (info.scenarios.length) {
    const rep = Object.fromEntries(((info.report && info.report.scenarios) || []).map(s => [s.file, s]));
    body += `<h2 id="scenarios">Scenarios</h2><p>Each scenario is a file of acts with expected outcomes. <span class="ok">ok</span> means the act must succeed with the listed fields; <span class="refused">refused</span> means the act must be refused with a sentence containing the listed text. Refusals are contract.</p>`;
    for (const s of info.scenarios) {
      const r = rep[s.file];
      body += `<div class="scn"><h3>${esc(s.name || s.file)} ${r ? `<span class="status ${r.pass ? 'pass' : 'fail'}">${r.pass ? 'pass' : 'fail'}</span>` : ''}</h3>`;
      if (s.notes) body += `<div class="notes">${esc(s.notes)}</div>`;
      if (s.env && s.env.length) body += `<div class="notes"><b>Environment:</b> ${s.env.map(e => `<code>${esc(e[0])}</code>`).join(', ')}</div>`;
      body += `<table><thead><tr><th>#</th><th>Act</th><th>Expect</th><th>Why</th></tr></thead><tbody>` + (s.steps || []).map((st, i) => {
        const ex = st.expect || {};
        const expect = ex.refused ? `<span class="refused">refused</span> <code>${esc(ex.refused)}</code>` : `<span class="ok">ok</span>${ex.include ? ' ' + Object.entries(ex.include).map(([k, v]) => `<code>${esc(k)}=${esc(JSON.stringify(v))}</code>`).join(' ') : ''}`;
        return `<tr><td>${i + 1}</td><td><code>${esc(st.act)}</code></td><td>${expect}</td><td>${esc(st.notes || '')}</td></tr>`;
      }).join('') + `</tbody></table></div>`;
    }
  }
  return SHELL(info.title, body, `${info.title}: acts, invariants, scenarios and the last conformance run.`);
}

const render = (area) => (area ? renderArea(area) : renderIndex());
module.exports = { render, md };
