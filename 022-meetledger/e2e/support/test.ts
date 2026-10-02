import { test as base, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Api, OWNER, Ws } from './api';
import { startServer, type RunningServer, type ServerOptions } from './server';

let current: RunningServer | null = null;

export interface ServerHandle {
  srv: RunningServer;
  /** Per-file scratch dir for generated WAV / export files. */
  work: string;
}

/**
 * Registers beforeAll/afterAll hooks that start an isolated server (own port + fresh DB) for the calling spec file.
 * Every test in the file shares it; the `baseURL` fixture points at it.
 */
export function useServer(opts: ServerOptions | (() => ServerOptions | Promise<ServerOptions>)): ServerHandle {
  const h = {} as ServerHandle;
  base.beforeAll(async () => {
    base.setTimeout(150_000);
    const o = typeof opts === 'function' ? await opts() : opts;
    h.work = mkdtempSync(path.join(tmpdir(), `ml-e2e-work-${o.name}-`));
    current = h.srv = await startServer(o);
  });
  base.afterAll(async () => {
    await h.srv?.stop();
    if (h.work) rmSync(h.work, { recursive: true, force: true });
    current = null;
  });
  base.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && h.srv) await info.attach('server.log', { body: h.srv.logTail(400), contentType: 'text/plain' });
  });
  return h;
}

export const test = base.extend<{ api: Api }>({
  baseURL: async ({}, use) => {
    await use(current?.url);
  },
  api: async ({ page }, use) => {
    await use(Api.of(page, current!.url));
  },
});
export { expect };

/** API setup (first owner) + browser session in the page's context. Returns workspace helper. */
export async function setupOwner(api: Api, o = OWNER): Promise<{ ws: Ws; userId: string; orgId: string }> {
  const { wsId, userId, orgId } = await api.setup(o);
  await api.call('PATCH', '/api/me', { timezone: 'Asia/Tokyo', locale: 'ja' });
  return { ws: new Ws(api, wsId), userId, orgId };
}

/** Collects uncaught page errors so a spec can assert the UI stayed healthy. */
export function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
  return errors;
}
