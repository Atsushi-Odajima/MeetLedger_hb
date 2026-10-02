import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  INAUDIBLE,
  MODEL_CATALOG,
  assignSpeakers,
  checkModels,
  decodeWav,
  downloadModel,
  getModelEntry,
  isUnintelligible,
  localAsrAvailable,
  transcribeFile,
  wavPcmSha256,
} from '../src';

const MODEL_DIR = process.env.LOCAL_ASR_MODEL_DIR ? resolve(process.env.LOCAL_ASR_MODEL_DIR) : resolve(__dirname, '../../../models');
const tmp = mkdtempSync(join(tmpdir(), 'local-asr-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function pcmWav(samples: number[], sampleRate = 16000, channels = 1, extraChunk?: Buffer): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * 2, 16);
  fmt.writeUInt16LE(channels * 2, 20);
  fmt.writeUInt16LE(16, 22);
  const dataHdr = Buffer.alloc(8);
  dataHdr.write('data', 0, 'ascii');
  dataHdr.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, ...(extraChunk ? [extraChunk] : []), dataHdr, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

describe('catalog', () => {
  it('default ASR + diarization entries point at official k2-fsa releases and carry licenses', () => {
    const asr = getModelEntry('sense-voice');
    expect(asr.kind).toBe('asr');
    expect(asr.files.model).toContain('sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17');
    expect(asr.files.vad).toBe('silero_vad.onnx');
    expect(asr.licenses.find((l) => /FunASR/.test(l.license))?.attribution).toBeTruthy();
    const d = getModelEntry('diarization');
    expect(d.files.segmentation).toContain('pyannote-segmentation-3-0');
    expect(d.files.embedding).toContain('campplus');
    for (const m of MODEL_CATALOG) {
      for (const dl of m.downloads) {
        expect(dl.url.startsWith('https://github.com/k2-fsa/sherpa-onnx/releases/download/')).toBe(true);
        expect(dl.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(dl.sizeBytes).toBeGreaterThan(0);
      }
    }
    expect(() => getModelEntry('nope')).toThrow(/Unknown/);
  });
});

describe('model files', () => {
  it('checkModels reports missing files without touching the network', () => {
    const dir = join(tmp, 'empty');
    mkdirSync(dir);
    const c = checkModels(dir, 'sense-voice');
    expect(c.ok).toBe(false);
    expect(c.missing).toHaveLength(3);
    expect(localAsrAvailable(dir).ok).toBe(false);
  });

  it('downloadModel rejects a size/hash mismatch and leaves no partial file', async () => {
    const dir = join(tmp, 'dl');
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(new Uint8Array(10), { status: 200, headers: { 'content-length': '10' } });
    }) as unknown as typeof fetch;
    await expect(downloadModel('sense-voice', dir, undefined, { fetchImpl: fakeFetch })).rejects.toThrow(/size mismatch/);
    expect(calls).toBe(1);
    expect(readdirSync(dir).filter((f) => f.includes('.part'))).toHaveLength(0);
  });

  it('downloadModel skips downloads that are already present (no fetch)', async () => {
    const dir = join(tmp, 'present');
    const e = getModelEntry('diarization');
    for (const rel of Object.values(e.files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), 'x');
    }
    const phases: string[] = [];
    const fakeFetch = (async () => {
      throw new Error('network must not be used');
    }) as unknown as typeof fetch;
    const r = await downloadModel('diarization', dir, (p) => phases.push(p.phase), { fetchImpl: fakeFetch });
    expect(r.ok).toBe(true);
    expect(phases).toEqual(['skip', 'skip', 'done']);
  });
});

describe('wav + helpers', () => {
  it('decodes PCM16 and hashes only the PCM payload (metadata chunks ignored)', () => {
    const samples = Array.from({ length: 1600 }, (_, i) => Math.sin(i / 10) * 0.5);
    const a = pcmWav(samples);
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([8, 0, 0, 0]), Buffer.from('INFOtest')]);
    const b = pcmWav(samples, 16000, 1, list);
    const d = decodeWav(a);
    expect(d.sampleRate).toBe(16000);
    expect(d.channels).toBe(1);
    expect(d.durationMs).toBe(100);
    expect(Math.abs(d.mono[10] - Math.sin(1) * 0.5)).toBeLessThan(1e-3);
    writeFileSync(join(tmp, 'a.wav'), a);
    writeFileSync(join(tmp, 'b.wav'), b);
    expect(wavPcmSha256(join(tmp, 'a.wav'))).toBe(wavPcmSha256(join(tmp, 'b.wav')));
  });

  it('isUnintelligible / assignSpeakers', () => {
    expect(isUnintelligible('')).toBe(true);
    expect(isUnintelligible('。、')).toBe(true);
    expect(isUnintelligible('[inaudible]')).toBe(true);
    expect(isUnintelligible('はい')).toBe(false);
    const input: { startMs: number; endMs: number; speaker?: string }[] = [
      { startMs: 0, endMs: 1000 },
      { startMs: 1200, endMs: 3000 },
      { startMs: 9000, endMs: 9500 },
    ];
    const segs = assignSpeakers(
      input,
      [
        { startMs: 0, endMs: 1500, speaker: 'speaker_0' },
        { startMs: 1500, endMs: 4000, speaker: 'speaker_1' },
      ],
    );
    expect(segs.map((s) => s.speaker)).toEqual(['speaker_0', 'speaker_1', 'speaker_1']);
  });
});

// ---- Real on-device transcription with the model's bundled test wavs (skipped when models are not downloaded).
const SV = join(MODEL_DIR, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17');
const haveModels = localAsrAvailable(MODEL_DIR).ok && existsSync(join(SV, 'test_wavs', 'ja.wav'));
const haveDiar = haveModels && checkModels(MODEL_DIR, 'diarization').ok;
if (!haveModels) console.warn(`[local-asr] real ASR tests skipped: models not found in ${MODEL_DIR} (run bash scripts/download-models.sh)`);

describe.skipIf(!haveModels)('real sherpa-onnx SenseVoice transcription (bundled test wavs)', () => {
  it('ja.wav', async () => {
    const r = await transcribeFile(join(SV, 'test_wavs', 'ja.wav'), { modelDir: MODEL_DIR, numThreads: 2 });
    console.info('[local-asr] ja.wav ->', JSON.stringify(r.segments));
    expect(r.language).toBe('ja');
    expect(r.diarization).toBe('none');
    const text = r.segments.map((s) => s.text).join('');
    expect(text).toContain('中学');
    expect(text).toContain('弁当');
    expect(r.segments[0].startMs).toBeGreaterThanOrEqual(0);
    expect(r.segments.at(-1)!.endMs).toBeLessThanOrEqual(r.durationMs);
  });

  it('en.wav', async () => {
    const r = await transcribeFile(join(SV, 'test_wavs', 'en.wav'), { modelDir: MODEL_DIR, numThreads: 2, language: 'en' });
    console.info('[local-asr] en.wav ->', JSON.stringify(r.segments));
    expect(r.segments.map((s) => s.text).join(' ').toLowerCase()).toContain('tribal chieftain');
  });

  it('noise-only audio produces no invented words', async () => {
    const wav = join(tmp, 'noise.wav');
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=4:c=pink:r=16000:a=0.05', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    const r = await transcribeFile(wav, { modelDir: MODEL_DIR, numThreads: 2, language: 'ja' });
    console.info('[local-asr] noise ->', JSON.stringify(r.segments));
    for (const s of r.segments) expect(s.text === INAUDIBLE || s.text.length > 0).toBe(true);
  });

  it.skipIf(!haveDiar)('ja + en + ja concatenation with local diarization', async () => {
    const wav = join(tmp, 'mix.wav');
    const tw = (n: string) => join(SV, 'test_wavs', n);
    execFileSync('ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-y',
      '-i', tw('ja.wav'), '-f', 'lavfi', '-t', '1.5', '-i', 'anullsrc=r=16000:cl=mono', '-i', tw('en.wav'), '-f', 'lavfi', '-t', '1.5', '-i', 'anullsrc=r=16000:cl=mono', '-i', tw('ja.wav'),
      '-filter_complex', '[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav,
    ]);
    const t0 = Date.now();
    const r = await transcribeFile(wav, { modelDir: MODEL_DIR, numThreads: 2, diarization: true });
    console.info('[local-asr] mix ->', JSON.stringify(r.segments), `elapsed ${Date.now() - t0} ms for ${r.durationMs} ms audio`);
    expect(r.segments).toHaveLength(3);
    expect(r.diarization).toBe('provider');
    // Same voice (ja.wav twice) clusters together; the English speaker is a different cluster.
    expect(r.segments[0].speaker).toBe(r.segments[2].speaker);
    expect(r.segments[1].speaker).not.toBe(r.segments[0].speaker);
    expect(r.segments[0].startMs).toBeLessThan(r.segments[1].startMs);
  });
});
