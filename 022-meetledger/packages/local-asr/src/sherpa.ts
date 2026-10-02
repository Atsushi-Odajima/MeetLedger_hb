import { createRequire } from 'node:module';

// sherpa-onnx-node is a native addon (optional dependency). It is loaded lazily so that environments without the
// prebuilt binary (e.g. win-arm64, CI images) can still import this package; callers check sherpaStatus() first.

type SherpaModule = any;

let injected: SherpaModule | null = null;
let cached: { mod: SherpaModule } | { error: string } | null = null;

/** Lets a host (e.g. Electron with an asar-unpacked addon path) provide the already-required module. */
export function setSherpaModule(mod: SherpaModule | null) {
  injected = mod;
  cached = null;
}

/** Base path for createRequire: works in ESM (import.meta.url) and in CJS bundles (__filename). */
export function requireBase(): string {
  return typeof __filename !== 'undefined' ? __filename : import.meta.url;
}

function localRequire(): NodeRequire {
  return createRequire(requireBase());
}

export function loadSherpa(): SherpaModule {
  if (injected) return injected;
  if (!cached) {
    try {
      cached = { mod: localRequire()('sherpa-onnx-node') };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      cached = { error: `sherpa-onnx-node を読み込めません（このOS/CPU向けのネイティブバイナリが無い可能性）: ${msg.split('\n')[0].slice(0, 200)}` };
    }
  }
  if ('error' in cached) throw new Error(cached.error);
  return cached.mod;
}

/** Low-level addon (for async APIs not wrapped by the JS layer). Null when unavailable or a module was injected. */
export function loadSherpaAddon(): any | null {
  if (injected) return injected.__addon ?? null;
  try {
    loadSherpa();
    return localRequire()('sherpa-onnx-node/addon.js');
  } catch {
    return null;
  }
}

export function sherpaStatus(): { ok: boolean; reason?: string; version?: string } {
  try {
    const m = loadSherpa();
    return { ok: true, version: String(m.version ?? 'unknown') };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
