// Review Inbox at scale: candidates grouped by meeting, with exact per-type totals, per-meeting counts and paging.
//
//  * totals: one count per type over the candidate indexes, ACL via itemVisibleSql (open contradictions: both decisions visible)
//  * page of meeting groups: visible meetings walked newest-first (index meetings_ws_review_order) with cheap per-meeting
//    probes, stopping after `groupLimit` meetings that have candidates; when the inbox is small the candidate rows are
//    grouped directly instead (no long walk over candidate-free meetings)
//  * items / speakers / participants / contradictions are loaded only for the meetings of the page
import type { ActionDto, CommitmentDto, ContradictionDto, DecisionDto, QuestionDto } from '@meetledger/shared';
import { one, rows, type Db } from '../../db/pool';
import { badRequest, notFound } from '../../lib/errors';
import { iso } from '../../lib/http';
import { itemVisibleSql, meetingVisibleSql } from '../../rbac/access';
import { MEETING_COLS, MEETING_JOIN, TABLE, myPersonIds, todayOf, type LedgerScope, type LedgerType } from './common';
import { actionDto, commitmentDto, decisionDto, loadSegStates, questionDto } from './mappers';
import { decodeCursor, encodeCursor, pageContradictions } from './queries';

export type ReviewType = LedgerType | 'contradiction';
const ITEM_TYPES: LedgerType[] = ['decision', 'action', 'commitment', 'question'];
const CANDIDATE: Record<LedgerType, string> = {
  decision: "x.review_state = 'candidate'",
  action: "x.status = 'candidate'",
  commitment: "x.status = 'candidate'",
  question: "x.status = 'candidate'",
};
/** Below this many candidates the page is built by grouping candidate rows instead of walking meetings. */
const GROUPING_THRESHOLD = 20_000;

export interface ReviewOpts {
  meetingId?: string;
  type?: ReviewType;
  /** max items returned (default 100, max 300) */
  limit?: number;
  /** meeting groups per page (default 20, max 50) */
  groupLimit?: number;
  cursor?: string | null;
}

type Counts = Record<ReviewType, number>;
const zero = (): Counts => ({ decision: 0, action: 0, commitment: 0, question: 0, contradiction: 0 });

export interface ReviewGroup {
  meetingId: string | null;
  meetingTitle: string | null;
  meetingDate: string | null;
  counts: Counts;
  /** candidates (4 item types) of this meeting */
  total: number;
  /** how many of this meeting's items are included in `items` (load `?meetingId=` for the rest) */
  itemsIncluded: number;
}

export interface ReviewFlags {
  assigneeInferred: boolean;
  dueInferred: boolean;
  missingOwner: boolean;
  missingDue: boolean;
  sourceStatus: 'ok' | 'edited' | 'missing' | null;
}
export type ReviewItem =
  | { type: 'decision'; item: DecisionDto; flags: ReviewFlags }
  | { type: 'action'; item: ActionDto; flags: ReviewFlags }
  | { type: 'commitment'; item: CommitmentDto; flags: ReviewFlags }
  | { type: 'question'; item: QuestionDto; flags: ReviewFlags };

export interface ReviewInbox {
  items: ReviewItem[];
  groups: ReviewGroup[];
  /** exact totals of the whole inbox (all pages) per type */
  counts: Counts;
  /** decision + action + commitment + question candidates in the whole inbox */
  total: number;
  nextCursor: string | null;
  contradictions: ContradictionDto[];
  unmappedSpeakers: { id: string; speakerId: string; label: string; suggestion: string | null; meetingId: string; meetingTitle: string | null }[];
  unlinkedParticipants: { id: string; participantId: string; displayName: string; email: string | null; meetingId: string; meetingTitle: string | null }[];
}

const MEETING_DATE = (a: string) => `coalesce(${a}.scheduled_start, ${a}.started_at, ${a}.created_at)`;

function encodeOffset(n: number) {
  return Buffer.from(JSON.stringify({ o: n })).toString('base64url');
}
function decodeOffset(c: string): number {
  try {
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'))?.o;
    if (Number.isInteger(o) && o >= 0 && o < 100_000) return o;
  } catch {
    /* fall through */
  }
  throw badRequest('Invalid cursor');
}

/** Exact totals per type, plus counts of candidates not attached to a meeting (shown as a last "no meeting" group). */
async function inboxTotals(db: Db, scope: LedgerScope, meetingId?: string): Promise<{ counts: Counts; noMeeting: Counts }> {
  const m = meetingId ? ' AND x.meeting_id = $3' : '';
  const params: unknown[] = [scope.workspaceId, scope.userId, ...(meetingId ? [meetingId] : [])];
  const part = (type: LedgerType) =>
    `(SELECT json_build_array(count(*), count(*) FILTER (WHERE x.meeting_id IS NULL)) FROM ${TABLE[type]} x
       WHERE x.workspace_id = $1 AND ${CANDIDATE[type]}${m} AND ${itemVisibleSql('x', '$2')}) AS ${type}`;
  const r = await one<any>(
    db,
    `SELECT ${ITEM_TYPES.map(part).join(', ')},
       (SELECT json_build_array(count(*), count(*) FILTER (WHERE c.meeting_id IS NULL)) FROM contradiction_candidates c
          JOIN decisions ed ON ed.id = c.existing_decision_id JOIN decisions nd ON nd.id = c.new_decision_id
         WHERE c.workspace_id = $1 AND c.status = 'open'${meetingId ? ' AND c.meeting_id = $3' : ''}
           AND ${itemVisibleSql('ed', '$2')} AND ${itemVisibleSql('nd', '$2')}) AS contradiction`,
    params,
  );
  const counts = zero();
  const noMeeting = zero();
  for (const k of Object.keys(counts) as ReviewType[]) {
    counts[k] = Number(r?.[k]?.[0] ?? 0);
    noMeeting[k] = Number(r?.[k]?.[1] ?? 0);
  }
  return { counts, noMeeting };
}

/** Per-meeting counts for the meetings of one page. */
async function meetingCounts(db: Db, scope: LedgerScope, ids: string[], includeNull: boolean): Promise<Map<string | null, Counts>> {
  const out = new Map<string | null, Counts>();
  const get = (id: string | null) => {
    if (!out.has(id)) out.set(id, zero());
    return out.get(id)!;
  };
  const inPage = (col: string) => `(${col} = ANY($3)${includeNull ? ` OR ${col} IS NULL` : ''})`;
  const parts = ITEM_TYPES.map(
    (t) => `SELECT x.meeting_id, '${t}' AS t, count(*)::int AS n FROM ${TABLE[t]} x
             WHERE x.workspace_id = $1 AND ${CANDIDATE[t]} AND ${inPage('x.meeting_id')} AND ${itemVisibleSql('x', '$2')} GROUP BY x.meeting_id`,
  );
  parts.push(`SELECT c.meeting_id, 'contradiction' AS t, count(*)::int AS n FROM contradiction_candidates c
                JOIN decisions ed ON ed.id = c.existing_decision_id JOIN decisions nd ON nd.id = c.new_decision_id
               WHERE c.workspace_id = $1 AND c.status = 'open' AND ${inPage('c.meeting_id')}
                 AND ${itemVisibleSql('ed', '$2')} AND ${itemVisibleSql('nd', '$2')} GROUP BY c.meeting_id`);
  for (const r of await rows<{ meeting_id: string | null; t: ReviewType; n: number }>(db, parts.join(' UNION ALL '), [scope.workspaceId, scope.userId, ids])) {
    get(r.meeting_id)[r.t] = r.n;
  }
  return out;
}

interface GroupHead {
  meetingId: string | null;
  meetingTitle: string | null;
  meetingDate: string | null;
}

/** Walks visible meetings newest-first and returns the first `limit + 1` that have candidates of the probed types. */
async function walkMeetings(db: Db, scope: LedgerScope, probe: ReviewType[], limit: number, cursor: { v: string | null; id: string } | null): Promise<GroupHead[]> {
  const params: unknown[] = [scope.workspaceId, scope.userId];
  const has = probe.map((t) =>
    t === 'contradiction'
      ? `coalesce((SELECT true FROM contradiction_candidates c JOIN decisions ed ON ed.id = c.existing_decision_id
                    WHERE c.meeting_id = m.id AND c.status = 'open' AND ${itemVisibleSql('ed', '$2')} LIMIT 1), false)`
      : `coalesce((SELECT true FROM ${TABLE[t]} x WHERE x.meeting_id = m.id AND ${CANDIDATE[t]} LIMIT 1), false)`,
  );
  let keyset = '';
  if (cursor) {
    params.push(cursor.v, cursor.id);
    keyset = ` AND (${MEETING_DATE('m')}, m.id) < ($3::timestamptz, $4::uuid)`;
  }
  // Scalar sub-selects with LIMIT 1 keep the probes per meeting (EXISTS would be planned as hashes over all candidates).
  const r = await rows<any>(
    db,
    `SELECT m.id, m.title, ${MEETING_DATE('m')} AS meeting_date FROM meetings m
      WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')}${keyset} AND (${has.join(' OR ')})
      ORDER BY ${MEETING_DATE('m')} DESC, m.id DESC LIMIT ${limit + 1}`,
    params,
  );
  return r.map((x) => ({ meetingId: x.id, meetingTitle: x.title, meetingDate: iso(x.meeting_date) }));
}

/** Small inboxes: group the candidate rows directly (avoids walking many candidate-free meetings). */
async function groupedMeetings(db: Db, scope: LedgerScope, types: ReviewType[], limit: number, cursor: { v: string | null; id: string } | null): Promise<GroupHead[]> {
  const parts = types.map((t) =>
    t === 'contradiction'
      ? `SELECT c.meeting_id FROM contradiction_candidates c JOIN decisions ed ON ed.id = c.existing_decision_id
           WHERE c.workspace_id = $1 AND c.status = 'open' AND c.meeting_id IS NOT NULL AND ${itemVisibleSql('ed', '$2')}`
      : `SELECT x.meeting_id FROM ${TABLE[t]} x WHERE x.workspace_id = $1 AND ${CANDIDATE[t]} AND x.meeting_id IS NOT NULL`,
  );
  const params: unknown[] = [scope.workspaceId, scope.userId];
  let keyset = '';
  if (cursor) {
    params.push(cursor.v, cursor.id);
    keyset = ` AND (${MEETING_DATE('m')}, m.id) < ($3::timestamptz, $4::uuid)`;
  }
  const r = await rows<any>(
    db,
    `SELECT m.id, m.title, ${MEETING_DATE('m')} AS meeting_date
       FROM (SELECT DISTINCT meeting_id FROM (${parts.join(' UNION ALL ')}) u) g JOIN meetings m ON m.id = g.meeting_id
      WHERE m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')}${keyset}
      ORDER BY ${MEETING_DATE('m')} DESC, m.id DESC LIMIT ${limit + 1}`,
    params,
  );
  return r.map((x) => ({ meetingId: x.id, meetingTitle: x.title, meetingDate: iso(x.meeting_date) }));
}

function flagsOf(type: LedgerType, item: any): ReviewFlags {
  const sourceStatus = item.source?.status ?? null;
  if (type === 'action')
    return {
      assigneeInferred: !!item.assigneeInferred,
      dueInferred: !!item.dueInferred,
      missingOwner: !item.assigneePersonId && !item.assigneeUserId && !item.assigneeText,
      missingDue: !item.dueDate,
      sourceStatus,
    };
  if (type === 'commitment')
    return { assigneeInferred: false, dueInferred: !!item.dueInferred, missingOwner: !item.promisedByPersonId && !item.promisedByText, missingDue: !item.dueDate, sourceStatus };
  return { assigneeInferred: false, dueInferred: false, missingOwner: false, missingDue: false, sourceStatus };
}

/** Candidate items of the given meetings (at most `perMeeting` per meeting and type), mapped to DTOs. */
async function candidateItems(db: Db, scope: LedgerScope, types: LedgerType[], ids: string[], includeNull: boolean, perMeeting: number): Promise<ReviewItem[]> {
  const today = todayOf(scope);
  const mine = new Set(await myPersonIds(db, scope));
  const out: ReviewItem[] = [];
  for (const t of types) {
    const extraJoin = t === 'commitment' ? 'LEFT JOIN people pbp ON pbp.id = x.promised_by_person_id' : '';
    const extraCols = t === 'commitment' ? ', pbp.user_id AS promised_by_person_user_id' : '';
    const list = await rows<any>(
      db,
      `SELECT * FROM (
         SELECT x.*, ${MEETING_COLS}${extraCols}, row_number() OVER (PARTITION BY x.meeting_id ORDER BY x.created_at, x.id) AS review_rn
           FROM ${TABLE[t]} x ${MEETING_JOIN('x')} ${extraJoin}
          WHERE x.workspace_id = $1 AND ${CANDIDATE[t]} AND (x.meeting_id = ANY($3)${includeNull ? ' OR x.meeting_id IS NULL' : ''})
            AND ${itemVisibleSql('x', '$2')}) s
        WHERE s.review_rn <= ${perMeeting} ORDER BY s.created_at, s.id`,
      [scope.workspaceId, scope.userId, ids],
    );
    const states = await loadSegStates(db, list);
    for (const r of list) {
      const item =
        t === 'decision' ? decisionDto(r, states) : t === 'action' ? actionDto(r, states, today) : t === 'commitment' ? commitmentDto(r, states, today, scope.userId, mine) : questionDto(r, states);
      out.push({ type: t, item, flags: flagsOf(t, item) } as ReviewItem);
    }
  }
  return out;
}

export async function reviewInbox(db: Db, scope: LedgerScope, o: ReviewOpts = {}): Promise<ReviewInbox> {
  await db.query('SET LOCAL jit = off');
  const limit = Math.min(Math.max(o.limit ?? 100, 1), 300);
  const groupLimit = Math.min(Math.max(o.groupLimit ?? 20, 1), 50);
  const itemTypes = o.type && o.type !== 'contradiction' ? [o.type] : o.type === 'contradiction' ? [] : ITEM_TYPES;

  let heads: GroupHead[];
  let nextCursor: string | null = null;
  let offset = 0;
  const { counts, noMeeting } = await inboxTotals(db, scope, o.meetingId);

  if (o.meetingId) {
    const m = await one<any>(
      db,
      `SELECT m.id, m.title, ${MEETING_DATE('m')} AS meeting_date FROM meetings m WHERE m.id = $3 AND m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')}`,
      [scope.workspaceId, scope.userId, o.meetingId],
    );
    if (!m) throw notFound('Meeting not found');
    heads = [{ meetingId: m.id, meetingTitle: m.title, meetingDate: iso(m.meeting_date) }];
    offset = o.cursor ? decodeOffset(o.cursor) : 0;
  } else {
    const cursor = o.cursor ? decodeCursor(o.cursor, 'timestamptz') : null;
    const probe: ReviewType[] = (o.type ? [o.type] : (['decision', 'action', 'commitment', 'question', 'contradiction'] as ReviewType[])).filter(
      (t) => counts[t] - noMeeting[t] > 0,
    );
    const candidates = probe.reduce((n, t) => n + counts[t] - noMeeting[t], 0);
    heads = !probe.length
      ? []
      : candidates <= GROUPING_THRESHOLD
        ? await groupedMeetings(db, scope, probe, groupLimit, cursor)
        : await walkMeetings(db, scope, probe, groupLimit, cursor);
    if (heads.length > groupLimit) {
      heads = heads.slice(0, groupLimit);
      const last = heads[heads.length - 1];
      nextCursor = encodeCursor(last.meetingDate, last.meetingId!);
    } else {
      // last page: candidates that belong to no meeting (e.g. contradictions raised by a workspace-level decision)
      const t = o.type ? [o.type] : (Object.keys(noMeeting) as ReviewType[]);
      if (t.some((k) => noMeeting[k] > 0)) heads.push({ meetingId: null, meetingTitle: null, meetingDate: null });
    }
  }

  const ids = heads.map((h) => h.meetingId).filter((x): x is string => !!x);
  const includeNull = heads.some((h) => h.meetingId === null);
  const perMeetingCounts = await meetingCounts(db, scope, ids, includeNull);

  // items: page order (group order, then type, then creation)
  const order = new Map(heads.map((h, i) => [h.meetingId, i]));
  const all = await candidateItems(db, scope, itemTypes, ids, includeNull, o.meetingId ? 500 : limit);
  all.sort((a, b) => (order.get(a.item.meetingId) ?? 0) - (order.get(b.item.meetingId) ?? 0) || ITEM_TYPES.indexOf(a.type) - ITEM_TYPES.indexOf(b.type));
  let items: ReviewItem[];
  if (o.meetingId) {
    items = all.slice(offset, offset + limit);
    if (offset + limit < all.length) nextCursor = encodeOffset(offset + limit);
  } else items = all.slice(0, limit);
  const included = new Map<string | null, number>();
  for (const it of items) included.set(it.item.meetingId, (included.get(it.item.meetingId) ?? 0) + 1);

  const groups: ReviewGroup[] = heads.map((h) => {
    const c = perMeetingCounts.get(h.meetingId) ?? zero();
    return { ...h, counts: c, total: c.decision + c.action + c.commitment + c.question, itemsIncluded: included.get(h.meetingId) ?? 0 };
  });

  const contradictions =
    !o.type || o.type === 'contradiction'
      ? (await pageContradictions(db, scope, { status: 'open', meetingIds: ids, includeNullMeeting: includeNull, limit: 200 })).items
      : [];

  const unmappedSpeakers = ids.length
    ? await rows<any>(
        db,
        `SELECT sp.id, sp.label, sp.suggestion, sp.meeting_id, m.title AS meeting_title FROM meeting_speakers sp JOIN meetings m ON m.id = sp.meeting_id
          WHERE sp.meeting_id = ANY($3) AND sp.person_id IS NULL AND m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')}
            AND EXISTS (SELECT 1 FROM transcripts t JOIN transcript_segments s ON s.transcript_id = t.id
                         WHERE t.meeting_id = sp.meeting_id AND t.is_current AND s.speaker_label = sp.label)
          ORDER BY ${MEETING_DATE('m')} DESC, sp.label LIMIT 500`,
        [scope.workspaceId, scope.userId, ids],
      )
    : [];
  const unlinkedParticipants = ids.length
    ? await rows<any>(
        db,
        `SELECT pa.id, pa.display_name, pa.email, pa.meeting_id, m.title AS meeting_title FROM participants pa JOIN meetings m ON m.id = pa.meeting_id
          WHERE pa.meeting_id = ANY($3) AND pa.person_id IS NULL AND m.workspace_id = $1 AND ${meetingVisibleSql('m', '$2')}
          ORDER BY ${MEETING_DATE('m')} DESC, pa.display_name LIMIT 500`,
        [scope.workspaceId, scope.userId, ids],
      )
    : [];

  return {
    items,
    groups,
    counts,
    total: counts.decision + counts.action + counts.commitment + counts.question,
    nextCursor,
    contradictions,
    unmappedSpeakers: unmappedSpeakers.map((s) => ({ id: s.id, speakerId: s.id, label: s.label, suggestion: s.suggestion ?? null, meetingId: s.meeting_id, meetingTitle: s.meeting_title })),
    unlinkedParticipants: unlinkedParticipants.map((p) => ({
      id: p.id,
      participantId: p.id,
      displayName: p.display_name,
      email: p.email ?? null,
      meetingId: p.meeting_id,
      meetingTitle: p.meeting_title,
    })),
  };
}
