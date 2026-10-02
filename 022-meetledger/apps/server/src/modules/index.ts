import type { FastifyInstance } from 'fastify';
import type { Deps } from '../context';
import type { Worker } from '../jobs/queue';
import type { ModuleDef } from './types';
import core from './core';
import audio from './audio';
import ledger from './ledger';
import followup from './followup';
import search from './search';
import data from './data';
import connectors from './connectors';
import mcp from '../mcp';

export const MODULES: ModuleDef[] = [core, audio, ledger, followup, search, data, connectors, mcp];

export async function registerModules(app: FastifyInstance, deps: Deps) {
  for (const m of MODULES) await app.register(async (inst) => m.routes(inst, deps));
}

export function registerJobHandlers(worker: Worker, deps: Deps) {
  for (const m of MODULES) m.jobs?.(worker, deps);
}
