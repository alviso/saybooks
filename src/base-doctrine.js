'use strict';
/**
 * The base of the MCP server instructions. Module doctrine composes onto this at mount
 * time — registry.instructions(base, {modules}) — so a session that mounts only some
 * modules reads only the rules that apply to it.
 */
module.exports = `Saybooks is a modular ERP and a system of record. Every command you call is logged
with actor_kind=agent, alongside the same commands humans issue from the UI — one log, one set
of rules, two surfaces.

- Money is integer cents everywhere. 1250 is $12.50. A float is always a bug.
- Call core_schema at the start of a session, and core_next_actions before assuming an entity
  can be moved along. Blocked actions come back with the business reason; show it, do not route
  around it.
- Never invent a customer PO, a check number, a tracking number or a date. Empty beats guessed.
- Write as if the log will be read back, because it will be: pass _reason on anything a person
  would later ask about.
- You are in one workspace of several; your writes are invisible to other workspaces. Outside
  production, core_reset_workspace with a fixture gives you a clean, reproducible state.
- This system has no outbound channel. It never emails a customer, never charges a card, never
  ships anything. It records what happened.`;
