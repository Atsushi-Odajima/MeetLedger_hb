// IPC handlers. Every channel: (1) sender check — top-level frame, expected window, allowed page/origin per
// CHANNEL_ACL; (2) argument validation (shared/validate.ts); (3) errors mapped to {code, message} without stack
// traces or file paths.

import fsp from 'node:fs/promises';
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { CH, CHANNEL_ACL, type Capabilities, type IpcResult, type SenderKind } from '../shared/ipc';
import { classifySenderUrl, normalizeServerUrl, UrlPolicyError } from '../shared/urlPolicy';
import {
  ValidationError,
  boundedString,
  fileToken,
  modelId,
  parseConfigPatch,
  parseConsentInput,
  parseCreateMeeting,
  parseMeetingRef,
  parseOptionalMeetingRef,
  parsePrepareInput,
  parseRecData,
  parseRecStarted,
  parseSaveRecording,
  parseTranscribeOptions,
  sanitizeSegments,
  uuid,
} from '../shared/validate';
import { isAsrWav, parseWavHeader } from '../shared/audio/wav';
import { ApiError, MeetLedgerApi, type FetchFn } from './apiClient';
import { AsrError } from './asrHost';
import { SessionError, type RecorderSession, type RawTranscript } from './recorderSession';
import { StoreError, type RecordingStore } from './recordingStore';
import { publicConfig, type DesktopConfig } from './config';

export interface IpcDeps {
  serverOrigin: () => string | null;
  isMainWindow: (wc: WebContents) => boolean;
  isSettingsWindow: (wc: WebContents) => boolean;
  isRecorderWindow: (wc: WebContents) => boolean;
  config: () => DesktopConfig;
  updateConfig: (patch: Partial<DesktopConfig>) => DesktopConfig;
  capabilities: () => Promise<Capabilities>;
  listModels: () => Promise<import('../shared/ipc').ModelInfo[]>;
  downloadModel: (wc: WebContents, id: string) => Promise<{ ok: boolean; cancelled?: boolean; alreadyInstalled?: boolean }>;
  transcribeWav: (wavPath: string, opts: { model?: string; language?: string; diarization?: boolean }) => Promise<RawTranscript>;
  openRecorder: (ref: { workspaceId: string; meetingId: string } | null) => void;
  openSettings: () => void;
  api: MeetLedgerApi;
  netFetch: FetchFn;
  session: RecorderSession;
  store: RecordingStore;
  osVersion: string;
  systemAudioPossible: () => boolean;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

const KNOWN_ERRORS = [ValidationError, UrlPolicyError, ApiError, SessionError, StoreError, AsrError];

function toError(e: unknown): { code: string; message: string } {
  if (KNOWN_ERRORS.some((C) => e instanceof C)) {
    const err = e as Error & { code: string };
    return { code: err.code, message: err.message.slice(0, 500) };
  }
  return { code: 'internal', message: '内部エラーが発生しました' };
}

export function senderKind(event: IpcMainInvokeEvent, deps: IpcDeps): SenderKind | null {
  const frame = event.senderFrame;
  const wc = event.sender;
  if (!frame || frame !== wc.mainFrame) return null; // sub-frames never get the bridge
  const kind = classifySenderUrl(frame.url, deps.serverOrigin());
  if (kind === 'web') return deps.isMainWindow(wc) ? 'web' : null;
  if (kind === 'settings') return deps.isMainWindow(wc) || deps.isSettingsWindow(wc) ? 'settings' : null;
  if (kind === 'recorder') return deps.isRecorderWindow(wc) ? 'recorder' : null;
  return null;
}

type Handler = (ctx: { wc: WebContents; kind: SenderKind }, ...args: unknown[]) => unknown;

export function registerIpc(deps: IpcDeps): void {
  const handle = (channel: string, maxArgs: number, fn: Handler) => {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
      const kind = senderKind(event, deps);
      const acl = CHANNEL_ACL[channel] ?? [];
      if (!kind || !acl.includes(kind)) {
        deps.log('ipc rejected', { channel, kind: kind ?? 'unknown' });
        return { ok: false, error: { code: 'forbidden', message: 'この操作は許可されていません' } };
      }
      if (args.length > maxArgs) return { ok: false, error: { code: 'invalid_input', message: 'too many arguments' } };
      try {
        return { ok: true, value: await fn({ wc: event.sender, kind }, ...args) };
      } catch (e) {
        const err = toError(e);
        if (err.code === 'internal') deps.log('ipc internal error', { channel, error: (e as Error)?.name ?? 'unknown' });
        return { ok: false, error: err };
      }
    });
  };

  // ---------------------------------------------------------------- window.meetledgerDesktop
  handle(CH.capabilities, 0, () => deps.capabilities());
  handle(CH.modelsList, 0, () => deps.listModels());
  handle(CH.modelsDownload, 1, ({ wc }, id) => deps.downloadModel(wc, modelId(id)));
  handle(CH.recordingSave, 1, ({ wc }, input) => {
    const p = parseSaveRecording(input);
    return deps.store.save(wc.id, p.mimeType, p.data);
  });
  handle(CH.recordingDiscard, 1, ({ wc }, token) => deps.store.discard(fileToken(token), wc.id));
  handle(CH.transcribeLocal, 2, async ({ wc }, token, opts) => {
    const entry = deps.store.get(fileToken(token), wc.id);
    const o = parseTranscribeOptions(opts);
    const fh = await fsp.open(entry.path, 'r');
    let head: Uint8Array;
    try {
      const buf = new Uint8Array(4096);
      const { bytesRead } = await fh.read(buf, 0, buf.byteLength, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    if (entry.mimeType !== 'audio/wav' || !isAsrWav(parseWavHeader(head))) {
      throw new ValidationError('16 kHz / mono / 16-bit PCM の WAV が必要です（録音ウィンドウは自動で変換します）');
    }
    const raw = await deps.transcribeWav(entry.path, o);
    return {
      provider: 'local-sherpa' as const,
      model: raw.model,
      language: raw.language,
      diarization: raw.diarization,
      segments: sanitizeSegments(raw.segments),
    };
  });
  handle(CH.openRecorder, 1, (_c, ref) => deps.openRecorder(parseOptionalMeetingRef(ref)));
  handle(CH.openSettings, 0, () => deps.openSettings());

  // ---------------------------------------------------------------- settings page
  handle(CH.configGet, 0, async () => ({ config: publicConfig(deps.config()), recordings: await deps.store.info(), osVersion: deps.osVersion }));
  handle(CH.configSet, 1, (_c, patch) => publicConfig(deps.updateConfig(parseConfigPatch(patch, normalizeServerUrl))));
  handle(CH.serverTest, 1, async (_c, url) => {
    const origin = normalizeServerUrl(boundedString(url, 2048, 'url'));
    const r = await MeetLedgerApi.probeServer(deps.netFetch, origin);
    return { ...r, origin };
  });
  handle(CH.recordingsClear, 0, () => deps.store.clear());

  // ---------------------------------------------------------------- recorder page: allow-listed server API
  handle(CH.apiMe, 0, () => deps.api.me());
  handle(CH.apiMeetings, 1, (_c, ws) => deps.api.meetings(uuid(ws, 'workspaceId')));
  handle(CH.apiMeeting, 1, (_c, ref) => {
    const r = parseMeetingRef(ref);
    return deps.api.meeting(r.workspaceId, r.meetingId);
  });
  handle(CH.apiCreateMeeting, 1, (_c, input) => {
    const r = parseCreateMeeting(input);
    return deps.api.createMeeting(r.workspaceId, r.title);
  });
  handle(CH.apiConsent, 1, async (_c, input) => {
    const r = parseConsentInput(input);
    await deps.api.recordConsent(r.workspaceId, r.meetingId, r.state, r.method);
    return deps.api.meeting(r.workspaceId, r.meetingId);
  });

  // ---------------------------------------------------------------- recorder session
  handle(CH.recPrepare, 1, ({ wc }, input) => {
    const p = parsePrepareInput(input);
    return deps.session.prepare(wc.id, { ...p, systemAudio: p.systemAudio && deps.systemAudioPossible() });
  });
  handle(CH.recStarted, 1, ({ wc }, info) => deps.session.started(wc.id, parseRecStarted(info)));
  handle(CH.recData, 1, ({ wc }, chunk) => deps.session.data(wc.id, parseRecData(chunk)));
  handle(CH.recStop, 0, ({ wc }) => deps.session.stop(wc.id));
  handle(CH.recTranscribe, 0, ({ wc }) => deps.session.transcribe(wc.id));
  handle(CH.recSubmit, 0, ({ wc }) => deps.session.submit(wc.id));
  handle(CH.recUpload, 0, ({ wc }) => deps.session.upload(wc.id));
  handle(CH.recDiscard, 0, ({ wc }) => deps.session.discard(wc.id));
  handle(CH.recCancel, 0, ({ wc }) => deps.session.abandon(wc.id));
}
