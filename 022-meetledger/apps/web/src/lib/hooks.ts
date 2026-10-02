import { useCallback, useEffect, useRef, useState } from 'react';
import { api, listOf, NetworkError } from './api';
import { listOps, subscribeOutbox, type OutboxOp } from './offline/outbox';

export interface ApiState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** Set when the data came from the offline cache (ISO timestamp of the cached copy). */
  cachedAt: string | null;
  reload(): void;
  setData(updater: T | ((cur: T | undefined) => T)): void;
}

/** GET a path (null = skip). Re-fetches when the path changes. Optional polling. */
export function useApi<T>(path: string | null, opts: { pollMs?: number; keepPrevious?: boolean } = {}): ApiState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    if (lastPath.current !== path && !opts.keepPrevious) setDataState(undefined);
    lastPath.current = path;
    setLoading(true);
    api
      .raw<T>('GET', path, undefined, { signal: ctrl.signal })
      .then((r) => {
        setDataState(r.data);
        setCachedAt(r.meta.cachedAt);
        setError(null);
      })
      .catch((e) => {
        if ((e as Error)?.name === 'AbortError') return;
        setError(e);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce]);

  useEffect(() => {
    if (!opts.pollMs || !path) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setNonce((n) => n + 1);
    }, opts.pollMs);
    return () => clearInterval(id);
  }, [opts.pollMs, path]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((u: T | ((cur: T | undefined) => T)) => {
    setDataState((cur) => (typeof u === 'function' ? (u as (c: T | undefined) => T)(cur) : u));
  }, []);
  return { data, error, loading, cachedAt, reload, setData };
}

/** Browser online state + API reachability (a failed request or an offline-cache answer flips it to offline). */
export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    const off = api.onConnectivity((s) => setOnline(s === 'online'));
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      off();
    };
  }, []);
  return online;
}

/** Live view of the offline queue. */
export function useOutbox(): { ops: OutboxOp[]; pending: number; conflicts: number; failed: number } {
  const [ops, setOps] = useState<OutboxOp[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      listOps()
        .then((o) => alive && setOps(o))
        .catch(() => undefined);
    load();
    const off = subscribeOutbox(load);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return {
    ops,
    pending: ops.filter((o) => o.status === 'pending').length,
    conflicts: ops.filter((o) => o.status === 'conflict').length,
    failed: ops.filter((o) => o.status === 'failed').length,
  };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(key, JSON.stringify(nv));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [v, set];
}

export const isOfflineError = (e: unknown) => e instanceof NetworkError;

/** Copies text to the clipboard (falls back to a hidden textarea). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Opaque cursor of a paged API response (`nextCursor`), if any. */
export function nextCursorOf(data: unknown): string | null {
  const c = (data as { nextCursor?: unknown } | null | undefined)?.nextCursor;
  return typeof c === 'string' && c ? c : null;
}

/** `total` of a paged API response (first page), if the server reports it. */
export function totalOf(data: unknown): number | undefined {
  const n = (data as { total?: unknown } | null | undefined)?.total;
  return typeof n === 'number' ? n : undefined;
}

export function withCursor(path: string, cursor: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`;
}

export interface PagedState<T> extends ApiState<unknown> {
  /** First page + every page loaded with loadMore (deduplicated by id). undefined until the first page arrives. */
  items: T[] | undefined;
  total: number | undefined;
  hasMore: boolean;
  loadingMore: boolean;
  moreError: unknown;
  loadMore(): Promise<void>;
}

/**
 * Cursor-paged list (`{ items, nextCursor, total }`): the first page comes from useApi (offline cache, reload), further
 * pages are appended by loadMore() using `?cursor=`.
 */
export function usePaged<T extends { id?: string }>(path: string | null, ...keys: string[]): PagedState<T> {
  const first = useApi<unknown>(path, { keepPrevious: true });
  const [extra, setExtra] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  useEffect(() => {
    setExtra([]);
    setCursor(nextCursorOf(first.data));
    setMoreError(null);
  }, [first.data]);
  const loadMore = useCallback(async () => {
    if (!path || !cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const r = await api.get<unknown>(withCursor(path, cursor));
      setExtra((cur) => [...cur, ...listOf<T>(r, ...keys)]);
      setCursor(nextCursorOf(r));
    } catch (e) {
      setMoreError(e);
    } finally {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, cursor]);
  let items: T[] | undefined;
  if (first.data !== undefined) {
    const seen = new Set<string>();
    items = [];
    for (const x of [...listOf<T>(first.data, ...keys), ...extra]) {
      if (x.id && seen.has(x.id)) continue;
      if (x.id) seen.add(x.id);
      items.push(x);
    }
  }
  return { ...first, items, total: totalOf(first.data), hasMore: !!cursor, loadingMore, moreError, loadMore };
}
