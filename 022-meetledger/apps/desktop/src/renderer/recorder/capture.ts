// Dual-channel capture for the desktop recorder page.
//
//   getUserMedia (mic) ──► mono ─┐
//                                ├─► ChannelMerger(2): ch0 = mic ("あなた"), ch1 = system audio (other side)
//   getDisplayMedia (loopback) ─► mono ─┘        │
//                                                ├─► MediaStreamDestination ─► MediaRecorder (opus/webm, stereo)  [upload]
//                                                ├─► AudioWorklet tap ─► 16 kHz mono PCM16 + L/R envelope        [device ASR]
//                                                └─► ChannelSplitter ─► 2 × Analyser (level meters)
//
// Keeping mic and system audio on separate channels lets the server (and the local attribution step) separate
// "あなた" from the remote participants without voice identification.

type Chunk = { webm?: ArrayBuffer; pcm?: ArrayBuffer; env?: ArrayBuffer };

export interface CaptureOptions {
  systemAudio: boolean;
  /** stream 16 kHz PCM for on-device ASR */
  tapPcm: boolean;
  /** record opus/webm for upload */
  recordWebm: boolean;
  onData: (chunk: Chunk) => Promise<void>;
  onWarning: (msg: string) => void;
}

export interface CaptureStartResult {
  systemAudioActive: boolean;
  mimeType: string | null;
  /** false = AudioWorklet unavailable; the page must convert the in-memory webm after stop (convert.ts) */
  tapActive: boolean;
}

const WEBM_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return WEBM_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

export class DualChannelRecorder {
  private ctx: AudioContext | null = null;
  private streams: MediaStream[] = [];
  private recorder: MediaRecorder | null = null;
  private tap: AudioWorkletNode | null = null;
  private analysers: [AnalyserNode, AnalyserNode] | null = null;
  private sendQueue: Promise<void> = Promise.resolve();
  private sendError: Error | null = null;
  /** webm kept in memory only when the worklet tap is unavailable (fallback conversion) */
  readonly fallbackChunks: Blob[] = [];
  private keepInMemory = false;

  constructor(private readonly opts: CaptureOptions) {}

  /** Sends chunks strictly in order (one IPC call at a time). */
  private send(make: () => Promise<Chunk> | Chunk): void {
    this.sendQueue = this.sendQueue
      .then(async () => this.opts.onData(await make()))
      .catch((e: Error) => {
        this.sendError ??= e;
        this.opts.onWarning(`録音データの保存に失敗しました: ${e.message}`);
      });
  }

  async start(): Promise<CaptureStartResult> {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.streams.push(mic);
    mic.getAudioTracks()[0]?.addEventListener('ended', () => this.opts.onWarning('マイクが切断されました'));

    let system: MediaStream | null = null;
    if (this.opts.systemAudio) {
      try {
        // getDisplayMedia must request video; main answers with this page itself as the video source and
        // 'loopback' as audio. The video track is stopped immediately — the screen is never captured.
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        display.getVideoTracks().forEach((t) => t.stop());
        const track = display.getAudioTracks()[0];
        if (track && track.readyState === 'live') {
          system = new MediaStream([track]);
          this.streams.push(display);
          track.addEventListener('ended', () =>
            this.opts.onWarning('システム音声のキャプチャが停止しました（OS の許可設定を確認してください）。マイクの録音は続いています。'),
          );
        } else {
          display.getTracks().forEach((t) => t.stop());
          this.opts.onWarning(
            'システム音声を取得できませんでした。macOS では「システム設定 > プライバシーとセキュリティ > 画面とシステムオーディオ収録」で MeetLedger を許可してください。マイクのみで録音します。',
          );
        }
      } catch (e) {
        this.opts.onWarning(`システム音声を取得できませんでした（${(e as Error).name}）。マイクのみで録音します。`);
      }
    }

    const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'playback' });
    this.ctx = ctx;
    if (ctx.state === 'suspended') await ctx.resume();

    const toMono = (stream: MediaStream) => {
      const src = ctx.createMediaStreamSource(stream);
      const g = ctx.createGain();
      g.channelCount = 1;
      g.channelCountMode = 'explicit';
      g.channelInterpretation = 'speakers'; // stereo sources are down-mixed 0.5·(L+R)
      src.connect(g);
      return g;
    };
    const merger = ctx.createChannelMerger(2);
    toMono(mic).connect(merger, 0, 0);
    if (system) toMono(system).connect(merger, 0, 1);

    // level meters
    const splitter = ctx.createChannelSplitter(2);
    merger.connect(splitter);
    const aL = ctx.createAnalyser();
    const aR = ctx.createAnalyser();
    aL.fftSize = aR.fftSize = 1024;
    splitter.connect(aL, 0);
    splitter.connect(aR, 1);
    this.analysers = [aL, aR];

    // on-device ASR tap
    let tapActive = false;
    if (this.opts.tapPcm) {
      try {
        await ctx.audioWorklet.addModule(new URL('./pcm-tap-worklet.js', location.href).href);
        const node = new AudioWorkletNode(ctx, 'meetledger-pcm-tap', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'discrete',
        });
        node.port.onmessage = (e: MessageEvent) => {
          const d = e.data as { type: string; pcm?: ArrayBuffer; env?: ArrayBuffer };
          if (d.type === 'data') this.send(() => ({ pcm: d.pcm!.byteLength ? d.pcm : undefined, env: d.env!.byteLength ? d.env : undefined }));
          if (d.type === 'stopped') this.tapStopped?.();
        };
        merger.connect(node);
        const sink = ctx.createGain();
        sink.gain.value = 0; // keeps the node pulled by the graph without playing anything
        node.connect(sink).connect(ctx.destination);
        this.tap = node;
        tapActive = true;
      } catch (e) {
        this.opts.onWarning(`AudioWorklet を利用できないため、停止後に変換します（${(e as Error).message}）`);
      }
    }

    // opus/webm recording (upload, or fallback conversion source)
    const mimeType = pickMimeType();
    this.keepInMemory = this.opts.tapPcm && !tapActive;
    if (this.opts.recordWebm || this.keepInMemory) {
      if (!mimeType) throw new Error('この環境では MediaRecorder（opus/webm）を利用できません');
      const dest = ctx.createMediaStreamDestination();
      dest.channelCount = 2;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
      merger.connect(dest);
      const rec = new MediaRecorder(dest.stream, { mimeType, audioBitsPerSecond: 96_000 });
      rec.ondataavailable = (e) => {
        if (!e.data || e.data.size === 0) return;
        if (this.keepInMemory) this.fallbackChunks.push(e.data);
        if (this.opts.recordWebm) {
          const blob = e.data;
          this.send(async () => ({ webm: await blob.arrayBuffer() }));
        }
      };
      rec.start(1000);
      this.recorder = rec;
    }

    return { systemAudioActive: !!system, mimeType: this.recorder ? mimeType : null, tapActive };
  }

  private tapStopped: (() => void) | null = null;

  /** RMS levels (0..1) of mic / system channels for the meters. */
  levels(): { mic: number; system: number } {
    if (!this.analysers) return { mic: 0, system: 0 };
    const rms = (a: AnalyserNode) => {
      const buf = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(buf);
      let s = 0;
      for (const x of buf) s += x * x;
      return Math.sqrt(s / buf.length);
    };
    return { mic: rms(this.analysers[0]), system: rms(this.analysers[1]) };
  }

  /** Stops capture, flushes the worklet and the MediaRecorder, and waits until every chunk reached main. */
  async stop(): Promise<void> {
    const waits: Promise<void>[] = [];
    if (this.tap) {
      waits.push(
        new Promise<void>((resolve) => {
          this.tapStopped = resolve;
          this.tap!.port.postMessage('stop');
          setTimeout(resolve, 2000);
        }),
      );
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      const rec = this.recorder;
      waits.push(
        new Promise<void>((resolve) => {
          rec.addEventListener('stop', () => resolve(), { once: true });
          rec.stop();
        }),
      );
    }
    await Promise.all(waits);
    for (const s of this.streams) s.getTracks().forEach((t) => t.stop());
    this.streams = [];
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    // ondataavailable fires before 'stop'; give the queued sends a turn to be chained, then drain
    await new Promise((r) => setTimeout(r, 0));
    await this.sendQueue;
    if (this.sendError) throw this.sendError;
  }

  /** Releases devices without waiting for data (used when aborting). */
  abort(): void {
    try {
      this.recorder?.stop();
    } catch {
      /* ignore */
    }
    for (const s of this.streams) s.getTracks().forEach((t) => t.stop());
    this.streams = [];
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  get needsFallbackConversion(): boolean {
    return this.keepInMemory;
  }
}
