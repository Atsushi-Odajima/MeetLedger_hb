// Public shape of the bridges exposed by the preload (contextBridge). The web app (apps/web) can feature-detect
// `window.meetledgerDesktop` and use these types; see docs/DESKTOP_COMPANION.md "Web 連携".

import type { Capabilities, DesktopConfigPublic, LocalTranscriptResult, ModelInfo, ModelProgress, RecState } from './ipc';
import type { MeetingSummaryDto, MeSummaryDto } from './dto';

export interface MeetLedgerDesktopBridge {
  readonly bridgeVersion: 1;
  /** Desktop app version (e.g. "1.0.0"). */
  readonly version: string;
  readonly platform: 'win32' | 'darwin' | 'linux' | string;
  capabilities(): Promise<Capabilities>;
  listModels(): Promise<ModelInfo[]>;
  /** Shows a native confirmation dialog with size / license / source; downloads only after the user accepts. */
  downloadModel(id: string): Promise<{ ok: boolean; cancelled?: boolean; alreadyInstalled?: boolean }>;
  onModelDownloadProgress(cb: (p: ModelProgress) => void): () => void;
  /** Stores audio bytes on this device (max 512 MB) and returns an opaque token bound to this page. */
  saveRecording(input: { mimeType: string; data: ArrayBuffer }): Promise<{ fileToken: string; bytes: number }>;
  discardRecording(fileToken: string): Promise<void>;
  /** On-device transcription of a saved 16 kHz mono PCM16 WAV. Audio never leaves the device. */
  transcribeLocal(fileToken: string, opts?: { model?: string; language?: 'ja' | 'en' | 'auto'; diarization?: boolean }): Promise<LocalTranscriptResult>;
  /** Opens the desktop recorder window (system audio + consent step + persistent indicator), optionally for a meeting. */
  openRecorder(target?: { workspaceId: string; meetingId: string }): Promise<void>;
  openSettings(): Promise<void>;
}

export interface MeetLedgerLocalBridge {
  config: {
    get(): Promise<{ config: DesktopConfigPublic; recordings: { files: number; bytes: number }; osVersion: string }>;
    set(patch: Partial<DesktopConfigPublic>): Promise<DesktopConfigPublic>;
    testServer(url: string): Promise<{ ok: boolean; origin: string; detail: string }>;
    clearRecordings(): Promise<{ removed: number }>;
  };
  api: {
    me(): Promise<MeSummaryDto>;
    meetings(workspaceId: string): Promise<MeetingSummaryDto[]>;
    meeting(workspaceId: string, meetingId: string): Promise<MeetingSummaryDto>;
    createMeeting(workspaceId: string, title: string): Promise<MeetingSummaryDto>;
    recordConsent(input: { workspaceId: string; meetingId: string; state: 'notified' | 'confirmed'; method: string }): Promise<MeetingSummaryDto>;
  };
  recorder: {
    prepare(input: { workspaceId: string; meetingId: string; mode: 'device' | 'server'; uploadAudio: boolean; systemAudio: boolean }): Promise<RecState>;
    started(info: { systemAudioActive: boolean; mimeType: string | null }): Promise<RecState>;
    data(chunk: { webm?: ArrayBuffer; pcm?: ArrayBuffer; env?: ArrayBuffer }): Promise<void>;
    stop(): Promise<RecState>;
    transcribe(): Promise<LocalTranscriptResult>;
    submit(): Promise<{ segments: number }>;
    upload(): Promise<{ assetId?: string }>;
    discard(): Promise<RecState>;
    cancel(): Promise<void>;
    onState(cb: (s: RecState) => void): () => void;
  };
}

declare global {
  interface Window {
    meetledgerDesktop?: MeetLedgerDesktopBridge;
    meetledgerLocal?: MeetLedgerLocalBridge;
  }
}
