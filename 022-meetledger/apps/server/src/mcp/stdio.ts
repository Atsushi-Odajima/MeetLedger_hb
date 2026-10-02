#!/usr/bin/env node
// MeetLedger MCP stdio entry (local clients). Proxies to a MeetLedger server; requires:
//   MEETLEDGER_URL    e.g. https://meetledger.example.com   (or …/mcp)
//   MEETLEDGER_TOKEN  a MeetLedger API token (Settings → API tokens; read or read+write)
// Run: `npx tsx apps/server/src/mcp/stdio.ts` (or the built JS). stdout is reserved for the protocol: logs go to stderr.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildProxyServer, connectRemote, mcpEndpoint } from './proxy';

const url = process.env.MEETLEDGER_URL ?? '';
const token = process.env.MEETLEDGER_TOKEN ?? '';
if (!url || !token) {
  process.stderr.write('meetledger-mcp: set MEETLEDGER_URL and MEETLEDGER_TOKEN\n');
  process.exit(2);
}
try {
  mcpEndpoint(url);
} catch (e) {
  process.stderr.write(`meetledger-mcp: ${(e as Error).message}\n`);
  process.exit(2);
}

let remote: Promise<Client> | null = null;
const getRemote = () => (remote ??= connectRemote({ url, token }).catch((e) => {
  remote = null;
  throw e;
}));

serveStdio(async () => buildProxyServer(await getRemote()), {
  onerror: (e) => process.stderr.write(`meetledger-mcp: ${String(e?.message ?? e).slice(0, 300)}\n`),
});
