import type { ExternalCall } from '../src/privacy/externalHttp';
import { dnsResolver } from '../src/modules/connectors/netguard';
import type { Client, TestEnv } from './helpers';

/** Deterministic DNS for SSRF tests (the real resolver / network is never used). */
export function fakeDns(map: Record<string, string[]>) {
  dnsResolver.lookup = async (host: string) => {
    const r = map[host.toLowerCase()];
    if (!r) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return r;
  };
}

type Route = (call: ExternalCall, url: URL) => Response | Promise<Response> | undefined;

/** FakeHttp responder dispatching on URL prefix; unknown URLs answer 599 so accidental calls are visible. */
export function routeResponder(routes: Record<string, Route | Response | (() => Response)>) {
  return async (call: ExternalCall): Promise<Response> => {
    const url = new URL(call.url);
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => `${url.origin}${url.pathname}`.startsWith(k));
    if (!key) return new Response(JSON.stringify({ error: 'unexpected_call' }), { status: 599 });
    const r = routes[key];
    if (r instanceof Response) return r.clone();
    const out = await (r as Route)(call, url);
    return out ?? new Response('{}', { status: 200 });
  };
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

export async function createApiToken(c: Client, workspaceId: string, scopes: ('read' | 'write')[] = ['read'], name = 'test') {
  const r = await c.post(`/api/w/${workspaceId}/api-tokens`, { name, scopes });
  if (r.status !== 200) throw new Error(`token create failed ${r.status} ${r.raw}`);
  return r.body.token as string;
}

export function bearer(env: TestEnv, token: string) {
  const c = env.client();
  c.bearer = token;
  return c;
}

/** Parses a Streamable HTTP response body (JSON or SSE) into the JSON-RPC message. */
export function parseMcpBody(raw: string, contentType: string | undefined): any {
  if ((contentType ?? '').includes('text/event-stream')) {
    const data = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    return data.length ? JSON.parse(data[data.length - 1]) : null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'meetledger-test', version: '1.0.0' },
};

/** Sends one JSON-RPC request to /mcp. era 'legacy' = 2025-era client (no envelope); 'modern' = 2026-07-28 envelope. */
export async function mcpRpc(env: TestEnv, token: string | null, method: string, params?: Record<string, unknown>, opts: { era?: 'legacy' | 'modern'; id?: number; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(opts.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  let p = params;
  if (opts.era === 'modern') {
    p = { ...(params ?? {}), _meta: MODERN_META };
    headers['mcp-protocol-version'] = '2026-07-28';
    headers['mcp-method'] = method;
    if (method === 'tools/call') headers['mcp-name'] = String(params?.name);
  }
  const res = await env.app.inject({ method: 'POST', url: '/mcp', headers, payload: JSON.stringify({ jsonrpc: '2.0', id: opts.id ?? 1, method, ...(p ? { params: p } : {}) }) });
  return { status: res.statusCode, headers: res.headers, message: parseMcpBody(res.body, res.headers['content-type'] as string | undefined), raw: res.body };
}

/** tools/call helper returning { isError, data } where data = structuredContent. */
export async function callTool(env: TestEnv, token: string, name: string, args: Record<string, unknown> = {}, era: 'legacy' | 'modern' = 'legacy') {
  const r = await mcpRpc(env, token, 'tools/call', { name, arguments: args }, { era });
  if (r.status !== 200 || !r.message?.result) throw new Error(`tools/call ${name} failed: ${r.status} ${r.raw.slice(0, 500)}`);
  return { isError: !!r.message.result.isError, data: r.message.result.structuredContent as any, result: r.message.result };
}

/** Routes a fetch() into app.inject (for SDK clients in tests). */
export function injectFetch(env: TestEnv) {
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init.headers as any).forEach((v, k) => (headers[k] = v));
    const res = await env.app.inject({ method: (init.method ?? 'GET') as any, url: `${u.pathname}${u.search}`, headers, payload: (init.body as string) ?? undefined });
    const h = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    return new Response(res.statusCode === 204 || res.statusCode === 202 ? null : res.body, { status: res.statusCode, headers: h });
  };
}
