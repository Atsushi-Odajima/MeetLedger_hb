// Meeting-scoped ledger endpoints: extract (enqueue), summary, ledger, ask (single meeting), coach (facts only).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AskResponseDto, CitationDto } from '@meetledger/shared';
import type { Deps, WsCtx } from '../../context';
import { one, rows } from '../../db/pool';
import { policyDenied } from '../../lib/errors';
import { body, iso, parse, query, wsIdParams } from '../../lib/http';
import { loadMeeting, workspaceCtx } from '../../rbac/access';
import { decideAi, wsSettings, type PolicyDecision } from '../../privacy/policy';
import type { AnswerContext, AiProvider } from '../../providers/ai/types';
import { isInaudibleSegment, stripInaudible, truncate } from '../../providers/ai/text';
import { questionKeywords, relevance } from '../../providers/ai/localRules';
import { INSUFFICIENT_EN, INSUFFICIENT_JA, scopeOf } from './common';
import { loadSegStates, summaryDto, summarySegmentIds } from './mappers';
import { meetingLedger } from './queries';
import { norm } from '../../providers/ai/text';

const MAX_ASK_CONTEXTS = 40;

export const COACH_DISCLAIMER_JA =
  'これは記録（文字起こし・台帳）から機械的に計算した事実ベースの指標です。発言者の能力・性格・感情を評価・推測するものではなく、人の順位付けも行いません。';
export const COACH_DISCLAIMER_EN =
  'These are factual metrics computed from the record (transcript and ledger). They do not assess or infer anyone’s ability, personality or emotions, and do not rank people.';

/** Extraction job key: one job per meeting & transcript (notes-only meetings use "notes"). */
export function extractJobKey(meetingId: string, transcriptId: string | null) {
  return `ai.extract:${meetingId}:${transcriptId ?? 'notes'}`;
}

async function meetingAiDecision(db: any, ctx: WsCtx, m: any): Promise<PolicyDecision> {
  const w = await one<{ settings: unknown }>(db, 'SELECT settings FROM workspaces WHERE id=$1', [ctx.workspaceId]);
  return decideAi(m, wsSettings(w?.settings), ctx.deps.config);
}

export default async function meetingLedgerRoutes(app: FastifyInstance, deps: Deps) {
  // ---------------------------------------------------------------- enqueue extraction (policy-checked)
  app.post('/api/w/:workspaceId/meetings/:id/extract', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ rerun: z.boolean().default(false) }));
    return ctx.tx(async (db) => {
      const m = await loadMeeting(db, ctx, id, 'write');
      const decision = await meetingAiDecision(db, ctx, m);
      if (!decision.allowed) throw policyDenied(decision.reason);
      const t = await one<{ id: string }>(db, 'SELECT id FROM transcripts WHERE meeting_id=$1 AND is_current ORDER BY version DESC LIMIT 1', [id]);
      const key = extractJobKey(id, t?.id ?? null);
      const payload = { meetingId: id, transcriptId: t?.id ?? null };
      let job = b.rerun ? await deps.jobs.rerun(db, key) : null;
      if (!job) job = await deps.jobs.enqueue(db, { orgId: ctx.orgId, type: 'ai.extract', key, payload });
      return { jobId: job.id, created: job.created, status: job.status, provider: decision.provider, isLocal: decision.isLocal, reason: decision.reason };
    });
  });

  // ---------------------------------------------------------------- summary
  app.get('/api/w/:workspaceId/meetings/:id/summary', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(req, z.object({ version: z.coerce.number().int().min(1).optional() }));
    return ctx.tx(async (db) => {
      await loadMeeting(db, ctx, id);
      const s = q.version
        ? await one<any>(db, 'SELECT * FROM summaries WHERE meeting_id=$1 AND version=$2', [id, q.version])
        : await one<any>(db, 'SELECT * FROM summaries WHERE meeting_id=$1 AND is_current ORDER BY version DESC LIMIT 1', [id]);
      if (!s) return null;
      const states = await loadSegStates(db, summarySegmentIds(s.sections));
      return summaryDto(s, states);
    });
  });

  // ---------------------------------------------------------------- per-meeting ledger
  app.get('/api/w/:workspaceId/meetings/:id/ledger', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(req, z.object({ includeRejected: z.enum(['1', 'true', '0', 'false']).optional() }));
    return ctx.tx(async (db) => {
      await loadMeeting(db, ctx, id);
      return meetingLedger(db, scopeOf(ctx), id, q.includeRejected === '1' || q.includeRejected === 'true');
    });
  });

  // ---------------------------------------------------------------- ask (single meeting)
  app.post('/api/w/:workspaceId/meetings/:id/ask', async (req): Promise<AskResponseDto> => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const b = body(req, z.object({ question: z.string().trim().min(1).max(1000) }));
    const locale = ctx.user.locale === 'en' ? 'en' : 'ja';
    const unknown = locale === 'en' ? INSUFFICIENT_EN : INSUFFICIENT_JA;
    // Phase 1 (tx): ACL, policy, contexts.
    const prep = await ctx.tx(async (db) => {
      const m = await loadMeeting(db, ctx, id);
      const decision = await meetingAiDecision(db, ctx, m);
      if (!decision.allowed) return { m, decision, contexts: [] as (AnswerContext & { segmentId: string | null; startMs: number | null; endMs: number | null })[] };
      const segs = await rows<any>(
        db,
        `SELECT s.id, s.start_ms, s.end_ms, s.text, s.flags, s.speaker_label FROM transcript_segments s
           JOIN transcripts t ON t.id = s.transcript_id AND t.is_current WHERE s.meeting_id=$1 ORDER BY s.seq`,
        [id],
      );
      let pool = segs
        .filter((s) => !isInaudibleSegment(s))
        .map((s) => ({ segmentId: s.id as string | null, startMs: s.start_ms as number | null, endMs: s.end_ms as number | null, text: `${s.speaker_label}: ${s.text}` }));
      if (!pool.length) {
        const notes = await rows<any>(db, 'SELECT body FROM meeting_notes WHERE meeting_id=$1 ORDER BY created_at', [id]);
        pool = notes
          .flatMap((n) => String(n.body).split(/\r?\n/))
          .map((l) => l.trim())
          .filter(Boolean)
          .map((text) => ({ segmentId: null, startMs: null, endMs: null, text }));
      }
      // Data minimization: send only the most relevant excerpts (in transcript order).
      const kw = questionKeywords(b.question);
      const ranked = pool.map((c, i) => ({ c, i, s: relevance(kw, stripInaudible(c.text)) }));
      const top = ranked
        .filter((x) => x.s > 0)
        .sort((a, b2) => b2.s - a.s || a.i - b2.i)
        .slice(0, MAX_ASK_CONTEXTS)
        .sort((a, b2) => a.i - b2.i);
      const date = m.scheduled_start ?? m.started_at ?? m.created_at;
      const contexts = top.map((x, k) => ({
        ref: `c${k + 1}`,
        text: truncate(x.c.text, 1200),
        meetingTitle: m.title as string,
        meetingDate: iso(date),
        segmentId: x.c.segmentId,
        startMs: x.c.startMs,
        endMs: x.c.endMs,
      }));
      return { m, decision, contexts };
    });
    const date = iso(prep.m.scheduled_start ?? prep.m.started_at ?? prep.m.created_at);
    if (!prep.decision.allowed) {
      return {
        answer: locale === 'en' ? 'AI is turned off for this meeting, so questions cannot be answered by AI.' : 'このMeetingはAI OFFのため、AIによる質問応答は利用できません。',
        insufficient: true,
        citations: [],
        provider: 'none',
        aiGenerated: false,
        excludedMeetings: 1,
      };
    }
    if (!prep.contexts.length) return { answer: unknown, insufficient: true, citations: [], provider: prep.decision.provider, aiGenerated: false, excludedMeetings: 0 };
    // Phase 2 (no tx): provider call through the guarded HTTP client.
    let provider: AiProvider = deps.providers.ai('local-rules');
    let decision = prep.decision;
    try {
      const p = deps.providers.ai(prep.decision.provider);
      if ((await p.available()).ok) provider = p;
    } catch {
      /* fall back to local-rules */
    }
    if (provider.id === 'local-rules') decision = { allowed: true, provider: 'local-rules', isLocal: true, reason: 'Local rules' };
    const out = await provider.answer(
      { question: b.question, contexts: prep.contexts.map(({ ref, text, meetingTitle, meetingDate }) => ({ ref, text, meetingTitle, meetingDate })), locale },
      { http: deps.http, orgId: ctx.orgId, meetingIds: [id], decision, purpose: 'ai.ask.meeting' },
    );
    // Citations must be among the provided contexts; an answer without a valid citation is "unknown".
    const byRef = new Map(prep.contexts.map((c) => [c.ref, c]));
    const cited = [...new Set(out.citedRefs)].map((r) => byRef.get(r)).filter((c): c is NonNullable<typeof c> => !!c);
    const insufficient = out.insufficient || !cited.length || !norm(out.answer);
    const citations: CitationDto[] = insufficient
      ? []
      : cited.map((c) => ({
          id: c.ref,
          entityType: c.segmentId ? 'segment' : 'note',
          entityId: c.segmentId ?? id,
          meetingId: id,
          meetingTitle: prep.m.title,
          meetingDate: date,
          startMs: c.startMs,
          endMs: c.endMs,
          snippet: truncate(c.text, 300),
        }));
    return {
      answer: insufficient ? unknown : out.answer,
      insufficient,
      citations,
      provider: provider.id,
      aiGenerated: provider.id !== 'local-rules',
      excludedMeetings: 0,
    };
  });

  // ---------------------------------------------------------------- coach: facts only, no ranking, no judgement
  app.get('/api/w/:workspaceId/meetings/:id/coach', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const m = await loadMeeting(db, ctx, id);
      const segs = await rows<any>(
        db,
        `SELECT s.start_ms, s.end_ms, s.speaker_label, s.text, s.flags, sp.display_name, p.name AS person_name
           FROM transcript_segments s JOIN transcripts t ON t.id = s.transcript_id AND t.is_current
           LEFT JOIN meeting_speakers sp ON sp.id = s.speaker_id LEFT JOIN people p ON p.id = sp.person_id
          WHERE s.meeting_id=$1 ORDER BY s.seq`,
        [id],
      );
      // Talk time per speaker label, listed in order of first appearance (never sorted by amount).
      const order: string[] = [];
      const talk = new Map<string, { ms: number; segments: number; name: string | null }>();
      for (const s of segs) {
        if (!talk.has(s.speaker_label)) {
          order.push(s.speaker_label);
          talk.set(s.speaker_label, { ms: 0, segments: 0, name: s.display_name ?? s.person_name ?? null });
        }
        const t = talk.get(s.speaker_label)!;
        t.ms += Math.max(0, (s.end_ms ?? 0) - (s.start_ms ?? 0));
        t.segments++;
      }
      const totalTalk = [...talk.values()].reduce((n, t) => n + t.ms, 0);
      const durationMs = segs.length
        ? Math.max(...segs.map((s) => s.end_ms)) - Math.min(...segs.map((s) => s.start_ms))
        : m.started_at && m.ended_at
          ? new Date(m.ended_at).getTime() - new Date(m.started_at).getTime()
          : null;
      const c = await one<any>(
        db,
        `SELECT
           (SELECT count(*) FROM open_questions WHERE meeting_id=$1 AND status IN ('candidate','open')) AS open_questions,
           (SELECT count(*) FROM actions WHERE meeting_id=$1 AND status NOT IN ('rejected','cancelled')
               AND assignee_person_id IS NULL AND assignee_user_id IS NULL AND assignee_text IS NULL) AS actions_without_owner,
           (SELECT count(*) FROM actions WHERE meeting_id=$1 AND status NOT IN ('rejected','cancelled') AND due_date IS NULL) AS actions_without_due,
           (SELECT count(*) FROM actions WHERE meeting_id=$1 AND status NOT IN ('rejected','cancelled')) AS actions,
           (SELECT count(*) FROM decisions WHERE meeting_id=$1 AND review_state <> 'rejected') AS decisions,
           (SELECT count(*) FROM decisions WHERE meeting_id=$1 AND review_state = 'confirmed') AS decisions_confirmed`,
        [id],
      );
      const summary = await one<any>(db, 'SELECT sections FROM summaries WHERE meeting_id=$1 AND is_current ORDER BY version DESC LIMIT 1', [id]);
      const decisionTopics = await rows<{ topic: string | null; text: string }>(db, "SELECT topic, text FROM decisions WHERE meeting_id=$1 AND review_state <> 'rejected'", [id]);
      const topicsWithoutDecision = ((summary?.sections?.topics ?? []) as { title: string }[])
        .map((t) => t.title)
        .filter((title) => {
          const k = norm(title);
          return !!k && !decisionTopics.some((d) => (d.topic && (norm(d.topic).includes(k) || k.includes(norm(d.topic)))) || norm(d.text).includes(k));
        });
      const locale = ctx.user.locale === 'en' ? 'en' : 'ja';
      return {
        meetingId: id,
        factsOnly: true,
        disclaimer: locale === 'en' ? COACH_DISCLAIMER_EN : COACH_DISCLAIMER_JA,
        durationMs,
        speakers: order.map((label) => {
          const t = talk.get(label)!;
          return { label, displayName: t.name, talkMs: t.ms, segments: t.segments, share: totalTalk ? Math.round((t.ms / totalTalk) * 1000) / 1000 : 0 };
        }),
        openQuestions: Number(c.open_questions),
        actions: Number(c.actions),
        actionsWithoutOwner: Number(c.actions_without_owner),
        actionsWithoutDue: Number(c.actions_without_due),
        decisionCount: Number(c.decisions),
        confirmedDecisionCount: Number(c.decisions_confirmed),
        topicsWithoutDecision,
      };
    });
  });
}
