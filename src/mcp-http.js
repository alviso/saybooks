'use strict';
/**
 * The hosted MCP endpoint — surface #1 over HTTP, so a visitor can point their own agent at
 * their own sandbox: `claude mcp add -t http saybooks https://saybooks.io/mcp/<workspace>`.
 *
 * Stateless Streamable HTTP: every request gets a fresh Server + transport pair, torn down
 * when the response closes. Every tool here is synchronous request/response — no push, no
 * subscriptions — so per-request statelessness costs nothing and removes all session
 * bookkeeping. The workspace rides in the URL path; execute() scopes everything else.
 *
 * This is the same registry the browser drives. A tool call from here and a button click in
 * the workbench land in the same audit log, distinguishable only by actor_kind — which is
 * the entire pitch, now demonstrable by the visitor personally.
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const R = require('./registry.js');
const BASE = require('./base-doctrine.js');

function buildServer(workspace, demo) {
  const demoNote = demo ? `

You are connected to sandbox workspace "${workspace}" on the Saybooks hosted demo. It is private
to whoever holds this URL, seeded with example data, and swept after 24 hours. The same sandbox
is visible in the browser at https://saybooks.io — a person watching it there sees your writes
appear live, attributed to actor_kind=agent. Play freely; nothing here is real.` : '';

  const server = new Server(
    { name: 'saybooks', version: '0.3.0' },
    { capabilities: { tools: {} }, instructions: R.instructions(BASE) + demoNote },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: R.mcpTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    if (!R.byName[name]) return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
    const { _reason, ...rest } = args;
    try {
      const out = R.execute(name, rest, { workspace, actor: 'claude', actor_kind: 'agent', session: `mcp-http:${workspace}`, reason: _reason });
      return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] };
    } catch (e) {
      // Business refusals come back as text the model should relay, not swallow.
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });

  return server;
}

async function handleMcp(req, res, body, workspace, demo) {
  const server = buildServer(workspace, demo);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

module.exports = { handleMcp };
