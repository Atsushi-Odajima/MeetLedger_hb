import { toTsvectorLiteral, type SegmentDto, type SpeakerDto, type TranscriptDto } from '@meetledger/shared';
import type { Deps } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { iso } from '../../lib/http';
import { decideAi, wsSettings } from '../../privacy/policy';
import { normalizeSpeakerLabels } from '../../providers/diarization';
import { alignSegments, qualitySummary, type InSegment } from './normalize';

export type SpeakerSource = 'diarization' | 'channel' | 'import' | 'none';

export interface SpeakerSpec {
  label: string;
  source: SpeakerSource;
  /** Hint for humans (e.g. "あなた（マイク）"). Never auto-assigned to a person. */
  suggestion?: string | null;
  displayName?: string | null;
}

export interface StoredSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  flags: string[];
  speakerLabel: string;
}

export interface PreparedTranscript {
  segments: StoredSegment[];
  speakers: SpeakerSpec[];
}

/**
 * Aligns timestamps, applies inaudible/low-confidence policy and normalizes speaker labels.
 * labelMode 'normalize': provider clusters -> "Speaker 1..N" (first appearance). 'verbatim': keep given labels
 * (transcript imports with "Name: text" prefixes; names come from the user's file, not from voice identification).
 */
export function prepareTranscript(
  raw: InSegment[],
  opts: { durationMs?: number | null; source: SpeakerSource; labelMode?: 'normalize' | 'verbatim'; suggestionFor?: (providerLabel: string | null, normalized: string) => string | null },
): PreparedTranscript {
  const aligned = alignSegments(raw, opts.durationMs);
  let labels: string[];
  if (opts.labelMode === 'verbatim') {
    labels = aligned.map((s) => (s.speaker ?? '').trim().slice(0, 100) || 'Speaker 1');
  } else {
    labels = normalizeSpeakerLabels(aligned).labels;
  }
  const speakers: SpeakerSpec[] = [];
  const seen = new Set<string>();
  aligned.forEach((s, i) => {
    const l = labels[i];
    if (seen.has(l)) return;
    seen.add(l);
    speakers.push({ label: l, source: opts.source, suggestion: opts.suggestionFor?.(s.speaker, l) ?? null });
  });
  return {
    segments: aligned.map((s, i) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text, confidence: s.confidence, flags: s.flags, speakerLabel: labels[i] })),
    speakers,
  };
}

export interface TranscriptWrite extends PreparedTranscript {
  orgId: string;
  meetingId: string;
  provider: string;
  isLocal: boolean;
  language: string | null;
  inputHash: string;
  mediaAssetId?: string | null;
  jobId?: string | null;
  qualityFlags: Record<string, unknown>;
}

/**
 * Idempotent transcript writer: (meeting_id, input_hash, provider) is unique, so re-running a job / re-posting the
 * same import never duplicates the transcript or its segments. A new version becomes current; older ones are kept.
 */
export async function writeTranscriptVersion(db: Db, w: TranscriptWrite): Promise<{ transcriptId: string; version: number; created: boolean }> {
  // Serialize writers per meeting (version numbers, is_current flip).
  await db.query('SELECT id FROM meetings WHERE id = $1 FOR UPDATE', [w.meetingId]);
  const existing = await one<{ id: string; version: number }>(db, 'SELECT id, version FROM transcripts WHERE meeting_id=$1 AND input_hash=$2 AND provider=$3', [
    w.meetingId,
    w.inputHash,
    w.provider,
  ]);
  if (existing) return { transcriptId: existing.id, version: existing.version, created: false };
  const v = await one<{ v: number }>(db, 'SELECT coalesce(max(version), 0) + 1 AS v FROM transcripts WHERE meeting_id=$1', [w.meetingId]);
  await db.query('UPDATE transcripts SET is_current=false WHERE meeting_id=$1 AND is_current', [w.meetingId]);
  const t = await one<{ id: string }>(
    db,
    `INSERT INTO transcripts(org_id, meeting_id, version, provider, is_local, language, input_hash, media_asset_id, job_id, is_current, quality_flags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10) RETURNING id`,
    [w.orgId, w.meetingId, v!.v, w.provider, w.isLocal, w.language, w.inputHash, w.mediaAssetId ?? null, w.jobId ?? null, { ...w.qualityFlags, ...qualitySummary(w.segments), speakerCount: w.speakers.length }],
  );
  const speakerIds = new Map<string, string>();
  for (const s of w.speakers) {
    const r = await one<{ id: string }>(
      db,
      `INSERT INTO meeting_speakers(org_id, meeting_id, label, source, suggestion, display_name) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (meeting_id, label) DO UPDATE
         SET suggestion = coalesce(meeting_speakers.suggestion, EXCLUDED.suggestion),
             display_name = coalesce(meeting_speakers.display_name, EXCLUDED.display_name)
       RETURNING id`,
      [w.orgId, w.meetingId, s.label, s.source, s.suggestion ?? null, s.displayName ?? null],
    );
    speakerIds.set(s.label, r!.id);
  }
  const BATCH = 500;
  for (let i = 0; i < w.segments.length; i += BATCH) {
    const batch = w.segments.slice(i, i + BATCH).map((s, j) => ({
      seq: i + j,
      start_ms: s.startMs,
      end_ms: s.endMs,
      speaker_id: speakerIds.get(s.speakerLabel) ?? null,
      speaker_label: s.speakerLabel,
      text: s.text,
      confidence: s.confidence,
      flags: s.flags,
      tsv: toTsvectorLiteral(s.text),
    }));
    await db.query(
      `INSERT INTO transcript_segments(org_id, transcript_id, meeting_id, seq, start_ms, end_ms, speaker_id, speaker_label, text, confidence, flags, tsv)
       SELECT $1, $2, $3, r.seq, r.start_ms, r.end_ms, r.speaker_id, r.speaker_label, r.text, r.confidence,
              ARRAY(SELECT jsonb_array_elements_text(r.flags)), r.tsv::tsvector
         FROM jsonb_to_recordset($4::jsonb) AS r(seq int, start_ms int, end_ms int, speaker_id uuid, speaker_label text, text text, confidence real, flags jsonb, tsv text)`,
      [w.orgId, t!.id, w.meetingId, JSON.stringify(batch)],
    );
  }
  return { transcriptId: t!.id, version: v!.v, created: true };
}

/**
 * Downstream work after a new transcript: AI extraction (only when decideAi allows it for this meeting) and
 * re-indexing. Meeting goes to needs_review (humans confirm speakers / candidates).
 */
export async function afterTranscriptWritten(deps: Deps, db: Db, meetingId: string, transcriptId: string): Promise<{ aiJobId: string | null; aiReason: string }> {
  const m = await one<any>(db, 'SELECT id, org_id, workspace_id, ai_enabled, transcription_mode, is_confidential FROM meetings WHERE id=$1', [meetingId]);
  if (!m) return { aiJobId: null, aiReason: 'meeting missing' };
  const ws = await one<{ settings: unknown }>(db, 'SELECT settings FROM workspaces WHERE id=$1', [m.workspace_id]);
  const ai = decideAi(m, wsSettings(ws?.settings), deps.config);
  let aiJobId: string | null = null;
  if (ai.allowed) {
    const j = await deps.jobs.enqueue(db, { orgId: m.org_id, type: 'ai.extract', key: `ai:${transcriptId}`, payload: { meetingId, transcriptId } });
    aiJobId = j.id;
  }
  await deps.jobs.enqueue(db, { orgId: m.org_id, type: 'index.meeting', key: `index:${meetingId}:${Date.now()}`, payload: { meetingId } });
  await db.query(`UPDATE meetings SET status = CASE WHEN status = 'archived' THEN status ELSE 'needs_review' END, updated_at = now() WHERE id=$1`, [meetingId]);
  return { aiJobId, aiReason: ai.reason };
}

export function segmentDto(r: any): SegmentDto {
  return {
    id: r.id,
    seq: r.seq,
    startMs: r.start_ms,
    endMs: r.end_ms,
    speakerId: r.speaker_id,
    speakerLabel: r.speaker_label,
    speakerName: r.speaker_name ?? null,
    text: r.text,
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    flags: r.flags ?? [],
    revision: r.revision,
  };
}

export function speakerDto(r: any): SpeakerDto {
  return {
    id: r.id,
    label: r.label,
    personId: r.person_id,
    displayName: r.display_name ?? r.person_name ?? null,
    source: r.source,
    suggestion: r.suggestion ?? null,
  };
}

const SEGMENT_SELECT = `SELECT s.id, s.seq, s.start_ms, s.end_ms, s.speaker_id, s.speaker_label, s.text, s.confidence, s.flags, s.revision,
       coalesce(ms.display_name, p.name) AS speaker_name
  FROM transcript_segments s
  LEFT JOIN meeting_speakers ms ON ms.id = s.speaker_id
  LEFT JOIN people p ON p.id = ms.person_id AND p.deleted_at IS NULL`;

export async function loadSegment(db: Db, segmentId: string) {
  return one<any>(db, `${SEGMENT_SELECT} WHERE s.id = $1`, [segmentId]);
}

/** Current transcript (or a specific version) as TranscriptDto; null when there is none. Caller enforces meeting ACL. */
export async function loadTranscriptDto(db: Db, meetingId: string, version?: number): Promise<TranscriptDto | null> {
  const t = await one<any>(
    db,
    version
      ? 'SELECT * FROM transcripts WHERE meeting_id=$1 AND version=$2'
      : 'SELECT * FROM transcripts WHERE meeting_id=$1 AND is_current ORDER BY version DESC LIMIT 1',
    version ? [meetingId, version] : [meetingId],
  );
  if (!t) return null;
  const segs = await rows(db, `${SEGMENT_SELECT} WHERE s.transcript_id = $1 ORDER BY s.seq`, [t.id]);
  const speakers = await rows(
    db,
    `SELECT ms.*, p.name AS person_name,
            (SELECT min(seq) FROM transcript_segments x WHERE x.transcript_id = $2 AND x.speaker_id = ms.id) AS first_seq
       FROM meeting_speakers ms LEFT JOIN people p ON p.id = ms.person_id AND p.deleted_at IS NULL
      WHERE ms.meeting_id = $1 AND EXISTS (SELECT 1 FROM transcript_segments x WHERE x.transcript_id = $2 AND x.speaker_id = ms.id)
      ORDER BY first_seq`,
    [meetingId, t.id],
  );
  return {
    id: t.id,
    meetingId: t.meeting_id,
    version: t.version,
    provider: t.provider,
    language: t.language,
    isLocal: t.is_local,
    qualityFlags: t.quality_flags ?? {},
    createdAt: iso(t.created_at)!,
    segments: segs.map(segmentDto),
    speakers: speakers.map(speakerDto),
  };
}

export async function listTranscriptVersions(db: Db, meetingId: string) {
  const list = await rows(
    db,
    `SELECT t.id, t.version, t.provider, t.is_local, t.language, t.is_current, t.quality_flags, t.created_at, t.media_asset_id,
            (SELECT count(*) FROM transcript_segments s WHERE s.transcript_id = t.id)::int AS segment_count
       FROM transcripts t WHERE t.meeting_id = $1 ORDER BY t.version DESC`,
    [meetingId],
  );
  return list.map((t) => ({
    id: t.id,
    version: t.version,
    provider: t.provider,
    isLocal: t.is_local,
    language: t.language,
    isCurrent: t.is_current,
    qualityFlags: t.quality_flags ?? {},
    segmentCount: t.segment_count,
    mediaAssetId: t.media_asset_id,
    createdAt: iso(t.created_at),
  }));
}
