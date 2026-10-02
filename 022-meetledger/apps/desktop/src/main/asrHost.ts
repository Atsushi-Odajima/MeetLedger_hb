// Spawns and talks to the ASR utility process (dist/asr-worker.cjs). One request at a time per method is fine:
// transcription is CPU-bound and serialized by the caller; the process is killed after a few idle minutes so
// model memory is returned to the OS.

import path from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { WorkerMessage, WorkerMethod } from '../worker/protocol';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (args: unknown[]) => void;
}

export class AsrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const IDLE_MS = 5 * 60 * 1000;

export class AsrHost {
  private proc: UtilityProcess | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly workerPath: string,
    private readonly nativeDirs: string[],
  ) {}

  private ensure(): UtilityProcess {
    if (this.proc) return this.proc;
    // Make the sherpa-onnx shared libraries resolvable (README of sherpa-onnx-node). Linux/Windows addons use
    // $ORIGIN / the addon directory; DYLD_LIBRARY_PATH is ignored under the hardened runtime, so macOS relies on
    // the addon's @loader_path (未検証 on signed builds — see docs/DESKTOP_COMPANION.md).
    const env: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    const join = (cur: string | undefined) => [...this.nativeDirs, ...(cur ? [cur] : [])].join(path.delimiter);
    if (process.platform === 'linux') env.LD_LIBRARY_PATH = join(process.env.LD_LIBRARY_PATH);
    if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = join(process.env.DYLD_LIBRARY_PATH);
    if (process.platform === 'win32') env.PATH = join(process.env.PATH);

    const proc = utilityProcess.fork(this.workerPath, [], { serviceName: 'MeetLedger ASR', stdio: 'inherit', env });
    proc.on('message', (msg: WorkerMessage) => this.onMessage(msg));
    proc.on('exit', (code) => {
      this.proc = null;
      for (const [, p] of this.pending) p.reject(new AsrError('asr_crashed', `文字起こしプロセスが終了しました (code ${code})`));
      this.pending.clear();
    });
    this.proc = proc;
    return proc;
  }

  private onMessage(msg: WorkerMessage): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if ('progress' in msg) {
      p.onProgress?.(Array.isArray(msg.progress) ? msg.progress : []);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new AsrError(msg.error?.code ?? 'asr_failed', msg.error?.message ?? 'ASR failed'));
    this.armIdle();
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.dispose();
    }, IDLE_MS);
    this.idleTimer.unref?.();
  }

  call<T>(method: WorkerMethod, params: Record<string, unknown>, onProgress?: (args: unknown[]) => void, timeoutMs = 0): Promise<T> {
    const proc = this.ensure();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const done = <F extends (...a: never[]) => void>(f: F) =>
        ((...a: Parameters<F>) => {
          if (timer) clearTimeout(timer);
          f(...a);
        }) as F;
      this.pending.set(id, { resolve: done(resolve as (v: unknown) => void), reject: done(reject), onProgress });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new AsrError('asr_timeout', '文字起こしプロセスが応答しません'));
        }, timeoutMs);
      }
      proc.postMessage({ id, method, params });
    });
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.proc?.kill();
    this.proc = null;
  }
}
