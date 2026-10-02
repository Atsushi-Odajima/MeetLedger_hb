// Manual (zod-like) validators for everything that crosses the IPC boundary.
// Renderer input is untrusted: the server page could be compromised (XSS) and must not be able to make main
// read arbitrary files, hit arbitrary URLs or exhaust memory. Every parser returns a NEW object with only known keys.

import type { DesktopConfigPublic, LocalSegment, ProcessingMode } from './ipc';

export class ValidationError extends Error {
  readonly code = 'invalid_input';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const fail = (msg: string): never => {
  throw new ValidationError(msg);
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FILE_TOKEN_RE = /^[0-9a-f]{64}$/;
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const LIMITS = {
  /** One-shot saveRecording (web bridge). Long meetings must use the recorder window (streams to disk). */
  saveRecordingBytes: 512 * 1024 * 1024,
  /** Per streamed chunk from the recorder page. */
  chunkBytes: 8 * 1024 * 1024,
  envFloatsPerChunk: 2 * 600,
  segmentCount: 100_000,
  segmentText: 10_000,
  speakerLabel: 100,
  title: 300,
  /** 24h in ms — anything beyond is garbage. */
  maxMs: 24 * 60 * 60 * 1000,
} as const;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!isPlainObject(v)) fail(`${what} must be an object`);
  return v as Record<string, unknown>;
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${what}: unknown field "${k}"`);
}

export function uuid(v: unknown, what = 'id'): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) fail(`${what} must be a UUID`);
  return (v as string).toLowerCase();
}

export function fileToken(v: unknown): string {
  if (typeof v !== 'string' || !FILE_TOKEN_RE.test(v)) fail('fileToken is invalid');
  return v as string;
}

export function modelId(v: unknown): string {
  if (typeof v !== 'string' || !MODEL_ID_RE.test(v)) fail('model id is invalid');
  return v as string;
}

export function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') fail(`${what} must be a boolean`);
  return v as boolean;
}

export function oneOf<T extends string>(v: unknown, values: readonly T[], what: string): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) fail(`${what} must be one of ${values.join('|')}`);
  return v as T;
}

export function intInRange(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(`${what} must be an integer in [${min}, ${max}]`);
  return v as number;
}

export function boundedString(v: unknown, max: number, what: string, opts: { allowEmpty?: boolean } = {}): string {
  if (typeof v !== 'string') fail(`${what} must be a string`);
  const s = (v as string).trim();
  if (!opts.allowEmpty && s.length === 0) fail(`${what} must not be empty`);
  if (s.length > max) fail(`${what} is too long (max ${max})`);
  // control characters other than tab/newline are never legitimate here
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) fail(`${what} contains control characters`);
  return s;
}

/** ArrayBuffer (or a typed-array view, which structured clone may deliver) with a size cap. Returns a copy-free Uint8Array view. */
export function binary(v: unknown, maxBytes: number, what: string): Uint8Array {
  let u8: Uint8Array | null = null;
  if (v instanceof ArrayBuffer) u8 = new Uint8Array(v);
  else if (ArrayBuffer.isView(v)) u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (!u8) fail(`${what} must be an ArrayBuffer`);
  if (u8!.byteLength === 0) fail(`${what} is empty`);
  if (u8!.byteLength > maxBytes) fail(`${what} is too large (max ${maxBytes} bytes)`);
  return u8!;
}

// ---------------------------------------------------------------- operation-specific parsers

export const RECORDING_MIME_TYPES = ['audio/wav', 'audio/webm', 'audio/ogg', 'audio/mp4'] as const;
export type RecordingMime = (typeof RECORDING_MIME_TYPES)[number];

export function parseSaveRecording(v: unknown): { mimeType: RecordingMime; data: Uint8Array } {
  const o = obj(v, 'saveRecording input');
  onlyKeys(o, ['mimeType', 'data'], 'saveRecording');
  // Accept "audio/webm;codecs=opus" style values but store the base type only.
  const rawMime = typeof o.mimeType === 'string' ? o.mimeType.split(';')[0]!.trim().toLowerCase() : o.mimeType;
  return {
    mimeType: oneOf(rawMime, RECORDING_MIME_TYPES, 'mimeType'),
    data: binary(o.data, LIMITS.saveRecordingBytes, 'data'),
  };
}

export interface TranscribeOptions {
  model?: string;
  language?: 'ja' | 'en' | 'auto';
  diarization?: boolean;
}

export function parseTranscribeOptions(v: unknown): TranscribeOptions {
  if (v === undefined || v === null) return {};
  const o = obj(v, 'transcribe options');
  onlyKeys(o, ['model', 'language', 'diarization'], 'transcribe options');
  const out: TranscribeOptions = {};
  if (o.model !== undefined) out.model = modelId(o.model);
  if (o.language !== undefined) out.language = oneOf(o.language, ['ja', 'en', 'auto'] as const, 'language');
  if (o.diarization !== undefined) out.diarization = bool(o.diarization, 'diarization');
  return out;
}

export const CONSENT_STATES_IN = ['notified', 'confirmed'] as const;
export const CONSENT_METHODS = ['in_app', 'verbal', 'calendar_note', 'email', 'chat_message', 'other'] as const;

export function parseConsentInput(v: unknown): { workspaceId: string; meetingId: string; state: (typeof CONSENT_STATES_IN)[number]; method: (typeof CONSENT_METHODS)[number] } {
  const o = obj(v, 'consent input');
  onlyKeys(o, ['workspaceId', 'meetingId', 'state', 'method'], 'consent');
  return {
    workspaceId: uuid(o.workspaceId, 'workspaceId'),
    meetingId: uuid(o.meetingId, 'meetingId'),
    // The desktop only records "notified" / "confirmed". "declined" is recorded in the web app by people who decline.
    state: oneOf(o.state, CONSENT_STATES_IN, 'state'),
    method: oneOf(o.method, CONSENT_METHODS, 'method'),
  };
}

export function parseMeetingRef(v: unknown): { workspaceId: string; meetingId: string } {
  const o = obj(v, 'meeting reference');
  onlyKeys(o, ['workspaceId', 'meetingId'], 'meeting reference');
  return { workspaceId: uuid(o.workspaceId, 'workspaceId'), meetingId: uuid(o.meetingId, 'meetingId') };
}

export function parseOptionalMeetingRef(v: unknown): { workspaceId: string; meetingId: string } | null {
  if (v === undefined || v === null) return null;
  return parseMeetingRef(v);
}

export function parseCreateMeeting(v: unknown): { workspaceId: string; title: string } {
  const o = obj(v, 'create meeting input');
  onlyKeys(o, ['workspaceId', 'title'], 'create meeting');
  return { workspaceId: uuid(o.workspaceId, 'workspaceId'), title: boundedString(o.title, LIMITS.title, 'title') };
}

export function parsePrepareInput(v: unknown): { workspaceId: string; meetingId: string; mode: ProcessingMode; uploadAudio: boolean; systemAudio: boolean } {
  const o = obj(v, 'prepare input');
  onlyKeys(o, ['workspaceId', 'meetingId', 'mode', 'uploadAudio', 'systemAudio'], 'prepare');
  const mode = oneOf(o.mode, ['device', 'server'] as const, 'mode');
  return {
    workspaceId: uuid(o.workspaceId, 'workspaceId'),
    meetingId: uuid(o.meetingId, 'meetingId'),
    mode,
    // In server mode the audio is uploaded by definition.
    uploadAudio: mode === 'server' ? true : bool(o.uploadAudio, 'uploadAudio'),
    systemAudio: bool(o.systemAudio, 'systemAudio'),
  };
}

export function parseRecStarted(v: unknown): { systemAudioActive: boolean; mimeType: string | null } {
  const o = obj(v, 'started input');
  onlyKeys(o, ['systemAudioActive', 'mimeType'], 'started');
  const mimeType = o.mimeType === null || o.mimeType === undefined ? null : boundedString(o.mimeType, 100, 'mimeType');
  return { systemAudioActive: bool(o.systemAudioActive, 'systemAudioActive'), mimeType };
}

/** A streamed chunk: opus/webm bytes (for upload) and/or 16 kHz mono PCM16 + per-100ms [L,R] RMS envelope. */
export function parseRecData(v: unknown): { webm: Uint8Array | null; pcm: Uint8Array | null; env: Float32Array | null } {
  const o = obj(v, 'data chunk');
  onlyKeys(o, ['webm', 'pcm', 'env'], 'data chunk');
  const webm = o.webm === undefined || o.webm === null ? null : binary(o.webm, LIMITS.chunkBytes, 'webm');
  const pcm = o.pcm === undefined || o.pcm === null ? null : binary(o.pcm, LIMITS.chunkBytes, 'pcm');
  if (pcm && pcm.byteLength % 2 !== 0) fail('pcm must be 16-bit samples');
  let env: Float32Array | null = null;
  if (o.env !== undefined && o.env !== null) {
    const b = binary(o.env, LIMITS.envFloatsPerChunk * 4, 'env');
    if (b.byteLength % 8 !== 0) fail('env must contain [L,R] float32 pairs');
    // copy into an aligned buffer (views from structured clone may have odd offsets)
    env = new Float32Array(b.slice().buffer);
    for (const x of env) if (!Number.isFinite(x) || x < 0 || x > 2) fail('env values out of range');
  }
  if (!webm && !pcm && !env) fail('data chunk is empty');
  return { webm, pcm, env };
}

export function sanitizeSegments(v: unknown): LocalSegment[] {
  if (!Array.isArray(v)) fail('segments must be an array');
  const arr = v as unknown[];
  if (arr.length > LIMITS.segmentCount) fail('too many segments');
  return arr.map((s, i) => {
    const o = obj(s, `segments[${i}]`);
    onlyKeys(o, ['startMs', 'endMs', 'text', 'confidence', 'speaker'], `segments[${i}]`);
    const startMs = intInRange(typeof o.startMs === 'number' ? Math.round(o.startMs) : o.startMs, 0, LIMITS.maxMs, `segments[${i}].startMs`);
    const endMs = intInRange(typeof o.endMs === 'number' ? Math.round(o.endMs) : o.endMs, 0, LIMITS.maxMs, `segments[${i}].endMs`);
    if (endMs < startMs) fail(`segments[${i}]: endMs < startMs`);
    const text = boundedString(o.text, LIMITS.segmentText, `segments[${i}].text`, { allowEmpty: true });
    const seg: LocalSegment = { startMs, endMs, text };
    if (o.confidence !== undefined && o.confidence !== null) {
      if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) fail(`segments[${i}].confidence must be within [0,1]`);
      seg.confidence = o.confidence as number;
    }
    if (o.speaker !== undefined && o.speaker !== null) seg.speaker = boundedString(String(o.speaker), LIMITS.speakerLabel, `segments[${i}].speaker`);
    return seg;
  });
}

export function parseConfigPatch(v: unknown, normalizeUrl: (u: string) => string): Partial<DesktopConfigPublic> {
  const o = obj(v, 'config');
  onlyKeys(
    o,
    ['serverUrl', 'processingMode', 'uploadAudioDefault', 'language', 'diarization', 'numThreads', 'model', 'macUseSystemPicker', 'macLegacyLoopback'],
    'config',
  );
  const out: Partial<DesktopConfigPublic> = {};
  if (o.serverUrl !== undefined) out.serverUrl = o.serverUrl === null ? null : normalizeUrl(boundedString(o.serverUrl, 2048, 'serverUrl'));
  if (o.processingMode !== undefined) out.processingMode = oneOf(o.processingMode, ['device', 'server'] as const, 'processingMode');
  if (o.uploadAudioDefault !== undefined) out.uploadAudioDefault = bool(o.uploadAudioDefault, 'uploadAudioDefault');
  if (o.language !== undefined) out.language = oneOf(o.language, ['ja', 'en', 'auto'] as const, 'language');
  if (o.diarization !== undefined) out.diarization = bool(o.diarization, 'diarization');
  if (o.numThreads !== undefined) out.numThreads = intInRange(o.numThreads, 1, 16, 'numThreads');
  if (o.model !== undefined) out.model = o.model === null ? null : modelId(o.model);
  if (o.macUseSystemPicker !== undefined) out.macUseSystemPicker = bool(o.macUseSystemPicker, 'macUseSystemPicker');
  if (o.macLegacyLoopback !== undefined) out.macLegacyLoopback = bool(o.macLegacyLoopback, 'macLegacyLoopback');
  return out;
}
