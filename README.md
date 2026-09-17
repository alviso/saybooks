# Saybooks

**The books you can talk to. The books that stay books.**

Saybooks is an open-source ERP where your agent and your interface are the same system: one
command registry, one rulebook, one audit trail. Tell Claude to ship the order, issue the
invoice or import a card statement, or click the button: same command, same rules, same record
of who did what and why.

**Live: [saybooks.io](https://saybooks.io)**. Try the demo with no signup, or sign in with Google
and pick the modules your books carry. Connect Claude by adding `https://saybooks.io/mcp` as a
connector (OAuth, no keys to paste); the same books are in the browser as ordinary pages.

Eight modules today, every one spec-first with executable conformance scenarios:

| module | for | what it keeps |
|---|---|---|
| **solo** (Invoicing) | freelancers | clients, invoices with a link and a PDF, payments, outstanding; any currency, your tax scheme |
| **o2c** (Order to cash) | small businesses | quotes, orders, shipments, invoices, receivables, with a credit gate the agent cannot talk past |
| **crm** | small businesses | campaigns, accounts, contacts with sources, gaps, pipeline; outreach drafts the agent writes and a person sends; events with their source and a calendar |
| **prospect** | anyone with a bought list | a holding area in front of the CRM: the agent stages and judges rows, only a person promotes |
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
src/modules/core, o2c, crm, prospect, jobhunt, solo, purchases, bridge
specs/<area>/spec.md       the area spec: calibration, entities, invariants, read models
specs/<area>/scenarios/    executable conformance scenarios (refusals are contract)
src/conformance.js         replays scenarios through the real registry; keeps evidence
server.js                  workbench + hosted demo + MCP + OAuth (all one registry)
mcp-server.js              stdio MCP for local development
test/contract.test.js      the 23-gate contract (see below)
test/smoke.mjs             every workbench view and detail panel rendered in headless Chrome
test/local/                plain-language scripts run against a local model, checked in the database
```

**Access control**: every command declares a permission tag; four roles (owner / controller /
clerk / viewer); enforcement at the registry choke point; denials are one-sentence refusals,
logged. An agent connecting through a member's key is that member's *delegate*: their name,
their permissions. Every write carries a reason; reads are never logged.

**Money** is integer minor units everywhere, with a currency; sums are per currency and never
cross. Nothing is invented: a missing amount, date or name is asked for, never guessed.

## The 23-gate contract

Every module — present and future — is held to: MCP/UI parity · namespace prefixes ·
doctrine on every write · guards declared · table ownership (no cross-module writes) ·
a tool budget · module mounts · one-sentence rule · audit behavior · fixture replay ·
**spec conformance** (an implementation claiming an area must map every act and pass every
scenario) · **permissions** (unpermissioned commands do not ship) · **spec version** (a module implements the version its acts file declares) · **human-only** (a field or a whole act a person must do, refused to agents whatever their role) · **the door** (staged rows are judged by an agent and promoted only by a person) · **the claim gate** (what a campaign may say is a person's to set, and holds on edit).

The endgame is competing implementations of the same area, certified by replaying the same
scenario files — the spec speaks in acts, not commands, so any conforming module runs them.

## Run it

```bash
npm install
npm test          # the 23 gates
npm run smoke     # every workbench view and panel, in headless Chrome
npm run local -- --model <id> --script plain-invoicing --instructions off   # a local model, plain prompts
npm run demo      # a full quote-to-cash run, human and agent interleaved
npm start         # workbench on http://127.0.0.1:8140
npm run mcp       # stdio MCP server (OTC_WORKSPACE=you)
```

Register for a Claude Code session: `claude mcp add saybooks-local -e SAYBOOKS_WORKSPACE=$USER -- node <path>/mcp-server.js`

## Local models

Saybooks is a plain MCP server, so a model on your own machine can keep the books with nothing
leaving it. Tested with Gemma 4 26B A4B in LM Studio on a 32 GB laptop: a full invoice cycle and
a full statement cycle from plain sentences, no coaching. In LM Studio's `mcp.json`:

```json
{ "mcpServers": { "saybooks": {
    "command": "/usr/local/bin/node",
    "args": ["/path/to/saybooks/mcp-server.js"],
    "env": { "SAYBOOKS_WORKSPACE": "main", "SAYBOOKS_MODULES": "core,solo", "SAYBOOKS_ACTOR": "gemma-4" }
} } }
```

`SAYBOOKS_MODULES` picks the tools the model sees (`core,solo` is 35 tools; `core,purchases` 48;
all eight modules is 144 and too many for a small model). Load the model with one concurrent slot.
What that took, and the six fixes it forced in the tools, is in
[saybooks.io/notes/local-models](https://saybooks.io/notes/local-models); the plain-language
harness that measures it is `npm run local`.

## Honest limits

Any currency per invoice but no conversion between them (sums stay per currency), one company
per space, no tax engine (rates are captured and frozen per line; determination is an
integration's job), no outbound anything: Saybooks never emails a customer, charges a card, or
books a shipment. It records what happened. The ledger hand-over writes import files for
QuickBooks Online and Xero; it does not post over their APIs. Each area's deferred list, with
reasons, is in its spec under `specs/`.

## License

[AGPL-3.0-only](LICENSE). Copyright (C) 2026 Peter Varga.
If you run a modified Saybooks as a service, share your changes — that's the deal.
