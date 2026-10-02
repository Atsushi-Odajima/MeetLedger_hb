import { createHash, randomBytes } from 'node:crypto';
import type { Deps } from '../../context';
import { one, withTenant } from '../../db/pool';
import { AppError } from '../../lib/errors';
import { openSecret, sealSecret } from './secrets';

// OAuth 2.0 authorization code + PKCE (S256). `state` and the code_verifier are kept server-side
// (connector_oauth_states: state hashed, verifier encrypted, 10 min TTL, one-time). Tokens are exchanged/refreshed
// only through deps.http.fetch (kind 'connector') and stored encrypted in connector_accounts.secret_ciphertext.

export type OAuthProvider = 'google_calendar' | 'microsoft_calendar' | 'gmail';

export const GOOGLE_SCOPES = {
  eventsReadonly: 'https://www.googleapis.com/auth/calendar.events.readonly',
  calendarListReadonly: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  gmailCompose: 'https://www.googleapis.com/auth/gmail.compose',
};
export const MS_SCOPES = { calendarsReadBasic: 'https://graph.microsoft.com/Calendars.ReadBasic', offlineAccess: 'offline_access' };

export interface ProviderDef {
  provider: OAuthProvider;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  /** scopes always requested (minimal) */
  scopes: string[];
  /** scope that MUST be granted for the connector to work */
  requiredScope: string;
  extraAuthParams: Record<string, string>;
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** Microsoft requires `scope` on token requests too. */
  scopeOnToken: boolean;
}

export function providerDef(deps: Pick<Deps, 'config'>, provider: OAuthProvider, opts: { calendarList?: boolean } = {}): ProviderDef {
  const c = deps.config;
  if (provider === 'microsoft_calendar') {
    const tenant = encodeURIComponent(c.MICROSOFT_TENANT || 'common');
    return {
      provider,
      authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      scopes: [MS_SCOPES.offlineAccess, MS_SCOPES.calendarsReadBasic],
      requiredScope: 'calendars.readbasic',
      extraAuthParams: { response_mode: 'query' },
      clientId: c.MICROSOFT_CLIENT_ID,
      clientSecret: c.MICROSOFT_CLIENT_SECRET,
      scopeOnToken: true,
    };
  }
  const google = {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' },
    clientId: c.GOOGLE_CLIENT_ID,
    clientSecret: c.GOOGLE_CLIENT_SECRET,
    scopeOnToken: false,
  };
  if (provider === 'gmail') return { provider, ...google, scopes: [GOOGLE_SCOPES.gmailCompose], requiredScope: GOOGLE_SCOPES.gmailCompose };
  return {
    provider,
    ...google,
    scopes: opts.calendarList ? [GOOGLE_SCOPES.eventsReadonly, GOOGLE_SCOPES.calendarListReadonly] : [GOOGLE_SCOPES.eventsReadonly],
    requiredScope: GOOGLE_SCOPES.eventsReadonly,
  };
}

export const redirectUri = (deps: Pick<Deps, 'config'>) => `${deps.config.APP_ORIGIN.replace(/\/$/, '')}/api/connectors/oauth/callback`;

const b64url = (b: Buffer) => b.toString('base64url');
export const hashState = (state: string) => createHash('sha256').update(state).digest('hex');

export function pkcePair() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  /** epoch ms */
  expiresAt: number | null;
  tokenType: string;
}

export const connectorError = (status: number, code: string, message: string) => new AppError(status, code, message);

/** Builds the authorize URL and stores state + verifier server-side. */
export async function startAuthorization(
  deps: Deps,
  ctx: { orgId: string; workspaceId: string; userId: string },
  provider: OAuthProvider,
  opts: { calendarList?: boolean } = {},
): Promise<{ authorizeUrl: string; scopes: string[] }> {
  const def = providerDef(deps, provider, opts);
  if (!def.clientId || !def.clientSecret) throw connectorError(409, 'connector_not_configured', `${provider} OAuth client is not configured on this server`);
  const state = b64url(randomBytes(32));
  const { verifier, challenge } = pkcePair();
  const now = deps.clock.now();
  await withTenant(deps.pool, ctx.orgId, (db) =>
    db.query(
      `INSERT INTO connector_oauth_states(org_id, workspace_id, user_id, provider, state_hash, verifier_ciphertext, redirect_uri, scopes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ctx.orgId, ctx.workspaceId, ctx.userId, provider, hashState(state), sealSecret(deps, { v: verifier }), redirectUri(deps), def.scopes, new Date(now.getTime() + 10 * 60_000)],
    ),
  );
  const q = new URLSearchParams({
    client_id: def.clientId,
    redirect_uri: redirectUri(deps),
    response_type: 'code',
    scope: def.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...def.extraAuthParams,
  });
  return { authorizeUrl: `${def.authorizeUrl}?${q.toString()}`, scopes: def.scopes };
}

async function tokenRequest(deps: Deps, orgId: string, def: ProviderDef, params: Record<string, string>, purpose: string): Promise<any> {
  const body = new URLSearchParams({ client_id: def.clientId ?? '', client_secret: def.clientSecret ?? '', ...params });
  if (def.scopeOnToken) body.set('scope', def.scopes.join(' '));
  let res: Response;
  try {
    res = await deps.http.fetch({
      orgId,
      kind: 'connector',
      provider: def.provider,
      purpose,
      url: def.tokenUrl,
      init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString(), redirect: 'manual' },
    });
  } catch {
    throw connectorError(502, 'connector_unreachable', 'OAuth token endpoint unreachable');
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || !json?.access_token) {
    // Never echo provider error descriptions (may contain request details); only the RFC 6749 error code.
    const code = typeof json?.error === 'string' ? json.error.slice(0, 40) : `http_${res.status}`;
    if (code === 'invalid_grant') throw connectorError(409, 'reauth_required', 'Connector authorization expired or was revoked. Please reconnect.');
    throw connectorError(502, 'oauth_token_error', `OAuth token request failed (${code})`);
  }
  return json;
}

function grantedScopes(json: any, requested: string[]): string[] {
  if (typeof json?.scope === 'string' && json.scope.trim()) return json.scope.trim().split(/\s+/);
  return requested;
}

/** Exchanges the authorization code (with PKCE verifier). Returns tokens + granted scopes; verifies the required scope was granted. */
export async function exchangeCode(deps: Deps, orgId: string, def: ProviderDef, code: string, verifier: string, redirect: string, requested: string[]) {
  const json = await tokenRequest(deps, orgId, def, { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }, 'oauth.code_exchange');
  const scopes = grantedScopes(json, requested);
  if (!scopes.some((s) => s.toLowerCase().includes(def.requiredScope.toLowerCase()))) {
    throw connectorError(400, 'scope_not_granted', 'The required read-only permission was not granted');
  }
  const tokens: StoredTokens = {
    accessToken: String(json.access_token),
    refreshToken: json.refresh_token ? String(json.refresh_token) : null,
    expiresAt: json.expires_in ? deps.clock.now().getTime() + Number(json.expires_in) * 1000 : null,
    tokenType: String(json.token_type ?? 'Bearer'),
  };
  return { tokens, scopes };
}

/** Returns a valid access token for an OAuth connector, refreshing (and persisting the new ciphertext) when expired. */
export async function accessTokenFor(deps: Deps, orgId: string, connector: { id: string; provider: string; secret_ciphertext: string | null }): Promise<string> {
  const tokens = openSecret<StoredTokens>(deps, connector.secret_ciphertext);
  if (!tokens?.accessToken) throw connectorError(409, 'reauth_required', 'Connector has no stored credentials. Please reconnect.');
  const now = deps.clock.now().getTime();
  if (!tokens.expiresAt || tokens.expiresAt - 60_000 > now) return tokens.accessToken;
  if (!tokens.refreshToken) throw connectorError(409, 'reauth_required', 'Connector authorization expired. Please reconnect.');
  const def = providerDef(deps, connector.provider as OAuthProvider);
  let json: any;
  try {
    json = await tokenRequest(deps, orgId, def, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, 'oauth.refresh');
  } catch (e) {
    if (e instanceof AppError && e.code === 'reauth_required') {
      await withTenant(deps.pool, orgId, (db) => db.query(`UPDATE connector_accounts SET status='error', last_error='reauth_required' WHERE id=$1`, [connector.id]));
    }
    throw e;
  }
  const next: StoredTokens = {
    accessToken: String(json.access_token),
    // Google usually omits refresh_token on refresh; Microsoft rotates it.
    refreshToken: json.refresh_token ? String(json.refresh_token) : tokens.refreshToken,
    expiresAt: json.expires_in ? now + Number(json.expires_in) * 1000 : null,
    tokenType: String(json.token_type ?? 'Bearer'),
  };
  const sealed = sealSecret(deps, next as unknown as Record<string, unknown>);
  await withTenant(deps.pool, orgId, (db) =>
    db.query('UPDATE connector_accounts SET secret_ciphertext=$2, expires_at=$3 WHERE id=$1', [connector.id, sealed, next.expiresAt ? new Date(next.expiresAt) : null]),
  );
  connector.secret_ciphertext = sealed;
  return next.accessToken;
}

/** Best-effort token revocation at the provider (Google only; Microsoft has no simple revoke endpoint). */
export async function revokeTokens(deps: Deps, orgId: string, connector: { provider: string; secret_ciphertext: string | null }) {
  if (connector.provider !== 'google_calendar' && connector.provider !== 'gmail') return;
  const tokens = openSecret<StoredTokens>(deps, connector.secret_ciphertext);
  const token = tokens?.refreshToken ?? tokens?.accessToken;
  if (!token) return;
  try {
    await deps.http.fetch({
      orgId,
      kind: 'connector',
      provider: connector.provider,
      purpose: 'oauth.revoke',
      url: 'https://oauth2.googleapis.com/revoke',
      init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString(), redirect: 'manual' },
    });
  } catch {
    /* best effort */
  }
}

/** Loads (and consumes) a pending OAuth state. Lookup by hash is an auth lookup (system context is not needed: org-scoped tx). */
export async function consumeState(deps: Deps, orgId: string, stateHash: string) {
  return withTenant(deps.pool, orgId, (db) =>
    one<any>(db, `UPDATE connector_oauth_states SET used_at=now() WHERE state_hash=$1 AND used_at IS NULL AND expires_at > $2 RETURNING *`, [stateHash, deps.clock.now()]),
  );
}
