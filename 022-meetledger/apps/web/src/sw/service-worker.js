/* MeetLedger service worker.
 * Built from apps/web/src/sw/service-worker.js — the precache list and version are injected at build time.
 *
 * - App shell: precached on install, cache-first for hashed /assets/*, network-first for navigations (falls back to
 *   the cached index.html so the PWA opens offline).
 * - API GET: network-first. Successful JSON responses for a small whitelist (Upcoming, Brief, My Actions, notes,
 *   meeting detail, dashboard) are copied into IndexedDB so they can be shown offline. Offline responses carry
 *   `x-ml-cache: offline` + `x-ml-cached-at` so the UI can label them as possibly stale.
 * - Mutations are NEVER replayed by the worker. The page owns the offline queue (outbox) and resolves conflicts with
 *   the user (optimistic concurrency, server data is never silently overwritten).
 * - Media (/api/files), exports and /mcp are never cached.
 */
/* eslint-disable no-restricted-globals */
const VERSION = '__ML_VERSION__';
const PRECACHE = [/*__ML_PRECACHE__*/];
const SHELL_CACHE = 'ml-shell-' + VERSION;
const DB_NAME = 'ml-sw';
const STORE = 'api';
const MAX_ENTRIES = 400;

const CACHEABLE_API = [
  /^\/api\/me$/,
  /^\/api\/setup\/status$/,
  /^\/api\/w\/[^/]+$/,
  /^\/api\/w\/[^/]+\/dashboard$/,
  /^\/api\/w\/[^/]+\/meetings$/,
  /^\/api\/w\/[^/]+\/meetings\/[^/]+$/,
  /^\/api\/w\/[^/]+\/meetings\/[^/]+\/brief$/,
  /^\/api\/w\/[^/]+\/meetings\/[^/]+\/notes$/,
  /^\/api\/w\/[^/]+\/meetings\/[^/]+\/agenda$/,
  /^\/api\/w\/[^/]+\/actions$/,
  /^\/api\/w\/[^/]+\/commitments$/,
];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('storedAt', 'storedAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      Promise.resolve(fn(store)).then((r) => {
        result = r;
      });
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function reqP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function cacheGet(key) {
  const db = await openDb();
  try {
    return await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
  } finally {
    db.close();
  }
}

async function cachePut(entry) {
  await withStore('readwrite', (store) => {
    store.put(entry);
  });
  // Prune the oldest entries so the offline cache stays small.
  const db = await openDb();
  try {
    const count = await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).count());
    if (count > MAX_ENTRIES) {
      const tx = db.transaction(STORE, 'readwrite');
      const idx = tx.objectStore(STORE).index('storedAt');
      let toDelete = count - MAX_ENTRIES;
      idx.openCursor().onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (cursor && toDelete > 0) {
          cursor.delete();
          toDelete -= 1;
          cursor.continue();
        }
      };
    }
  } finally {
    db.close();
  }
}

async function cacheClear() {
  await withStore('readwrite', (store) => {
    store.clear();
  });
}

/** Never persist the per-session CSRF token. */
function sanitize(pathname, text) {
  if (pathname !== '/api/me') return text;
  try {
    const data = JSON.parse(text);
    delete data.csrfToken;
    return JSON.stringify(data);
  } catch {
    return text;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Add one by one: a missing optional file (e.g. an icon) must not break installation.
      await Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined)));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('ml-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'skip-waiting') self.skipWaiting();
  if (type === 'clear-api-cache') event.waitUntil(cacheClear().catch(() => undefined));
});

async function apiNetworkFirst(request, url) {
  const key = url.pathname + url.search;
  const cacheable = CACHEABLE_API.some((re) => re.test(url.pathname));
  try {
    const res = await fetch(request);
    if (res.status === 401 && url.pathname === '/api/me') {
      // Session ended: drop everything that was cached for the previous user.
      await cacheClear().catch(() => undefined);
    } else if (cacheable && res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      const copy = res.clone();
      copy
        .text()
        .then((text) => cachePut({ key, body: sanitize(url.pathname, text), storedAt: new Date().toISOString() }))
        .catch(() => undefined);
    }
    return res;
  } catch (err) {
    if (cacheable) {
      const hit = await cacheGet(key).catch(() => undefined);
      if (hit) {
        return new Response(hit.body, {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'x-ml-cache': 'offline', 'x-ml-cached-at': hit.storedAt },
        });
      }
    }
    return new Response(JSON.stringify({ error: { code: 'offline', message: 'Offline and no cached copy' } }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-ml-cache': 'miss' },
    });
  }
}

async function navigationNetworkFirst(request) {
  try {
    return await fetch(request);
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    const hit = (await cache.match('/index.html')) || (await cache.match('/'));
    if (hit) return hit;
    return new Response('<!doctype html><meta charset="utf-8"><title>MeetLedger</title><p>オフラインです / You are offline.</p>', {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') cache.put(request, res.clone()).catch(() => undefined);
  return res;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // mutations: handled by the page outbox, never queued here
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith('/api/files/') || p.startsWith('/mcp') || p.includes('/export') || p.endsWith('/book')) return;
  if (p.startsWith('/api/')) {
    if (p === '/api/health' || p.startsWith('/api/connectors/oauth')) return;
    event.respondWith(apiNetworkFirst(request, url));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(navigationNetworkFirst(request));
    return;
  }
  if (p.startsWith('/assets/') || p.startsWith('/icons/') || PRECACHE.includes(p)) {
    event.respondWith(cacheFirst(request));
  }
});
