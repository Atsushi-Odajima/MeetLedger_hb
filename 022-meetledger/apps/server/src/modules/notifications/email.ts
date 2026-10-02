import type { Db } from '../../db/pool';

export interface EmailMessage {
  orgId: string;
  to: string;
  subject: string;
  body: string;
  dedupeKey?: string;
}

/** Email delivery. Default 'outbox' driver only stores messages (status 'held'); nothing is sent externally. */
export interface EmailAdapter {
  readonly driver: string;
  send(db: Db, msg: EmailMessage): Promise<{ id: string | null; duplicate: boolean }>;
}

export class OutboxEmail implements EmailAdapter {
  readonly driver = 'outbox';
  async send(db: Db, msg: EmailMessage) {
    const r = await db.query(
      `INSERT INTO email_outbox(org_id, to_address, subject, body, status, dedupe_key) VALUES ($1,$2,$3,$4,'held',$5)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [msg.orgId, msg.to, msg.subject, msg.body, msg.dedupeKey ?? null],
    );
    return { id: r.rows[0]?.id ?? null, duplicate: r.rowCount === 0 };
  }
}
