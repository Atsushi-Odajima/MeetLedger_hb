// The desktop recording session, owned by the main process (single source of truth for "is something recording").
//
//   idle ──prepare (consent verified + POST /start)──▶ ready ──started──▶ recording ──stop──▶ stopped ──discard──▶ idle
//
// - Capture permissions (mic / system audio) for the recorder page are granted ONLY in ready|recording.
// - The persistent indicator (tray, window titles, always-on-top recorder window) follows this state.
// - Audio is streamed to disk while recording (crash-safe; no multi-GB buffers in the renderer):
//     device mode : <token>.wav  16 kHz mono PCM16 for local ASR (+ in-memory L/R envelope for speaker attribution)
//     upload      : <token>.webm stereo opus (L = mic, R = system) exactly as recorded, for POST /media
// - Nothing is sent to the server except: consent record, start/end, and — only after the user presses the button —
//   the transcript segments (device mode) and/or the audio file (server mode or "音声もアップロード").

import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { LocalSegment, LocalTranscriptResult, ProcessingMode, RecState } from '../shared/ipc';
import { WAV_HEADER_BYTES, ASR_SAMPLE_RATE, wavHeader } from '../shared/audio/wav';
import { attributeSpeakers } from '../shared/audio/attribution';
import { sanitizeSegments } from '../shared/validate';
import type { MeetLedgerApi, MeetingSummary } from './apiClient';
import type { RecordingStore } from './recordingStore';

export class SessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RawTranscript {
  model: string;
  language: string;
  diarization: boolean;
  diarizationError?: string;
  segments: unknown[];
}

export type AsrProgress = { phase?: string; done?: number; total?: number };

export interface SessionDeps {
  api: MeetLedgerApi;
  store: RecordingStore;
  transcribeWav: (wavPath: string, opts: { language?: string }, onProgress?: (p: AsrProgress) => void) => Promise<RawTranscript>;
  emit: (ownerId: number, state: RecState) => void;
  onStateChange: (state: RecState) => void;
  onSystemAudioObserved: () => void;
  platform: string;
}

const ENV_FRAME_MS = 100;
const MAX_WAV_BYTES = 0xffffffff - WAV_HEADER_BYTES;

function initialState(): RecState {
  return {
    phase: 'idle',
    workspaceId: null,
    meetingId: null,
    meetingTitle: null,
    mode: null,
    uploadAudio: false,
    systemAudioRequested: false,
    systemAudioActive: false,
    startedAt: null,
    wavBytes: 0,
    webmBytes: 0,
    message: null,
  };
}

export class RecorderSession {
  private st: RecState = initialState();
  private ownerId: number | null = null;
  private token: string | null = null;
  private wavPath: string | null = null;
  private webmPath: string | null = null;
  private wavFd: FileHandle | null = null;
  private webmFd: FileHandle | null = null;
  private env = new Float32Array(0);
  private envLen = 0;
  private queue: Promise<void> = Promise.resolve();
  private meeting: MeetingSummary | null = null;
  private result: LocalTranscriptResult | null = null;
  private systemAudioObserved = false;
  private ending = false;

  constructor(private readonly deps: SessionDeps) {}

  get state(): RecState {
    return { ...this.st };
  }

  /** Capture (getUserMedia / getDisplayMedia) is allowed for the recorder page only while armed. */
  captureAllowedFor(webContentsId: number): boolean {
    return this.ownerId === webContentsId && (this.st.phase === 'ready' || this.st.phase === 'recording');
  }

  isActive(): boolean {
    return this.st.phase === 'ready' || this.st.phase === 'recording' || this.st.phase === 'busy';
  }

  private set(patch: Partial<RecState>): void {
    this.st = { ...this.st, ...patch };
    this.deps.onStateChange(this.state);
    if (this.ownerId !== null) this.deps.emit(this.ownerId, this.state);
  }

  private assertOwner(ownerId: number): void {
    if (this.ownerId !== ownerId) throw new SessionError('not_owner', 'この録音セッションを操作できません');
  }

  async prepare(
    ownerId: number,
    input: { workspaceId: string; meetingId: string; mode: ProcessingMode; uploadAudio: boolean; systemAudio: boolean },
  ): Promise<RecState> {
    if (this.st.phase !== 'idle') throw new SessionError('busy', '別の録音セッションが進行中です');
    const m = await this.deps.api.meeting(input.workspaceId, input.meetingId);
    if (m.consentState === 'declined') throw new SessionError('consent_declined', '参加者が録音を拒否しています。録音できません。');
    if (m.consentState !== 'notified' && m.consentState !== 'confirmed') {
      throw new SessionError('consent_required', '録音前に参加者への通知/同意を記録してください');
    }
    if (input.mode === 'device' && m.transcriptionMode === 'none') {
      throw new SessionError('transcription_disabled', 'この会議は文字起こし「なし」に設定されています');
    }
    // The server re-checks consent (409 consent_required) — the desktop never bypasses it.
    await this.deps.api.start(input.workspaceId, input.meetingId);

    const token = this.deps.store.newToken();
    this.token = token;
    this.ownerId = ownerId;
    this.meeting = m;
    this.result = null;
    this.systemAudioObserved = false;
    this.env = new Float32Array(2 * 10 * 60 * 30); // 30 min, grows
    this.envLen = 0;
    if (input.mode === 'device') {
      this.wavPath = this.deps.store.pathFor(token, 'wav');
      this.wavFd = await fsp.open(this.wavPath, 'wx', 0o600);
      await this.wavFd.write(wavHeader(0, ASR_SAMPLE_RATE, 1, 16), 0, WAV_HEADER_BYTES, 0);
      this.deps.store.protect(this.wavPath);
    }
    if (input.uploadAudio) {
      this.webmPath = this.deps.store.pathFor(token, 'webm');
      this.webmFd = await fsp.open(this.webmPath, 'wx', 0o600);
      this.deps.store.protect(this.webmPath);
    }
    this.set({
      ...initialState(),
      phase: 'ready',
      workspaceId: input.workspaceId,
      meetingId: input.meetingId,
      meetingTitle: m.title,
      mode: input.mode,
      uploadAudio: input.uploadAudio,
      systemAudioRequested: input.systemAudio,
      message: '録音の準備ができました',
    });
    return this.state;
  }

  started(ownerId: number, info: { systemAudioActive: boolean }): RecState {
    this.assertOwner(ownerId);
    if (this.st.phase !== 'ready') throw new SessionError('bad_state', '録音を開始できる状態ではありません');
    this.set({
      phase: 'recording',
      startedAt: Date.now(),
      systemAudioActive: info.systemAudioActive,
      message: info.systemAudioActive ? '録音中（マイク + システム音声）' : '録音中（マイクのみ）',
    });
    return this.state;
  }

  data(ownerId: number, chunk: { webm: Uint8Array | null; pcm: Uint8Array | null; env: Float32Array | null }): Promise<void> {
    this.assertOwner(ownerId);
    if (this.st.phase !== 'recording') return Promise.reject(new SessionError('bad_state', '録音中ではありません'));
    if (chunk.pcm && !this.wavFd) return Promise.reject(new SessionError('bad_state', 'この録音は端末内文字起こし用の音声を保存しません'));
    if (chunk.webm && !this.webmFd) return Promise.reject(new SessionError('bad_state', 'この録音は音声ファイルを保存しません'));
    const job = this.queue.then(async () => {
      if (chunk.pcm && this.wavFd) {
        if (this.st.wavBytes + chunk.pcm.byteLength > MAX_WAV_BYTES) throw new SessionError('too_long', '録音が長すぎます');
        await this.wavFd.write(chunk.pcm, 0, chunk.pcm.byteLength, WAV_HEADER_BYTES + this.st.wavBytes);
        this.st.wavBytes += chunk.pcm.byteLength;
      }
      if (chunk.webm && this.webmFd) {
        await this.webmFd.write(chunk.webm, 0, chunk.webm.byteLength, this.st.webmBytes);
        this.st.webmBytes += chunk.webm.byteLength;
      }
      if (chunk.env) this.appendEnv(chunk.env);
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  private appendEnv(env: Float32Array): void {
    if (this.envLen + env.length > this.env.length) {
      const next = new Float32Array(Math.max(this.env.length * 2, this.envLen + env.length));
      next.set(this.env.subarray(0, this.envLen));
      this.env = next;
    }
    this.env.set(env, this.envLen);
    this.envLen += env.length;
    if (!this.systemAudioObserved && this.st.systemAudioActive) {
      for (let i = 1; i < env.length; i += 2) {
        if (env[i]! > 0.001) {
          this.systemAudioObserved = true;
          this.deps.onSystemAudioObserved();
          break;
        }
      }
    }
  }

  private async closeFiles(): Promise<void> {
    await this.queue;
    if (this.wavFd) {
      await this.wavFd.write(wavHeader(this.st.wavBytes, ASR_SAMPLE_RATE, 1, 16), 0, WAV_HEADER_BYTES, 0);
      await this.wavFd.close();
      this.wavFd = null;
    }
    if (this.webmFd) {
      await this.webmFd.close();
      this.webmFd = null;
    }
  }

  async stop(ownerId: number): Promise<RecState> {
    this.assertOwner(ownerId);
    if (this.st.phase !== 'recording' && this.st.phase !== 'ready') throw new SessionError('bad_state', '録音中ではありません');
    const wasRecording = this.st.phase === 'recording';
    this.set({ phase: 'busy', message: '録音を保存しています…' });
    await this.closeFiles();
    let message = wasRecording ? '録音を停止しました' : '録音を開始せずに終了しました';
    try {
      await this.endMeeting();
    } catch (e) {
      message += `（会議終了の記録に失敗: ${(e as Error).message}）`;
    }
    this.set({ phase: 'stopped', message });
    return this.state;
  }

  private async endMeeting(): Promise<void> {
    if (this.ending || !this.st.workspaceId || !this.st.meetingId) return;
    this.ending = true;
    await this.deps.api.end(this.st.workspaceId, this.st.meetingId, this.st.uploadAudio && this.st.webmBytes > 0);
  }

  async transcribe(ownerId: number): Promise<LocalTranscriptResult> {
    this.assertOwner(ownerId);
    if (this.st.phase !== 'stopped') throw new SessionError('bad_state', '録音を停止してから文字起こししてください');
    if (this.st.mode !== 'device' || !this.wavPath) throw new SessionError('bad_state', 'この録音は端末内文字起こしの対象ではありません');
    if (this.st.wavBytes < ASR_SAMPLE_RATE * 2 * 0.5) throw new SessionError('too_short', '録音が短すぎます（0.5秒未満）');
    this.set({ phase: 'busy', message: 'この端末で文字起こししています…（音声は送信されません）' });
    try {
      let last = 0;
      const PHASE: Record<string, string> = { vad: '発話区間の検出', asr: '音声認識', diarization: '話者分離' };
      const raw = await this.deps.transcribeWav(this.wavPath, { language: this.meeting?.language ?? undefined }, (p) => {
        const now = Date.now();
        if (now - last < 500 || !p.phase) return;
        last = now;
        const pct = p.total ? ` ${Math.min(100, Math.round(((p.done ?? 0) / p.total) * 100))}%` : '';
        this.set({ message: `この端末で文字起こししています…（${PHASE[p.phase] ?? p.phase}${pct}）音声は送信されません` });
      });
      const segments = sanitizeSegments(raw.segments) as LocalSegment[];
      const attributed = attributeSpeakers(segments, { frames: this.env.subarray(0, this.envLen), frameMs: ENV_FRAME_MS }, {
        systemAudioCaptured: this.st.systemAudioActive,
      });
      this.result = { provider: 'local-sherpa', model: raw.model, language: raw.language, diarization: raw.diarization, segments: attributed };
      const diar = raw.diarizationError ? `（話者分離は実行されませんでした: ${raw.diarizationError}）` : '';
      this.set({ phase: 'stopped', message: `文字起こし完了（${attributed.length} セグメント）${diar}。内容を確認して送信してください。` });
      return this.result;
    } catch (e) {
      this.set({ phase: 'stopped', message: `文字起こしに失敗しました: ${(e as Error).message}` });
      throw e;
    }
  }

  async submit(ownerId: number): Promise<{ segments: number }> {
    this.assertOwner(ownerId);
    if (this.st.phase !== 'stopped' || !this.result) throw new SessionError('bad_state', '送信する文字起こし結果がありません');
    const r = this.result;
    this.set({ phase: 'busy', message: '文字起こし結果（テキストのみ）を送信しています…' });
    try {
      await this.deps.api.postLocalTranscript(this.st.workspaceId!, this.st.meetingId!, {
        provider: r.provider,
        model: r.model,
        language: r.language,
        segments: r.segments,
      });
    } catch (e) {
      this.set({ phase: 'stopped', message: `送信に失敗しました: ${(e as Error).message}` });
      throw e;
    }
    // The transcript is on the server; the local 16 kHz working copy is no longer needed.
    if (this.wavPath) {
      this.deps.store.unprotect(this.wavPath);
      await fsp.rm(this.wavPath, { force: true });
      this.wavPath = null;
    }
    this.result = null;
    this.set({ phase: 'stopped', message: `文字起こし結果を送信しました（${r.segments.length} セグメント、音声は送信していません）` });
    return { segments: r.segments.length };
  }

  async upload(ownerId: number): Promise<{ assetId?: string }> {
    this.assertOwner(ownerId);
    if (this.st.phase !== 'stopped') throw new SessionError('bad_state', '録音を停止してからアップロードしてください');
    if (!this.st.uploadAudio || !this.webmPath || this.st.webmBytes === 0) throw new SessionError('bad_state', 'アップロードする音声がありません');
    this.set({ phase: 'busy', message: '音声ファイルをアップロードしています…' });
    try {
      const { openAsBlob } = await import('node:fs');
      const blob = await openAsBlob(this.webmPath, { type: 'audio/webm' });
      const stamp = new Date(this.st.startedAt ?? Date.now()).toISOString().replace(/[:.]/g, '-');
      const res = await this.deps.api.uploadMedia(this.st.workspaceId!, this.st.meetingId!, blob, `desktop-${stamp}.webm`);
      this.deps.store.unprotect(this.webmPath);
      await fsp.rm(this.webmPath, { force: true });
      this.webmPath = null;
      this.set({ phase: 'stopped', message: '音声をアップロードしました（サーバーで処理されます）' });
      return { assetId: res.assetId };
    } catch (e) {
      this.set({ phase: 'stopped', message: `アップロードに失敗しました: ${(e as Error).message}` });
      throw e;
    }
  }

  /** Removes any remaining local files and returns to idle. */
  async discard(ownerId: number): Promise<RecState> {
    this.assertOwner(ownerId);
    if (this.st.phase === 'recording' || this.st.phase === 'ready' || this.st.phase === 'busy') {
      throw new SessionError('bad_state', '録音を停止してから破棄してください');
    }
    await this.removeFiles();
    this.reset();
    return this.state;
  }

  private async removeFiles(): Promise<void> {
    for (const p of [this.wavPath, this.webmPath]) {
      if (!p) continue;
      this.deps.store.unprotect(p);
      await fsp.rm(p, { force: true }).catch(() => undefined);
    }
    this.wavPath = this.webmPath = null;
  }

  private reset(): void {
    const owner = this.ownerId;
    this.st = initialState();
    this.deps.onStateChange(this.state);
    if (owner !== null) this.deps.emit(owner, this.state);
    this.ownerId = null;
    this.token = null;
    this.meeting = null;
    this.result = null;
    this.ending = false;
    this.env = new Float32Array(0);
    this.envLen = 0;
  }

  /**
   * The recorder page went away (window closed, reload, renderer crash) or the app quits.
   * Capture stops with the renderer; we finalize files and end the meeting. Recorded files are KEPT on disk
   * (never silently deleted — the user can remove them in Settings).
   */
  async abandon(ownerId: number | null): Promise<void> {
    if (ownerId !== null && this.ownerId !== ownerId) return;
    if (this.st.phase === 'idle') return;
    try {
      await this.closeFiles();
      if (this.st.phase === 'ready' || this.st.phase === 'recording' || this.st.phase === 'busy') await this.endMeeting().catch(() => undefined);
    } finally {
      for (const p of [this.wavPath, this.webmPath]) if (p) this.deps.store.unprotect(p);
      // drop empty working files (nothing recorded)
      if (this.wavPath && this.st.wavBytes === 0) await fsp.rm(this.wavPath, { force: true }).catch(() => undefined);
      if (this.webmPath && this.st.webmBytes === 0) await fsp.rm(this.webmPath, { force: true }).catch(() => undefined);
      this.wavPath = this.webmPath = null;
      this.reset();
    }
  }
}
