import type { AiProviderId, AudioRetention, EmbeddingProviderId, TranscriptionMode, Visibility } from '@meetledger/shared';
import { LOCAL_AI_PROVIDERS } from '@meetledger/shared';
import type { Config } from '../config';

/** Workspace-level privacy & processing settings (stored in workspaces.settings, merged with defaults). */
export interface WorkspaceSettings {
  defaults: {
    visibility: Visibility;
    audioRetention: AudioRetention;
    audioRetentionDays: number | null;
    transcriptionMode: TranscriptionMode;
    aiEnabled: boolean;
  };
  transcription: {
    /** Workspace opt-in for sending audio to the installation's cloud transcription provider. */
    cloudAllowed: boolean;
    language: 'ja' | 'en' | 'auto';
  };
  ai: {
    provider: AiProviderId;
    /** Workspace opt-in for sending transcript excerpts to a cloud LLM / embedding API. */
    cloudAllowed: boolean;
    embeddings: EmbeddingProviderId;
  };
  retention: {
    transcriptDays: number | null;
    aiIndexDays: number | null;
    artifactDays: number | null;
  };
}

/** Local-first defaults: nothing leaves the installation unless an admin opts in. */
export const DEFAULT_WS_SETTINGS: WorkspaceSettings = {
  defaults: { visibility: 'workspace', audioRetention: 'until_processed', audioRetentionDays: null, transcriptionMode: 'local', aiEnabled: true },
  transcription: { cloudAllowed: false, language: 'auto' },
  ai: { provider: 'local-rules', cloudAllowed: false, embeddings: 'local-hash' },
  retention: { transcriptDays: null, aiIndexDays: null, artifactDays: null },
};

export function wsSettings(raw: unknown): WorkspaceSettings {
  const r = (raw ?? {}) as Partial<WorkspaceSettings>;
  return {
    defaults: { ...DEFAULT_WS_SETTINGS.defaults, ...(r.defaults ?? {}) },
    transcription: { ...DEFAULT_WS_SETTINGS.transcription, ...(r.transcription ?? {}) },
    ai: { ...DEFAULT_WS_SETTINGS.ai, ...(r.ai ?? {}) },
    retention: { ...DEFAULT_WS_SETTINGS.retention, ...(r.retention ?? {}) },
  };
}

export interface PolicyDecision {
  allowed: boolean;
  provider: string;
  isLocal: boolean;
  reason: string;
}

export interface MeetingPolicyInput {
  ai_enabled: boolean;
  transcription_mode: TranscriptionMode | string;
  is_confidential: boolean;
}

export function decideTranscription(m: MeetingPolicyInput, s: WorkspaceSettings, cfg: Config): PolicyDecision {
  if (m.transcription_mode === 'none') return { allowed: false, provider: 'none', isLocal: true, reason: 'このMeetingは文字起こしOFF（手動メモのみ）です' };
  if (m.transcription_mode === 'local') return { allowed: true, provider: 'local-sherpa', isLocal: true, reason: 'Local transcription（音声は外部へ送信されません）' };
  if (m.is_confidential) return { allowed: false, provider: 'none', isLocal: true, reason: 'Confidential Meetingはクラウド文字起こしできません' };
  if (!s.transcription.cloudAllowed) return { allowed: false, provider: 'none', isLocal: true, reason: 'Workspace設定でクラウド文字起こしが許可されていません' };
  if (cfg.CLOUD_TRANSCRIPTION_PROVIDER === 'none') return { allowed: false, provider: 'none', isLocal: true, reason: 'クラウド文字起こしProviderが設定されていません' };
  return { allowed: true, provider: cfg.CLOUD_TRANSCRIPTION_PROVIDER, isLocal: false, reason: `Cloud transcription (${cfg.CLOUD_TRANSCRIPTION_PROVIDER}) へ音声を送信します` };
}

function aiProviderFor(s: WorkspaceSettings, cfg: Config): { provider: AiProviderId; isLocal: boolean; note?: string } {
  const wanted = s.ai.provider;
  if (LOCAL_AI_PROVIDERS.includes(wanted)) return { provider: wanted, isLocal: true };
  if (!s.ai.cloudAllowed) return { provider: 'local-rules', isLocal: true, note: 'クラウドAIが許可されていないためLocal rulesを使用' };
  if (cfg.AI_PROVIDER !== wanted) return { provider: 'local-rules', isLocal: true, note: `${wanted} はこのインストールで有効化されていません` };
  return { provider: wanted, isLocal: false };
}

/** AI (summary / extraction / ask) for a single meeting. AI OFF meetings are never processed by any AI provider. */
export function decideAi(m: MeetingPolicyInput, s: WorkspaceSettings, cfg: Config): PolicyDecision {
  if (!m.ai_enabled) return { allowed: false, provider: 'none', isLocal: true, reason: 'このMeetingはAI OFFです（AI処理・AI検索の対象外）' };
  const p = aiProviderFor(s, cfg);
  if (!p.isLocal && m.is_confidential) return { allowed: true, provider: 'local-rules', isLocal: true, reason: 'Confidential MeetingのためLocal rulesを使用' };
  return { allowed: true, provider: p.provider, isLocal: p.isLocal, reason: p.note ?? (p.isLocal ? 'Local AI（外部送信なし）' : `Cloud AI (${p.provider}) へ抜粋を送信します`) };
}

/** Workspace-level AI (cross-meeting ask). Retrieval separately restricts context to ai_enabled meetings. */
export function decideWorkspaceAi(s: WorkspaceSettings, cfg: Config): PolicyDecision {
  const p = aiProviderFor(s, cfg);
  return { allowed: true, provider: p.provider, isLocal: p.isLocal, reason: p.note ?? (p.isLocal ? 'Local AI（外部送信なし）' : `Cloud AI (${p.provider})`) };
}

export function decideEmbedding(s: WorkspaceSettings): PolicyDecision {
  const id = s.ai.embeddings;
  if (id === 'openai' && !s.ai.cloudAllowed) return { allowed: true, provider: 'local-hash', isLocal: true, reason: 'クラウド不可のためlocal-hash embedding' };
  return { allowed: true, provider: id, isLocal: id !== 'openai', reason: id === 'openai' ? 'Cloud embedding (OpenAI)' : 'Local embedding' };
}
