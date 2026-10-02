import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (022-meetledger). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MODELS_DIR = process.env.E2E_MODELS_DIR ?? path.join(ROOT, 'models');
export const WEB_DIST = path.join(ROOT, 'apps', 'web', 'dist');

const PG = {
  host: process.env.E2E_PG_HOST ?? '127.0.0.1',
  port: process.env.E2E_PG_PORT ?? '55432',
  user: process.env.E2E_PG_USER ?? 'meetledger',
  password: process.env.E2E_PG_PASSWORD ?? 'meetledger',
};
const pgEnv = { ...process.env, PGPASSWORD: PG.password };
const pgArgs = ['-h', PG.host, '-p', PG.port, '-U', PG.user];

export interface ServerOptions {
  /** Short name used for the DB / temp dir (letters, digits, _). */
  name: string;
  /** 'fixture' (deterministic, default) or 'local-sherpa' (real on-device ASR). */
  localAsr?: 'fixture' | 'local-sherpa';
  /** Extra environment for the server process (e.g. OPENAI_BASE_URL of the fake external server). */
  env?: Record<string, string>;
}

export interface RunningServer {
  url: string;
  port: number;
  dbName: string;
  tmpDir: string;
  /** `<tmp>/fixtures/transcripts` — the fixture provider reads `<sha>.json` from here on every call. */
  fixturesDir: string;
  logFile: string;
  /** Run SQL against this server's DB as the cluster admin (test assertions / triggering system jobs). */
  sql(query: string): string;
  /** Stop the process but keep DB / storage (simulate the server going away). */
  kill(): Promise<void>;
  /** Start again on the same port / DB / storage. */
  restart(): Promise<void>;
  /** Stop the process and remove the DB + temp files. */
  stop(): Promise<void>;
  logTail(lines?: number): string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** Test-harness SQL runs as the cluster admin (row level security would hide tenant rows from a plain session). */
const PG_ADMIN = process.env.E2E_PG_ADMIN_USER ?? 'postgres';
function psql(db: string, query: string): string {
  return execFileSync('psql', ['-h', PG.host, '-p', PG.port, '-U', PG_ADMIN, '-d', db, '-qtAX', '-v', 'ON_ERROR_STOP=1', '-c', query], { env: pgEnv, encoding: 'utf8' }).trim();
}

async function waitHealthy(url: string, proc: ChildProcess, logFile: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode}) during startup:\n${tail(logFile, 40)}`);
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) return;
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = String((e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become healthy (${lastErr}):\n${tail(logFile, 40)}`);
}

function tail(file: string, n = 60): string {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-n).join('\n');
  } catch {
    return '';
  }
}

/**
 * Starts an isolated MeetLedger server (API + built PWA) for one spec file:
 * fresh PostgreSQL database, own port, temp STORAGE_DIR, temp models dir (symlink to the real models) with a
 * fixtures/transcripts directory next to it, so the repository stays clean.
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  if (!existsSync(path.join(WEB_DIST, 'index.html'))) throw new Error(`apps/web/dist is missing — run "npm run build -w @meetledger/web" first`);
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const dbName = `ml_e2e_${opts.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}_${suffix}`;
  const tmpDir = mkdtempSync(path.join(tmpdir(), `ml-e2e-${opts.name}-`));
  const modelsLink = path.join(tmpDir, 'models');
  symlinkSync(MODELS_DIR, modelsLink, 'dir');
  const fixturesDir = path.join(tmpDir, 'fixtures', 'transcripts');
  mkdirSync(fixturesDir, { recursive: true });
  mkdirSync(path.join(tmpDir, 'storage'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'tmp'), { recursive: true });
  execFileSync('createdb', [...pgArgs, dbName], { env: pgEnv });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const logFile = path.join(tmpDir, 'server.log');

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    APP_ORIGIN: url,
    DATABASE_URL: `postgres://${PG.user}:${PG.password}@${PG.host}:${PG.port}/${dbName}`,
    WEB_DIST_DIR: WEB_DIST,
    STORAGE_DIR: path.join(tmpDir, 'storage'),
    TMP_DIR: path.join(tmpDir, 'tmp'),
    LOCAL_ASR_MODEL_DIR: modelsLink,
    LOG_LEVEL: process.env.E2E_SERVER_LOG_LEVEL ?? 'info',
    WORKER_POLL_MS: '200',
    WORKER_CONCURRENCY: '2',
    EMAIL_DRIVER: 'outbox',
    ...(opts.env ?? {}),
  };
  if ((opts.localAsr ?? 'fixture') === 'fixture') env.LOCAL_TRANSCRIPTION_PROVIDER = 'fixture';
  else delete env.LOCAL_TRANSCRIPTION_PROVIDER;

  let proc: ChildProcess;
  const launch = async () => {
    const fd = openSync(logFile, 'a');
    proc = spawn(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['apps/server/src/index.ts'], {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    await waitHealthy(url, proc, logFile);
  };
  const killProc = async () => {
    if (!proc || proc.exitCode !== null || proc.signalCode) return;
    const exited = new Promise<void>((r) => proc.once('exit', () => r()));
    try {
      process.kill(-proc.pid!, 'SIGTERM');
    } catch {
      /* already gone */
    }
    const t = setTimeout(() => {
      try {
        process.kill(-proc.pid!, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, 5_000);
    await exited;
    clearTimeout(t);
  };

  try {
    await launch();
  } catch (e) {
    await killProc();
    try {
      execFileSync('dropdb', [...pgArgs, '--if-exists', '--force', dbName], { env: pgEnv });
    } catch {
      /* ignore */
    }
    throw e;
  }

  return {
    url,
    port,
    dbName,
    tmpDir,
    fixturesDir,
    logFile,
    sql: (q) => psql(dbName, q),
    kill: killProc,
    restart: async () => {
      await killProc();
      await launch();
    },
    stop: async () => {
      await killProc();
      try {
        execFileSync('dropdb', [...pgArgs, '--if-exists', '--force', dbName], { env: pgEnv });
      } catch {
        /* ignore */
      }
      if (!process.env.E2E_KEEP_TMP) rmSync(tmpDir, { recursive: true, force: true });
    },
    logTail: (n) => tail(logFile, n),
  };
}
