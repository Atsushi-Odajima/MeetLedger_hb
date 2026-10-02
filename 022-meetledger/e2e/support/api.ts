import type { APIRequestContext, Page } from '@playwright/test';

export const OWNER = { email: 'owner@e2e.example.com', name: '山田 太郎', password: 'e2e-password-1234', orgName: 'E2E株式会社', workspaceName: '営業チーム' };

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    msg: string,
  ) {
    super(msg);
  }
}

/** Thin JSON client over a Playwright request context (shares cookies with the browser context when taken from it). */
export class Api {
  csrf = '';
  constructor(
    public req: APIRequestContext,
    public base: string,
  ) {}

  static of(page: Page, base: string) {
    return new Api(page.context().request, base);
  }

  async me(): Promise<any> {
    const r = await this.req.get(`${this.base}/api/me`);
    if (!r.ok()) throw new ApiError(r.status(), await r.text(), `GET /api/me -> ${r.status()}`);
    const j = await r.json();
    this.csrf = j.csrfToken ?? '';
    return j;
  }

  async call<T = any>(method: string, path: string, data?: unknown, extra: { multipart?: Record<string, any> } = {}): Promise<T> {
    if (method !== 'GET' && !this.csrf && !path.startsWith('/api/setup') && !path.startsWith('/api/auth/')) await this.me().catch(() => undefined);
    const r = await this.req.fetch(`${this.base}${path}`, {
      method,
      headers: { origin: this.base, ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}) },
      ...(extra.multipart ? { multipart: extra.multipart } : data !== undefined ? { data } : {}),
      timeout: 60_000,
    });
    const text = await r.text();
    if (!r.ok()) throw new ApiError(r.status(), text, `${method} ${path} -> ${r.status()} ${text.slice(0, 500)}`);
    const ct = r.headers()['content-type'] ?? '';
    return (ct.includes('json') && text ? JSON.parse(text) : text) as T;
  }
  get<T = any>(p: string) {
    return this.call<T>('GET', p);
  }
  post<T = any>(p: string, d: unknown = {}) {
    return this.call<T>('POST', p, d);
  }
  put<T = any>(p: string, d: unknown = {}) {
    return this.call<T>('PUT', p, d);
  }
  patch<T = any>(p: string, d: unknown = {}) {
    return this.call<T>('PATCH', p, d);
  }

  /** First-run setup (creates org + workspace + session cookie). Returns the workspace id. */
  async setup(o = OWNER): Promise<{ wsId: string; userId: string; orgId: string }> {
    await this.call('POST', '/api/setup', o);
    const me = await this.me();
    const ws = me.workspaces.find((w: any) => !w.isSample) ?? me.workspaces[0];
    return { wsId: ws.id, userId: me.user.id, orgId: ws.orgId };
  }

  async login(email = OWNER.email, password = OWNER.password) {
    await this.call('POST', '/api/auth/login', { email, password });
    this.csrf = '';
    return this.me();
  }
}

/** Workspace-scoped helpers. */
export class Ws {
  constructor(
    public api: Api,
    public wsId: string,
  ) {}
  p(path: string) {
    return `/api/w/${this.wsId}${path}`;
  }
  get<T = any>(p: string) {
    return this.api.get<T>(this.p(p));
  }
  post<T = any>(p: string, d: unknown = {}) {
    return this.api.post<T>(this.p(p), d);
  }
  put<T = any>(p: string, d: unknown = {}) {
    return this.api.put<T>(this.p(p), d);
  }
  patch<T = any>(p: string, d: unknown = {}) {
    return this.api.patch<T>(this.p(p), d);
  }

  async createMeeting(body: Record<string, unknown>): Promise<any> {
    const r = await this.post('/meetings', body);
    return r.meeting ?? r;
  }
  async meeting(id: string): Promise<any> {
    const r = await this.get(`/meetings/${id}`);
    return r.meeting ?? r;
  }
  async processing(id: string): Promise<any> {
    return this.get(`/meetings/${id}/processing`);
  }
  async review(): Promise<any[]> {
    const r = await this.get('/review');
    return r.items ?? [];
  }
}

export async function waitFor<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 60_000, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (ok(last)) return last;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out waiting for ${what}; last=${JSON.stringify(last)?.slice(0, 800)} err=${String((lastErr as Error)?.message ?? '')}`);
}

/** YYYY-MM-DD in Asia/Tokyo (the e2e user's timezone), offset by `days`. */
export function tokyoDate(days = 0): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
