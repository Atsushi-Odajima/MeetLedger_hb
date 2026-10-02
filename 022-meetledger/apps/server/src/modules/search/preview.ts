// GET /api/w/:ws/ai/privacy-preview[?meetingId] — what WOULD be sent where (provider, local vs cloud, host, fields,
// character counts). Never returns content. Counts are computed only over meetings the caller can see.
import type { Config } from '../../config';
import type { WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { loadMeeting, meetingVisibleSql } from '../../rbac/access';
import { decideAi, decideTranscription, decideWorkspaceAi, wsSettings, type PolicyDecision } from '../../privacy/policy';
import { embeddingDecision, embeddingProviderFor, meetingEmbeddingDecision } from './embed';
import { WINDOW_CHARS, WINDOW_MS } from './indexer';

export function providerHost(provider: string, cfg: Config): string | null {
  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return null;
    }
  };
  switch (provider) {
    case 'openai':
      return host(cfg.OPENAI_BASE_URL);
    case 'anthropic':
      return 'api.anthropic.com';
    case 'deepgram':
      return 'api.deepgram.com';
    case 'ollama':
      return host(cfg.OLLAMA_URL);
    default:
      return null;
  }
}

function destination(d: PolicyDecision): 'none' | 'local' | 'self_hosted' | 'cloud' {
  if (!d.allowed || d.provider === 'none') return 'none';
  if (d.provider === 'ollama') return 'self_hosted';
  return d.isLocal ? 'local' : 'cloud';
}

function describe(d: PolicyDecision, cfg: Config) {
  const dest = destination(d);
  return {
    allowed: d.allowed,
    provider: d.provider,
    isLocal: d.isLocal,
    reason: d.reason,
    destination: dest,
    host: dest === 'cloud' || dest === 'self_hosted' ? providerHost(d.provider, cfg) : null,
  };
}

/** Estimated number of AI chunks for a transcript, using only lengths and timestamps (no content). */
function estimateWindows(segs: { start_ms: number; end_ms: number; len: number }[]): number {
  let n = 0;
  let start = -1;
  let chars = 0;
  for (const s of segs) {
    const len = s.len + 12;
    if (len > WINDOW_CHARS) {
      if (start >= 0) n++;
      n += Math.ceil(len / WINDOW_CHARS);
      start = -1;
      chars = 0;
      continue;
    }
    if (start >= 0 && (s.end_ms - start > WINDOW_MS || chars + len + 1 > WINDOW_CHARS)) {
      n++;
      start = -1;
      chars = 0;
    }
    if (start < 0) start = s.start_ms;
    chars += len + 1;
  }
  return start >= 0 ? n + 1 : n;
}

const ASK_FIELDS = ['質問文', '検索で選ばれた最大8〜12件の抜粋（各≤800文字: 文字起こし窓・AI要約・確定済みの決定/約束/質問/アクション）', '抜粋元Meetingのタイトルと日付'];
const NEVER_SENT = ['音声ファイル（クラウド文字起こしを除く）', '手動メモ・人物メモ', 'AI OFF / Confidential Meetingの内容', '閲覧権限のないMeeting', 'APIキー・認証情報'];

export async function meetingPreview(db: Db, ctx: WsCtx, meetingId: string) {
  const cfg = ctx.deps.config;
  const m = await loadMeeting(db, ctx, meetingId);
  const s = wsSettings((await one<any>(db, 'SELECT settings FROM workspaces WHERE id=$1', [ctx.workspaceId]))?.settings);
  const t = decideTranscription(m as any, s, cfg);
  const a = decideAi(m as any, s, cfg);
  const e = meetingEmbeddingDecision(m as any, s, cfg);
  const askD = decideWorkspaceAi(s, cfg);
  const segs = await rows<{ start_ms: number; end_ms: number; len: number }>(
    db,
    `SELECT s.start_ms, s.end_ms, char_length(s.text) AS len FROM transcript_segments s JOIN transcripts tr ON tr.id = s.transcript_id AND tr.is_current
      WHERE s.meeting_id = $1 ORDER BY s.seq`,
    [meetingId],
  );
  const transcriptChars = segs.reduce((x, r) => x + Number(r.len), 0);
  const counts = await one<any>(
    db,
    `SELECT (SELECT count(*) FROM participants WHERE meeting_id = $1)::int AS participants,
            (SELECT coalesce(sum(char_length(body)), 0) FROM meeting_notes WHERE meeting_id = $1)::int AS notes_chars,
            (SELECT count(*) FROM decisions d WHERE d.workspace_id = $2 AND d.review_state = 'confirmed' AND d.status = 'active' AND d.meeting_id IS DISTINCT FROM $1
               AND ((d.project_id IS NOT NULL AND d.project_id = $3) OR (d.series_id IS NOT NULL AND d.series_id = $4)))::int AS related_decisions,
            (SELECT coalesce(sum(char_length(x)), 0) FROM summaries su, LATERAL (SELECT su.sections::text AS x) z WHERE su.meeting_id = $1 AND su.is_current)::int AS summary_chars,
            (SELECT count(*) FROM decisions WHERE meeting_id = $1 AND review_state = 'confirmed')::int AS confirmed_decisions,
            (SELECT count(*) FROM ai_chunks WHERE meeting_id = $1)::int AS ai_chunks,
            (SELECT count(*) FROM search_docs WHERE meeting_id = $1)::int AS search_docs`,
    [meetingId, ctx.workspaceId, m.project_id ?? null, m.series_id ?? null],
  );
  const models = await rows<{ embedding_model: string; n: number }>(db, 'SELECT embedding_model, count(*)::int AS n FROM ai_chunks WHERE meeting_id=$1 GROUP BY 1', [meetingId]);
  const embProv = e.allowed ? embeddingProviderFor(ctx.deps, e) : null;
  const eligible = !!m.ai_enabled && !m.is_confidential;
  return {
    scope: 'meeting' as const,
    meeting: {
      id: m.id,
      title: m.title,
      aiEnabled: m.ai_enabled,
      isConfidential: m.is_confidential,
      transcriptionMode: m.transcription_mode,
      visibility: m.visibility,
    },
    transcription: {
      ...describe(t, cfg),
      fields: t.allowed && !t.isLocal ? ['音声（録音ファイル）'] : [],
      note: t.isLocal ? '音声はこのサーバー（またはデスクトップ）内で処理されます' : undefined,
    },
    ai: {
      ...describe(a, cfg),
      fields: a.allowed
        ? ['Meetingタイトル・種別・日付・言語', 'テンプレート定義', '参加者の表示名', '文字起こし（話者ラベル/名前・タイムスタンプ・本文）', '同じProject/Seriesの確定済み決定事項（矛盾検出用）']
        : [],
      sizes: { transcriptChars, segmentCount: segs.length, participantCount: counts.participants, relatedDecisionCount: counts.related_decisions },
    },
    embedding: {
      ...describe(e, cfg),
      model: embProv?.model ?? null,
      description: embProv?.description ?? null,
      fields: e.allowed ? ['文字起こしの約45秒/最大800文字の窓（話者名付き）', 'AI要約', '確定済みの決定事項'] : [],
      sizes: {
        estimatedChunks: e.allowed ? estimateWindows(segs) + (counts.summary_chars > 0 ? 1 : 0) + counts.confirmed_decisions : 0,
        transcriptChars: e.allowed ? transcriptChars : 0,
      },
      metadataStored: ['org_id', 'workspace_id', 'meeting_id', 'entity_type/entity_id', '開始/終了ms', 'person_ids'],
    },
    ask: {
      eligible,
      eligibilityReason: eligible ? 'Workspace横断の質問でこのMeetingの抜粋が使われる場合があります（閲覧権限がある利用者のみ）' : 'AI OFF / Confidential のため横断質問の根拠には使われません',
      ...describe(eligible ? askD : { allowed: false, provider: 'none', isLocal: true, reason: 'AI対象外' }, cfg),
      fields: eligible ? ASK_FIELDS : [],
      maxContextChars: 800,
    },
    index: { searchDocs: counts.search_docs, aiChunks: counts.ai_chunks, aiChunkModels: models.map((x) => ({ model: x.embedding_model, count: x.n })) },
    notSent: { notesChars: counts.notes_chars, items: NEVER_SENT },
  };
}

export async function workspacePreview(db: Db, ctx: WsCtx) {
  const cfg = ctx.deps.config;
  const s = wsSettings((await one<any>(db, 'SELECT settings FROM workspaces WHERE id=$1', [ctx.workspaceId]))?.settings);
  const askD = decideWorkspaceAi(s, cfg);
  const e = embeddingDecision(s, cfg);
  const embProv = embeddingProviderFor(ctx.deps, e);
  const sample = { ai_enabled: s.defaults.aiEnabled, transcription_mode: s.defaults.transcriptionMode, is_confidential: false };
  const t = decideTranscription(sample, s, cfg);
  const c = await one<any>(
    db,
    `SELECT count(*)::int AS visible,
            count(*) FILTER (WHERE m.ai_enabled AND NOT m.is_confidential)::int AS ai_eligible,
            count(*) FILTER (WHERE NOT m.ai_enabled)::int AS ai_off,
            count(*) FILTER (WHERE m.is_confidential)::int AS confidential,
            count(*) FILTER (WHERE m.transcription_mode = 'cloud')::int AS cloud_transcription
       FROM meetings m WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')}`,
    [ctx.workspaceId, ctx.userId],
  );
  const chunks = await one<any>(
    db,
    `SELECT count(*)::int AS n, coalesce(sum(char_length(c.text)), 0)::bigint AS chars
       FROM ai_chunks c JOIN meetings m ON m.id = c.meeting_id
      WHERE c.workspace_id = $1 AND m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')}`,
    [ctx.workspaceId, ctx.userId],
  );
  return {
    scope: 'workspace' as const,
    settings: { aiProvider: s.ai.provider, cloudAllowed: s.ai.cloudAllowed, embeddings: s.ai.embeddings, transcriptionCloudAllowed: s.transcription.cloudAllowed },
    installation: { aiProvider: cfg.AI_PROVIDER, embeddingProvider: cfg.EMBEDDING_PROVIDER, cloudTranscriptionProvider: cfg.CLOUD_TRANSCRIPTION_PROVIDER },
    transcriptionDefault: { ...describe(t, cfg), fields: t.allowed && !t.isLocal ? ['音声（録音ファイル）'] : [] },
    ask: { ...describe(askD, cfg), fields: ASK_FIELDS, maxContexts: 12, maxContextChars: 800, eligibleMeetings: c.ai_eligible },
    embedding: {
      ...describe(e, cfg),
      model: embProv.model,
      description: embProv.description ?? null,
      queryEmbedding: e.isLocal ? 'ローカルで計算（外部送信なし）' : '質問文のみをクラウドembedding APIへ送信（Meeting本文は含まない）',
    },
    meetings: { visible: c.visible, aiEligible: c.ai_eligible, aiOff: c.ai_off, confidential: c.confidential, cloudTranscription: c.cloud_transcription },
    index: { aiChunks: chunks.n, aiChunkChars: Number(chunks.chars) },
    notSent: NEVER_SENT,
  };
}
