import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const hmac = (secret: string | Buffer, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// OWASP Password Storage Cheat Sheet: scrypt N=2^17, r=8, p=1.
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const SCRYPT_TEST = { N: 2 ** 12, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const params = process.env.MEETLEDGER_FAST_HASH === '1' ? SCRYPT_TEST : SCRYPT;
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 32, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [alg, n, r, p, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  });
  return timingSafeEqual(key, expected);
}

/** Derives a purpose/tenant specific 32-byte key from the master key (HKDF-SHA256). */
export function deriveKey(masterKeyB64: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(masterKeyB64, 'base64'), Buffer.alloc(0), info, 32));
}

/** AES-256-GCM: returns base64("v1" | iv | tag | ciphertext). Used for connector tokens / small secrets. */
export function encryptString(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from('v1'), iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptString(key: Buffer, payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  if (buf.subarray(0, 2).toString() !== 'v1') throw new Error('Unknown ciphertext version');
  const iv = buf.subarray(2, 14);
  const tag = buf.subarray(14, 30);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(30)), d.final()]).toString('utf8');
}
