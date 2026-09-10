# Saybooks

**The books you can talk to. The books that stay books.**

Saybooks is an open-source ERP where your agent and your interface are the same system: one
command registry, one rulebook, one audit trail. Tell Claude to ship the order, issue the
invoice or import a card statement, or click the button: same command, same rules, same record
of who did what and why.

**Live: [saybooks.io](https://saybooks.io)**. Try the demo with no signup, or sign in with Google
and pick the modules your books carry. Connect Claude by adding `https://saybooks.io/mcp` as a
connector (OAuth, no keys to paste); the same books are in the browser as ordinary pages.

Seven modules today, every one spec-first with executable conformance scenarios:

| module | for | what it keeps |
|---|---|---|
| **solo** (Invoicing) | freelancers | clients, invoices with a link and a PDF, payments, outstanding; any currency, your tax scheme |
| **o2c** (Order to cash) | small businesses | quotes, orders, shipments, invoices, receivables, with a credit gate the agent cannot talk past |
| **crm** | small businesses | campaigns, accounts, contacts with sources, gaps, pipeline |
| **jobhunt** | people open to work | postings, applications, interviews, recruiters, a duplicate guard, one next action |
| **purchases** (Personal finances) | anyone | bank and card statements and receipts the agent reads: rows with provenance, review, subscriptions, spend |
| **bridge** (Ledger) | anyone with an accountant | the hand-over to QuickBooks, Xero or a plain CSV: map their chart once, export a period, keep what went and through when |
| **core** | every space | customers, items, the company profile, search, audit, setup |

## Why this exists

"Conversational ERP" usually means a chat layer bolted onto a system that doesn't know the
agent exists. Saybooks inverts that: every business act is **declared once**, and everything
else is *derived* from that declaration:

| derived | so that |
|---|---|
| the MCP tool (name, doctrine, JSON Schema, annotations) | the agent sees exactly what the UI can do |
| the UI form (fields, widgets, validation) | the human sees exactly what the agent can do |
| the guard evaluation | a greyed-out button's tooltip, the thrown refusal, and the agent's answer are **the same sentence**, asserted by test |
| the audit row | every write from either surface lands in one log with an actor and a reason; refusals included |

Nothing outside the registry may call a handler. A click and a tool call go through the same
command, the same guards, the same transaction. The two surfaces cannot drift, because neither
is authored, and `test/contract.test.js` fails the build if anyone tries.

Agent-first, not parser-first: where a file is involved (a statement, a receipt), the agent
reads it and hands over what it read; the module checks the control totals, keeps the
provenance of every row, and refuses what does not reconcile. No bank parsers to maintain.

## What's inside

```
src/registry.js            declare once; derive tools, forms, guards, audit; enforce
src/workspace.js           a SQLite database per space (per person, per sandbox)
src/members.js             capability-token identity: named members with roles
src/oauth.js               OAuth 2.0 front door for MCP clients (DCR, client-id metadata documents)
src/mcp-http.js            MCP over streamable HTTP; one tool list per space's modules
src/document.js            the invoice document: one PDF renderer, previewed as its own pages
src/modules/core, o2c, crm, jobhunt, solo, purchases, bridge
specs/<area>/spec.md       the area spec: calibration, entities, invariants, read models
specs/<area>/scenarios/    executable conformance scenarios (refusals are contract)
src/conformance.js         replays scenarios through the real registry; keeps evidence
server.js                  workbench + hosted demo + MCP + OAuth (all one registry)
mcp-server.js              stdio MCP for local development
test/contract.test.js      the 18-gate contract (see below)
```

**Access control**: every command declares a permission tag; four roles (owner / controller /
clerk / viewer); enforcement at the registry choke point; denials are one-sentence refusals,
logged. An agent connecting through a member's key is that member's *delegate*: their name,
their permissions. Every write carries a reason; reads are never logged.

**Money** is integer minor units everywhere, with a currency; sums are per currency and never
cross. Nothing is invented: a missing amount, date or name is asked for, never guessed.

## The 19-gate contract

Every module — present and future — is held to: MCP/UI parity · namespace prefixes ·
doctrine on every write · guards declared · table ownership (no cross-module writes) ·
a tool budget · module mounts · one-sentence rule · audit behavior · fixture replay ·
**spec conformance** (an implementation claiming an area must map every act and pass every
scenario) · **permissions** (unpermissioned commands do not ship).

The endgame is competing implementations of the same area, certified by replaying the same
scenario files — the spec speaks in acts, not commands, so any conforming module runs them.

## Run it

```bash
npm install
npm test          # the 19 gates
npm run demo      # a full quote-to-cash run, human and agent interleaved
npm start         # workbench on http://127.0.0.1:8140
npm run mcp       # stdio MCP server (OTC_WORKSPACE=you)
```

Register for a Claude Code session: `claude mcp add saybooks-local -e SAYBOOKS_WORKSPACE=$USER -- node <path>/mcp-server.js`

## Honest limits

Not multi-currency, not multi-entity, no tax engine (rates are captured and frozen per line;
determination is an integration's job), no outbound anything — Saybooks never emails a
customer, charges a card, or books a shipment. It records what happened. The deferred list
with reasons is in [specs/o2c/spec.md](specs/o2c/spec.md) §9.

## License

[AGPL-3.0-only](LICENSE). Copyright (C) 2026 Peter Varga.
If you run a modified Saybooks as a service, share your changes — that's the deal.
