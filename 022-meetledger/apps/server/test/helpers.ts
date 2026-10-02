import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../src/config';
import { buildApp, type BuildOptions } from '../src/app';
import { createPool, withTenant, type Db, type Pool } from '../src/db/pool';
import { FakeClock } from '../src/lib/clock';
import type { Deps } from '../src/context';
import type { Worker } from '../src/jobs/queue';
import type { ExternalCall, ExternalHttp } from '../src/privacy/externalHttp';
import { GuardedHttp } from '../src/privacy/externalHttp';
import { ADMIN_URL, templateName } from './global-setup';

process.env.MEETLEDGER_FAST_HASH = '1';

export async function createTestDb(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `ml_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const tpl = process.env.ML_TEMPLATE_DB ?? templateName();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (let i = 0; ; i++) {
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${tpl}`);
      break;
    } catch (e: any) {
      if (i > 20 || !/being accessed|already exists/.test(String(e.message))) throw e;
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    }
  }
  await admin.end();
  return {
    url: ADMIN_URL.replace(/\/[^/]+$/, `/${name}`),
    drop: async () => {
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Records every outbound call; by default passes them to a fake responder (never the real network). */
export class FakeHttp implements ExternalHttp {
  calls: ExternalCall[] = [];
  private guard: GuardedHttp;
  constructor(
    pool: Pool,
    public responder: (call: ExternalCall) => Promise<Response> | Response = () => new Response('{}', { status: 200 }),
  ) {
    this.guard = new GuardedHttp(pool, (async (url: string, init: RequestInit) => {
      const call = this.calls[this.calls.length - 1];
      return this.responder({ ...call, url, init });
    }) as any);
  }
  async fetch(call: ExternalCall): Promise<Response> {
    this.calls.push(call);
    return this.guard.fetch(call);
  }
  byKind(kind: string) {
    return this.calls.filter((c) => c.kind === kind);
  }
}

export interface TestEnv {
  app: FastifyInstance;
  deps: Deps;
  worker: Worker;
  pool: Pool;
  clock: FakeClock;
  http: FakeHttp;
  config: Config;
  logs: string[];
  storageDir: string;
  close(): Promise<void>;
  /** Creates owner via first-run setup and returns logged-in client + ids. */
  setupOwner(email?: string, opts?: { orgName?: string }): Promise<{ client: Client; orgId: string; workspaceId: string; userId: string }>;
  /** Invites a user into the workspace with the given role and returns a logged-in client. */
  addUser(owner: Client, orgId: string, workspaceId: string, email: string, role: 'admin' | 'member' | 'viewer'): Promise<{ client: Client; userId: string }>;
  /** Creates a separate org (tenant B) with its own owner (signup bypass). */
  createTenant(email: string): Promise<{ client: Client; orgId: string; workspaceId: string; userId: string }>;
  client(): Client;
  tenantTx<T>(orgId: string, fn: (db: Db) => Promise<T>): Promise<T>;
}

export class Client {
  cookie = '';
  csrf = '';
  bearer = '';
  constructor(private app: FastifyInstance) {}
  async req(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && method !== 'GET') h['x-csrf-token'] = this.csrf;
    if (this.bearer) h.authorization = `Bearer ${this.bearer}`;
    const res = await this.app.inject({ method: method as any, url, payload: payload as any, headers: h });
    const set = res.headers['set-cookie'];
    if (set) {
      const arr = Array.isArray(set) ? set : [set];
      for (const c of arr) {
        const m = c.match(/^ml_sid=([^;]*)/);
        if (m) this.cookie = m[1] ? `ml_sid=${m[1]}` : '';
      }
    }
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, body: json, raw: res.body, headers: res.headers };
  }
  get(url: string) {
    return this.req('GET', url);
  }
  post(url: string, payload?: unknown) {
    return this.req('POST', url, payload ?? {});
  }
  patch(url: string, payload?: unknown) {
    return this.req('PATCH', url, payload ?? {});
  }
  put(url: string, payload?: unknown) {
    return this.req('PUT', url, payload ?? {});
  }
  del(url: string) {
    return this.req('DELETE', url);
  }
  async refreshCsrf() {
    const me = await this.get('/api/me');
    this.csrf = me.body?.csrfToken ?? '';
    return me.body;
  }
}

export async function createTestEnv(opts: Partial<BuildOptions> & { env?: Record<string, string>; now?: string } = {}): Promise<TestEnv> {
  const db = await createTestDb();
  const storageDir = mkdtempSync(join(tmpdir(), 'ml-store-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: db.url,
    STORAGE_DIR: join(storageDir, 'objects'),
    TMP_DIR: join(storageDir, 'tmp'),
    LOG_LEVEL: 'info',
    WEB_DIST_DIR: join(storageDir, 'no-web'),
    APP_ORIGIN: 'http://localhost:8787',
    ...(opts.env ?? {}),
  });
  const pool = createPool(db.url, 5);
  const clock = new FakeClock(new Date(opts.now ?? '2026-10-01T01:00:00Z'));
  const http = new FakeHttp(pool);
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk, _e, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  const built = await buildApp({ config, pool, clock, http, logStream, ...opts });
  await built.app.ready();
  const app = built.app;

  const env: TestEnv = {
    app,
    deps: built.deps,
    worker: built.worker,
    pool,
    clock,
    http: (opts.http as FakeHttp) ?? http,
    config,
    logs,
    storageDir,
    client: () => new Client(app),
    tenantTx: (orgId, fn) => withTenant(pool, orgId, fn),
    async close() {
      await app.close();
      await pool.end();
      await db.drop();
      rmSync(storageDir, { recursive: true, force: true });
    },
    async setupOwner(email = 'owner@example.com', o = {}) {
      const c = new Client(app);
      const r = await c.post('/api/setup', { email, name: 'Owner', password: 'correct horse battery', orgName: o.orgName ?? 'Acme', workspaceName: 'Main' });
      if (r.status !== 200) throw new Error(`setup failed ${r.status} ${r.raw}`);
      const me = await c.refreshCsrf();
      return { client: c, orgId: me.orgs[0].id, workspaceId: me.workspaces[0].id, userId: me.user.id };
    },
    async addUser(owner, orgId, workspaceId, email, role) {
      const inv = await owner.post(`/api/orgs/${orgId}/invitations`, { email, role, workspaceId });
      if (inv.status !== 200) throw new Error(`invite failed ${inv.status} ${inv.raw}`);
      const token = new URL(inv.body.inviteUrl).searchParams.get('token');
      const c = new Client(app);
      const r = await c.post('/api/auth/accept-invite', { token, name: email.split('@')[0], password: 'correct horse battery' });
      if (r.status !== 200) throw new Error(`accept failed ${r.status} ${r.raw}`);
      const me = await c.refreshCsrf();
      return { client: c, userId: me.user.id };
    },
    async createTenant(email) {
      const { createOrgWithWorkspace } = await import('../src/modules/core/auth');
      const { hashPassword } = await import('../src/lib/crypto');
      const { withSystem, one } = await import('../src/db/pool');
      const h = await hashPassword('correct horse battery');
      const ids = await withSystem(pool, async (d) => {
        const u = await one<{ id: string }>(d, 'INSERT INTO users(email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', [email, email.split('@')[0], h]);
        const r = await createOrgWithWorkspace(d, u!.id, `Tenant ${email}`, 'Main');
        return { ...r, userId: u!.id };
      });
      const c = new Client(app);
      const r = await c.post('/api/auth/login', { email, password: 'correct horse battery' });
      if (r.status !== 200) throw new Error('login failed');
      await c.refreshCsrf();
      return { client: c, ...ids };
    },
  };
  return env;
}

/** Inserts a transcript with segments directly (for modules that do not depend on the audio pipeline). */
export async function insertTranscript(
  env: TestEnv,
  orgId: string,
  meetingId: string,
  segments: { speaker: string; text: string; startMs?: number; endMs?: number; confidence?: number; flags?: string[] }[],
  opts: { provider?: string; isLocal?: boolean } = {},
) {
  const { toTsvectorLiteral } = await import('@meetledger/shared');
  return env.tenantTx(orgId, async (db) => {
    const v = await db.query('SELECT coalesce(max(version),0)+1 AS v FROM transcripts WHERE meeting_id=$1', [meetingId]);
    await db.query('UPDATE transcripts SET is_current=false WHERE meeting_id=$1', [meetingId]);
    const t = await db.query(
      `INSERT INTO transcripts(org_id, meeting_id, version, provider, is_local, language, input_hash) VALUES ($1,$2,$3,$4,$5,'ja',$6) RETURNING id`,
      [orgId, meetingId, v.rows[0].v, opts.provider ?? 'fixture', opts.isLocal ?? true, `test-${Date.now()}-${Math.random()}`],
    );
    const transcriptId = t.rows[0].id;
    const speakers = new Map<string, string>();
    for (const s of segments) {
      if (!speakers.has(s.speaker)) {
        const r = await db.query(
          `INSERT INTO meeting_speakers(org_id, meeting_id, label, source) VALUES ($1,$2,$3,'diarization')
           ON CONFLICT (meeting_id, label) DO UPDATE SET label=EXCLUDED.label RETURNING id`,
          [orgId, meetingId, s.speaker],
        );
        speakers.set(s.speaker, r.rows[0].id);
      }
    }
    const ids: string[] = [];
    let t0 = 0;
    for (const [i, s] of segments.entries()) {
      const start = s.startMs ?? t0;
      const end = s.endMs ?? start + 4000;
      t0 = end;
      const r = await db.query(
        `INSERT INTO transcript_segments(org_id, transcript_id, meeting_id, seq, start_ms, end_ms, speaker_id, speaker_label, text, confidence, flags, tsv)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::tsvector) RETURNING id`,
        [orgId, transcriptId, meetingId, i, start, end, speakers.get(s.speaker), s.speaker, s.text, s.confidence ?? 0.9, s.flags ?? [], toTsvectorLiteral(s.text)],
      );
      ids.push(r.rows[0].id);
    }
    return { transcriptId, segmentIds: ids, speakerIds: Object.fromEntries(speakers) };
  });
}
