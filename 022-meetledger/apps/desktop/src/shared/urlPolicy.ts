// URL allowlist rules (pure; unit tested). The desktop app only ever shows ONE remote origin: the configured
// MeetLedger server. Everything else is either a bundled local page (app://desktop/...) or opened in the OS browser.

import type { SenderKind } from './ipc';

export const LOCAL_SCHEME = 'app';
export const LOCAL_HOST = 'desktop';
export const LOCAL_ORIGIN = `${LOCAL_SCHEME}://${LOCAL_HOST}`;
export const LOCAL_PAGES = {
  settings: `${LOCAL_ORIGIN}/settings/index.html`,
  recorder: `${LOCAL_ORIGIN}/recorder/index.html`,
} as const;

export class UrlPolicyError extends Error {
  readonly code = 'invalid_server_url';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalizes what the user typed in the first-run settings into an origin ("https://host[:port]").
 * - https is required; plain http is only accepted for loopback (self-hosted dev server on the same machine).
 * - credentials, query and fragment are rejected; a path is dropped (the web app is served at "/").
 */
export function normalizeServerUrl(input: string): string {
  let raw = input.trim();
  if (!raw) throw new UrlPolicyError('サーバーURLを入力してください');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlPolicyError('URLの形式が正しくありません');
  }
  if (u.username || u.password) throw new UrlPolicyError('URLに認証情報を含めないでください');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UrlPolicyError('https:// のURLを指定してください');
  if (u.protocol === 'http:' && !LOOPBACK_HOSTS.has(u.hostname)) {
    throw new UrlPolicyError('http:// は localhost のみ許可されています。https:// を使用してください');
  }
  if (!u.hostname) throw new UrlPolicyError('ホスト名がありません');
  return u.origin;
}

/** Origin of a URL or null for opaque / unparsable URLs. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === `${LOCAL_SCHEME}:`) return u.host === LOCAL_HOST ? LOCAL_ORIGIN : null;
    if (u.origin === 'null') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function isSameOrigin(url: string, origin: string | null): boolean {
  if (!origin) return false;
  return originOf(url) === origin;
}

export function isLocalPage(url: string, page?: keyof typeof LOCAL_PAGES): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== `${LOCAL_SCHEME}:` || u.host !== LOCAL_HOST) return false;
    if (!page) return true;
    const p = new URL(LOCAL_PAGES[page]);
    return u.pathname === p.pathname;
  } catch {
    return false;
  }
}

export type NavigationDecision = 'allow' | 'external' | 'deny';

/**
 * Decision for renderer-initiated navigations / redirects / window.open.
 * - same origin as the configured server → allow (main window only)
 * - other https URL → open in the OS browser (OAuth for calendar connectors, help links, ...)
 * - mailto: → external
 * - everything else (file:, javascript:, data:, custom schemes, http to non-loopback) → deny
 */
export function decideNavigation(targetUrl: string, serverOrigin: string | null, opts: { allowInWindow: boolean }): NavigationDecision {
  let u: URL;
  try {
    u = new URL(targetUrl);
  } catch {
    return 'deny';
  }
  if (opts.allowInWindow && serverOrigin && originOf(targetUrl) === serverOrigin) return 'allow';
  if (u.protocol === 'https:') return 'external';
  if (u.protocol === 'mailto:') return 'external';
  return 'deny';
}

/** Classifies the frame that sent an IPC message. Only top-level frames are accepted (checked by the caller). */
export function classifySenderUrl(url: string, serverOrigin: string | null): SenderKind | null {
  if (serverOrigin && originOf(url) === serverOrigin) return 'web';
  if (isLocalPage(url, 'settings')) return 'settings';
  if (isLocalPage(url, 'recorder')) return 'recorder';
  return null;
}

/** Maps app://desktop/<path> to a file path relative to the bundled renderer dir, or null if not allowed. */
export function localAssetPath(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${LOCAL_SCHEME}:` || u.host !== LOCAL_HOST) return null;
  let p: string;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (p.includes('\0') || p.includes('\\')) return null;
  const parts = p.split('/').filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  if (parts.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return null;
  if (!/^(settings|recorder|common)$/.test(parts[0]!)) return null;
  const rel = parts.join('/');
  if (!/\.(html|js|css|png|svg|woff2)$/.test(rel)) return null;
  return rel;
}

export const LOCAL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self'",
  "font-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');
