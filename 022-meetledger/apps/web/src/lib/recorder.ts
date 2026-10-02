// Browser microphone recorder (MediaRecorder). The recording indicator is always visible in the UI and the browser
// shows its own mic indicator; there is intentionally no "hidden" mode.
// Chunks are persisted to IndexedDB while recording so a crash / reload does not lose the audio (upload later).

import { idb } from './offline/idb';
import { extensionForMime, pickMimeType } from './media';

export interface StoredRecording {
  id: string;
  wsId: string;
  meetingId: string;
  mimeType: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  chunks: Blob[];
  uploaded: boolean;
}

export interface RecorderEvents {
  onLevel?: (level: number) => void;
  onState?: (state: RecordingState) => void;
  onWarning?: (key: string) => void;
}

export type RecordingState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'stopped' | 'error';

export class BrowserRecorder {
  private stream: MediaStream | null = null;
  private extraStreams: MediaStream[] = [];
  private recorder: MediaRecorder | null = null;
  private ctx: AudioContext | null = null;
  private raf = 0;
  private wakeLock: { release(): Promise<void> } | null = null;
  private startedAt = 0;
  private pausedTotal = 0;
  private pausedAt = 0;
  private chunks: Blob[] = [];
  private persistChain: Promise<unknown> = Promise.resolve();
  state: RecordingState = 'idle';
  mimeType = '';
  readonly id: string;

  constructor(
    private wsId: string,
    private meetingId: string,
    private events: RecorderEvents = {},
  ) {
    this.id = `rec-${meetingId}-${Date.now()}`;
  }

  private setState(s: RecordingState) {
    this.state = s;
    this.events.onState?.(s);
  }

  /** Elapsed recording time (excluding pauses). */
  elapsedMs(): number {
    if (!this.startedAt) return 0;
    const end = this.state === 'paused' ? this.pausedAt : Date.now();
    return Math.max(0, end - this.startedAt - this.pausedTotal);
  }

  async start(opts: { includeTabAudio?: boolean } = {}) {
    this.setState('starting');
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.stream = mic;
    let recordStream: MediaStream = mic;
    const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) this.ctx = new AC();
    if (opts.includeTabAudio && navigator.mediaDevices.getDisplayMedia && this.ctx) {
      try {
        // The browser shows its own sharing UI and indicator; the user picks the tab and "share tab audio".
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        display.getVideoTracks().forEach((t) => t.stop());
        if (display.getAudioTracks().length) {
          this.extraStreams.push(display);
          const dest = this.ctx.createMediaStreamDestination();
          this.ctx.createMediaStreamSource(mic).connect(dest);
          this.ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(dest);
          recordStream = dest.stream;
        } else {
          this.events.onWarning?.('capture.warn.noTabAudio');
        }
      } catch {
        this.events.onWarning?.('capture.warn.noTabAudio');
      }
    }
    if (this.ctx) {
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      this.ctx.createMediaStreamSource(recordStream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        this.events.onLevel?.(Math.min(1, Math.sqrt(sum / buf.length) * 3));
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
    const mime = pickMimeType();
    this.recorder = mime ? new MediaRecorder(recordStream, { mimeType: mime, audioBitsPerSecond: 64000 }) : new MediaRecorder(recordStream);
    this.mimeType = this.recorder.mimeType || mime || 'audio/webm';
    this.recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        this.chunks.push(ev.data);
        this.persist();
      }
    };
    this.recorder.onerror = () => this.setState('error');
    this.startedAt = Date.now();
    await idb
      .put<StoredRecording>('recordings', {
        id: this.id,
        wsId: this.wsId,
        meetingId: this.meetingId,
        mimeType: this.mimeType,
        startedAt: new Date(this.startedAt).toISOString(),
        endedAt: null,
        durationMs: 0,
        chunks: [],
        uploaded: false,
      })
      .catch(() => undefined);
    this.recorder.start(1000);
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl) this.wakeLock = await wl.request('screen');
    } catch {
      /* wake lock is best effort */
    }
    this.setState('recording');
  }

  private persist() {
    const chunks = this.chunks.slice();
    const durationMs = this.elapsedMs();
    this.persistChain = this.persistChain.then(() =>
      idb.update<StoredRecording>('recordings', this.id, (cur) => (cur ? { ...cur, chunks, durationMs } : cur)).catch(() => undefined),
    );
  }

  pause() {
    if (this.recorder?.state === 'recording') {
      this.recorder.pause();
      this.pausedAt = Date.now();
      this.setState('paused');
    }
  }

  resume() {
    if (this.recorder?.state === 'paused') {
      this.recorder.resume();
      this.pausedTotal += Date.now() - this.pausedAt;
      this.setState('recording');
    }
  }

  /** Stops recording and returns the complete audio. */
  async stop(): Promise<{ blob: Blob; durationMs: number; mimeType: string; filename: string; id: string }> {
    this.setState('stopping');
    const durationMs = this.elapsedMs();
    const rec = this.recorder;
    if (rec && rec.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        rec.addEventListener('stop', () => resolve(), { once: true });
        rec.stop();
      });
    }
    this.cleanup();
    this.persist();
    await this.persistChain;
    await idb.update<StoredRecording>('recordings', this.id, (cur) => (cur ? { ...cur, endedAt: new Date().toISOString(), durationMs } : cur)).catch(() => undefined);
    this.setState('stopped');
    const blob = new Blob(this.chunks, { type: this.mimeType });
    const stamp = new Date(this.startedAt).toISOString().replace(/[:.]/g, '-');
    return { blob, durationMs, mimeType: this.mimeType, filename: `meetledger-${stamp}.${extensionForMime(this.mimeType)}`, id: this.id };
  }

  /** Stops everything without keeping the audio (user cancelled). */
  async discard() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.cleanup();
    await this.persistChain;
    await idb.delete('recordings', this.id).catch(() => undefined);
    this.setState('idle');
  }

  private cleanup() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.extraStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.extraStreams = [];
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
  }
}

export async function listStoredRecordings(meetingId: string): Promise<StoredRecording[]> {
  try {
    return (await idb.all<StoredRecording>('recordings')).filter((r) => r.meetingId === meetingId && !r.uploaded);
  } catch {
    return [];
  }
}

export function storedRecordingBlob(r: StoredRecording): Blob {
  return new Blob(r.chunks, { type: r.mimeType });
}

export function deleteStoredRecording(id: string) {
  return idb.delete('recordings', id).catch(() => undefined);
}
