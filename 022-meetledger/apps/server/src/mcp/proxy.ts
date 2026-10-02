import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer, fromJsonSchema, type CallToolResult } from '@modelcontextprotocol/server';
import { SERVER_INFO, SERVER_INSTRUCTIONS } from './tools';

// stdio → Streamable HTTP proxy for local MCP clients (Codex CLI `command = ...`, Claude Desktop, IDEs).
// It holds NO business logic and NO database access: tools/list and tools/call are forwarded to the configured
// MeetLedger server (`<MEETLEDGER_URL>/mcp`) with the user's API token, so every rule (scopes, ACL, two-step
// confirmation stored server-side) is enforced remotely. Remote calls use the stable 2025-11-25 client
// (@modelcontextprotocol/sdk v1), which the server's stateless legacy path serves.

export interface ProxyOptions {
  /** MeetLedger base URL (https://…) or the full /mcp endpoint URL. */
  url: string;
  token: string;
  /** Injectable fetch (tests route it into app.inject). */
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

export function mcpEndpoint(raw: string): URL {
  const u = new URL(raw);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('MEETLEDGER_URL must use https:// (http:// only for localhost)');
  if (!u.pathname.replace(/\/$/, '').endsWith('/mcp')) u.pathname = `${u.pathname.replace(/\/$/, '')}/mcp`;
  return u;
}

export async function connectRemote(opts: ProxyOptions): Promise<Client> {
  const client = new Client({ name: 'meetledger-stdio-proxy', version: SERVER_INFO.version });
  const transport = new StreamableHTTPClientTransport(mcpEndpoint(opts.url), {
    requestInit: { headers: { authorization: `Bearer ${opts.token}` } },
    ...(opts.fetch ? { fetch: opts.fetch as any } : {}),
  });
  await client.connect(transport);
  return client;
}

/** Builds a local McpServer mirroring the remote tool list (names, schemas, annotations) and forwarding calls. */
export async function buildProxyServer(client: Client): Promise<McpServer> {
  const { tools } = await client.listTools();
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: fromJsonSchema(t.inputSchema as any), annotations: t.annotations },
      async (args: unknown) => (await client.callTool({ name: t.name, arguments: (args ?? {}) as Record<string, unknown> })) as CallToolResult,
    );
  }
  return server;
}
