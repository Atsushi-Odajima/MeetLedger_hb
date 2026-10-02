import { describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError, createApiClient, listOf, qs } from './api';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string; credentials?: string };

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Fake fetch recording calls; `handler` decides the response. */
function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const c: Call = {
      url: String(input),
      method: (init.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init.body === 'string' ? init.body : undefined,
      credentials: init.credentials,
    };
    calls.push(c);
    return handler(c);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('API client — CSRF header', () => {
  it('sends x-csrf-token on every non-GET request and never on GET', async () => {
    const { fn, calls } = fakeFetch(() => json(200, { ok: true }));
    const api = createApiClient({ fetch: fn });
    api.setCsrf('tok-123');
    await api.get('/api/w/1/meetings');
    await api.post('/api/w/1/meetings', { title: 'x' });
    await api.put('/api/w/1/meetings/2/notes', { body: '', baseVersion: 0 });
    await api.patch('/api/w/1/actions/3', { status: 'done' });
    await api.del('/api/w/1/meetings/2');
    const byMethod = Object.fromEntries(calls.map((c) => [c.method, c]));
    expect(byMethod.GET.headers['x-csrf-token']).toBeUndefined();
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(byMethod[m].headers['x-csrf-token']).toBe('tok-123');
    expect(calls.every((c) => c.credentials === 'same-origin')).toBe(true);
    expect(byMethod.POST.headers['content-type']).toBe('application/json');
    expect(JSON.parse(byMethod.POST.body!)).toEqual({ title: 'x' });
  });

  it('fetches the token from GET /api/me before the first mutation', async () => {
    const { fn, calls } = fakeFetch((c) => (c.url === '/api/me' ? json(200, { csrfToken: 'from-me', user: {} }) : json(200, {})));
    const api = createApiClient({ fetch: fn });
    await api.post('/api/w/1/meetings', { title: 'x' });
    expect(calls[0].url).toBe('/api/me');
    expect(calls[1].headers['x-csrf-token']).toBe('from-me');
    expect(api.getCsrf()).toBe('from-me');
  });

  it('refreshes the token once and retries when the server rejects the CSRF token', async () => {
    let attempt = 0;
    const { fn, calls } = fakeFetch((c) => {
      if (c.url === '/api/me') return json(200, { csrfToken: 'fresh' });
      attempt += 1;
      if (c.headers['x-csrf-token'] !== 'fresh') return json(403, { error: { code: 'forbidden', message: 'CSRF token missing or invalid' } });
      return json(200, { id: 'm1' });
    });
    const api = createApiClient({ fetch: fn });
    api.setCsrf('stale');
    await expect(api.post('/api/w/1/meetings', {})).resolves.toEqual({ id: 'm1' });
    expect(attempt).toBe(2);
    expect(calls.filter((c) => c.url === '/api/me')).toHaveLength(1);
  });

  it('does not retry forever on repeated CSRF failures', async () => {
    const { fn, calls } = fakeFetch((c) => (c.url === '/api/me' ? json(200, { csrfToken: 'x' }) : json(403, { error: { code: 'forbidden', message: 'CSRF token missing or invalid' } })));
    const api = createApiClient({ fetch: fn });
    api.setCsrf('x');
    await expect(api.post('/api/w/1/meetings', {})).rejects.toBeInstanceOf(ApiError);
    expect(calls.filter((c) => c.url !== '/api/me')).toHaveLength(2);
  });
});

describe('API client — errors and offline', () => {
  it('maps error bodies to ApiError with code and details (409 server copy)', async () => {
    const { fn } = fakeFetch(() => json(409, { error: { code: 'conflict', message: 'Notes were changed on another device', details: { serverBody: 'S', serverVersion: 4 } } }));
    const api = createApiClient({ fetch: fn });
    api.setCsrf('t');
    const err = (await api.put("/x", {}).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('conflict');
    expect(err.details).toEqual({ serverBody: 'S', serverVersion: 4 });
  });

  it('raises NetworkError when fetch fails and reports offline', async () => {
    const { fn } = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const api = createApiClient({ fetch: fn });
    const states: string[] = [];
    api.onConnectivity((s) => states.push(s));
    await expect(api.get('/api/w/1/dashboard')).rejects.toBeInstanceOf(NetworkError);
    expect(states).toEqual(['offline']);
  });

  it('treats the service worker "offline, no copy" answer as a network error', async () => {
    const { fn } = fakeFetch(() => json(503, { error: { code: 'offline', message: 'Offline' } }, { 'x-ml-cache': 'miss' }));
    const api = createApiClient({ fetch: fn });
    await expect(api.get('/api/w/1/dashboard')).rejects.toBeInstanceOf(NetworkError);
  });

  it('flags data served from the offline cache', async () => {
    const { fn } = fakeFetch(() => json(200, { items: [] }, { 'x-ml-cache': 'offline', 'x-ml-cached-at': '2026-10-01T09:00:00.000Z' }));
    const api = createApiClient({ fetch: fn });
    const r = await api.raw('GET', '/api/w/1/meetings');
    expect(r.meta.cachedAt).toBe('2026-10-01T09:00:00.000Z');
  });

  it('calls onUnauthorized on 401', async () => {
    const onUnauthorized = vi.fn();
    const { fn } = fakeFetch(() => json(401, { error: { code: 'unauthorized', message: 'Authentication required' } }));
    const api = createApiClient({ fetch: fn, onUnauthorized });
    await expect(api.get('/api/me')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});

describe('helpers', () => {
  it('qs skips empty values', () => {
    expect(qs({ a: 1, b: '', c: undefined, d: null, e: 'x y' })).toBe('?a=1&e=x+y');
    expect(qs({})).toBe('');
  });
  it('listOf accepts arrays and wrapped lists', () => {
    expect(listOf([1, 2])).toEqual([1, 2]);
    expect(listOf({ items: [1] })).toEqual([1]);
    expect(listOf({ members: [3] }, 'members')).toEqual([3]);
    expect(listOf(null)).toEqual([]);
  });
});
