import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config';
import type { Pool, Db } from './db/pool';
import type { Clock } from './lib/clock';
import type { ObjectStorage } from './storage/types';
import type { ProviderRegistry } from './providers/registry';
import type { ExternalHttp } from './privacy/externalHttp';
import type { EmailAdapter } from './modules/notifications/email';
import type { JobQueue } from './jobs/queue';
import type { Role } from '@meetledger/shared';

/** Process-wide dependencies. Tests construct this with fakes (clock, providers, http). */
export interface Deps {
  config: Config;
  pool: Pool;
  clock: Clock;
  storage: ObjectStorage;
  providers: ProviderRegistry;
  http: ExternalHttp;
  email: EmailAdapter;
  jobs: JobQueue;
  log: FastifyBaseLogger | Console;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  timezone: string;
  locale: string;
}

/** Authentication result attached to each request. */
export interface AuthInfo {
  user: AuthUser;
  via: 'session' | 'token';
  sessionId?: string;
  csrfToken?: string;
  /** For API tokens: the token is pinned to one org/workspace and carries scopes. */
  tokenOrgId?: string;
  tokenWorkspaceId?: string;
  scopes?: string[];
}

/** Workspace-scoped request context. All tenant data access goes through ctx.tx (RLS-scoped transaction). */
export interface WsCtx {
  deps: Deps;
  userId: string;
  user: AuthUser;
  orgId: string;
  workspaceId: string;
  role: Role;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}
