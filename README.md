# Saybooks

**The books you can talk to. The books that stay books.**

Saybooks is an ERP where your agent and your interface are the same system — one command
registry, one rulebook, one audit trail. Tell Claude to ship the order, or click the button:
same command, same rules, same record of who did what and why.

**Live demo: [saybooks.io](https://saybooks.io)** — no signup; you get a private sandbox with
example books. Point your own Claude at it over MCP and watch your words become attributed,
reasoned ledger entries next to the human ones.

## Why this exists

"Conversational ERP" usually means a chat layer bolted onto a system that doesn't know the
agent exists. Saybooks inverts that: every business act is **declared once**, and everything
else is *derived* from that declaration —

| derived | so that |
|---|---|
| the MCP tool (name, doctrine, JSON Schema) | the agent sees exactly what the UI can do |
| the UI form (fields, widgets, validation) | the human sees exactly what the agent can do |
| the guard evaluation | a greyed-out button's tooltip, the thrown refusal, and the agent's answer are **the same sentence** — asserted by test |
| the audit row | every write from either surface lands in one log with an actor; refusals included |

Nothing outside the registry may call a handler. A click and a tool call go through the same
command, the same guards, the same transaction. The two surfaces cannot drift, because neither
is authored — and `test/contract.test.js` fails the build if anyone tries.

## What's inside

```
src/registry.js            declare once; derive tools, forms, guards, audit — and enforce
src/workspace.js           a SQLite database per workspace (per contributor, per sandbox)
src/members.js             capability-token identity: named members with roles
src/modules/core/          master data, stock/price/credit acts, registry-wide reads
src/modules/o2c/           order-to-cash: 25 acts, spec-exact
specs/o2c/spec.md          the curated area spec: 21 invariants, lifecycles, read models
specs/o2c/scenarios/       9 executable conformance scenarios (refusals are contract)
src/conformance.js         replays scenarios through the real registry; keeps evidence
server.js                  workbench + hosted demo + MCP-over-HTTP (all one registry)
mcp-server.js              stdio MCP for local development
test/contract.test.js      the 12-gate contract (see below)
```

**The o2c vertical**, calibrated for a 5–200 person company selling on account: quotes, orders,
a credit gate that counts committed value, partial fulfilment and backorders, invoicing from
what shipped, returns and credit notes, cash application, refunds, write-offs, customer
statements, AR aging. Money is integer cents, everywhere.

**Access control**: every command declares a permission tag; four roles (owner / controller /
clerk / viewer); enforcement at the registry choke point; denials are one-sentence refusals,
logged — attempted overreach is reviewable. An agent connecting through a member's token is
that member's *delegate*: their name, their permissions.

## The 12-gate contract

Every module — present and future — is held to: MCP/UI parity · namespace prefixes ·
doctrine on every write · guards declared · table ownership (no cross-module writes) ·
a 25-tool budget · module mounts · one-sentence rule · audit behavior · fixture replay ·
**spec conformance** (an implementation claiming an area must map every act and pass every
scenario) · **permissions** (unpermissioned commands do not ship).

The endgame is competing implementations of the same area, certified by replaying the same
scenario files — the spec speaks in acts, not commands, so any conforming module runs them.

## Run it

```bash
npm install
npm test          # the 12 gates
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
