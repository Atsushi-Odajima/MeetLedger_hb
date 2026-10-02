// Helpers for ledger tests (AI extraction, review, ledgers). Real network is never used.
import type { Client, TestEnv } from './helpers';
import { insertTranscript } from './helpers';
import type { ExternalCall } from '../src/privacy/externalHttp';

export interface Owner {
  client: Client;
  orgId: string;
  workspaceId: string;
  userId: string;
}

export async function createMeeting(c: Client, ws: string, body: Record<string, unknown>) {
  const r = await c.post(`/api/w/${ws}/meetings`, { scheduledStart: '2026-10-01T01:00:00Z', ...body });
  if (r.status !== 200) throw new Error(`create meeting failed ${r.status} ${r.raw}`);
  return r.body;
}

/** Inserts a transcript; segments get 5s each unless given. */
export async function transcript(env: TestEnv, orgId: string, meetingId: string, segs: { speaker: string; text: string; startMs?: number; endMs?: number; flags?: string[]; confidence?: number }[]) {
  return insertTranscript(env, orgId, meetingId, segs.map((s, i) => ({ startMs: i * 5000, endMs: i * 5000 + 4500, ...s })));
}

/** POST /extract then run queued jobs. */
export async function extract(env: TestEnv, c: Client, ws: string, meetingId: string, rerun = false) {
  const r = await c.post(`/api/w/${ws}/meetings/${meetingId}/extract`, { rerun });
  if (r.status === 200) await env.worker.drain();
  return r;
}

export async function ledger(c: Client, ws: string, meetingId: string) {
  const r = await c.get(`/api/w/${ws}/meetings/${meetingId}/ledger`);
  if (r.status !== 200) throw new Error(`ledger failed ${r.status} ${r.raw}`);
  return r.body as { decisions: any[]; actions: any[]; commitments: any[]; questions: any[]; contradictions: any[] };
}

export async function enableCloudAi(c: Client, ws: string, provider: 'openai' | 'anthropic' = 'openai') {
  const r = await c.patch(`/api/w/${ws}/settings`, { ai: { provider, cloudAllowed: true } });
  if (r.status !== 200) throw new Error(`settings failed ${r.status} ${r.raw}`);
}

/** Wraps a JSON object as an OpenAI Responses API result. */
export function openAiJson(obj: unknown): Response {
  return new Response(
    JSON.stringify({
      id: 'resp_test',
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(obj) }] }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

export function anthropicJson(obj: unknown): Response {
  return new Response(
    JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

export function requestBody(call: ExternalCall | undefined): any {
  const b = call?.init?.body;
  return typeof b === 'string' ? JSON.parse(b) : null;
}

export const emptyExtraction = { summary: { executive: '', topics: [], risks: [], nextMeeting: null }, decisions: [], actions: [], commitments: [], questions: [] };
