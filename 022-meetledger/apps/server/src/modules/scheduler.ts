import type { Deps } from '../context';
import { withSystem } from '../db/pool';

/** Periodic system jobs (org-less; handlers iterate tenants). Keys are time-bucketed so each period runs once cluster-wide. */
export const SCHEDULES: { type: string; everySec: (d: Deps) => number }[] = [
  { type: 'followup.tick', everySec: (d) => d.config.SCHEDULER_INTERVAL_SEC },
  { type: 'retention.sweep', everySec: () => 3600 },
  { type: 'connectors.sync', everySec: () => 900 },
];

export async function enqueueDueSchedules(deps: Deps, now = deps.clock.now()) {
  await withSystem(deps.pool, async (db) => {
    for (const s of SCHEDULES) {
      const period = s.everySec(deps);
      const bucket = Math.floor(now.getTime() / 1000 / period);
      await deps.jobs.enqueue(db, { orgId: null, type: s.type, key: `${s.type}:${bucket}`, payload: { at: now.toISOString() }, maxAttempts: 1 });
    }
  });
}

export function startSchedulers(deps: Deps) {
  const run = () => enqueueDueSchedules(deps).catch((e) => deps.log.error({ err: String(e?.message ?? e) }, 'scheduler failed'));
  run();
  const t = setInterval(run, 60_000);
  t.unref();
  return () => clearInterval(t);
}
