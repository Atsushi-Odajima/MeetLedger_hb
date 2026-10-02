import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT, WEB_DIST } from './support/server';

/** Newest mtime under a directory (skips node_modules / dist). */
function newest(dir: string): number {
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    max = Math.max(max, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return max;
}

/**
 * Runs once before all specs:
 *  - starts the local PostgreSQL test cluster (scripts/pg-test.sh, idempotent) unless E2E_SKIP_PG=1
 *  - (re)builds the PWA when apps/web/dist is missing or older than apps/web sources (E2E_SKIP_BUILD=1 to skip)
 *  - checks that ffmpeg is available (fixture WAVs are generated with it)
 */
export default async function globalSetup() {
  if (!process.env.E2E_SKIP_PG) execFileSync('bash', [path.join(ROOT, 'scripts', 'pg-test.sh'), 'start'], { stdio: 'inherit' });
  const web = path.join(ROOT, 'apps', 'web');
  const distIndex = path.join(WEB_DIST, 'index.html');
  const stale = !existsSync(distIndex) || newest(path.join(web, 'src')) > statSync(distIndex).mtimeMs || newest(path.join(web, 'public')) > statSync(distIndex).mtimeMs;
  if (stale && !process.env.E2E_SKIP_BUILD) {
    console.log('[e2e] building apps/web (dist missing or stale)…');
    execFileSync('npm', ['run', 'build', '-w', '@meetledger/web'], { cwd: ROOT, stdio: 'inherit' });
  }
  execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
}
