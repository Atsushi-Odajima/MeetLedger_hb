// Sandboxed preload (contextIsolation + sandbox). Exposes ONLY named operations — never ipcRenderer itself,
// never a generic invoke(channel, ...). Inputs are re-validated in main; this layer just shapes the calls.
//   window.meetledgerDesktop — on the configured server origin and on the bundled local pages
//   window.meetledgerLocal   — only on app://desktop pages (settings / recorder)

import { contextBridge, ipcRenderer } from 'electron';
import { CH, type IpcResult, type ModelProgress, type RecState } from '../shared/ipc';
import type { MeetLedgerDesktopBridge, MeetLedgerLocalBridge } from '../shared/bridge';

function arg(name: string): string {
  const prefix = `--meetledger-${name}=`;
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : '';
}

const APP_VERSION = arg('version') || '0.0.0';
const SERVER_ORIGIN = arg('server-origin');
const LOCAL_ORIGIN = 'app://desktop';

class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MeetLedgerDesktopError';
  }
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (r && r.ok === true) return r.value;
  const err = r && r.ok === false ? r.error : { code: 'internal', message: 'IPC failed' };
  throw new BridgeError(err.code, err.message);
}

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  if (typeof cb !== 'function') throw new TypeError('callback must be a function');
  const listener = (_e: Electron.IpcRendererEvent, v: T) => {
    try {
      cb(v);
    } catch {
      /* page callback errors must not break the bridge */
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const desktop: MeetLedgerDesktopBridge = {
  bridgeVersion: 1,
  version: APP_VERSION,
  platform: process.platform,
  capabilities: () => call(CH.capabilities),
  listModels: () => call(CH.modelsList),
  downloadModel: (id) => call(CH.modelsDownload, id),
  onModelDownloadProgress: (cb) => subscribe<ModelProgress>(CH.evtModelProgress, cb),
  saveRecording: (input) => call(CH.recordingSave, input),
  discardRecording: (fileToken) => call(CH.recordingDiscard, fileToken),
  transcribeLocal: (fileToken, opts) => call(CH.transcribeLocal, fileToken, opts ?? null),
  openRecorder: (target) => call(CH.openRecorder, target ?? null),
  openSettings: () => call(CH.openSettings),
};

const local: MeetLedgerLocalBridge = {
  config: {
    get: () => call(CH.configGet),
    set: (patch) => call(CH.configSet, patch),
    testServer: (url) => call(CH.serverTest, url),
    clearRecordings: () => call(CH.recordingsClear),
  },
  api: {
    me: () => call(CH.apiMe),
    meetings: (workspaceId) => call(CH.apiMeetings, workspaceId),
    meeting: (workspaceId, meetingId) => call(CH.apiMeeting, { workspaceId, meetingId }),
    createMeeting: (workspaceId, title) => call(CH.apiCreateMeeting, { workspaceId, title }),
    recordConsent: (input) => call(CH.apiConsent, input),
  },
  recorder: {
    prepare: (input) => call(CH.recPrepare, input),
    started: (info) => call(CH.recStarted, info),
    data: (chunk) => call(CH.recData, chunk),
    stop: () => call(CH.recStop),
    transcribe: () => call(CH.recTranscribe),
    submit: () => call(CH.recSubmit),
    upload: () => call(CH.recUpload),
    discard: () => call(CH.recDiscard),
    cancel: () => call(CH.recCancel),
    onState: (cb) => subscribe<RecState>(CH.evtRecState, cb),
  },
};

const origin = globalThis.location?.origin ?? '';
if (origin === LOCAL_ORIGIN) {
  contextBridge.exposeInMainWorld('meetledgerDesktop', desktop);
  contextBridge.exposeInMainWorld('meetledgerLocal', local);
} else if (SERVER_ORIGIN && origin === SERVER_ORIGIN) {
  contextBridge.exposeInMainWorld('meetledgerDesktop', desktop);
}
