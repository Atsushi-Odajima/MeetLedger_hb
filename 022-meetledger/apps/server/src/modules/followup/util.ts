// Shared helpers for the followup module: time zones, ledger item loading (ACL-filtered), DTO mapping.
import { dateInTz, defaultTemplateFor, findBuiltinTemplate, minutesInTz, type MeetingTemplate } from '@meetledger/shared';
import type { WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { iso } from '../../lib/http';
import { itemVisibleSql } from '../../rbac/access';

export type Locale = 'ja' | 'en';
export const asLocale = (s: string | null | undefined): Locale => (s === 'en' ? 'en' : 'ja');

/** SQL expression for "when the meeting happened / will happen". */
export const meetingTimeSql = (a: string) => `coalesce(${a}.scheduled_start, ${a}.started_at, ${a}.created_at)`;

export function safeTz(tz: string | null | undefined, fallback = 'Asia/Tokyo'): string {
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

/** Offset (ms) of `tz` at instant `d`: local wall clock - UTC. */
export function tzOffsetMs(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const local = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return local - Math.floor(d.getTime() / 1000) * 1000;
}

/** UTC instant for local date `YYYY-MM-DD` at `minutes` after local midnight in `tz`. */
export function zonedTime(date: string, minutes: number, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  const off2 = tzOffsetMs(new Date(t), tz);
  t = guess - off2;
  return new Date(t);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** ISO-8601 week key (e.g. 2026-W40) of a local date. */
export function isoWeekKey(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function localClock(d: Date, tz: string): string {
  return hhmm(minutesInTz(d, tz));
}

export function todayFor(ctx: Pick<WsCtx, 'deps' | 'user'>): string {
  return dateInTz(ctx.deps.clock.now(), safeTz(ctx.user.timezone));
}

/** Template for a meeting: built-in, else workspace custom template (templates table), else default for the type. */
export async function resolveTemplate(db: Db, workspaceId: string, key: string | null, meetingType: string): Promise<MeetingTemplate> {
  const builtin = findBuiltinTemplate(key);
  if (builtin) return builtin;
  const base = defaultTemplateFor((meetingType as any) ?? 'other');
  if (key) {
    const t = await one<any>(db, 'SELECT key, name, meeting_type, definition FROM templates WHERE workspace_id=$1 AND key=$2', [workspaceId, key]);
    if (t) return mergeTemplate(base, { ...(t.definition ?? {}), key: t.key, name: t.name, meetingType: t.meeting_type });
  }
  return base;
}

export function mergeTemplate(base: MeetingTemplate, over: Partial<MeetingTemplate>): MeetingTemplate {
  return {
    ...base,
    ...over,
    extractionRules: { ...base.extractionRules, ...(over.extractionRules ?? {}) },
    followupStyle: { ...base.followupStyle, ...(over.followupStyle ?? {}) },
    agenda: over.agenda ?? base.agenda,
    summarySections: over.summarySections ?? base.summarySections,
  };
}

// ----------------------------------------------------------------------------------------------- ledger item loading

export interface SourceInfo {
  meetingId: string | null;
  meetingTitle: string | null;
  meetingDate: string | null;
}

export interface MemDecision {
  type: 'decision';
  id: string;
  text: string;
  topic: string | null;
  reason: string | null;
  status: string;
  decidedAt: string | null;
  confirmedAt: string | null;
  supersedesDecisionId: string | null;
  source: SourceInfo;
}
export interface MemAction {
  type: 'action';
  id: string;
  description: string;
  assigneeName: string | null;
  assigneePersonId: string | null;
  assigneeUserId: string | null;
  mine: boolean;
  dueDate: string | null;
  status: string;
  overdue: boolean;
  confirmedAt: string | null;
  source: SourceInfo;
}
export interface MemCommitment {
  type: 'commitment';
  id: string;
  description: string;
  promisedByName: string | null;
  promisedByPersonId: string | null;
  promisedToName: string | null;
  promisedToPersonId: string | null;
  direction: 'mine' | 'theirs' | 'other';
  dueDate: string | null;
  status: string;
  overdue: boolean;
  source: SourceInfo;
}
export interface MemQuestion {
  type: 'question';
  id: string;
  question: string;
  ownerName: string | null;
  ownerPersonId: string | null;
  dueDate: string | null;
  status: string;
  source: SourceInfo;
}
export interface MemChange {
  changedAt: string | null;
  previous: { id: string; text: string; source: SourceInfo };
  current: { id: string; text: string; source: SourceInfo } | null;
}

const src = (r: any): SourceInfo => ({ meetingId: r.meeting_id ?? null, meetingTitle: r.src_title ?? null, meetingDate: iso(r.src_date) });

/**
 * Item scope. Every loader adds `workspace_id = $1` and `itemVisibleSql(alias, $2)` (ACL), then ANDs `ands` and ORs `ors`.
 * Fragments are FIXED SQL using `{a}` for the table alias; values always go through `p()` (parameterized).
 * Loaders clone the scope so their own params never leak into other queries (pg rejects unreferenced params).
 */
export class Scope {
  ors: string[] = [];
  ands: string[] = [];
  params: unknown[];
  constructor(workspaceId: string, userId: string) {
    this.params = [workspaceId, userId];
  }
  p(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  clone(): Scope {
    const c = new Scope('', '');
    c.params = [...this.params];
    c.ors = [...this.ors];
    c.ands = [...this.ands];
    return c;
  }
}

export function newScope(workspaceId: string, userId: string): Scope {
  return new Scope(workspaceId, userId);
}

function whereFor(alias: string, s: Scope): string {
  const parts = [`${alias}.workspace_id = $1`, itemVisibleSql(alias, '$2'), ...s.ands.map((x) => x.replaceAll('{a}', alias))];
  if (s.ors.length) parts.push(`(${s.ors.map((x) => x.replaceAll('{a}', alias)).join(' OR ')})`);
  return parts.join(' AND ');
}

/** Decisions: `view` current = confirmed & active & not superseded. */
export async function loadDecisions(db: Db, s0: Scope, opts: { view: 'current' | 'confirmed_all'; limit: number; extra?: (alias: string) => string }): Promise<MemDecision[]> {
  const s = s0.clone();
  const cond =
    opts.view === 'current'
      ? `d.review_state = 'confirmed' AND d.status = 'active' AND d.superseded_by_decision_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM decisions sd WHERE sd.supersedes_decision_id = d.id AND sd.review_state = 'confirmed' AND sd.status = 'active')`
      : `d.review_state = 'confirmed'`;
  const list = await rows(
    db,
    `SELECT d.*, sm.title AS src_title, ${meetingTimeSql('sm')} AS src_date
       FROM decisions d LEFT JOIN meetings sm ON sm.id = d.meeting_id
      WHERE ${whereFor('d', s)} AND ${cond} ${opts.extra ? 'AND ' + opts.extra('d') : ''}
      ORDER BY coalesce(d.decided_at, d.confirmed_at, ${meetingTimeSql('sm')}, d.created_at) DESC
      LIMIT ${Math.max(1, Math.min(500, opts.limit | 0))}`,
    s.params,
  );
  return list.map((r) => ({
    type: 'decision',
    id: r.id,
    text: r.text,
    topic: r.topic,
    reason: r.reason,
    status: r.status,
    decidedAt: iso(r.decided_at),
    confirmedAt: iso(r.confirmed_at),
    supersedesDecisionId: r.supersedes_decision_id,
    source: src(r),
  }));
}

export async function loadActions(
  db: Db,
  s0: Scope,
  opts: { statuses: string[]; today: string; limit: number; extra?: (alias: string) => string },
): Promise<MemAction[]> {
  const s = s0.clone();
  const st = s.p(opts.statuses);
  const me = '$2';
  const list = await rows(
    db,
    `SELECT a.*, sm.title AS src_title, ${meetingTimeSql('sm')} AS src_date,
            coalesce(ap.name, au.name, a.assignee_text) AS assignee_name,
            (a.assignee_user_id = ${me} OR ap.user_id = ${me}) AS mine
       FROM actions a
       LEFT JOIN meetings sm ON sm.id = a.meeting_id
       LEFT JOIN people ap ON ap.id = a.assignee_person_id
       LEFT JOIN users au ON au.id = a.assignee_user_id
      WHERE ${whereFor('a', s)} AND a.status = ANY(${st}) ${opts.extra ? 'AND ' + opts.extra('a') : ''}
      ORDER BY a.due_date ASC NULLS LAST, a.created_at DESC
      LIMIT ${Math.max(1, Math.min(500, opts.limit | 0))}`,
    s.params,
  );
  return list.map((r) => ({
    type: 'action',
    id: r.id,
    description: r.description,
    assigneeName: r.assignee_name ?? null,
    assigneePersonId: r.assignee_person_id,
    assigneeUserId: r.assignee_user_id,
    mine: r.mine === true,
    dueDate: r.due_date,
    status: r.status,
    overdue: !!r.due_date && r.due_date < opts.today && ['confirmed', 'in_progress'].includes(r.status),
    confirmedAt: iso(r.confirmed_at),
    source: src(r),
  }));
}

/** Direction relative to the current user ($2): mine = promised by me; theirs = promised to me / us (internal) or by an external person. */
export const commitmentDirectionSql = (c: string, pb: string, pt: string, me = '$2') => `CASE
  WHEN ${c}.promised_by_user_id = ${me} OR ${pb}.user_id = ${me} THEN 'mine'
  WHEN ${c}.promised_to_user_id IS NOT NULL OR ${pt}.user_id IS NOT NULL
    OR (${c}.promised_by_user_id IS NULL AND ${pb}.id IS NOT NULL AND ${pb}.user_id IS NULL) THEN 'theirs'
  ELSE 'other' END`;

export async function loadCommitments(
  db: Db,
  s0: Scope,
  opts: { statuses: string[]; today: string; limit: number; extra?: (alias: string) => string },
): Promise<MemCommitment[]> {
  const s = s0.clone();
  const st = s.p(opts.statuses);
  const list = await rows(
    db,
    `SELECT c.*, sm.title AS src_title, ${meetingTimeSql('sm')} AS src_date,
            coalesce(pb.name, pbu.name, c.promised_by_text) AS by_name,
            coalesce(pt.name, ptu.name, c.promised_to_text) AS to_name,
            ${commitmentDirectionSql('c', 'pb', 'pt')} AS direction
       FROM commitments c
       LEFT JOIN meetings sm ON sm.id = c.meeting_id
       LEFT JOIN people pb ON pb.id = c.promised_by_person_id
       LEFT JOIN users pbu ON pbu.id = c.promised_by_user_id
       LEFT JOIN people pt ON pt.id = c.promised_to_person_id
       LEFT JOIN users ptu ON ptu.id = c.promised_to_user_id
      WHERE ${whereFor('c', s)} AND c.status = ANY(${st}) ${opts.extra ? 'AND ' + opts.extra('c') : ''}
      ORDER BY c.due_date ASC NULLS LAST, c.created_at DESC
      LIMIT ${Math.max(1, Math.min(500, opts.limit | 0))}`,
    s.params,
  );
  return list.map((r) => ({
    type: 'commitment',
    id: r.id,
    description: r.description,
    promisedByName: r.by_name ?? null,
    promisedByPersonId: r.promised_by_person_id,
    promisedToName: r.to_name ?? null,
    promisedToPersonId: r.promised_to_person_id,
    direction: r.direction,
    dueDate: r.due_date,
    status: r.status,
    overdue: !!r.due_date && r.due_date < opts.today && r.status === 'open',
    source: src(r),
  }));
}

export async function loadQuestions(db: Db, s0: Scope, opts: { statuses: string[]; limit: number; extra?: (alias: string) => string }): Promise<MemQuestion[]> {
  const s = s0.clone();
  const st = s.p(opts.statuses);
  const list = await rows(
    db,
    `SELECT q.*, sm.title AS src_title, ${meetingTimeSql('sm')} AS src_date, op.name AS owner_name
       FROM open_questions q
       LEFT JOIN meetings sm ON sm.id = q.meeting_id
       LEFT JOIN people op ON op.id = q.owner_person_id
      WHERE ${whereFor('q', s)} AND q.status = ANY(${st}) ${opts.extra ? 'AND ' + opts.extra('q') : ''}
      ORDER BY q.created_at DESC
      LIMIT ${Math.max(1, Math.min(500, opts.limit | 0))}`,
    s.params,
  );
  return list.map((r) => ({
    type: 'question',
    id: r.id,
    question: r.question,
    ownerName: r.owner_name ?? null,
    ownerPersonId: r.owner_person_id,
    dueDate: r.due_date,
    status: r.status,
    source: src(r),
  }));
}

/** Superseded decisions (old → new) within the scope; both sides must be visible. */
export async function loadChanges(db: Db, s0: Scope, opts: { sinceIso?: string | null; limit: number }): Promise<MemChange[]> {
  const s = s0.clone();
  const since = opts.sinceIso ? s.p(opts.sinceIso) : null;
  const list = await rows(
    db,
    `SELECT d.id, d.text, d.meeting_id, d.updated_at, sm.title AS src_title, ${meetingTimeSql('sm')} AS src_date,
            nd.id AS new_id, nd.text AS new_text, nd.meeting_id AS new_meeting_id, nm.title AS new_title, ${meetingTimeSql('nm')} AS new_date,
            coalesce(nd.confirmed_at, nd.created_at, d.updated_at) AS changed_at
       FROM decisions d
       LEFT JOIN meetings sm ON sm.id = d.meeting_id
       LEFT JOIN LATERAL (
         SELECT x.* FROM decisions x
          WHERE (x.id = d.superseded_by_decision_id OR x.supersedes_decision_id = d.id) AND x.review_state = 'confirmed'
            AND ${itemVisibleSql('x', '$2')}
          ORDER BY (x.id = d.superseded_by_decision_id) DESC, x.created_at DESC LIMIT 1) nd ON true
       LEFT JOIN meetings nm ON nm.id = nd.meeting_id
      WHERE ${whereFor('d', s)} AND d.review_state = 'confirmed' AND d.status = 'superseded'
        ${since ? `AND coalesce(nd.confirmed_at, nd.created_at, d.updated_at) >= ${since}` : ''}
      ORDER BY changed_at DESC
      LIMIT ${Math.max(1, Math.min(200, opts.limit | 0))}`,
    s.params,
  );
  return list.map((r) => ({
    changedAt: iso(r.changed_at),
    previous: { id: r.id, text: r.text, source: src(r) },
    current: r.new_id
      ? { id: r.new_id, text: r.new_text, source: { meetingId: r.new_meeting_id, meetingTitle: r.new_title ?? null, meetingDate: iso(r.new_date) } }
      : null,
  }));
}

export function meetingBrief(m: any) {
  return {
    id: m.id,
    title: m.title,
    scheduledStart: iso(m.scheduled_start),
    scheduledEnd: iso(m.scheduled_end),
    date: iso(m.scheduled_start ?? m.started_at ?? m.created_at),
    meetingType: m.meeting_type,
    status: m.status,
    visibility: m.visibility,
    projectId: m.project_id,
    seriesId: m.series_id,
  };
}

/** Person ids of the current user in this workspace. */
export async function myPersonIds(db: Db, workspaceId: string, userId: string): Promise<string[]> {
  return (await rows<{ id: string }>(db, 'SELECT id FROM people WHERE workspace_id=$1 AND user_id=$2 AND deleted_at IS NULL', [workspaceId, userId])).map((r) => r.id);
}
