// IPC contract between main, preloads and local pages.
// There is deliberately NO generic passthrough: every channel is a named operation with validated input,
// and main checks which window/page is allowed to call it (see main/ipc.ts → senderKind).

export const CH = {
  // ---- window.meetledgerDesktop (server-origin main window AND local pages)
  capabilities: 'desk:capabilities',
  modelsList: 'desk:models:list',
  modelsDownload: 'desk:models:download',
  recordingSave: 'desk:recording:save',
  recordingDiscard: 'desk:recording:discard',
  transcribeLocal: 'desk:transcribe',
  openRecorder: 'desk:open:recorder',
  openSettings: 'desk:open:settings',
  // ---- window.meetledgerLocal (app://desktop/settings/*)
  configGet: 'local:config:get',
  configSet: 'local:config:set',
  serverTest: 'local:server:test',
  recordingsClear: 'local:recordings:clear',
  // ---- window.meetledgerLocal (app://desktop/recorder/*)
  apiMe: 'local:api:me',
  apiMeetings: 'local:api:meetings',
  apiMeeting: 'local:api:meeting',
  apiCreateMeeting: 'local:api:create-meeting',
  apiConsent: 'local:api:consent',
  recPrepare: 'local:rec:prepare',
  recStarted: 'local:rec:started',
  recData: 'local:rec:data',
  recStop: 'local:rec:stop',
  recTranscribe: 'local:rec:transcribe',
  recSubmit: 'local:rec:submit',
  recUpload: 'local:rec:upload',
  recDiscard: 'local:rec:discard',
  recCancel: 'local:rec:cancel',
  // ---- events main → renderer
  evtModelProgress: 'evt:model:progress',
  evtRecState: 'evt:rec:state',
} as const;

export type Channel = (typeof CH)[keyof typeof CH];

/** Which caller may use which channel. 'web' = configured server origin in the main window. */
export type SenderKind = 'web' | 'settings' | 'recorder';

export const CHANNEL_ACL: Record<string, readonly SenderKind[]> = {
  [CH.capabilities]: ['web', 'settings', 'recorder'],
  [CH.modelsList]: ['web', 'settings', 'recorder'],
  [CH.modelsDownload]: ['web', 'settings'],
  [CH.recordingSave]: ['web'],
  [CH.recordingDiscard]: ['web'],
  [CH.transcribeLocal]: ['web'],
  [CH.openRecorder]: ['web', 'settings'],
  [CH.openSettings]: ['web', 'recorder'],
  [CH.configGet]: ['settings', 'recorder'],
  [CH.configSet]: ['settings'],
  [CH.serverTest]: ['settings'],
  [CH.recordingsClear]: ['settings'],
  [CH.apiMe]: ['recorder'],
  [CH.apiMeetings]: ['recorder'],
  [CH.apiMeeting]: ['recorder'],
  [CH.apiCreateMeeting]: ['recorder'],
  [CH.apiConsent]: ['recorder'],
  [CH.recPrepare]: ['recorder'],
  [CH.recStarted]: ['recorder'],
  [CH.recData]: ['recorder'],
  [CH.recStop]: ['recorder'],
  [CH.recTranscribe]: ['recorder'],
  [CH.recSubmit]: ['recorder'],
  [CH.recUpload]: ['recorder'],
  [CH.recDiscard]: ['recorder'],
  [CH.recCancel]: ['recorder'],
};

/** Every IPC reply is wrapped so errors arrive with a stable code (preload unwraps and throws). */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface Capabilities {
  /** true = supported & expected to work; 'unknown' = may work but unverified on this OS (see reason); false = not possible. */
  systemAudio: boolean | 'unknown';
  reason: string;
  localTranscription: { available: boolean; reason: string };
  platform: string;
  arch: string;
  osVersion: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  languages: string[];
  sizeBytes: number | null;
  license: string;
  attribution: string | null;
  sourceUrl: string | null;
  diarization: boolean;
  installed: boolean;
}

export interface ModelProgress {
  id: string;
  receivedBytes: number | null;
  totalBytes: number | null;
  fraction: number | null;
  /** local-asr phases: download | verify | extract | skip | done */
  phase?: string;
  done?: boolean;
  error?: string;
}

export interface LocalSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
  speaker?: string;
}

export interface LocalTranscriptResult {
  provider: 'local-sherpa';
  model: string;
  language: string;
  diarization: boolean;
  segments: LocalSegment[];
}

export type ProcessingMode = 'device' | 'server';

export interface DesktopConfigPublic {
  serverUrl: string | null;
  processingMode: ProcessingMode;
  uploadAudioDefault: boolean;
  language: 'ja' | 'en' | 'auto';
  diarization: boolean;
  numThreads: number;
  model: string | null;
  macUseSystemPicker: boolean;
  macLegacyLoopback: boolean;
}

export type RecPhase = 'idle' | 'ready' | 'recording' | 'stopped' | 'busy';

export interface RecState {
  phase: RecPhase;
  workspaceId: string | null;
  meetingId: string | null;
  meetingTitle: string | null;
  mode: ProcessingMode | null;
  uploadAudio: boolean;
  systemAudioRequested: boolean;
  systemAudioActive: boolean;
  startedAt: number | null;
  wavBytes: number;
  webmBytes: number;
  message: string | null;
}
