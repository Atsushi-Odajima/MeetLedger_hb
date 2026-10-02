import { createTransport } from 'nodemailer';
import type { Config } from '../../config';
import type { Db } from '../../db/pool';
import { safeErrorMessage } from '../../lib/logger';

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

/** Minimal transport surface we use (nodemailer Transporter or a test double). */
export interface MailTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface SmtpEmailOptions {
  /** smtp(s)://user:pass@host:port — never logged. */
  smtpUrl?: string;
  from: string;
  /** Inject a transport (tests use nodemailer's local jsonTransport/streamTransport; nothing leaves the process). */
  transport?: MailTransport;
}

function smtpHost(url: string | undefined): string {
  if (!url) return 'smtp';
  try {
    return new URL(url).host || 'smtp';
  } catch {
    return 'smtp';
  }
}

/**
 * SMTP delivery via nodemailer (EMAIL_DRIVER=smtp).
 * Every message is first written to email_outbox (dedupe_key UNIQUE ⇒ the same notification is never mailed twice),
 * then sent; the row records sent/failed. Metadata of the outbound call (host, bytes, status — no content) is recorded
 * in external_calls like every other third-party call.
 */
export class SmtpEmail implements EmailAdapter {
  readonly driver = 'smtp';
  private transport: MailTransport;
  private host: string;

  constructor(private opts: SmtpEmailOptions) {
    if (!opts.transport && !opts.smtpUrl) throw new Error('SMTP_URL is required when EMAIL_DRIVER=smtp');
    this.transport = opts.transport ?? (createTransport(opts.smtpUrl as string) as unknown as MailTransport);
    this.host = smtpHost(opts.smtpUrl);
  }

  async send(db: Db, msg: EmailMessage) {
    const ins = await db.query(
      `INSERT INTO email_outbox(org_id, to_address, subject, body, status, dedupe_key) VALUES ($1,$2,$3,$4,'queued',$5)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [msg.orgId, msg.to, msg.subject, msg.body, msg.dedupeKey ?? null],
    );
    if (!ins.rowCount) return { id: null, duplicate: true };
    const id: string = ins.rows[0].id;
    const bytes = Buffer.byteLength(msg.subject) + Buffer.byteLength(msg.body);
    let status = 'sent';
    try {
      await this.transport.sendMail({ from: this.opts.from, to: msg.to, subject: msg.subject, text: msg.body });
      await db.query(`UPDATE email_outbox SET status='sent', sent_at=now(), error=NULL WHERE id=$1`, [id]);
    } catch (e) {
      status = 'error';
      await db.query(`UPDATE email_outbox SET status='failed', error=$2 WHERE id=$1`, [id, safeErrorMessage(e)]);
    }
    await db.query(
      `INSERT INTO external_calls(org_id, meeting_id, kind, provider, host, purpose, bytes_sent, status) VALUES ($1,NULL,'email','smtp',$2,'notification_email',$3,$4)`,
      [msg.orgId, this.host, bytes, status],
    );
    return { id, duplicate: false };
  }
}

/** Chooses the email driver from config: 'smtp' ⇒ SmtpEmail (requires SMTP_URL), otherwise the hold-only outbox. */
export function createEmailAdapter(cfg: Pick<Config, 'EMAIL_DRIVER' | 'SMTP_URL' | 'EMAIL_FROM'>, opts: { transport?: MailTransport } = {}): EmailAdapter {
  if (cfg.EMAIL_DRIVER === 'smtp') return new SmtpEmail({ smtpUrl: cfg.SMTP_URL, from: cfg.EMAIL_FROM, transport: opts.transport });
  return new OutboxEmail();
}
