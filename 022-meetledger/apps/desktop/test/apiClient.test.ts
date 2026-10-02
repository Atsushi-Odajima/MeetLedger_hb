import { describe, expect, it } from 'vitest';
import { ApiError, MeetLedgerApi, type FetchFn } from '../src/main/apiClient';

const ORIGIN = 'https://ml.example.jp';
const WS = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';

function fake(routes: Record<string, (init: RequestInit) => { status?: number; body?: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const key = `${init.method} ${url.replace(ORIGIN, '')}`;
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nf' } }), { status: 404 });
    const r = h(init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { fetchFn, calls };
}

describe('MeetLedgerApi (main-process client for the recorder page)', () => {
  it('fetches the CSRF token once and sends it with Origin on writes, using session cookies', async () => {
    let csrf = 'c1';
    const { fetchFn, calls } = fake({
      'GET /api/me': () => ({ body: { user: { name: 'A' }, workspaces: [{ id: WS, name: 'W', role: 'member' }], csrfToken: csrf } }),
      [`POST /api/w/${WS}/meetings/${M}/consent`]: (init) => ({ status: (init.headers as Record<string, string>)['x-csrf-token'] === csrf ? 200 : 403, body: {} }),
    });
    const api = new MeetLedgerApi(fetchFn, () => ORIGIN, { appVersion: '1.0.0', platform: 'linux' });
    await api.recordConsent(WS, M, 'notified', 'verbal');
    const post = calls.find((c) => c.init.method === 'POST')!;
    expect(post.init.credentials).toBe('include');
    expect((post.init.headers as Record<string, string>).origin).toBe(ORIGIN);
    expect(JSON.parse(post.init.body as string)).toMatchObject({ kind: 'recording', state: 'notified', method: 'verbal', details: { client: 'desktop' } });
    // session rotated → 403 → token refreshed once and retried
    csrf = 'c2';
    await api.recordConsent(WS, M, 'confirmed', 'verbal');
    expect(calls.filter((c) => c.url.endsWith('/api/me')).length).toBe(2);
  });

  it('maps 409 consent_required from error.details.code and 401 to unauthenticated', async () => {
    const { fetchFn } = fake({
      'GET /api/me': () => ({ body: { csrfToken: 't' } }),
      [`POST /api/w/${WS}/meetings/${M}/start`]: () => ({ status: 409, body: { error: { code: 'conflict', message: '録音前に…', details: { code: 'consent_required' } } } }),
      [`GET /api/w/${WS}/meetings/${M}`]: () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'x' } } }),
    });
    const api = new MeetLedgerApi(fetchFn, () => ORIGIN, { appVersion: '1', platform: 'linux' });
    await expect(api.start(WS, M)).rejects.toMatchObject({ code: 'consent_required', status: 409 });
    await expect(api.meeting(WS, M)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('refuses to run without a configured server and reports network errors', async () => {
    const api = new MeetLedgerApi(async () => new Response('{}'), () => null, { appVersion: '1', platform: 'linux' });
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    const api2 = new MeetLedgerApi(
      async () => {
        throw new Error('ECONNREFUSED');
      },
      () => ORIGIN,
      { appVersion: '1', platform: 'linux' },
    );
    await expect(api2.me()).rejects.toMatchObject({ code: 'network' });
  });

  it('posts local transcripts as JSON to the documented endpoint', async () => {
    const { fetchFn, calls } = fake({
      'GET /api/me': () => ({ body: { csrfToken: 't' } }),
      [`POST /api/w/${WS}/meetings/${M}/transcript/local`]: () => ({ body: { ok: true } }),
    });
    const api = new MeetLedgerApi(fetchFn, () => ORIGIN, { appVersion: '1', platform: 'linux' });
    await api.postLocalTranscript(WS, M, { provider: 'local-sherpa', model: 'm', language: 'ja', segments: [{ startMs: 0, endMs: 1, text: 'x' }] });
    const c = calls.at(-1)!;
    expect(c.url).toBe(`${ORIGIN}/api/w/${WS}/meetings/${M}/transcript/local`);
    expect((c.init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});
