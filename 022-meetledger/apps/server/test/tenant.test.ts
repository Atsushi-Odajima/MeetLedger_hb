import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';
import { withTenant, withSystem } from '../src/db/pool';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

describe('#25 tenant isolation (A -> B rejected at API and DB/RLS level)', () => {
  it('blocks cross-tenant access', async () => {
    const a = await env.setupOwner('a@example.com');
    const b = await env.createTenant('b@example.com');
    const m = await a.client.post(`/api/w/${a.workspaceId}/meetings`, { title: 'A secret', visibility: 'workspace' });
    expect(m.status).toBe(200);

    // API: tenant B cannot see A's workspace nor its meeting, even with a valid id.
    expect((await b.client.get(`/api/w/${a.workspaceId}`)).status).toBe(404);
    expect((await b.client.get(`/api/w/${a.workspaceId}/meetings/${m.body.id}`)).status).toBe(404);
    expect((await b.client.get(`/api/w/${b.workspaceId}/meetings/${m.body.id}`)).status).toBe(404);
    expect((await b.client.post(`/api/w/${a.workspaceId}/meetings`, { title: 'inject' })).status).toBe(404);

    // DB: with tenant B's context, RLS hides A's rows even for an unfiltered query.
    const seen = await withTenant(env.pool, b.orgId, async (db) => (await db.query('SELECT id FROM meetings')).rows);
    expect(seen.find((r) => r.id === m.body.id)).toBeUndefined();
    // and inserting a row for tenant A from tenant B's context is rejected by the WITH CHECK policy
    await expect(
      withTenant(env.pool, b.orgId, (db) =>
        db.query("INSERT INTO people(org_id, workspace_id, name) VALUES ($1,$2,'x')", [a.orgId, a.workspaceId]),
      ),
    ).rejects.toThrow(/row-level security/);
    // without any tenant context nothing is visible
    const none = await env.pool.query('SELECT count(*)::int n FROM meetings');
    expect(none.rows[0].n).toBe(0);
    const sys = await withSystem(env.pool, async (db) => (await db.query('SELECT count(*)::int n FROM meetings')).rows[0].n);
    expect(sys).toBeGreaterThan(0);
  });

  it('the application role is not superuser and cannot bypass RLS', async () => {
    const r = await env.pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
