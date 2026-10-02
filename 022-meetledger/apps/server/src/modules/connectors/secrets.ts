import { createHash } from 'node:crypto';
import type { Deps } from '../../context';
import { decryptString, deriveKey, encryptString } from '../../lib/crypto';

// Connector credentials (OAuth tokens, Slack/HubSpot tokens, webhook URLs & signing secrets, private ICS URLs)
// are stored ONLY as AES-256-GCM ciphertext with a purpose-specific key derived from MASTER_KEY.
// They are never returned by the API and never logged.

let cached: { master: string; key: Buffer } | null = null;

export function connectorKey(deps: Pick<Deps, 'config'>): Buffer {
  const master = deps.config.MASTER_KEY;
  if (!cached || cached.master !== master) cached = { master, key: deriveKey(master, 'connector') };
  return cached.key;
}

export function sealSecret(deps: Pick<Deps, 'config'>, value: Record<string, unknown>): string {
  return encryptString(connectorKey(deps), JSON.stringify(value));
}

export function openSecret<T = Record<string, any>>(deps: Pick<Deps, 'config'>, ciphertext: string | null | undefined): T | null {
  if (!ciphertext) return null;
  return JSON.parse(decryptString(connectorKey(deps), ciphertext)) as T;
}

const truthy = (v: unknown) => typeof v === 'boolean' ? v : typeof v === 'string' && ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

/**
 * Connector-specific settings. They are read from the parsed config object first (so tests / embedders can set them on
 * deps.config) and then from the process environment, so config.ts does not need connector-specific keys.
 */
export function connectorSettings(deps: Pick<Deps, 'config'>) {
  const c = deps.config as unknown as Record<string, unknown>;
  const env = (k: string) => c[k] ?? process.env[k];
  return {
    /** Allow outbound webhooks / ICS URLs / generic webhook writes to private, loopback or link-local addresses. Default OFF. */
    allowPrivateNetworks: truthy(env('CONNECTOR_ALLOW_PRIVATE_NETWORKS')),
    /** http:// is only accepted for localhost in development. */
    allowHttpLocalhost: deps.config.NODE_ENV === 'development',
    /** Max ICS size (bytes) accepted from upload or URL. */
    icsMaxBytes: Number(env('ICS_MAX_BYTES') ?? 2_000_000),
  };
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x === undefined ? null : x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** Masks a URL for display: keeps scheme + host, hides path/query (private ICS / webhook URLs are secrets). */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '[invalid url]';
  }
}
