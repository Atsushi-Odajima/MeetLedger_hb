import { hostname } from 'node:os';
import type { Db, Pool } from '../db/pool';
import { one, rows, withSystem } from '../db/pool';
import { safeErrorMessage } from '../lib/logger';

export interface JobRow {
  id: string;
  org_id: string | null;
  type: string;
  idempotency_key: string;
  payload: any;
  status: string;
  attempts: number;
  max_attempts: number;
}

export interface EnqueueInput {
  orgId: string | null;
  type: string;
  /** Idempotency key: enqueueing the same key twice returns the existing job (no duplicate work). */
  key: string;
  payload?: Record<string, unknown>;
  runAfter?: Date;
  maxAttempts?: number;
}

export interface EnqueueResult {
  id: string;
  created: boolean;
  status: string;
}

export class JobQueue {
  /** Must be called with a db in the job's tenant context (or system context for org-less jobs). */
  async enqueue(db: Db, j: EnqueueInput): Promise<EnqueueResult> {
    const r = await one<{ id: string; status: string; inserted: boolean }>(
      db,
      `INSERT INTO jobs(org_id, type, idempotency_key, payload, run_after, max_attempts)
       VALUES ($1,$2,$3,$4,coalesce($5, now()),$6)
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id, status, (xmax = 0) AS inserted`,
      [j.orgId, j.type, j.key, j.payload ?? {}, j.runAfter ?? null, j.maxAttempts ?? 3],
    );
    return { id: r!.id, created: r!.inserted, status: r!.status };
  }

  /** Explicit re-run (user pressed "再処理"): re-queues a finished job under the same key. Output writers are idempotent. */
  async rerun(db: Db, key: string): Promise<EnqueueResult | null> {
    const r = await one<{ id: string; status: string }>(
      db,
      `UPDATE jobs SET status='queued', attempts=0, run_after=now(), last_error=NULL, locked_by=NULL, locked_until=NULL, updated_at=now()
        WHERE idempotency_key=$1 AND status IN ('succeeded','failed','dead','cancelled') RETURNING id, status`,
      [key],
    );
    return r ? { id: r.id, created: false, status: r.status } : null;
  }
}

export type JobHandler = (job: JobRow) => Promise<unknown>;

/** Polling worker using FOR UPDATE SKIP LOCKED leases. Safe to run several processes concurrently. */
export class Worker {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = 0;
  private stopped = true;
  readonly id = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;

  constructor(
    private pool: Pool,
    private opts: { concurrency: number; pollMs: number; leaseSec?: number; log?: { error: (...a: any[]) => void } },
  ) {}

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  async claim(limit: number): Promise<JobRow[]> {
    const types = [...this.handlers.keys()];
    if (!types.length || limit <= 0) return [];
    return withSystem(this.pool, (db) =>
      rows<JobRow>(
        db,
        `UPDATE jobs SET status='running', locked_by=$1, locked_until=now() + make_interval(secs => $2), attempts=attempts+1, updated_at=now()
          WHERE id IN (
            SELECT id FROM jobs
             WHERE type = ANY($3) AND ((status='queued' AND run_after <= now()) OR (status='running' AND locked_until < now()))
             ORDER BY run_after
             LIMIT $4 FOR UPDATE SKIP LOCKED)
        RETURNING id, org_id, type, idempotency_key, payload, status, attempts, max_attempts`,
        [this.id, this.opts.leaseSec ?? 900, types, limit],
      ),
    );
  }

  private async finish(job: JobRow, ok: boolean, result: unknown, err?: unknown) {
    await withSystem(this.pool, async (db) => {
      if (ok) {
        await db.query(`UPDATE jobs SET status='succeeded', result=$2, locked_by=NULL, locked_until=NULL, finished_at=now(), updated_at=now() WHERE id=$1`, [
          job.id,
          JSON.stringify(result ?? null),
        ]);
      } else {
        const dead = job.attempts >= job.max_attempts || (err as any)?.permanent === true;
        const backoffSec = Math.min(3600, 15 * 2 ** (job.attempts - 1));
        await db.query(
          `UPDATE jobs SET status=$2, last_error=$3, locked_by=NULL, locked_until=NULL, run_after=now() + make_interval(secs => $4),
                  finished_at = CASE WHEN $2='dead' THEN now() ELSE NULL END, updated_at=now() WHERE id=$1`,
          [job.id, dead ? 'dead' : 'queued', safeErrorMessage(err), backoffSec],
        );
      }
    });
  }

  async runJob(job: JobRow) {
    const h = this.handlers.get(job.type);
    try {
      if (!h) throw Object.assign(new Error(`no handler for ${job.type}`), { permanent: true });
      const res = await h(job);
      await this.finish(job, true, res);
    } catch (e) {
      this.opts.log?.error({ jobId: job.id, type: job.type, err: safeErrorMessage(e) }, 'job failed');
      await this.finish(job, false, null, e);
    }
  }

  /** Processes runnable jobs until none are left (tests, CLI). Returns number of jobs run. */
  async drain(maxRounds = 100): Promise<number> {
    let n = 0;
    for (let i = 0; i < maxRounds; i++) {
      const jobs = await this.claim(this.opts.concurrency);
      if (!jobs.length) break;
      await Promise.all(jobs.map((j) => this.runJob(j)));
      n += jobs.length;
    }
    return n;
  }

  start() {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      try {
        const free = this.opts.concurrency - this.running;
        const jobs = await this.claim(free);
        for (const j of jobs) {
          this.running++;
          this.runJob(j).finally(() => this.running--);
        }
      } catch (e) {
        this.opts.log?.error({ err: safeErrorMessage(e) }, 'worker poll failed');
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.opts.pollMs);
    };
    this.timer = setTimeout(tick, 10);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running > 0) await new Promise((r) => setTimeout(r, 50));
  }
}

/** Error that should not be retried (bad input, policy denial). */
export function permanentError(message: string) {
  return Object.assign(new Error(message), { permanent: true });
}
