#!/usr/bin/env node
'use strict';
/**
 * otc MCP server — stdio. Surface #1.
 *
 * One process, one workspace, an explicit module mount:
 *   OTC_WORKSPACE=peter OTC_MODULES=core,o2c node mcp-server.js
 *
 * Workspace defaults to $USER so each contributor's dev session lands in their own file
 * without configuration. Modules default to everything; a scoped mount (a finance
 * reviewer's session getting AR only) is how the tool count stays inside what a model
 * handles well as the ERP grows.
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const R = require('./src/registry.js');
const BASE = require('./src/base-doctrine.js');

R.loadModules();
const workspace = process.env.OTC_WORKSPACE || process.env.USER || 'main';
const modules = process.env.OTC_MODULES ? process.env.OTC_MODULES.split(',').map(s => s.trim()) : null;
if (modules) for (const m of modules) if (!R.MODULES.some(x => x.name === m)) {
  process.stderr.write(`[otc] unknown module "${m}" — have: ${R.MODULES.map(x => x.name).join(', ')}\n`);
  process.exit(1);
}
const mount = { modules };
const session = `mcp-${workspace}-${process.pid}`;

const server = new Server(
  { name: 'otc', version: '0.2.0' },
  { capabilities: { tools: {} }, instructions: R.instructions(BASE, mount) },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: R.mcpTools(mount) }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const cmd = R.byName[name];
  if (!cmd || (mount.modules && !mount.modules.includes(cmd.module))) {
    return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  }
  const { _reason, ...rest } = args;              // an optional why, carried into the log
  try {
    const out = R.execute(name, rest, { workspace, actor: 'claude', actor_kind: 'agent', session, reason: _reason, modules: mount.modules });
    return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] };
  } catch (e) {
    // Business refusals come back as text the model should relay, not swallow.
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
});

async function main() {
  require('./src/workspace.js').dbFor(workspace);     // open + migrate up front
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[otc] ready — workspace ${workspace}, modules ${modules ? modules.join(',') : 'all'}\n`);
}
main().catch(e => { process.stderr.write(`[otc] fatal: ${e.stack}\n`); process.exit(1); });
