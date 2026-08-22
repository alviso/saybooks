# Contributing to Saybooks

The unit of contribution is the **module**, and the contract is enforced, not aspirational.

## Before anything

1. Read [specs/o2c/spec.md](specs/o2c/spec.md) — the shape of an area spec: acts, invariants,
   lifecycles, read models, contract-vs-freedom, deferred-with-reasons.
2. Open the demo's **Spec tab** and walk a scenario or two — it teaches the rules as
   filled-in forms, refusals included.
3. Run `npm test`. Those 12 gates are the review. A PR that adds a hand-written form, a
   prefix-less command, a cross-module table write, or an unpermissioned command fails in CI,
   not in code review.

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

## Practical notes

- Workspaces isolate data per contributor: `OTC_WORKSPACE=you npm run mcp`, `?ws=you` in the
  workbench. Fixtures (`fixtures/*.json`) are command scripts — seeded state has a real audit
  trail.
- Money is integer cents. A float is a bug, not a rounding choice.
- SQLite: double-quoted tokens are identifiers, not strings. Single-quote SQL literals.

Questions, module ideas, or a spec you want to write: hello@saybooks.io.
