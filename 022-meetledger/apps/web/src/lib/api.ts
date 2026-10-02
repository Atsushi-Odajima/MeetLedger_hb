// Minimal typed HTTP client for the MeetLedger API.
// - Cookie session (same-origin credentials) + `x-csrf-token` header on every non-GET request (token from GET /api/me).
// - A 403 "CSRF" rejection refreshes the token once and retries (e.g. after the session was renewed in another tab).
// - Network failures raise NetworkError so callers can fall back to the offline queue.
// - Responses served by the service worker from its offline cache are flagged via `x-ml-cache: offline`.

export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isConflict() {
    return this.status === 409;
  }
  get isNotFound() {
    return this.status === 404;
  }
}

export class NetworkError extends Error {
  constructor(message = 'Network unavailable') {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface ResponseMeta {
  /** ISO timestamp when the data came from the offline cache, else null. */
  cachedAt: string | null;
  status: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** internal: skip CSRF refresh+retry */
  noRetry?: boolean;
}

export type ConnectivityListener = (state: 'online' | 'offline') => void;

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  onUnauthorized?: () => void;
}

export function isCsrfRejection(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403 && /csrf/i.test(e.message);
}

export function createApiClient(opts: ApiClientOptions = {}) {
  const base = opts.baseUrl ?? '';
  const doFetch: typeof fetch = (...args) => (opts.fetch ?? globalThis.fetch)(...args);
  let csrfToken: string | null = null;
  const connectivity = new Set<ConnectivityListener>();
  const emit = (s: 'online' | 'offline') => connectivity.forEach((l) => l(s));

  async function refreshCsrf(): Promise<string | null> {
    try {
      const res = await doFetch(base + '/api/me', { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) return null;
      if (res.headers.get('x-ml-cache')) return csrfToken; // offline copy never contains the token
      const me = await res.json();
      csrfToken = typeof me?.csrfToken === 'string' && me.csrfToken ? me.csrfToken : null;
      return csrfToken;
    } catch {
      return null;
    }
  }

  async function raw<T>(method: string, path: string, body?: unknown, o: RequestOptions = {}): Promise<{ data: T; meta: ResponseMeta }> {
    const headers: Record<string, string> = { accept: 'application/json', ...(o.headers ?? {}) };
    let payload: BodyInit | undefined;
    if (body instanceof FormData || body instanceof Blob) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (!SAFE.has(method)) {
      if (!csrfToken) await refreshCsrf();
      if (csrfToken) headers['x-csrf-token'] = csrfToken;
    }
    let res: Response;
    try {
      res = await doFetch(base + path, { method, headers, body: payload, credentials: 'same-origin', signal: o.signal });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      emit('offline');
      throw new NetworkError();
    }
    const cacheFlag = res.headers.get('x-ml-cache');
    const text = res.status === 204 ? '' : await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (cacheFlag === 'miss' || (res.status === 503 && (data as ApiErrorBody)?.error?.code === 'offline')) {
      emit('offline');
      throw new NetworkError();
    }
    if (cacheFlag === 'offline') emit('offline');
    else emit('online');
    if (!res.ok) {
      const err = (data as ApiErrorBody)?.error;
      const apiErr = new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? res.statusText ?? 'Request failed', err?.details);
      if (!o.noRetry && !SAFE.has(method) && isCsrfRejection(apiErr)) {
        csrfToken = null;
        await refreshCsrf();
        return raw<T>(method, path, body, { ...o, noRetry: true });
      }
      if (res.status === 401) opts.onUnauthorized?.();
      throw apiErr;
    }
    return { data: data as T, meta: { cachedAt: cacheFlag === 'offline' ? res.headers.get('x-ml-cached-at') ?? new Date(0).toISOString() : null, status: res.status } };
  }

  const call = <T>(method: string, path: string, body?: unknown, o?: RequestOptions) => raw<T>(method, path, body, o).then((r) => r.data);

  return {
    raw,
    get: <T>(path: string, o?: RequestOptions) => call<T>('GET', path, undefined, o),
    post: <T>(path: string, body?: unknown, o?: RequestOptions) => call<T>('POST', path, body ?? {}, o),
    put: <T>(path: string, body?: unknown, o?: RequestOptions) => call<T>('PUT', path, body ?? {}, o),
    patch: <T>(path: string, body?: unknown, o?: RequestOptions) => call<T>('PATCH', path, body ?? {}, o),
    del: <T>(path: string, o?: RequestOptions) => call<T>('DELETE', path, undefined, o),
    setCsrf(token: string | null) {
      csrfToken = token;
    },
    getCsrf: () => csrfToken,
    refreshCsrf,
    onConnectivity(l: ConnectivityListener) {
      connectivity.add(l);
      return () => connectivity.delete(l);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** App-wide singleton. */
export const api = createApiClient();

/** Builds a query string from defined, non-empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Accepts `T[]`, `{items: T[]}` or `{<key>: T[]}` (servers modules evolve; the UI stays tolerant). */
export function listOf<T>(x: unknown, ...keys: string[]): T[] {
  if (Array.isArray(x)) return x as T[];
  if (x && typeof x === 'object') {
    for (const k of ['items', ...keys, 'data', 'results']) {
      const v = (x as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof NetworkError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
