import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecorderSession, type SessionDeps } from '../src/main/recorderSession';
import { RecordingStore } from '../src/main/recordingStore';
import type { MeetLedgerApi, MeetingSummary } from '../src/main/apiClient';
import { parseWavHeader } from '../src/shared/audio/wav';
import type { RecState } from '../src/shared/ipc';

const WS = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';
const OWNER = 7;

function meeting(consentState: string, transcriptionMode = 'local'): MeetingSummary {
  return { id: M, workspaceId: WS, title: 't', status: 'scheduled', consentState, transcriptionMode, isConfidential: false, aiEnabled: true, scheduledStart: null, startedAt: null, language: null };
}

let dir: string;
let calls: string[];
let posted: unknown[];
let states: RecState[];

function setup(consent = 'notified', opts: { transcriptionMode?: string } = {}) {
  const api = {
    meeting: async () => meeting(consent, opts.transcriptionMode),
    start: async () => {
      calls.push('start');
      return meeting(consent);
    },
    end: async (_w: string, _m: string, expectMedia: boolean) => void calls.push(`end:${expectMedia}`),
    postLocalTranscript: async (_w: string, _m: string, p: unknown) => void posted.push(p),
    uploadMedia: async (_w: string, _m: string, blob: Blob) => {
      calls.push(`upload:${blob.size}`);
      return { assetId: 'a1' };
    },
  } as unknown as MeetLedgerApi;
  const store = new RecordingStore(dir);
  const deps: SessionDeps = {
    api,
    store,
    transcribeWav: async (p) => {
      const info = parseWavHeader(fs.readFileSync(p));
      calls.push(`asr:${info?.sampleRate}:${info?.dataBytes}`);
      return { model: 'm', language: 'ja', diarization: false, segments: [{ startMs: 0, endMs: 500, text: 'はい' }] };
    },
    emit: () => undefined,
    onStateChange: (s) => states.push(s),
    onSystemAudioObserved: () => calls.push('observed'),
    platform: 'linux',
  };
  return { s: new RecorderSession(deps), store };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-rec-'));
  calls = [];
  posted = [];
  states = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const input = (o: Partial<{ mode: 'device' | 'server'; uploadAudio: boolean }> = {}) => ({ workspaceId: WS, meetingId: M, mode: o.mode ?? 'device', uploadAudio: o.uploadAudio ?? false, systemAudio: true });

describe('RecorderSession', () => {
  it('refuses to arm without notified/confirmed consent and never calls /start then', async () => {
    for (const c of ['pending', 'not_recording', 'declined']) {
      const { s } = setup(c);
      await expect(s.prepare(OWNER, input())).rejects.toMatchObject({ code: c === 'declined' ? 'consent_declined' : 'consent_required' });
      expect(s.captureAllowedFor(OWNER)).toBe(false);
    }
    expect(calls).not.toContain('start');
  });

  it('refuses on-device transcription when the meeting says "none"', async () => {
    const { s } = setup('confirmed', { transcriptionMode: 'none' });
    await expect(s.prepare(OWNER, input())).rejects.toMatchObject({ code: 'transcription_disabled' });
  });

  it('device mode: capture only while armed, WAV streamed to disk, text-only submit deletes the audio', async () => {
    const { s } = setup('confirmed');
    await s.prepare(OWNER, input());
    expect(calls).toEqual(['start']);
    expect(s.captureAllowedFor(OWNER)).toBe(true);
    expect(s.captureAllowedFor(OWNER + 1)).toBe(false);
    await expect(s.data(OWNER, { pcm: new Uint8Array(4), webm: null, env: null })).rejects.toMatchObject({ code: 'bad_state' }); // not started yet
    s.started(OWNER, { systemAudioActive: true });
    expect(() => s.started(OWNER + 1, { systemAudioActive: true })).toThrow();
    const second = new Uint8Array(32000); // 1 s of 16 kHz PCM16
    await s.data(OWNER, { pcm: second, webm: null, env: Float32Array.from([0.1, 0.0, 0.1, 0.2]) });
    await s.data(OWNER, { pcm: second, webm: null, env: null });
    await expect(s.data(OWNER, { webm: new Uint8Array(4), pcm: null, env: null })).rejects.toMatchObject({ code: 'bad_state' }); // no webm in text-only mode
    expect(calls).toContain('observed');
    await s.stop(OWNER);
    expect(s.captureAllowedFor(OWNER)).toBe(false);
    expect(calls).toContain('end:false');
    const wav = fs.readdirSync(dir).find((f) => f.endsWith('.wav'))!;
    const info = parseWavHeader(fs.readFileSync(path.join(dir, wav)))!;
    expect(info).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16, dataBytes: 64000, durationMs: 2000 });
    const r = await s.transcribe(OWNER);
    expect(calls).toContain('asr:16000:64000');
    expect(r.provider).toBe('local-sherpa');
    await s.submit(OWNER);
    expect(posted).toHaveLength(1);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.wav'))).toHaveLength(0);
    await s.discard(OWNER);
    expect(s.state.phase).toBe('idle');
  });

  it('upload mode keeps the opus/webm as recorded and uploads it on request', async () => {
    const { s } = setup('notified');
    await s.prepare(OWNER, input({ mode: 'server', uploadAudio: true }));
    s.started(OWNER, { systemAudioActive: false });
    await s.data(OWNER, { webm: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2]), pcm: null, env: null });
    await expect(s.data(OWNER, { pcm: new Uint8Array(2), webm: null, env: null })).rejects.toMatchObject({ code: 'bad_state' });
    await s.stop(OWNER);
    expect(calls).toContain('end:true');
    await expect(s.transcribe(OWNER)).rejects.toMatchObject({ code: 'bad_state' });
    await s.upload(OWNER);
    expect(calls).toContain('upload:6');
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('abandon (window closed / crash) ends the meeting, keeps recorded audio, returns to idle', async () => {
    const { s, store } = setup('notified');
    await s.prepare(OWNER, input({ uploadAudio: true }));
    s.started(OWNER, { systemAudioActive: false });
    await s.data(OWNER, { pcm: new Uint8Array(3200), webm: new Uint8Array(10), env: null });
    await s.abandon(OWNER + 1); // other window: ignored
    expect(s.state.phase).toBe('recording');
    await s.abandon(OWNER);
    expect(s.state.phase).toBe('idle');
    expect(calls).toContain('end:true');
    expect(fs.readdirSync(dir).sort().map((f) => path.extname(f))).toEqual(['.wav', '.webm']);
    expect((await store.clear()).removed).toBe(2);
  });
});

describe('RecorderSession async safety', () => {
  it('a transcription that finishes after the window was closed cannot resurrect the old session', async () => {
    let release: (v: { model: string; language: string; diarization: boolean; segments: unknown[] }) => void = () => undefined;
    const store = new RecordingStore(dir);
    const s = new RecorderSession({
      api: {
        meeting: async () => meeting('confirmed'),
        start: async () => meeting('confirmed'),
        end: async () => undefined,
      } as unknown as MeetLedgerApi,
      store,
      transcribeWav: () => new Promise((r) => (release = r)),
      emit: () => undefined,
      onStateChange: () => undefined,
      onSystemAudioObserved: () => undefined,
      platform: 'linux',
    });
    await s.prepare(OWNER, input());
    s.started(OWNER, { systemAudioActive: false });
    await s.data(OWNER, { pcm: new Uint8Array(32000), webm: null, env: null });
    await s.stop(OWNER);
    const pending = s.transcribe(OWNER);
    await s.abandon(OWNER); // window closed while ASR is running
    release({ model: 'm', language: 'ja', diarization: false, segments: [{ startMs: 0, endMs: 10, text: 'x' }] });
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(s.state.phase).toBe('idle');
  });

  it('concurrent prepare calls arm only one session', async () => {
    const { s } = setup('confirmed');
    const r = await Promise.allSettled([s.prepare(OWNER, input()), s.prepare(OWNER, input())]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(calls.filter((c) => c === 'start')).toHaveLength(1);
  });
});
