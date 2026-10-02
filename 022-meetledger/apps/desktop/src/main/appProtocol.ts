// app://desktop/* serves the bundled local pages (settings, recorder) from dist/renderer with a strict CSP.
// A privileged standard+secure scheme gives the pages a real origin and a secure context (needed for
// getUserMedia / AudioWorklet) without enabling file:// access.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { protocol, type Session } from 'electron';
import { LOCAL_CSP, LOCAL_SCHEME, localAssetPath } from '../shared/urlPolicy';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/** Must run before app 'ready'. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: LOCAL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: false, corsEnabled: false } },
  ]);
}

export function handleAppScheme(ses: Session, rendererDir: string): void {
  const root = path.resolve(rendererDir);
  ses.protocol.handle(LOCAL_SCHEME, async (req) => {
    const rel = localAssetPath(req.url);
    if (!rel || req.method !== 'GET') return new Response('Not found', { status: 404 });
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
    try {
      const body = await fsp.readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
          'content-security-policy': LOCAL_CSP,
          'x-content-type-options': 'nosniff',
          'cross-origin-opener-policy': 'same-origin',
          'referrer-policy': 'no-referrer',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
