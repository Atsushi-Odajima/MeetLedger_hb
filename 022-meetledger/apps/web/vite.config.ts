import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const API_TARGET = process.env.MEETLEDGER_API ?? 'http://localhost:8787';

function listPublic(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listPublic(p));
    else out.push('/' + relative(join(root, 'public'), p).split('\\').join('/'));
  }
  return out;
}

/**
 * Emits /sw.js from src/sw/service-worker.js with the app-shell precache list (hashed bundle files + public assets)
 * injected at build time. The worker is a classic script (no imports) so it runs on every browser with SW support.
 */
function serviceWorker(): Plugin {
  return {
    name: 'meetledger-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'sw.js');
      const pub = listPublic(join(root, 'public')).filter((f) => !f.endsWith('.map') && f !== '/og.png'); // OG image is for link previews only
      const precache = Array.from(new Set(['/', '/index.html', ...pub, ...files.map((f) => '/' + f)]));
      const raw = readFileSync(resolve(root, 'src/sw/service-worker.js'), 'utf8');
      const version = createHash('sha256').update(precache.join('|')).update(raw).digest('hex').slice(0, 12);
      const src = raw
        .replace('[/*__ML_PRECACHE__*/]', JSON.stringify(precache))
        .replace('__ML_VERSION__', version);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    port: 5173,
    proxy: {
      // The API checks Origin against APP_ORIGIN for CSRF defence; the dev proxy presents the API origin.
      '/api': { target: API_TARGET, changeOrigin: true, headers: { origin: API_TARGET } },
      '/mcp': { target: API_TARGET, changeOrigin: true, headers: { origin: API_TARGET } },
    },
  },
  preview: {
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true, headers: { origin: API_TARGET } },
      '/mcp': { target: API_TARGET, changeOrigin: true, headers: { origin: API_TARGET } },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
