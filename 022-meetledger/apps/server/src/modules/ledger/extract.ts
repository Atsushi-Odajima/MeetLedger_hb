// Job `ai.extract` {meetingId, transcriptId?}: builds the extraction input from the current transcript (or the meeting
// notes), applies the AI privacy policy, calls the provider OUTSIDE any DB transaction, validates the output server-side
// and stores candidates idempotently. Never confirms anything.
import { dateInTz, defaultTemplateFor, findBuiltinTemplate, MAX_INAUDIBLE_CONFIDENCE, type MeetingTemplate } from '@meetledger/shared';
import type { Deps } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { AppError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { permanentError, type Worker } from '../../jobs/queue';
import { isUuid, tenantTx } from '../../rbac/access';
import { decideAi, wsSettings, type PolicyDecision } from '../../privacy/policy';
import type { AiProvider, ExtractionInput, ExtractionSegment } from '../../providers/ai/types';
import { norm } from '../../providers/ai/text';
import { LEDGER_TYPES, TABLE, TEXT_COL, ledgerEvent, topicKeyOf, type LedgerType } from './common';
import { contradictionReason } from './contradictions';
import { validateExtraction, type VParty, type VSource, type ValidatedExtraction } from './validate';

interface SpeakerInfo {
  id: string;
  label: string;
  personId: string | null;
  personName: string | null;
  personUserId: string | null;
  displayName: string | null;
}
interface ParticipantInfo {
  personId: string | null;
  userId: string | null;
  displayName: string;
  personName: string | null;
}

export interface PreparedExtraction {
  meeting: any;
  decision: PolicyDecision;
  input: ExtractionInput;
  transcriptId: string | null;
  segRevisions: Map<string, number>;
  speakers: Map<string, SpeakerInfo>;
  participants: ParticipantInfo[];
}

export interface ExtractResult {
  skipped?: string;
  provider?: string;
  isLocal?: boolean;
  fallback?: string | null;
  counts?: Record<string, number>;
  dropped?: Record<string, number>;
  replaced?: number;
  contradictions?: number;
}

const MAX_INPUT_CHARS: Record<string, number> = { openai: 800_000, anthropic: 800_000, ollama: 100_000 };

function meetingTimezone(m: any): string {
  const tz = m.creator_timezone || 'Asia/Tokyo';
  try {
    dateInTz(new Date(0), tz);
    return tz;
  } catch {
    return 'Asia/Tokyo';
  }
}

async function templateFor(db: Db, m: any): Promise<MeetingTemplate> {
  const builtin = findBuiltinTemplate(m.template_key) ?? defaultTemplateFor(m.meeting_type);
  if (!m.template_key || findBuiltinTemplate(m.template_key)) return builtin;
  const custom = await one<{ definition: any }>(db, 'SELECT definition FROM templates WHERE workspace_id=$1 AND key=$2', [m.workspace_id, m.template_key]);
  const r = custom?.definition?.extractionRules;
  if (!r || typeof r !== 'object') return builtin;
  const flag = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    ...builtin,
    extractionRules: {
      decisions: flag(r.decisions, true),
      actions: flag(r.actions, true),
      commitments: flag(r.commitments, true),
      questions: flag(r.questions, true),
      risks: flag(r.risks, true),
      hints: Array.isArray(r.hints) ? r.hints.filter((h: unknown) => typeof h === 'string').slice(0, 10).map((h: string) => h.slice(0, 200)) : [],
    },
  };
}

/** Marks a meeting whose AI processing is off: needs_review only when candidates are pending, otherwise ready. */
async function markWithoutAi(db: Db, meetingId: string) {
  await db.query(
    `UPDATE meetings SET status = CASE WHEN
        EXISTS (SELECT 1 FROM decisions WHERE meeting_id=$1 AND review_state='candidate')
        OR EXISTS (SELECT 1 FROM actions WHERE meeting_id=$1 AND status='candidate')
        OR EXISTS (SELECT 1 FROM commitments WHERE meeting_id=$1 AND status='candidate')
        OR EXISTS (SELECT 1 FROM open_questions WHERE meeting_id=$1 AND status='candidate')
      THEN 'needs_review' ELSE 'ready' END, updated_at=now()
      WHERE id=$1 AND status IN ('processing','needs_review','ready')`,
    [meetingId],
  );
}

export async function prepareExtraction(db: Db, deps: Deps, meetingId: string): Promise<PreparedExtraction | { skipped: string }> {
  const m = await one<any>(
    db,
    'SELECT m.*, u.timezone AS creator_timezone FROM meetings m JOIN users u ON u.id = m.created_by WHERE m.id=$1 AND m.deleted_at IS NULL',
    [meetingId],
  );
  if (!m) return { skipped: 'meeting_not_found' };
  const w = await one<{ settings: unknown }>(db, 'SELECT settings FROM workspaces WHERE id=$1', [m.workspace_id]);
  const decision = decideAi(m, wsSettings(w?.settings), deps.config);
  if (!decision.allowed) {
    // AI OFF: no provider (local or cloud) is ever called.
    await markWithoutAi(db, meetingId);
    return { skipped: 'ai_off' };
  }
  const tz = meetingTimezone(m);
  const when = m.scheduled_start ?? m.started_at ?? m.created_at;
  const date = when ? dateInTz(new Date(when), tz) : null;
  const template = await templateFor(db, m);

  const speakersRows = await rows<any>(
    db,
    `SELECT sp.id, sp.label, sp.person_id, sp.display_name, p.name AS person_name, p.user_id AS person_user_id
       FROM meeting_speakers sp LEFT JOIN people p ON p.id = sp.person_id AND p.deleted_at IS NULL WHERE sp.meeting_id=$1`,
    [meetingId],
  );
  const speakers = new Map<string, SpeakerInfo>(
    speakersRows.map((s) => [s.label, { id: s.id, label: s.label, personId: s.person_id, personName: s.person_name, personUserId: s.person_user_id, displayName: s.display_name }]),
  );
  const participantRows = await rows<any>(
    db,
    `SELECT pa.person_id, coalesce(pa.user_id, p.user_id) AS user_id, pa.display_name, p.name AS person_name
       FROM participants pa LEFT JOIN people p ON p.id = pa.person_id AND p.deleted_at IS NULL WHERE pa.meeting_id=$1`,
    [meetingId],
  );
  const participants: ParticipantInfo[] = participantRows.map((p) => ({ personId: p.person_id, userId: p.user_id, displayName: p.display_name, personName: p.person_name }));

  const transcript = await one<{ id: string; language: string | null }>(
    db,
    'SELECT id, language FROM transcripts WHERE meeting_id=$1 AND is_current ORDER BY version DESC LIMIT 1',
    [meetingId],
  );
  const segRevisions = new Map<string, number>();
  let segments: ExtractionSegment[] = [];
  if (transcript) {
    const segs = await rows<any>(
      db,
      'SELECT id, seq, start_ms, end_ms, speaker_label, text, flags, revision, confidence FROM transcript_segments WHERE transcript_id=$1 ORDER BY seq',
      [transcript.id],
    );
    segments = segs.map((s) => {
      segRevisions.set(s.id, s.revision);
      const sp = speakers.get(s.speaker_label);
      const flags: string[] = [...(s.flags ?? [])];
      if (s.confidence != null && s.confidence < MAX_INAUDIBLE_CONFIDENCE && !flags.includes('inaudible')) flags.push('inaudible');
      return {
        id: s.id,
        speakerLabel: s.speaker_label,
        speakerName: sp?.displayName ?? sp?.personName ?? null,
        startMs: s.start_ms,
        endMs: s.end_ms,
        text: s.text,
        flags,
      };
    });
  }
  let usedTranscript: string | null = segments.length ? transcript!.id : null;
  if (!segments.length) {
    // No transcript: meeting notes lines become pseudo-segments (evidence = quote only, no timestamps).
    const notes = await rows<any>(
      db,
      `SELECT n.id, n.body, u.name AS author FROM meeting_notes n JOIN users u ON u.id = n.author_user_id WHERE n.meeting_id=$1 ORDER BY n.created_at`,
      [meetingId],
    );
    for (const n of notes) {
      const lines = String(n.body ?? '').split(/\r?\n/);
      lines.forEach((line, i) => {
        const t = line.replace(/^\s*(?:[-*・●○■□▶>]|\d+[.)．])\s*/u, '').trim();
        if (!t) return;
        segments.push({ id: `note:${n.id}:${i}`, speakerLabel: `notes:${n.author}`, speakerName: n.author, startMs: 0, endMs: 0, text: t.slice(0, 2000), flags: [] });
      });
    }
    usedTranscript = null;
  }
  const input: ExtractionInput = {
    meeting: { id: m.id, title: m.title, meetingType: m.meeting_type, date, timezone: tz, language: m.language ?? transcript?.language ?? null },
    template,
    participants: participants.map((p) => ({ name: p.displayName, personId: p.personId, isSelf: !!p.userId && p.userId === m.created_by })),
    segments,
    // Other meetings' decisions are never sent to an AI provider; contradictions are computed server-side.
    existingDecisions: [],
  };
  return { meeting: m, decision, input, transcriptId: usedTranscript, segRevisions, speakers, participants };
}

/** Picks the provider allowed by the policy; falls back to 'local-rules' (never to another cloud) when unavailable. */
async function chooseProvider(deps: Deps, decision: PolicyDecision, input: ExtractionInput): Promise<{ provider: AiProvider; decision: PolicyDecision; fallback: string | null }> {
  const local = (why: string) => ({
    provider: deps.providers.ai('local-rules'),
    decision: { allowed: true, provider: 'local-rules', isLocal: true, reason: `Local rules（${why}）` },
    fallback: why,
  });
  if (decision.provider === 'local-rules') return { provider: deps.providers.ai('local-rules'), decision, fallback: null };
  let p: AiProvider;
  try {
    p = deps.providers.ai(decision.provider);
  } catch {
    return local('provider_not_configured');
  }
  if (!(await p.available()).ok) return local('provider_unavailable');
  const size = input.segments.reduce((n, s) => n + s.text.length, 0);
  if (size > (MAX_INPUT_CHARS[p.id] ?? 800_000)) return local('input_too_large');
  return { provider: p, decision, fallback: null };
}

export async function runExtraction(deps: Deps, orgId: string, meetingId: string): Promise<ExtractResult> {
  const prep = await tenantTx(deps, orgId, (db) => prepareExtraction(db, deps, meetingId));
  if ('skipped' in prep) return { skipped: prep.skipped };
  if (!prep.input.segments.length) {
    await tenantTx(deps, orgId, (db) => markWithoutAi(db, meetingId));
    return { skipped: 'no_content' };
  }
  const chosen = await chooseProvider(deps, prep.decision, prep.input);
  let raw: unknown;
  try {
    raw = await chosen.provider.extract(prep.input, { http: deps.http, orgId, meetingIds: [meetingId], decision: chosen.decision, purpose: 'ai.extract' });
  } catch (e) {
    if (e instanceof AppError && e.code === 'policy_denied') throw permanentError(e.message);
    throw e;
  }
  const validated = validateExtraction(prep.input, raw, { trustedSummary: chosen.provider.id === 'local-rules' });
  return tenantTx(deps, orgId, (db) => persistExtraction(db, deps, prep, validated, chosen.provider, chosen.fallback));
}

// ---------------------------------------------------------------- persistence
function sourceCols(src: VSource, prep: PreparedExtraction) {
  const ids = src.segmentIds.filter(isUuid);
  return {
    ids,
    start: ids.length ? src.startMs : null,
    end: ids.length ? src.endMs : null,
    quote: src.quote,
    transcriptId: ids.length ? prep.transcriptId : null,
    revisions: Object.fromEntries(ids.map((id) => [id, prep.segRevisions.get(id) ?? 1])),
  };
}

function matchPerson(name: string, prep: PreparedExtraction): { personId: string; userId: string | null } | null {
  const n = norm(name);
  if (!n) return null;
  const found = new Map<string, string | null>();
  const test = (candidate: string | null) => {
    if (!candidate) return false;
    const c = norm(candidate);
    return !!c && (c === n || c.startsWith(n) || (n.length >= 2 && c.includes(n)) || (c.length >= 2 && n.includes(c)));
  };
  for (const p of prep.participants) if (p.personId && (test(p.displayName) || test(p.personName))) found.set(p.personId, p.userId);
  for (const s of prep.speakers.values()) if (s.personId && (test(s.personName) || test(s.displayName))) found.set(s.personId, s.personUserId);
  if (found.size !== 1) return null; // ambiguous or unknown -> keep the text only
  const [[personId, userId]] = [...found];
  return { personId, userId };
}

function resolveParty(p: VParty | null, prep: PreparedExtraction) {
  if (!p) return { personId: null, userId: null, speakerId: null, text: null, explicit: false };
  const sp = p.speakerLabel ? prep.speakers.get(p.speakerLabel) : undefined;
  let personId = sp?.personId ?? null;
  let userId = sp?.personUserId ?? null;
  if (!personId && p.name) {
    const m = matchPerson(p.name, prep);
    if (m) {
      personId = m.personId;
      userId = m.userId;
    }
  }
  const text = p.name ?? sp?.displayName ?? sp?.personName ?? p.speakerLabel ?? null;
  return { personId, userId, speakerId: sp?.id ?? null, text: text ? text.slice(0, 200) : null, explicit: p.explicit };
}

/** Deletes unreviewed AI candidates of the meeting (a human-edited candidate counts as reviewed and is kept). */
async function replaceCandidates(db: Db, meetingId: string): Promise<number> {
  let n = 0;
  for (const type of LEDGER_TYPES) {
    const cand = type === 'decision' ? "x.review_state = 'candidate'" : "x.status = 'candidate'";
    const keepContradictions =
      type === 'decision'
        ? `AND NOT EXISTS (SELECT 1 FROM contradiction_candidates c WHERE (c.new_decision_id = x.id OR c.existing_decision_id = x.id) AND c.status <> 'open')`
        : '';
    const r = await db.query(
      `DELETE FROM ${TABLE[type]} x WHERE x.meeting_id = $1 AND x.extracted_by = 'ai' AND ${cand}
         AND NOT EXISTS (SELECT 1 FROM ledger_events e WHERE e.entity_type = $2 AND e.entity_id = x.id AND e.by_user_id IS NOT NULL) ${keepContradictions}`,
      [meetingId, type],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

/** Keys of items that already exist for the meeting (confirmed / rejected / human-edited) to avoid duplicates. */
async function existingKeys(db: Db, meetingId: string, type: LedgerType): Promise<Set<string>> {
  const r = await rows<{ t: string; q: string | null }>(db, `SELECT ${TEXT_COL[type]} AS t, source_quote AS q FROM ${TABLE[type]} WHERE meeting_id=$1`, [meetingId]);
  const s = new Set<string>();
  for (const x of r) {
    if (x.t) s.add('t:' + norm(x.t));
    if (x.q) s.add('q:' + norm(x.q));
  }
  return s;
}
function isDuplicate(keys: Set<string>, text: string, quote: string) {
  return keys.has('t:' + norm(text)) || (!!norm(quote) && keys.has('q:' + norm(quote)));
}

export async function persistExtraction(
  db: Db,
  deps: Deps,
  prep: PreparedExtraction,
  v: ValidatedExtraction,
  provider: AiProvider,
  fallback: string | null,
): Promise<ExtractResult> {
  const meetingId = prep.input.meeting.id;
  const m = await one<any>(db, 'SELECT * FROM meetings WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [meetingId]);
  if (!m) return { skipped: 'meeting_not_found' };
  const w = await one<{ settings: unknown }>(db, 'SELECT settings FROM workspaces WHERE id=$1', [m.workspace_id]);
  if (!decideAi(m, wsSettings(w?.settings), deps.config).allowed) return { skipped: 'ai_disabled_during_run' };
  const org = m.org_id;
  const ws = m.workspace_id;
  const providerId = provider.id;
  const replaced = await replaceCandidates(db, meetingId);
  const decidedAt = m.scheduled_start ?? m.started_at ?? m.created_at;
  const participantIds = [...new Set(prep.participants.map((p) => p.personId).filter((x): x is string => !!x))];
  const counts: Record<string, number> = { decision: 0, action: 0, commitment: 0, question: 0, skippedDuplicates: 0 };
  const event = (type: LedgerType, id: string, confidence: number) =>
    ledgerEvent(db, { orgId: org, workspaceId: ws, type, id, event: 'extracted', byUserId: null, diff: { provider: providerId, confidence } });

  // decisions
  const newDecisions: any[] = [];
  let keys = await existingKeys(db, meetingId, 'decision');
  for (const d of v.decisions) {
    if (isDuplicate(keys, d.text, d.source.quote)) {
      counts.skippedDuplicates++;
      continue;
    }
    const s = sourceCols(d.source, prep);
    const row = await one<any>(
      db,
      `INSERT INTO decisions(org_id, workspace_id, meeting_id, project_id, series_id, text, topic, topic_key, decided_at, reason, participant_person_ids,
                             review_state, status, source_segment_ids, source_start_ms, source_end_ms, source_quote, source_transcript_id, source_revisions,
                             confidence, extracted_by, ai_provider)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'candidate','active',$12,$13,$14,$15,$16,$17,$18,'ai',$19) RETURNING *`,
      [org, ws, meetingId, m.project_id, m.series_id, d.text, d.topic, topicKeyOf(d.topic), decidedAt, d.reason, participantIds, s.ids, s.start, s.end, s.quote, s.transcriptId, s.revisions, d.confidence, providerId],
    );
    keys.add('t:' + norm(d.text));
    newDecisions.push(row);
    counts.decision++;
    await event('decision', row.id, d.confidence);
  }

  // actions
  keys = await existingKeys(db, meetingId, 'action');
  for (const a of v.actions) {
    if (isDuplicate(keys, a.description, a.source.quote)) {
      counts.skippedDuplicates++;
      continue;
    }
    const s = sourceCols(a.source, prep);
    const who = resolveParty(a.assignee, prep);
    const row = await one<{ id: string }>(
      db,
      `INSERT INTO actions(org_id, workspace_id, meeting_id, project_id, series_id, description, assignee_person_id, assignee_user_id, assignee_speaker_id,
                           assignee_text, assignee_inferred, due_date, due_text, due_inferred, status, source_segment_ids, source_start_ms, source_end_ms,
                           source_quote, source_transcript_id, source_revisions, confidence, extracted_by, ai_provider)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'candidate',$15,$16,$17,$18,$19,$20,$21,'ai',$22) RETURNING id`,
      [
        org, ws, meetingId, m.project_id, m.series_id, a.description,
        who.personId, who.userId, who.speakerId, who.text, a.assignee ? !a.assignee.explicit : false,
        a.due?.date ?? null, a.due?.text ?? null, a.due?.date ? !a.due.explicit : false,
        s.ids, s.start, s.end, s.quote, s.transcriptId, s.revisions, a.confidence, providerId,
      ],
    );
    keys.add('t:' + norm(a.description));
    counts.action++;
    await event('action', row!.id, a.confidence);
  }

  // commitments
  keys = await existingKeys(db, meetingId, 'commitment');
  for (const c of v.commitments) {
    if (isDuplicate(keys, c.description, c.source.quote)) {
      counts.skippedDuplicates++;
      continue;
    }
    const s = sourceCols(c.source, prep);
    const by = resolveParty(c.promisedBy, prep);
    const to = resolveParty(c.promisedTo, prep);
    const row = await one<{ id: string }>(
      db,
      `INSERT INTO commitments(org_id, workspace_id, meeting_id, project_id, series_id, description, promised_by_person_id, promised_by_user_id,
                               promised_by_speaker_id, promised_by_text, promised_to_person_id, promised_to_user_id, promised_to_text, due_date, due_text,
                               due_inferred, status, source_segment_ids, source_start_ms, source_end_ms, source_quote, source_transcript_id, source_revisions,
                               confidence, extracted_by, ai_provider)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'candidate',$17,$18,$19,$20,$21,$22,$23,'ai',$24) RETURNING id`,
      [
        org, ws, meetingId, m.project_id, m.series_id, c.description,
        by.personId, by.userId, by.speakerId, by.text, to.personId, to.userId, to.text,
        c.due?.date ?? null, c.due?.text ?? null, c.due?.date ? !c.due.explicit : false,
        s.ids, s.start, s.end, s.quote, s.transcriptId, s.revisions, c.confidence, providerId,
      ],
    );
    keys.add('t:' + norm(c.description));
    counts.commitment++;
    await event('commitment', row!.id, c.confidence);
  }

  // open questions
  keys = await existingKeys(db, meetingId, 'question');
  for (const q of v.questions) {
    if (isDuplicate(keys, q.question, q.source.quote)) {
      counts.skippedDuplicates++;
      continue;
    }
    const s = sourceCols(q.source, prep);
    const owner = resolveParty(q.owner, prep);
    const row = await one<{ id: string }>(
      db,
      `INSERT INTO open_questions(org_id, workspace_id, meeting_id, project_id, series_id, question, owner_person_id, status, source_segment_ids,
                                  source_start_ms, source_end_ms, source_quote, source_transcript_id, source_revisions, confidence, extracted_by, ai_provider)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'candidate',$8,$9,$10,$11,$12,$13,$14,'ai',$15) RETURNING id`,
      [org, ws, meetingId, m.project_id, m.series_id, q.question, owner.personId, s.ids, s.start, s.end, s.quote, s.transcriptId, s.revisions, q.confidence, providerId],
    );
    keys.add('t:' + norm(q.question));
    counts.question++;
    await event('question', row!.id, q.confidence);
  }

  // summary version (skipped when identical to the current one for the same transcript)
  const src = (x: VSource | null) => {
    if (!x) return null;
    const s = sourceCols(x, prep);
    return { segmentIds: s.ids, startMs: s.start, endMs: s.end, quote: s.quote, revisions: s.revisions };
  };
  const sections = {
    executive: v.summary.executive,
    topics: v.summary.topics.map((t) => ({ title: t.title, source: src(t.source) })),
    risks: v.summary.risks.map((r) => ({ text: r.text, source: src(r.source) })),
    nextMeeting: v.summary.nextMeeting,
  };
  const cur = await one<any>(db, 'SELECT id, sections, transcript_id, provider FROM summaries WHERE meeting_id=$1 AND is_current', [meetingId]);
  if (!cur || cur.transcript_id !== prep.transcriptId || cur.provider !== providerId || JSON.stringify(cur.sections) !== JSON.stringify(sections)) {
    await db.query('UPDATE summaries SET is_current=false WHERE meeting_id=$1', [meetingId]);
    await db.query(
      `INSERT INTO summaries(org_id, meeting_id, transcript_id, version, provider, model, sections, is_current)
       VALUES ($1,$2,$3,(SELECT coalesce(max(version),0)+1 FROM summaries WHERE meeting_id=$2),$4,$5,$6,true)`,
      [org, meetingId, prep.transcriptId, providerId, (provider.model ?? null), sections],
    );
  }

  const contradictions = await detectContradictions(db, org, ws, m, newDecisions);
  await db.query("UPDATE meetings SET status='needs_review', updated_at=now() WHERE id=$1 AND status NOT IN ('archived','live')", [meetingId]);
  await deps.jobs.enqueue(db, { orgId: org, type: 'index.meeting', key: `index:${meetingId}:${Date.now()}`, payload: { meetingId } });
  const result: ExtractResult = { provider: providerId, isLocal: provider.isLocal, fallback, counts, dropped: v.stats.dropped, replaced, contradictions };
  await audit(db, {
    orgId: org,
    workspaceId: ws,
    action: 'ai.extracted',
    entityType: 'meeting',
    entityId: meetingId,
    meta: { provider: providerId, isLocal: provider.isLocal, fallback, counts, dropped: v.stats.dropped, textReplaced: v.stats.textReplaced, replaced, contradictions },
  });
  return result;
}

/**
 * Creates contradiction candidates between `newDecisions` and confirmed, active decisions of the same project or series
 * (workspace-wide when the meeting has neither). Exported for manual decision creation.
 */
export async function detectContradictions(
  db: Db,
  orgId: string,
  workspaceId: string,
  meeting: { id: string | null; project_id: string | null; series_id: string | null },
  newDecisions: any[],
): Promise<number> {
  if (!newDecisions.length) return 0;
  const params: unknown[] = [workspaceId, newDecisions.map((d) => d.id)];
  const scope: string[] = [];
  if (meeting.project_id) {
    params.push(meeting.project_id);
    scope.push(`d.project_id = $${params.length}`);
  }
  if (meeting.series_id) {
    params.push(meeting.series_id);
    scope.push(`d.series_id = $${params.length}`);
  }
  const existing = await rows<any>(
    db,
    `SELECT d.id, d.text, d.topic, d.topic_key FROM decisions d
      WHERE d.workspace_id = $1 AND d.review_state = 'confirmed' AND d.status = 'active' AND NOT (d.id = ANY($2))
        AND (d.meeting_id IS NULL OR EXISTS (SELECT 1 FROM meetings dm WHERE dm.id = d.meeting_id AND dm.deleted_at IS NULL))
        AND ${scope.length ? `(${scope.join(' OR ')})` : 'TRUE'}
      ORDER BY d.created_at DESC LIMIT 1000`,
    params,
  );
  let n = 0;
  for (const nd of newDecisions) {
    for (const ed of existing) {
      const reason = contradictionReason(
        { text: nd.text, topic: nd.topic, topicKey: nd.topic_key ?? topicKeyOf(nd.topic) },
        { text: ed.text, topic: ed.topic, topicKey: ed.topic_key ?? topicKeyOf(ed.topic) },
      );
      if (!reason) continue;
      const c = await one<{ id: string }>(
        db,
        `INSERT INTO contradiction_candidates(org_id, workspace_id, meeting_id, existing_decision_id, new_decision_id, reason)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (existing_decision_id, new_decision_id) DO NOTHING RETURNING id`,
        [orgId, workspaceId, meeting.id ?? nd.meeting_id ?? null, ed.id, nd.id, reason],
      );
      if (c) {
        n++;
        await ledgerEvent(db, { orgId, workspaceId, type: 'contradiction', id: c.id, event: 'detected', byUserId: null, diff: { existing: ed.id, new: nd.id } });
      }
    }
  }
  return n;
}

export function registerExtractJob(worker: Worker, deps: Deps) {
  worker.register('ai.extract', async (job) => {
    const meetingId = job.payload?.meetingId;
    if (!job.org_id || !isUuid(meetingId)) throw permanentError('ai.extract: invalid payload');
    return runExtraction(deps, job.org_id, meetingId);
  });
}
