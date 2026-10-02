import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeFixtureMeetingAudio, type FixtureSegment } from './audio';
import { tokyoDate, waitFor, type Ws } from './api';
import type { ServerHandle } from './test';

let nextFreq = 300;

export interface MeetingSpec {
  title: string;
  scheduledStart?: string;
  participants?: { name?: string; email?: string; personId?: string; role?: 'organizer' | 'attendee' | 'optional' }[];
  seriesId?: string;
  projectId?: string;
  transcriptionMode?: 'local' | 'cloud' | 'none';
  aiEnabled?: boolean;
  isConfidential?: boolean;
}

/** Creates a meeting via the API (no transcript yet). */
export async function createMeeting(ws: Ws, spec: MeetingSpec): Promise<any> {
  return ws.createMeeting({ transcriptionMode: 'local', ...spec });
}

/** Registers a deterministic transcript for a new WAV and returns the WAV path (unique tone per call). */
export function fixtureWav(h: ServerHandle, name: string, segments: FixtureSegment[]): string {
  nextFreq += 37;
  return makeFixtureMeetingAudio(h.srv.fixturesDir, h.work, name, nextFreq, segments);
}

/** Records the participant notice and uploads the file through the API (the UI path is covered by E2E-1/6/7). */
export async function uploadViaApi(ws: Ws, meetingId: string, wav: string) {
  await ws.post(`/meetings/${meetingId}/consent`, { kind: 'recording', state: 'notified', method: 'verbal' });
  return ws.api.call('POST', ws.p(`/meetings/${meetingId}/media`), undefined, {
    multipart: { file: { name: path.basename(wav), mimeType: 'audio/wav', buffer: readFileSync(wav) } },
  });
}

/** Waits until the transcript exists and AI extraction finished (or was skipped for AI OFF meetings). */
export async function waitProcessed(ws: Ws, meetingId: string, opts: { extraction?: boolean; timeoutMs?: number } = {}) {
  const needExtraction = opts.extraction ?? true;
  return waitFor(
    `processing of ${meetingId}`,
    () => ws.processing(meetingId),
    (p: any) => {
      const failed = p.jobs?.find((j: any) => ['failed', 'dead'].includes(j.status));
      if (failed) throw new Error(`job ${failed.type} failed: ${failed.error}`);
      if (!p.transcript) return false;
      if (!needExtraction) return true;
      return p.jobs.some((j: any) => j.type === 'ai.extract' && j.status === 'succeeded') && !p.jobs.some((j: any) => ['queued', 'running'].includes(j.status));
    },
    opts.timeoutMs ?? 60_000,
  );
}

/** Meeting + fixture transcript + processing, all through the API. */
export async function meetingWithTranscript(h: ServerHandle, ws: Ws, spec: MeetingSpec, segments: FixtureSegment[]) {
  const m = await createMeeting(ws, spec);
  const wav = fixtureWav(h, `m-${m.id.slice(0, 8)}`, segments);
  await uploadViaApi(ws, m.id, wav);
  await waitProcessed(ws, m.id, { extraction: spec.aiEnabled !== false && !spec.isConfidential });
  return m;
}

/** Review-inbox candidates of a meeting by type. */
export async function candidates(ws: Ws, meetingId: string, type?: string): Promise<any[]> {
  const items = await ws.review();
  return items.filter((x: any) => x.item.meetingId === meetingId && (!type || x.type === type)).map((x: any) => ({ ...x.item, type: x.type, flags: x.flags }));
}

/** ISO timestamp of `hour`:00 Asia/Tokyo on the day `days` from today (Tokyo calendar). */
export function jstAt(days: number, hour = 10): string {
  return new Date(`${tokyoDate(days)}T${String(hour).padStart(2, '0')}:00:00+09:00`).toISOString();
}
