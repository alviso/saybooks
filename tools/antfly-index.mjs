#!/usr/bin/env node
/**
 * Index a Saybooks export in a local Antfly node, so core_search can rank by meaning.
 *
 *   node tools/antfly-index.mjs ~/Downloads/saybooks-export-hunt-2026-09-18.json --table hunt
 *
 * Reads the export (the JSON the workbench's Export button writes), turns the entities that
 * carry prose into documents, and loads them with the antfly CLI into a table with one
 * embeddings index. Then run the workbench or the MCP server with SAYBOOKS_ANTFLY_TABLE=hunt.
 *
 * What becomes a document: job-hunt postings (with JD text, fit notes, red flags, application
 * status and interviews), companies, contacts, interactions; CRM accounts (why_them, hook,
 * path-in), contacts, drafts' rationales, events. Money and dates stay in the books; this is
 * for the text.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const file = process.argv[2]; const ti = process.argv.indexOf('--table');
const table = ti > -1 ? process.argv[ti + 1] : null;
if (!file || !table) { console.error('usage: node tools/antfly-index.mjs <export.json> --table <name>'); process.exit(2); }
const T = JSON.parse(fs.readFileSync(file, 'utf8')).tables;
const by = (t, k = 'id') => Object.fromEntries((T[t] || []).map(r => [r[k], r]));
const join = (...xs) => xs.filter(x => x != null && x !== '').join('\n');
const docs = [];

// job hunt
const co = by('hunt_company'), po = by('hunt_posting'), ct = by('hunt_contact'), app = by('hunt_application', 'posting_id');
const ivs = {}; for (const r of T.hunt_interview || []) (ivs[r.application_id] = ivs[r.application_id] || []).push(r);
for (const r of T.hunt_posting || []) {
  const a = app[r.id]; const iv = a ? (ivs[a.id] || []) : [];
  docs.push({ id: r.id, kind: 'posting', title: r.title, company: co[r.company_id]?.name, end_client: co[r.end_client_id]?.name, status: r.status,
    application_status: a?.status, applied_at: a?.applied_at, location: r.location, work_mode: r.work_mode, req_id: r.req_id, url: r.url, fit_score: r.fit_score,
    body: join(r.jd_text, r.fit_notes && `Fit notes: ${r.fit_notes}`, r.red_flags && `Red flags: ${r.red_flags}`, r.skip_reason && `Skipped: ${r.skip_reason}`,
      a && `Application: ${a.status}`, ...iv.map(x => `Interview round ${x.round ?? ''}: ${x.kind ?? ''} ${x.outcome ?? ''} ${x.notes ?? ''}`)), created_at: r.created_at });
}
for (const r of T.hunt_company || []) docs.push({ id: r.id, kind: 'company', title: r.name, company: r.name, status: r.kind, body: join(r.notes, r.red_flags && `Red flags: ${r.red_flags}`), created_at: r.created_at });
for (const r of T.hunt_contact || []) docs.push({ id: r.id, kind: 'contact', title: `${r.name}${r.role ? ', ' + r.role : ''}`, company: co[r.company_id]?.name, status: r.relationship, body: join(r.notes, r.source && `Source: ${r.source}`), created_at: r.created_at });
for (const r of T.hunt_interaction || []) { const p = po[r.posting_id] || {}; const k = ct[r.contact_id] || {};
  docs.push({ id: `IX-${r.id}`, kind: 'interaction', title: `${r.direction || ''} ${r.medium || ''} ${String(r.at).slice(0, 10)}: ${p.title || k.name || ''}`.trim(), company: co[p.company_id]?.name, status: r.next_action_state, posting_id: r.posting_id,
    body: join(r.summary, r.next_action && `Next action: ${r.next_action}`), created_at: r.at }); }

// crm
const acc = by('account');
for (const r of T.account || []) docs.push({ id: r.id, kind: 'account', title: r.name, company: r.name, status: r.status,
  body: join(r.why_them, r.trigger_event && `Trigger: ${r.trigger_event}`, r.hook && `Hook: ${r.hook}`, ...(T.account_path_in || []).filter(p => p.account_id === r.id).map(p => `Path in: ${p.bullet}`), r.owner_note), created_at: r.created_at });
for (const r of T.contact || []) docs.push({ id: r.id, kind: 'crm_contact', title: `${r.name || 'gap: ' + r.role_type}${r.title ? ', ' + r.title : ''}`, company: acc[r.account_id]?.name, status: r.status, body: join(r.notes, r.gap_note, r.confidence_note), created_at: r.created_at });
for (const r of T.crm_draft || []) docs.push({ id: r.id, kind: 'draft', title: r.subject || `${r.channel} draft`, company: acc[r.account_id]?.name, status: r.status, body: join(r.body, `Why this one: ${r.rationale}`), created_at: r.created_at });
for (const r of T.crm_event || []) docs.push({ id: r.id, kind: 'event', title: r.title, company: acc[r.account_id]?.name, status: r.status, body: join(r.note, r.location, `Source: ${r.source}`), created_at: r.created_at });

const jsonl = path.join(os.tmpdir(), `saybooks-antfly-${table}.jsonl`);
fs.writeFileSync(jsonl, docs.map(d => JSON.stringify(Object.fromEntries(Object.entries(d).filter(([, v]) => v != null && v !== '')))).join('\n') + '\n');
const counts = {}; for (const d of docs) counts[d.kind] = (counts[d.kind] || 0) + 1;
console.log(`${docs.length} documents: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);

const run = (args) => execFileSync('antfly', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim().split('\n').pop();
try { run(['table', 'get', '--table', table]); console.log(`table ${table} exists; loading into it`); }
catch {
  console.log(run(['table', 'create', '--table', table, '--index', JSON.stringify({ name: 'text', type: 'embeddings', template: '{{title}} {{company}} {{body}}',
    embedder: { provider: 'antfly', model: 'Qwen/Qwen3-Embedding-0.6B-GGUF:q8-0-bundle-v1' }, chunker: { provider: 'antfly', text: { target_tokens: 250, overlap_tokens: 30 } } })]));
}
console.log(run(['load', '--table', table, '--file', jsonl, '--id-field', 'id', '--sync-level', 'full_text']));
console.log(run(['index', 'wait', '--table', table, '--index', 'text', '--until', 'complete']).slice(0, 140));
console.log(`\nNow: SAYBOOKS_ANTFLY_TABLE=${table} node server.js   (or the same variable on mcp-server.js)`);
