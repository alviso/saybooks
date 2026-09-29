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

// A spec page is a document with an author and a date, and search engines that answer questions
// need to be told which URL it lives at. `at` is the path, `modified` the day the spec last moved.
const mtime = (f) => { try { return fs.statSync(f).mtime.toISOString().slice(0, 10); } catch { return null; } };
const newest = () => areas().map(a => mtime(path.join(SPEC_DIR, a, 'spec.md'))).filter(Boolean).sort().pop() || null;

const SHELL = (title, body, sub, at = '/specs', modified = null) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Saybooks specs</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="description" content="${esc(sub || 'The Saybooks specifications: acts, invariants, executable scenarios, and the last conformance run.')}"><link rel="canonical" href="https://saybooks.io${at}"><meta property="og:title" content="${esc(title)} · Saybooks specs"><meta property="og:description" content="${esc(sub || 'The Saybooks specifications: acts, invariants, executable scenarios, and the last conformance run.')}"><meta property="og:type" content="article"><meta property="og:url" content="https://saybooks.io${at}"><meta property="og:image" content="https://saybooks.io/card.png"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="https://saybooks.io/card.png">
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'TechArticle', headline: `${title} · Saybooks specs`, description: sub || 'The Saybooks specifications: acts, invariants, executable scenarios, and the last conformance run.', url: `https://saybooks.io${at}`, inLanguage: 'en', ...(modified ? { dateModified: modified } : {}), author: { '@type': 'Person', name: 'Peter Varga', url: 'https://portlandaiworks.com/' }, publisher: { '@type': 'Organization', name: 'Saybooks', url: 'https://saybooks.io/' }, isPartOf: { '@type': 'WebSite', name: 'Saybooks', url: 'https://saybooks.io/' } }).replace(/</g, '\\u003c')}</script>
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Saybooks', item: 'https://saybooks.io/' }, { '@type': 'ListItem', position: 2, name: 'Specs', item: 'https://saybooks.io/specs' }, ...(at === '/specs' ? [] : [{ '@type': 'ListItem', position: 3, name: title, item: `https://saybooks.io${at}` }])] }).replace(/</g, '\\u003c')}</script><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,500..700,100,0&family=Figtree:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap"><link rel="stylesheet" href="/site.css"><style>
.prose.spec{max-width:960px} .prose h4{font:700 16px var(--sans);margin:1.2em 0 .3em}
.status{display:inline-block;font:600 12.5px var(--mono);padding:3px 10px;border-radius:999px;background:var(--paper2);color:var(--ink2)} .status.pass{background:var(--green-soft);color:var(--green2)} .status.fail{background:var(--tomato-soft);color:var(--tomato)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin:10px 0 24px} .cards .card{display:block;padding:20px 22px;text-decoration:none;color:inherit;transition:transform .15s ease,border-color .15s ease} .cards .card:hover{transform:translateY(-2px);border-color:var(--green)} .cards .card b{display:block;font:600 21px var(--serif);color:var(--ink);margin-bottom:4px} .cards .card span{font-size:15px;color:var(--ink2)}
.refused{color:var(--tomato);font-weight:700} .ok{color:var(--green);font-weight:700}
.scn{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px 22px;margin:0 0 16px;box-shadow:var(--shadow)} .scn h3{margin:0 0 6px} .scn .notes{font-size:15px;color:var(--ink2);margin:0 0 12px} .scn table{margin:0;box-shadow:none;border:1px solid var(--line2)}
</style></head><body><div class="wrap">
<nav class="top"><a class="mark" href="/"><svg width="18" height="21" viewBox="0 0 22 26" fill="none" stroke="#1E7A4C" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4.5 10a5 5 0 0 1 0 6" opacity=".35"/><path d="M10.5 7a9.5 9.5 0 0 1 0 12" opacity=".65"/><path d="M16.5 3.5a14.5 14.5 0 0 1 0 19"/></svg><span>SAYBOOKS</span></a><div class="links"><a href="/hostel">Mac &amp; iPhone</a><a href="/solo">Invoicing</a><a href="/hunt">Job hunt</a><a href="/docs">Docs</a><a href="/notes">Notes</a></div><div class="auth"><a class="btn line small" href="/auth/google">Sign in</a><a class="btn solid small" href="/app?demo=1">Try it now</a></div></nav>
<main class="prose spec">
${body}
<p class="more">These pages are generated from the files in <code>specs/</code> in the repository; scenarios are executed by <code>src/conformance.js</code> on every build. Written and maintained by <a href="/about">Peter Varga</a>, who also runs <a href="https://portlandaiworks.com/">Portland AI Works</a>. <a href="https://github.com/alviso/saybooks">github.com/alviso/saybooks</a>, AGPL-3.0.</p>
</main></div>
<footer class="site"><div class="wrap"><div class="fcols"><div><a class="mark" href="/"><svg width="18" height="21" viewBox="0 0 22 26" fill="none" stroke="#6BBF8C" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4.5 10a5 5 0 0 1 0 6" opacity=".35"/><path d="M10.5 7a9.5 9.5 0 0 1 0 12" opacity=".65"/><path d="M16.5 3.5a14.5 14.5 0 0 1 0 19"/></svg><span>SAYBOOKS</span></a><p>Books you keep by talking, under rules that refuse a guess, with every act on the record. Built in Portland, Oregon by <a href="/about">Peter Varga</a>.</p></div><div><b>Books</b><a href="/solo">Invoicing</a><a href="/hunt">Job hunt</a><a href="/app?demo=1">Personal finances</a><a href="/app?demo=1">Order to cash</a><a href="/app?demo=1">CRM and prospects</a><a href="/docs#ledger">Ledger hand-over</a></div><div><b>Get it</b><a href="/app?demo=1">saybooks.io</a><a href="/hostel">Mac and iPhone</a><a href="/docs#connect">Claude connector</a><a href="https://github.com/alviso/saybooks">Source code</a></div><div><b>Read</b><a href="/docs">Docs</a><a href="/specs">Specs</a><a href="/notes">Notes</a><a href="/notes/local-models">Local models</a><a href="/session/harborline">A full session</a></div><div><b>Company</b><a href="/about">About</a><a href="/privacy">Privacy</a><a href="https://portlandaiworks.com/">Portland AI Works</a><a href="mailto:hello@saybooks.io">hello@saybooks.io</a></div></div><div class="legal">Open source under AGPL-3.0. Saybooks never emails a customer, charges a card or moves money; it records what happened.</div></div></footer>
<script src="/site.js" defer></script></body></html>`;

function renderIndex() {
  const cards = areas().map(a => {
    const info = areaInfo(a);
    const n = info.acts ? Object.keys(info.acts.acts || {}).length : 0;
    const status = info.report ? (info.report.scenarios || []).every(s => s.pass) ? 'conformant' : 'failing' : (info.acts ? 'no run yet' : 'draft');
    return `<a class="card" href="/specs/${a}"><b>${esc(info.title)}</b><span>${BLURB[a] ? esc(BLURB[a]) + '<br>' : ''}${info.acts ? `${info.acts.area}@${esc(info.acts.spec)} · ${n} acts · ${info.scenarios.length} scenarios · ` : 'spec only · '}<span class="status ${status === 'conformant' ? 'pass' : status === 'failing' ? 'fail' : ''}">${status}</span></span></a>`;
  }).join('');
  // Every invariant in one place. The index used to be eight cards and a paragraph, which is a
  // hub a search engine skips; the rules themselves are the content people come for.
  const invariants = areas().map(a => {
    const info = areaInfo(a); const inv = (info.acts && info.acts.invariants) || [];
    if (!inv.length) return '';
    return `<h2 id="${esc(a)}"><a href="/specs/${a}" style="text-decoration:none;color:inherit">${esc(info.title)}</a></h2>
<table><thead><tr><th>Id</th><th>Invariant</th></tr></thead><tbody>${inv.map(v => `<tr><td><code>${esc(v.id)}</code></td><td>${esc(v.title)}</td></tr>`).join('')}</tbody></table>`;
  }).join('');
  const total = areas().reduce((t, a) => t + (((areaInfo(a).acts || {}).invariants) || []).length, 0);
  return SHELL('Specs', `<div class="kicker">Specifications</div><h1>The rules, written down and executed</h1>
<p>Each area of Saybooks is governed by a written spec: the acts it must support, the invariants it must keep, and scenario files that replay real sequences of acts, refusals included, through the actual command registry. A module that claims an area must map every act and pass every scenario; the contract test fails the build otherwise. The specs speak in acts, not commands, so a competing implementation can be certified by the same files.</p>
<div class="cards">${cards}</div>
<h2 style="margin-top:2.2em">Every invariant, in one place</h2>
<p>${total} rules across ${areas().length} areas. Each is one sentence, enforced at the one place every command passes through, and shown identically to a person and to an agent when it refuses. The area pages hold the acts, the scenarios and the last conformance run.</p>
${invariants}`, `Every rule Saybooks enforces, written down and executed: ${total} invariants across ${areas().length} areas, the acts each must support, and scenario files replayed through the real command registry on every build.`, '/specs', newest());
}

/** One sentence per area, for the index. What it governs, in the words a person would use. */
const BLURB = {
  o2c: 'Quotes, orders, shipments, invoices, receivables and credit: the order-to-cash cycle of a small business, with a credit gate the agent cannot talk past.',
  solo: 'A freelancer\'s invoicing: numbered invoices with a link and a PDF, any currency, your tax scheme, payments and what is still open. Issued means issued.',
  crm: 'Relationship pursuit: campaigns with a goal, accounts that earned their place, contacts with sources or recorded as gaps, drafts the agent writes and a person sends, events with the page their date came from.',
  prospect: 'The holding area in front of the CRM: bought or scraped rows the agent stages and judges, that only a person promotes.',
  jobhunt: 'A job search as a system of record: postings, applications, interviews, recruiters, a duplicate guard, and one next action per pursuit.',
  purchases: 'Bank and card statements and receipts the agent read: rows with provenance, accepted whole or not at all, reviewed in the person\'s own words, subscriptions and spend.',
  bridge: 'The hand-over to the accountant: map their chart once, export a period as QuickBooks Online or Xero journal lines, keep what went and when.',
  p2p: 'Procure-to-pay, specified ahead of any implementation: purchase orders, receipts against them, supplier invoices matched three ways, payment runs.',
};

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
      + Object.entries(a.acts || {}).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v.kind)}</td><td>${(v.required || []).map(r => `<code>${esc(r)}</code>`).join(' ') || 'none'}</td></tr>`).join('')
      + (a.env_acts ? Object.entries(a.env_acts).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>environment</td><td>${(v.required || []).map(r => `<code>${esc(r)}</code>`).join(' ') || 'none'}</td></tr>`).join('') : '')
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
  return SHELL(info.title, body, `${info.title}: acts, invariants, scenarios and the last conformance run.`, `/specs/${area}`, mtime(path.join(SPEC_DIR, area, 'spec.md')));
}

const render = (area) => (area ? renderArea(area) : renderIndex());
module.exports = { render, md };
