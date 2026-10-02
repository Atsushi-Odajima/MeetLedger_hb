// ASR utility process (Electron utilityProcess). Runs @meetledger/local-asr (sherpa-onnx-node native addon) out of
// the main process so a native crash or a 2 GB model never takes the UI down. Audio files never leave this machine:
// this process has no network code of its own besides local-asr's explicit, user-confirmed model download.

import { createRequire } from 'node:module';
import type * as LocalAsr from '@meetledger/local-asr';
import { catalogEntries, normalizeCheck, normalizeModel } from '../shared/models';
import type { ModelInfo } from '../shared/ipc';
import type { CatalogResult, ProbeResult, WorkerMessage, WorkerRequest } from './protocol';

type Mod = Partial<typeof LocalAsr>;

interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

let modPromise: Promise<Mod> | null = null;
function loadModule(): Promise<Mod> {
  // Lazy: the import evaluates local-asr (and possibly loads the native addon); failures are reported, not thrown at startup.
  modPromise ??= import('@meetledger/local-asr').then((m) => m as Mod);
  return modPromise;
}

const REQUIRED = ['MODEL_CATALOG', 'checkModels', 'downloadModel', 'transcribeFile'] as const;

function errMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.slice(0, 500);
}

async function probe(): Promise<ProbeResult> {
  const out: ProbeResult = { module: { ok: false, missing: [], error: null }, runtime: { ok: false, error: null } };
  try {
    const m = await loadModule();
    out.module.missing = REQUIRED.filter((k) => (m as Record<string, unknown>)[k] === undefined);
    out.module.ok = out.module.missing.length === 0;
  } catch (e) {
    out.module.error = errMessage(e);
  }
  try {
    const req = createRequire(import.meta.url);
    const sherpa = req('sherpa-onnx-node') as Record<string, unknown>;
    out.runtime.ok = typeof sherpa === 'object' && sherpa !== null && typeof sherpa.OfflineRecognizer === 'function';
    if (!out.runtime.ok) out.runtime.error = 'sherpa-onnx-node loaded but OfflineRecognizer is missing';
  } catch (e) {
    out.runtime.error = errMessage(e);
  }
  return out;
}

async function requireModule(): Promise<Required<Pick<Mod, (typeof REQUIRED)[number]>>> {
  const m = await loadModule();
  const missing = REQUIRED.filter((k) => (m as Record<string, unknown>)[k] === undefined);
  if (missing.length) throw Object.assign(new Error(`local-asr is missing: ${missing.join(', ')}`), { code: 'local_asr_unavailable' });
  return m as Required<Pick<Mod, (typeof REQUIRED)[number]>>;
}

async function catalog(modelDir: string): Promise<CatalogResult> {
  const m = await requireModule();
  const models: ModelInfo[] = [];
  for (const e of catalogEntries(m.MODEL_CATALOG)) {
    const id = typeof e.id === 'string' ? e.id : '';
    let installed = false;
    try {
      installed = id ? normalizeCheck(await m.checkModels(modelDir, id)) : false;
    } catch {
      installed = false;
    }
    const info = normalizeModel(e, installed);
    if (info) models.push(info);
  }
  return { models };
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`${what} required`);
  return v;
}

async function handle(req: WorkerRequest): Promise<unknown> {
  const p = req.params ?? {};
  switch (req.method) {
    case 'probe':
      return probe();
    case 'catalog':
      return catalog(str(p.modelDir, 'modelDir'));
    case 'download': {
      const m = await requireModule();
      await m.downloadModel(str(p.id, 'id'), str(p.modelDir, 'modelDir'), (...args: unknown[]) => {
        // progress args are forwarded as-is (numbers / plain objects only) and normalized in main
        const safe = args.slice(0, 2).map((a) => (typeof a === 'number' || (typeof a === 'object' && a !== null) ? JSON.parse(JSON.stringify(a)) : null));
        parentPort?.postMessage({ id: req.id, progress: safe } satisfies WorkerMessage);
      });
      return { ok: true };
    }
    case 'transcribe': {
      const m = await requireModule();
      const res = await m.transcribeFile(str(p.wavPath, 'wavPath'), {
        modelDir: str(p.modelDir, 'modelDir'),
        model: typeof p.model === 'string' ? p.model : undefined,
        numThreads: typeof p.numThreads === 'number' ? p.numThreads : undefined,
        diarization: p.diarization === true,
        language: typeof p.language === 'string' ? p.language : undefined,
      });
      // Pass through only plain data; main validates again (sanitizeSegments) before anything is sent to the server.
      const segments = Array.isArray(res?.segments) ? res.segments : [];
      return {
        model: typeof res?.model === 'string' ? res.model : String(p.model ?? 'unknown'),
        language: typeof res?.language === 'string' ? res.language : String(p.language ?? 'auto'),
        diarization: res?.diarization === true,
        segments: segments.map((s) => ({
          startMs: Number(s?.startMs),
          endMs: Number(s?.endMs),
          text: typeof s?.text === 'string' ? s.text : '',
          ...(typeof s?.confidence === 'number' ? { confidence: s.confidence } : {}),
          ...(s?.speaker !== undefined && s?.speaker !== null ? { speaker: String(s.speaker) } : {}),
        })),
      };
    }
    default:
      throw new Error(`unknown method ${(req as { method: string }).method}`);
  }
}

if (!parentPort) {
  console.error('asr-worker must run as an Electron utility process');
  process.exit(1);
}

parentPort.on('message', (e) => {
  const req = e.data as WorkerRequest;
  if (!req || typeof req.id !== 'number' || typeof req.method !== 'string') return;
  handle(req).then(
    (result) => parentPort.postMessage({ id: req.id, ok: true, result } satisfies WorkerMessage),
    (err) =>
      parentPort.postMessage({
        id: req.id,
        ok: false,
        error: { code: (err as { code?: string })?.code ?? 'asr_failed', message: errMessage(err) },
      } satisfies WorkerMessage),
  );
});
