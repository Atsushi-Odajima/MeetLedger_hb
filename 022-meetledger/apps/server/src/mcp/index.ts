import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createMcpHandler, type AuthInfo as McpAuthInfo } from '@modelcontextprotocol/server';
import type { AuthInfo } from '../context';
import { safeErrorMessage } from '../lib/logger';
import type { ModuleDef } from '../modules/types';
import { buildMcpServer, injectBackend } from './tools';

// MCP endpoint: Streamable HTTP at /mcp, stateless (no Mcp-Session-Id), Bearer API token required.
// SDK: @modelcontextprotocol/server v2 `createMcpHandler` — serves MCP 2026-07-28 (per-request envelope, server/discover)
// AND 2025-era clients (initialize handshake; 2025-11-25 … 2024-10-07) through its stateless legacy fallback on the same URL.
// Each request builds a fresh McpServer bound to the caller's token (see docs/MCP_PLUGIN.md).

const FORWARD_HEADERS = ['accept', 'content-type', 'mcp-protocol-version', 'mcp-method', 'mcp-name'];
const WWW_AUTH = 'Bearer realm="MeetLedger MCP", error="invalid_token", error_description="A MeetLedger API token is required"';

function jsonRpcError(reply: FastifyReply, status: number, code: number, message: string) {
  return reply.status(status).type('application/json').send({ jsonrpc: '2.0', error: { code, message }, id: null });
}

const mod: ModuleDef = {
  name: 'mcp',
  routes(app, deps) {
    const handler = createMcpHandler(
      (rc) => {
        const ai = rc.authInfo;
        const extra = (ai?.extra ?? {}) as { userId?: string; orgId?: string; workspaceId?: string };
        const backend =
          ai && extra.userId && extra.orgId && extra.workspaceId
            ? injectBackend(app, ai.token, { userId: extra.userId, orgId: extra.orgId, workspaceId: extra.workspaceId }, ai.scopes)
            : null;
        return buildMcpServer(deps, backend);
      },
      { onerror: (e) => deps.log.warn({ err: safeErrorMessage(e) }, 'mcp request error'), maxRequestBodySize: 1_000_000 },
    );

    // Invalid tokens are rejected by the global auth hook (401) — add the RFC 6750 challenge for MCP clients.
    app.addHook('onSend', async (req, reply, payload) => {
      if (reply.statusCode === 401 && req.url.startsWith('/mcp')) reply.header('www-authenticate', WWW_AUTH);
      return payload;
    });

    const serve = async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = (req as any).auth as AuthInfo | null;
      if (!auth || auth.via !== 'token' || !auth.tokenWorkspaceId || !auth.tokenOrgId) {
        reply.header('www-authenticate', WWW_AUTH);
        return jsonRpcError(reply, 401, -32001, 'Authentication required: send Authorization: Bearer <MeetLedger API token>');
      }
      if (req.method !== 'POST') {
        // Stateless server: no standalone SSE stream (GET) and no session to delete (DELETE).
        reply.header('allow', 'POST');
        return jsonRpcError(reply, 405, -32000, 'Method not allowed.');
      }
      const token = String(req.headers.authorization).slice(7).trim();
      const headers = new Headers();
      for (const h of FORWARD_HEADERS) {
        const v = req.headers[h];
        if (typeof v === 'string') headers.set(h, v);
      }
      if (!headers.has('accept')) headers.set('accept', 'application/json, text/event-stream');
      const authInfo: McpAuthInfo = {
        token,
        clientId: 'meetledger-api-token',
        scopes: auth.scopes ?? [],
        extra: { userId: auth.user.id, orgId: auth.tokenOrgId, workspaceId: auth.tokenWorkspaceId },
      };
      const request = new Request(`${deps.config.APP_ORIGIN.replace(/\/$/, '')}/mcp`, { method: 'POST', headers, body: JSON.stringify(req.body ?? null) });
      const res = await handler.fetch(request, { authInfo, parsedBody: req.body });
      reply.status(res.status);
      res.headers.forEach((v, k) => {
        if (!['content-length', 'transfer-encoding', 'connection', 'mcp-session-id'].includes(k)) reply.header(k, v);
      });
      if (!res.body) return reply.send();
      if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) return reply.send(Readable.fromWeb(res.body as any));
      return reply.send(Buffer.from(await res.arrayBuffer()));
    };

    app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', handler: serve });
  },
};
export default mod;
