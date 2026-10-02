import type { ExternalCallKind } from '@meetledger/shared';
import type { Pool } from '../db/pool';
import { rows, withTenant } from '../db/pool';
import { policyDenied } from '../lib/errors';
import type { PolicyDecision } from './policy';

export interface ExternalCall {
  orgId: string;
  /** Meetings whose data is contained in this request (verified against DB before sending). */
  meetingIds?: string[];
  kind: ExternalCallKind;
  provider: string;
  purpose: string;
  url: string;
  init?: RequestInit;
  /** Required for transcription / ai / embedding calls. */
  decision?: PolicyDecision;
}

export interface ExternalHttp {
  fetch(call: ExternalCall): Promise<Response>;
}

const CONTENT_KINDS: ExternalCallKind[] = ['transcription', 'ai', 'embedding'];

function bodySize(init?: RequestInit): number {
  const b = init?.body as any;
  if (!b) return 0;
  if (typeof b === 'string') return Buffer.byteLength(b);
  if (b instanceof ArrayBuffer) return b.byteLength;
  if (ArrayBuffer.isView(b)) return b.byteLength;
  if (typeof b.size === 'number') return b.size;
  return 0;
}

/**
 * The ONLY path for outbound calls carrying customer data. It re-checks the meeting's privacy flags in the DB
 * (last line of defense against AI-OFF / local-mode leaks) and records metadata (never content) in external_calls.
 */
export class GuardedHttp implements ExternalHttp {
  constructor(
    private pool: Pool,
    private fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async verify(call: ExternalCall) {
    if (CONTENT_KINDS.includes(call.kind)) {
      if (!call.decision || !call.decision.allowed || call.decision.isLocal) throw policyDenied(`External ${call.kind} call without an allowing policy decision`);
    }
    const ids = call.meetingIds ?? [];
    if (!ids.length) return;
    const ms = await withTenant(this.pool, call.orgId, (db) =>
      rows<{ id: string; ai_enabled: boolean; transcription_mode: string; is_confidential: boolean }>(
        db,
        'SELECT id, ai_enabled, transcription_mode, is_confidential FROM meetings WHERE id = ANY($1)',
        [ids],
      ),
    );
    if (ms.length !== new Set(ids).size) throw policyDenied('Meeting not found for external call');
    for (const m of ms) {
      if ((call.kind === 'ai' || call.kind === 'embedding') && (!m.ai_enabled || m.is_confidential)) throw policyDenied('AI OFF / Confidential meeting data cannot be sent to an external AI provider');
      if (call.kind === 'transcription' && (m.transcription_mode !== 'cloud' || m.is_confidential)) throw policyDenied('Meeting is not in cloud transcription mode');
    }
  }

  private async record(call: ExternalCall, status: string) {
    let host = 'invalid';
    try {
      host = new URL(call.url).host;
    } catch {
      /* keep */
    }
    await withTenant(this.pool, call.orgId, (db) =>
      db.query('INSERT INTO external_calls(org_id, meeting_id, kind, provider, host, purpose, bytes_sent, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
        call.orgId,
        call.meetingIds?.length === 1 ? call.meetingIds[0] : null,
        call.kind,
        call.provider,
        host,
        call.purpose,
        bodySize(call.init),
        status,
      ]),
    );
  }

  async fetch(call: ExternalCall): Promise<Response> {
    await this.verify(call);
    try {
      const res = await this.fetchImpl(call.url, call.init);
      await this.record(call, String(res.status));
      return res;
    } catch (e) {
      await this.record(call, 'network_error');
      throw e;
    }
  }
}
