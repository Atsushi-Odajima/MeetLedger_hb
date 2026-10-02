import type { FastifyInstance } from 'fastify';
import type { Deps } from '../context';
import type { Worker } from '../jobs/queue';

export interface ModuleDef {
  name: string;
  routes(app: FastifyInstance, deps: Deps): Promise<void> | void;
  jobs?(worker: Worker, deps: Deps): void;
}
