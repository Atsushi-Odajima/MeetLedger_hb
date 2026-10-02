import { cpus } from 'node:os';
import { DEFAULT_ASR_MODEL, DIARIZATION_MODEL, getModelEntry } from './catalog';
import { checkModels } from './models';
import { loadSherpa, loadSherpaAddon, sherpaStatus } from './sherpa';
import { readWavFile } from './wav';

/** Unintelligible speech is emitted as exactly this token — never "filled in". */
export const INAUDIBLE = '[inaudible]';
const SAMPLE_RATE = 16000;

export interface LocalSegment {
  startMs: number;
  endMs: number;
  /** Recognized text, or exactly "[inaudible]" when speech was detected but nothing intelligible was recognized. */
  text: string;
  /** 0..1 when the model exposes token probabilities; undefined otherwise (SenseVoice via sherpa-onnx does not). */
  confidence?: number;
  /** Diarization cluster label ("speaker_0", ...). Never a real person's name. */
  speaker?: string;
  /** Language detected by the model for this segment (e.g. "ja"). */
  lang?: string;
}

export interface LocalTranscriptionResult {
  segments: LocalSegment[];
  model: string;
  language: string | null;
  diarization: 'provider' | 'none';
  durationMs: number;
  /** Set when diarization was requested but could not run (models missing / error). */
  diarizationError?: string;
}

export interface DiarizationOptions {
  /** Known number of speakers (improves clustering). Default: unknown (-1, threshold based). */
  numSpeakers?: number;
  /** Clustering threshold (larger => fewer speakers). Default 0.5. */
  threshold?: number;
}

export interface TranscribeOptions {
  modelDir: string;
  /** Catalog id (default 'sense-voice'). */
  model?: string;
  numThreads?: number;
  /** true / options => run local diarization (requires the 'diarization' catalog model). */
  diarization?: boolean | DiarizationOptions;
  /** 'ja' | 'en' | 'auto' (or any SenseVoice language code). */
  language?: string;
  onProgress?: (p: { phase: 'vad' | 'asr' | 'diarization'; done: number; total: number }) => void;
  signal?: AbortSignal;
}

/** Availability check without loading models into memory. */
export function localAsrAvailable(modelDir: string, model = DEFAULT_ASR_MODEL): { ok: boolean; reason?: string } {
  const s = sherpaStatus();
  if (!s.ok) return { ok: false, reason: s.reason };
  const c = checkModels(modelDir, model);
  if (!c.ok) return { ok: false, reason: `モデル未ダウンロード（${c.missing.join(', ')}）。scripts/download-models.sh を実行してください` };
  return { ok: true };
}

/** True when recognized text carries no letters/digits (noise, punctuation only, empty). */
export function isUnintelligible(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text.replace(/\[inaudible\]/gi, ''));
}

function letterCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

// Recognizers are expensive to create (hundreds of MB); cache per configuration.
const recognizers = new Map<string, Promise<any>>();

function defaultThreads() {
  return Math.max(1, Math.min(4, cpus().length));
}

function getRecognizer(sherpa: any, files: Record<string, string>, numThreads: number, language: string): Promise<any> {
  const lang = !language || language === 'auto' ? 'auto' : language;
  const key = `${files.model}|${numThreads}|${lang}`;
  let r = recognizers.get(key);
  if (!r) {
    const config = {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: files.model, language: lang, useInverseTextNormalization: 1 },
        tokens: files.tokens,
        numThreads,
        provider: 'cpu',
        debug: 0,
      },
    };
    const created: Promise<any> =
      typeof sherpa.OfflineRecognizer.createAsync === 'function' ? sherpa.OfflineRecognizer.createAsync(config) : Promise.resolve().then(() => new sherpa.OfflineRecognizer(config));
    created.catch(() => recognizers.delete(key));
    recognizers.set(key, created);
    r = created;
  }
  return r;
}

interface SpeechChunk {
  startSample: number;
  samples: Float32Array;
}

/**
 * Silero VAD segmentation (speech regions, max ~20 s each so the offline recognizer gets bounded inputs).
 * Yields to the event loop periodically so a server process stays responsive on long recordings.
 */
async function vadSegments(sherpa: any, vadModel: string, samples: Float32Array, numThreads: number, signal?: AbortSignal): Promise<SpeechChunk[]> {
  const config = {
    sileroVad: { model: vadModel, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.5, maxSpeechDuration: 20, windowSize: 512 },
    sampleRate: SAMPLE_RATE,
    numThreads: Math.min(numThreads, 2),
    provider: 'cpu',
    debug: 0,
  };
  const vad = new sherpa.Vad(config, 60);
  const win = config.sileroVad.windowSize;
  const out: SpeechChunk[] = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front(false);
      out.push({ startSample: seg.start, samples: new Float32Array(seg.samples) });
      vad.pop();
    }
  };
  const yieldEvery = win * 1000; // ~32 s of audio
  for (let i = 0; i + win <= samples.length; i += win) {
    vad.acceptWaveform(samples.subarray(i, i + win));
    drain();
    if (i % yieldEvery === 0 && i > 0) {
      await new Promise((r) => setImmediate(r));
      if (signal?.aborted) throw new Error('aborted');
    }
  }
  // Pad the tail so the final partial window is analysed too.
  const rest = samples.length % win;
  if (rest) {
    const tail = new Float32Array(win);
    tail.set(samples.subarray(samples.length - rest));
    vad.acceptWaveform(tail);
  }
  vad.flush();
  drain();
  return out;
}

function confidenceFrom(result: any): number | undefined {
  const lp: number[] | undefined = result?.ys_log_probs;
  if (!Array.isArray(lp) || !lp.length) return undefined;
  const mean = lp.reduce((a, b) => a + b, 0) / lp.length;
  return Math.max(0, Math.min(1, Math.exp(mean)));
}

/** Assigns each ASR segment the diarization speaker with the largest time overlap (nearest when none overlaps). */
export function assignSpeakers<T extends { startMs: number; endMs: number; speaker?: string }>(segments: T[], turns: { startMs: number; endMs: number; speaker: string }[]): T[] {
  if (!turns.length) return segments;
  return segments.map((s) => {
    const overlap = new Map<string, number>();
    for (const t of turns) {
      const o = Math.min(s.endMs, t.endMs) - Math.max(s.startMs, t.startMs);
      if (o > 0) overlap.set(t.speaker, (overlap.get(t.speaker) ?? 0) + o);
    }
    let best: string | undefined;
    let bestV = 0;
    for (const [k, v] of overlap) if (v > bestV) [best, bestV] = [k, v];
    if (!best) {
      const mid = (s.startMs + s.endMs) / 2;
      let d = Infinity;
      for (const t of turns) {
        const dd = Math.min(Math.abs(t.startMs - mid), Math.abs(t.endMs - mid));
        if (dd < d) [d, best] = [dd, t.speaker];
      }
    }
    return { ...s, speaker: best };
  });
}

async function diarize(sherpa: any, files: Record<string, string>, samples: Float32Array, numThreads: number, o: DiarizationOptions) {
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: files.segmentation }, numThreads, debug: 0 },
    embedding: { model: files.embedding, numThreads, debug: 0 },
    clustering: { numClusters: o.numSpeakers && o.numSpeakers > 0 ? o.numSpeakers : -1, threshold: o.threshold ?? 0.5 },
    minDurationOn: 0.2,
    minDurationOff: 0.5,
  });
  if (sd.sampleRate !== SAMPLE_RATE) throw new Error(`diarization model expects ${sd.sampleRate} Hz`);
  // Prefer the native async variant (runs off the main thread); fall back to the synchronous API.
  let res: { start: number; end: number; speaker: number }[];
  const addon = loadSherpaAddon();
  if (addon && typeof addon.offlineSpeakerDiarizationProcessAsync === 'function' && sd.handle) {
    res = await addon.offlineSpeakerDiarizationProcessAsync(sd.handle, samples, () => 0);
  } else {
    res = sd.process(samples);
  }
  return res.map((r) => ({ startMs: Math.round(r.start * 1000), endMs: Math.round(r.end * 1000), speaker: `speaker_${r.speaker}` }));
}

/** Transcribes 16 kHz mono samples. See transcribeFile. */
export async function transcribeSamples(samples: Float32Array, opts: TranscribeOptions): Promise<LocalTranscriptionResult> {
  const modelId = opts.model ?? DEFAULT_ASR_MODEL;
  const entry = getModelEntry(modelId);
  if (entry.kind !== 'asr') throw new Error(`${modelId} is not an ASR model`);
  const sherpa = loadSherpa();
  const check = checkModels(opts.modelDir, modelId);
  if (!check.ok) throw new Error(`local ASR model '${modelId}' is not installed (missing: ${check.missing.join(', ')})`);
  const numThreads = opts.numThreads ?? defaultThreads();
  const durationMs = Math.round((samples.length / SAMPLE_RATE) * 1000);

  const chunks = await vadSegments(sherpa, check.files.vad, samples, numThreads, opts.signal);
  opts.onProgress?.({ phase: 'vad', done: 1, total: 1 });
  const recognizer = await getRecognizer(sherpa, check.files, numThreads, opts.language ?? 'auto');
  const segments: LocalSegment[] = [];
  const langCount = new Map<string, number>();
  for (const [i, c] of chunks.entries()) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: c.samples, sampleRate: SAMPLE_RATE });
    let result: any;
    if (typeof recognizer.decodeAsync === 'function') result = await recognizer.decodeAsync(stream);
    else {
      recognizer.decode(stream);
      result = recognizer.getResult(stream);
    }
    const text = String(result?.text ?? '').trim();
    const lang = String(result?.lang ?? '').replace(/[<>|]/g, '') || undefined;
    const event = String(result?.event ?? '').replace(/[<>|]/g, '') || undefined;
    if (lang && !isUnintelligible(text)) langCount.set(lang, (langCount.get(lang) ?? 0) + c.samples.length);
    const startMs = Math.round((c.startSample / SAMPLE_RATE) * 1000);
    const endMs = Math.round(((c.startSample + c.samples.length) / SAMPLE_RATE) * 1000);
    // Speech was detected but nothing intelligible came out: keep the gap visible, never invent words.
    const unintelligible = isUnintelligible(text) || (event !== undefined && event !== 'Speech' && letterCount(text) <= 2);
    const confidence = unintelligible ? 0 : confidenceFrom(result);
    segments.push({ startMs, endMs, text: unintelligible ? INAUDIBLE : text, ...(confidence !== undefined ? { confidence } : {}), ...(lang ? { lang } : {}) });
    opts.onProgress?.({ phase: 'asr', done: i + 1, total: chunks.length });
  }
  // SenseVoice sometimes emits a single character in another language for noise (measured: background noise ->
  // "그."). A 1-letter segment whose language differs from the meeting's language is marked inaudible instead.
  const expectedLang = opts.language && opts.language !== 'auto' ? opts.language : langCount.size ? [...langCount.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
  if (expectedLang) {
    for (const s of segments) {
      if (s.text !== INAUDIBLE && s.lang && s.lang !== expectedLang && letterCount(s.text) <= 1) {
        s.text = INAUDIBLE;
        s.confidence = 0;
      }
    }
  }

  let diarization: 'provider' | 'none' = 'none';
  let diarizationError: string | undefined;
  if (opts.diarization && segments.length) {
    const d = checkModels(opts.modelDir, DIARIZATION_MODEL);
    if (!d.ok) diarizationError = `diarization models missing: ${d.missing.join(', ')}`;
    else {
      try {
        const turns = await diarize(sherpa, d.files, samples, numThreads, typeof opts.diarization === 'object' ? opts.diarization : {});
        if (turns.length) {
          segments.splice(0, segments.length, ...assignSpeakers(segments, turns));
          diarization = 'provider';
        }
      } catch (e) {
        diarizationError = e instanceof Error ? e.message.slice(0, 200) : 'diarization failed';
      }
      opts.onProgress?.({ phase: 'diarization', done: 1, total: 1 });
    }
  }
  let language: string | null = opts.language && opts.language !== 'auto' ? opts.language : null;
  if (!language && langCount.size) language = [...langCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { segments, model: modelId, language, diarization, durationMs, ...(diarizationError ? { diarizationError } : {}) };
}

/**
 * Transcribes a 16 kHz mono WAV file fully on this machine (VAD-segmented SenseVoice via sherpa-onnx; optional
 * pyannote + CAM++ diarization). No network access is performed.
 */
export async function transcribeFile(wav16kMonoPath: string, opts: TranscribeOptions): Promise<LocalTranscriptionResult> {
  const wav = readWavFile(wav16kMonoPath);
  if (wav.sampleRate !== SAMPLE_RATE) throw new Error(`expected 16 kHz WAV, got ${wav.sampleRate} Hz (normalize with ffmpeg -ar 16000 -ac 1)`);
  return transcribeSamples(wav.mono, opts);
}
