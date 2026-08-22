# otc — a modular ERP skeleton where the UI and the MCP cannot drift

A sketch built to test two claims. First: "keep the UI and the MCP in tandem" should be a
structural property, not a discipline. Second: that property survives multiple contributors
working on separate functional areas against one deployment.

## The shape

```
src/registry.js            the choke point: define, derive, execute, log
src/workspace.js           a SQLite database per contributor; code shared, data not
src/modules/<name>/        the unit of contribution
  index.js                 manifest: name, prefix, owned tables, doctrine, api, subjects
  commands/*.js            declarations — everything else is derived
  migrations/NNN_*.sql     numbered, per module
fixtures/*.json            command scripts: seeded state has a real audit trail
specs/<area>/spec.md       the curated area spec (acts, invariants, read models)
specs/<area>/acts.json     its machine layer: required acts + invariant list
specs/<area>/scenarios/    executable conformance: act-named steps, ok/refused assertions
src/conformance.js         replays scenarios through the real registry; keeps the evidence
test/contract.test.js      the contributor contract, as assertions (incl. gate 11: conformance)
```

Every command is declared once. Derived from that one declaration: the MCP tool, the UI form,
the guard evaluation (greyed buttons ≡ `core_next_actions`, same sentence verbatim), and the
audit row. Nothing outside the registry may call a handler; both servers call `execute()`,
which differs between them only by `actor_kind`.

## Try it

```
npm run demo     # full quote→cash run, human and agent alternating, plus workspace isolation
npm test         # the 10-point contract
npm start        # workbench on http://127.0.0.1:8140 — ?ws=<name> picks your workspace
npm run mcp      # stdio MCP; OTC_WORKSPACE=you OTC_MODULES=core,o2c
```

Register for a dev session: `claude mcp add otc -e OTC_WORKSPACE=$USER -- node <path>/mcp-server.js`.
Reset your workspace to shared state: ask the agent to `core_reset_workspace` with fixture `acme`,
or click it in the workbench. Fixtures replay through the real registry — a seeded workspace is
indistinguishable from one built by hand, and a fixture that violates a business rule fails loudly.

## The contributor contract (`npm test`)

1. **parity** — MCP tool and UI form derive from one declaration; fields, required sets, enums
   and doctrine are asserted identical on both surfaces
2. **namespace** — every command carries its module's prefix; collisions are impossible
3. **doctrine** — every write command teaches; empty doctrine does not ship
4. **guards** — every instance write declares what blocks it, or says `guardless: true` out loud
5. **ownership** — no module writes a table it does not own (reads and joins stay free); it uses
   the owner's api — o2c depletes stock only through `core.adjustStock`
6. **budget** — ≤25 tools per module; past that, the review question is which commands are
   really the same business act
7. **mounts** — `OTC_MODULES=core` yields exactly core's tools, and `core_schema` reports only
   what is mounted; this is how the ERP grows past one agent's tool budget
8. **one sentence** — a guard's tooltip and the thrown refusal are the same string, verbatim
9. **audit** — reads never log; refused writes always do, with their actor
10. **fixtures** — the shared fixture replays cleanly

The ownership and namespace gates are verified to actually trip — with messages that name the
fix ("writes item, owned by core — use core's api instead").

Gate 11 is the spec made enforceable: a module declaring `implements: {area, spec, acts, argmap}`
must map every spec act to a real command and pass every scenario. Scenarios speak in *acts*,
not commands, so any competing implementation runs the same files.

## Spec visibility

The spec is a live object, not a document nobody opens:

- **Workbench → Spec tab**: conformance status (derived from the implements map and the last
  run — never asserted), the act table with per-act implemented/exercised flags, every
  invariant with the evidence that exercises it, and each scenario expandable into its
  step-by-step trace. **Replay** runs a scenario live in a scratch workspace through the real
  registry — same guards, same audit log — which is what makes it a teaching surface: the
  steps show act → command, the arguments, the doctrine note, and what actually came back.
  The refusal steps teach more than the happy path.
- **Agent side**: `core_spec_status` returns the same report; `core_replay_scenario`
  (non-production only) replays and returns the trace, so a session can walk a newcomer
  through how the area works using real executions.

## Workspaces

One deployment, one registry, one set of rules; `data/ws_<name>.db` per contributor. The MCP
session (`OTC_WORKSPACE`) and the browser tab (`?ws=`) name the same workspace and therefore see
the same rows — test conversationally, verify in the UI. Workspaces isolate data, not authority:
there is no auth here, deliberately, and adding it starts with a `permissions` field on the
command declaration, not with the workspace layer.

## What this deliberately is not

No tax, no multi-currency, no GL posting, no period close, no credit notes, no returns. Those are
the parts that make ERP hard; the architecture does not make them easier — it makes them land as
modules under the same contract. Still stubbed: authorization (a `permissions` field the registry
enforces, greying the button and hiding the tool from one declaration) and reversal (each
irreversible act needs a compensating command; `o2c_void_invoice` is the only one so far).
