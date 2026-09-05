# Contributing to Saybooks

The unit of contribution is the **module**, and the contract is enforced, not aspirational.

## Before anything

1. Read [specs/o2c/spec.md](specs/o2c/spec.md) — the shape of an area spec: acts, invariants,
   lifecycles, read models, contract-vs-freedom, deferred-with-reasons.
2. Open the demo's **Spec tab** and walk a scenario or two — it teaches the rules as
   filled-in forms, refusals included.
3. Run `npm test`. The contract gates are the review (16 checks at the time of writing —
   the header of `test/contract.test.js` names them: parity, namespace, doctrine, guards,
   ownership, budget, mounts, one sentence, audit, fixtures, conformance, permissions,
   human-only). A PR that adds a hand-written form, a prefix-less command, a cross-module
   table write, or an unpermissioned command fails in CI, not in code review.
4. The specs are public at [saybooks.io/specs](https://saybooks.io/specs) — every area, its
   acts and invariants, every scenario, and the last conformance run.

## The module contract, in prose

- **Declare once.** A command's tool, form, guards, and audit row derive from one declaration.
  Never hand-author a form or a tool.
- **Doctrine is not optional.** Every write command teaches — the prose an agent reads before
  calling and a human reads above the form. One string, because it is one rule.
- **One sentence per rule.** A guard's tooltip and its thrown refusal must be the same string.
  Refusals name the numbers.
- **Own your tables.** Reads and joins across modules are free; writes go through the owning
  module's exported API (`core.adjustStock` is the canonical example).
- **Stay under 25 tools.** Past that, ask which of your commands are really the same business act.
- **Spec first for new areas.** An area arrives as a spec (acts + invariants + scenarios)
  before its implementation. Spec PRs are separate from implementation PRs; the spec has a
  single curator per area.
- **Competing implementations are welcome** — that is the point. Claim an area with
  `implements: {area, spec, acts, argmap}` and pass its scenarios.
- **Reads may render.** A read handler may return a promise for pure rendering work (a PDF,
  a picture), provided every database read happened synchronously first — the workspace is
  only current inside the call. Results may carry `_attachments`; the MCP layer projects
  them to content blocks, the HTTP API reports them by name and size.
- **Refusals name the fix.** "X has no billing address — ask for it, call
  core_update_customer, and come back." The agent reading it at 3 a.m. should know what to do.

## A good first module

Mirror an existing module at a different calibration, the way `solo` mirrors the invoicing
half of `o2c` for a company of one: spec first (`specs/<area>/spec.md`, `acts.json`, two
scenario files with at least one refusal), then the module. Look for the issue labelled
**good first module** in the tracker; it names a candidate area and the acts it needs.

## Practical notes

- Workspaces isolate data per contributor: `OTC_WORKSPACE=you npm run mcp`, `?ws=you` in the
  workbench. Fixtures (`fixtures/*.json`) are command scripts — seeded state has a real audit
  trail.
- Money is integer cents. A float is a bug, not a rounding choice.
- SQLite: double-quoted tokens are identifiers, not strings. Single-quote SQL literals.

Questions, module ideas, or a spec you want to write: hello@saybooks.io.
