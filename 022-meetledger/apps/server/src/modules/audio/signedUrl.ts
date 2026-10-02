import type { Config } from '../../config';
import type { Clock } from '../../lib/clock';
import { hmac, safeEqual } from '../../lib/crypto';

// Short-lived media URLs: HMAC-SHA256(SESSION_SECRET) over asset id + user id + expiry. The /api/files route ALSO
// requires the same authenticated user and re-checks the meeting ACL, so a leaked URL is useless to anyone else.

function payload(assetId: string, userId: string, exp: number) {
  return `media:v1:${assetId}:${userId}:${exp}`;
}

export function signFileUrl(cfg: Pick<Config, 'SESSION_SECRET' | 'SIGNED_URL_TTL_SEC'>, clock: Clock, assetId: string, userId: string, ttlSec = cfg.SIGNED_URL_TTL_SEC) {
  const exp = Math.floor(clock.now().getTime() / 1000) + Math.max(1, ttlSec);
  const sig = hmac(cfg.SESSION_SECRET, payload(assetId, userId, exp));
  const q = new URLSearchParams({ u: userId, exp: String(exp), sig });
  return { url: `/api/files/${assetId}?${q.toString()}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export type SignatureCheck = 'ok' | 'expired' | 'invalid';

export function verifyFileSignature(cfg: Pick<Config, 'SESSION_SECRET'>, clock: Clock, assetId: string, userId: string, exp: number, sig: string): SignatureCheck {
  if (!Number.isInteger(exp) || exp <= 0 || !sig) return 'invalid';
  const expected = hmac(cfg.SESSION_SECRET, payload(assetId, userId, exp));
  if (!safeEqual(expected, sig)) return 'invalid';
  if (exp * 1000 <= clock.now().getTime()) return 'expired';
  return 'ok';
}
