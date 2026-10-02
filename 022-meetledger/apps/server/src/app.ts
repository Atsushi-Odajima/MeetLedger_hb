import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './config';
import type { Deps } from './context';
import { createPool, type Pool } from './db/pool';
import { AppError } from './lib/errors';
import { REDACT_PATHS } from './lib/logger';
import { systemClock, type Clock } from './lib/clock';
import { authenticate, checkCsrf } from './auth/sessions';
import { LocalEncryptedStorage } from './storage/localEncrypted';
import type { ObjectStorage } from './storage/types';
import { createProviders, type ProviderRegistry } from './providers/registry';
import { GuardedHttp, type ExternalHttp } from './privacy/externalHttp';
import { createEmailAdapter, type EmailAdapter } from './modules/notifications/email';
import { JobQueue, Worker } from './jobs/queue';
import { registerModules, registerJobHandlers } from './modules';

function localHostsFrom(config: Config): string[] {
  try {
    return [new URL(config.OLLAMA_URL).host];
  } catch {
    return [];
  }
}

export interface BuildOptions {
  config: Config;
  pool?: Pool;
  clock?: Clock;
  storage?: ObjectStorage;
  providers?: ProviderRegistry;
  http?: ExternalHttp;
  email?: EmailAdapter;
  /** pino destination override (tests capture logs to assert no secrets/content are logged). */
  logStream?: NodeJS.WritableStream;
  logger?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  deps: Deps;
  worker: Worker;
}

export async function buildApp(opts: BuildOptions): Promise<BuiltApp> {
  const config = opts.config;
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : { level: config.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: '[redacted]' }, ...(opts.logStream ? { stream: opts.logStream } : {}) },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 5 * 1024 * 1024,
  });
  const pool = opts.pool ?? createPool(config.DATABASE_URL);
  const deps: Deps = {
    config,
    pool,
    clock: opts.clock ?? systemClock,
    storage: opts.storage ?? new LocalEncryptedStorage(config.STORAGE_DIR, config.MASTER_KEY),
    providers: opts.providers ?? createProviders(config),
    http: opts.http ?? new GuardedHttp(pool, globalThis.fetch, localHostsFrom(config)),
    email: opts.email ?? createEmailAdapter(config),
    jobs: new JobQueue(),
    log: app.log,
  };
  const worker = new Worker(pool, { concurrency: config.WORKER_CONCURRENCY, pollMs: config.WORKER_POLL_MS, log: app.log });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.COOKIE_SECURE ? undefined : false,
  });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 20 } });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') && !req.url.startsWith('/mcp')) return;
    const auth = await authenticate(deps, req);
    (req as any).auth = auth;
    checkCsrf(deps, req, auth);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: err.code ?? 'request_error', message: err.message } });
    }
    req.log.error({ err: { message: String(err.message).slice(0, 300), code: err.code } }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, version: '1.0.0' };
  });

  await registerModules(app, deps);
  registerJobHandlers(worker, deps);

  // Serve the built PWA (if present) with SPA fallback.
  const webDir = resolve(config.WEB_DIST_DIR);
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/mcp')) return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
      return reply.type('text/html').sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => {
    await worker.stop();
    if (!opts.pool) await pool.end();
  });

  return { app, deps, worker };
}
