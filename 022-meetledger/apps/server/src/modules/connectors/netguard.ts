import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { badRequest } from '../../lib/errors';

// SSRF protection for every user-supplied outbound URL (webhooks, generic webhook writes, ICS subscription URLs).
// Rules: https only (http only for localhost in development); no credentials in the URL; the host must not be or
// resolve to a private / loopback / link-local / CGNAT / multicast / reserved address unless explicitly allowed by env
// (CONNECTOR_ALLOW_PRIVATE_NETWORKS=1). Checked at registration AND again right before every delivery (DNS changes).
// Redirects are never followed automatically (callers use redirect:'manual').

/** Injectable resolver (tests replace `lookup`; production uses the system resolver with a timeout). */
export const dnsResolver = {
  lookup: async (host: string): Promise<string[]> => {
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dns timeout')), 3000).unref());
    const res = await Promise.race([lookup(host, { all: true, verbatim: true }), timeout]);
    return res.map((a) => a.address);
  },
};

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function isPrivateV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // embedded IPv4 (e.g. ::ffff:127.0.0.1)
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const n = v4ToInt(m[2]);
    s = `${m[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  if (all.length !== 8) return null;
  return all.map((h) => Number.parseInt(h || '0', 16));
}

function isPrivateV6(ip: string): boolean {
  const w = expandV6(ip);
  if (!w) return true; // unparsable => treat as unsafe
  const allZero = w.every((x) => x === 0);
  if (allZero) return true; // ::
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true; // ::1
  // IPv4-mapped / IPv4-compatible / NAT64 well-known prefix => check embedded v4
  const embedded = `${w[6] >> 8}.${w[6] & 0xff}.${w[7] >> 8}.${w[7] & 0xff}`;
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) return isPrivateV4(embedded);
  if (w[0] === 0x64 && w[1] === 0xff9b) return isPrivateV4(embedded);
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((w[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // documentation
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true;
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/i;

export interface OutboundUrlOptions {
  allowPrivateNetworks: boolean;
  allowHttpLocalhost: boolean;
}

/** Validates a user-supplied outbound URL. Throws 400 `unsafe_url` (generic message; never echoes the URL). */
export async function assertSafeOutboundUrl(raw: string, opts: OutboundUrlOptions): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest('Invalid URL', { code: 'invalid_url' });
  }
  if (u.username || u.password) throw badRequest('URL must not contain credentials', { code: 'unsafe_url' });
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const isLocalhostName = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (u.protocol === 'http:') {
    if (!(opts.allowHttpLocalhost && isLocalhostName)) throw badRequest('Only https URLs are allowed', { code: 'unsafe_url' });
    return u; // development-only localhost exception
  }
  if (u.protocol !== 'https:') throw badRequest('Only https URLs are allowed', { code: 'unsafe_url' });
  if (opts.allowPrivateNetworks) return u;
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw badRequest('URL targets a private or reserved network address', { code: 'unsafe_url' });
    return u;
  }
  if (LOCAL_NAMES.test(host) || !host.includes('.')) throw badRequest('URL targets a local host name', { code: 'unsafe_url' });
  let addrs: string[];
  try {
    addrs = await dnsResolver.lookup(host);
  } catch {
    throw badRequest('URL host could not be resolved', { code: 'unresolvable_host' });
  }
  if (!addrs.length) throw badRequest('URL host could not be resolved', { code: 'unresolvable_host' });
  if (addrs.some(isPrivateAddress)) throw badRequest('URL resolves to a private or reserved network address', { code: 'unsafe_url' });
  return u;
}
