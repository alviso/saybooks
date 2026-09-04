'use strict';
// Servers cannot go stale; clients cache. Say so where the agent will read it.
const CACHE_NOTE = `

If core_schema lists a command your tools do not have, or shows more arguments than a tool accepts, your
client cached an older tool list: remove and re-add this connector, then start a new chat. core_schema is
generated from the registry the tools come from and is always current.`;
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

function buildServer(workspace, demo, member = { name: 'owner', role: 'owner' }, mounts = null) {
  /* Every key introduces itself FIRST: which book this is, whose, and what the key may do.
   * A session that connects to the wrong space notices at the greeting, not at the audit. */
  let identity = null;
  try { identity = require('./users.js').spaceIdentity(workspace); } catch { /* no users store locally */ }

  const ownedNote = identity ? `THIS KEY OPENS ONE BOOK: the space "${identity.space}" (workspace ${workspace}),
owned by ${identity.owner}. This is a real, persistent space — not a demo. You hold ${member.name}'s
key with the role "${member.role}": you are their delegate and can do exactly what they can. A
command the role does not permit is refused with a sentence naming who to ask; relay it rather
than routing around it. Every write through this connection lands in THIS book and no other —
identically named tools on a different Saybooks connector are a different book. If this is not
the book you mean to write in, stop and ask for that space's key. The same space is in the
browser at https://saybooks.io/app — writes appear there live, attributed to actor_kind=agent,
in the same audit trail as clicks.

` : '';

  const demoNote = (!identity && demo) ? `

You are connected to sandbox workspace "${workspace}" on the Saybooks hosted demo, through
${member.name}'s key, with the role "${member.role}" — you are ${member.name}'s delegate and can
do exactly what they can. A command their role does not permit is refused with a sentence naming
who to ask; relay it rather than routing around it. It is private
to whoever holds this URL, seeded with example data, and swept after 24 hours. The same sandbox
is visible in the browser at https://saybooks.io/app?ws=${workspace} — share that link with the
person you are working with and they will see your writes appear live, attributed to
actor_kind=agent, in the same audit trail as their clicks. Play freely; nothing here is real.` : '';

  const server = new Server(
    { name: 'saybooks', version: '0.3.0' },
    { capabilities: { tools: {} }, instructions: ownedNote + R.instructions(BASE, { modules: mounts }) + demoNote + CACHE_NOTE },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: R.mcpTools({ modules: mounts }) }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    if (!R.byName[name] || (mounts && !mounts.includes(R.byName[name].module))) return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
    const { _reason, ...rest } = args;
    try {
      const out = await R.execute(name, await R.prepare(name, rest), { workspace, actor: member.name, actor_kind: 'agent', role: member.role, session: `mcp-http:${workspace}`, reason: _reason });
      // A result may carry binary attachments (a rendered page, a PDF). They become MCP content blocks:
      // an image the model can look at, a resource the client can hand to the person.
      if (out && typeof out === 'object' && Array.isArray(out._attachments)) {
        const { _attachments, ...rest } = out;
        const content = [{ type: 'text', text: JSON.stringify(rest, null, 1) }];
        for (const a of _attachments) {
          if (a.kind === 'image') content.push({ type: 'image', data: a.data, mimeType: a.mime });
          else content.push({ type: 'resource', resource: { uri: a.uri || `saybooks://${a.name}`, mimeType: a.mime, blob: a.data } });
        }
        return { content };
      }
      return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] };
    } catch (e) {
      // Business refusals come back as text the model should relay, not swallow.
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });

  return server;
}

async function handleMcp(req, res, body, workspace, demo, member, mounts = null) {
  const server = buildServer(workspace, demo, member, mounts);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

module.exports = { handleMcp };
