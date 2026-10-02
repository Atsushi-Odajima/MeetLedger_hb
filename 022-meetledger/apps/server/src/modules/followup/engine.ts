// Notification engine (job `followup.tick`, org-less system job enqueued by the scheduler).
// Iterates organizations in system context, then does all tenant work inside tenantTx(org).
// Guarantees: dedupe (UNIQUE(user_id, dedupe_key)), quiet hours in the user's time zone, storm control (max_per_hour,
// excess merged into ONE digest), neutral wording (no blame / guilt), e-mail copy only when the user enabled it.
import { dateInTz, minutesInTz } from '@meetledger/shared';
import type { Deps } from '../../context';
import { rows, withSystem, type Db } from '../../db/pool';
import { safeErrorMessage } from '../../lib/logger';
import { meetingVisibleSql, tenantTx } from '../../rbac/access';
import type { EmailMessage } from '../notifications/email';
import { addDays, asLocale, isoWeekKey, localClock, safeTz, zonedTime, type Locale } from './util';

export interface NotifyUser {
  id: string;
  email: string;
  locale: Locale;
  tz: string;
  quietStartMin: number;
  quietEndMin: number;
  emailEnabled: boolean;
  maxPerHour: number;
  briefLeadMin: number;
}

export function inQuietHours(minutes: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false;
  return quietStart < quietEnd ? minutes >= quietStart && minutes < quietEnd : minutes >= quietStart || minutes < quietEnd;
}

/** Moves `at` to the end of the user's quiet hours (local time) when it falls inside them. */
export function applyQuietHours(at: Date, u: Pick<NotifyUser, 'tz' | 'quietStartMin' | 'quietEndMin'>): Date {
  const m = minutesInTz(at, u.tz);
  if (!inQuietHours(m, u.quietStartMin, u.quietEndMin)) return at;
  const delta = (u.quietEndMin - m + 1440) % 1440;
  const t = new Date(at.getTime() + delta * 60_000);
  t.setUTCSeconds(0, 0);
  return t;
}

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Fixed, neutral wording (no blame, no urgency pressure). */
const TEXT = {
  needs_review: (l: Locale, x: { title: string; count: number }) =>
    l === 'ja'
      ? { title: `確認待ちの候補があります：${clip(x.title)}`, body: x.count > 0 ? `決定・Action・約束などの候補が${x.count}件あります。内容を確認して確定できます。` : '議事内容を確認できます。' }
      : { title: `Ready for review: ${clip(x.title)}`, body: x.count > 0 ? `${x.count} candidate items (decisions, actions, commitments) are ready for your review.` : 'The meeting is ready for review.' },
  action_t1: (l: Locale, x: { desc: string; meeting: string | null; due: string | null }) =>
    l === 'ja'
      ? { title: `Actionの確認：${clip(x.desc)}`, body: `${x.meeting ? `「${clip(x.meeting, 60)}」で確定したActionです。` : '確定したActionです。'}${x.due ? `期限は${x.due}です。` : '期限は未設定です。'}` }
      : { title: `Action reminder: ${clip(x.desc)}`, body: `${x.meeting ? `Confirmed in "${clip(x.meeting, 60)}". ` : ''}${x.due ? `Due ${x.due}.` : 'No due date set.'}` },
  action_due: (l: Locale, x: { desc: string; meeting: string | null }) =>
    l === 'ja'
      ? { title: `本日が期限のAction：${clip(x.desc)}`, body: `${x.meeting ? `「${clip(x.meeting, 60)}」のActionです。` : ''}状況に合わせて完了・期限変更ができます。` }
      : { title: `Due today: ${clip(x.desc)}`, body: `${x.meeting ? `From "${clip(x.meeting, 60)}". ` : ''}You can mark it done or change the due date.` },
  commitment_due: (l: Locale, x: { desc: string; to: string | null; meeting: string | null }) =>
    l === 'ja'
      ? { title: `本日が期限の約束：${clip(x.desc)}`, body: `${x.to ? `${x.to} への約束です。` : ''}${x.meeting ? `「${clip(x.meeting, 60)}」で確認されました。` : ''}` }
      : { title: `Commitment due today: ${clip(x.desc)}`, body: `${x.to ? `Promised to ${x.to}. ` : ''}${x.meeting ? `From "${clip(x.meeting, 60)}".` : ''}` },
  overdue_digest: (l: Locale, items: { desc: string; due: string }[], total: number, capped: boolean) => {
    const shown = items.slice(0, 10);
    const lines = shown.map((i) => (l === 'ja' ? `・${clip(i.desc, 60)}（期限 ${i.due}）` : `- ${clip(i.desc, 60)} (due ${i.due})`));
    const rest = total - shown.length;
    const n = capped ? (l === 'ja' ? `${total}件以上` : `${total}+`) : l === 'ja' ? `${total}件` : `${total}`;
    const more = rest > 0 ? (l === 'ja' ? `ほか ${capped ? `${rest}件以上` : `${rest}件`}` : `and ${rest}${capped ? '+' : ''} more`) : null;
    return l === 'ja'
      ? { title: `期限が過ぎています（${n}）`, body: [...lines, ...(more ? [more] : []), '', '状況が変わった項目は、完了・期限変更・取り消しで整理できます。'].join('\n') }
      : { title: `Past due date (${n})`, body: [...lines, ...(more ? [more] : []), '', 'Items whose situation changed can be marked done, rescheduled or cancelled.'].join('\n') };
  },
  upcoming_brief: (l: Locale, x: { title: string; at: string }) =>
    l === 'ja'
      ? { title: `まもなく開始：${clip(x.title)}（${x.at}）`, body: '事前Briefで前回からの未完了事項などを確認できます。' }
      : { title: `Starting soon: ${clip(x.title)} (${x.at})`, body: 'The pre-meeting brief shows open items from earlier meetings.' },
  next_meeting: (l: Locale, x: { series: string }) =>
    l === 'ja'
      ? { title: `次回の予定が未登録です：${clip(x.series)}`, body: 'シリーズの次回Meetingを作成すると、未完了のActionや質問が事前Briefとアジェンダ候補に引き継がれます。' }
      : { title: `No next meeting scheduled: ${clip(x.series)}`, body: 'Creating the next meeting in this series carries open actions and questions into its brief and agenda.' },
  digest: (l: Locale, titles: string[]) =>
    l === 'ja'
      ? { title: `通知${titles.length}件をまとめました`, body: titles.map((t) => `・${t}`).join('\n') }
      : { title: `${titles.length} notifications bundled`, body: titles.map((t) => `- ${t}`).join('\n') },
};

/** Lower = more important (delivered individually first when storm control kicks in). */
const PRIORITY: Record<string, number> = { upcoming_brief: 0, action_due: 1, commitment_due: 1, needs_review: 2, action_t1: 3, next_meeting: 4, overdue_digest: 5 };

export async function loadOrgUsers(db: Db, orgId: string): Promise<Map<string, NotifyUser>> {
  const list = await rows(
    db,
    `SELECT u.id, u.email, u.locale, u.timezone AS user_tz, up.timezone AS pref_tz, up.timezone_set,
            up.quiet_start_min, up.quiet_end_min, up.email_enabled, up.max_per_hour, up.brief_lead_min
       FROM org_members om JOIN users u ON u.id = om.user_id
       LEFT JOIN user_prefs up ON up.user_id = u.id AND up.org_id = om.org_id
      WHERE om.org_id = $1 AND u.disabled_at IS NULL`,
    [orgId],
  );
  return new Map(
    list.map((r) => [
      r.id,
      {
        id: r.id,
        email: r.email,
        locale: asLocale(r.locale),
        tz: safeTz(r.timezone_set ? r.pref_tz : r.user_tz),
        quietStartMin: r.quiet_start_min ?? 1320,
        quietEndMin: r.quiet_end_min ?? 480,
        emailEnabled: r.email_enabled === true,
        maxPerHour: Math.max(1, r.max_per_hour ?? 6),
        briefLeadMin: r.brief_lead_min ?? 60,
      },
    ]),
  );
}

interface NewNotification {
  workspaceId: string | null;
  kind: string;
  entityType: string | null;
  entityId: string | null;
  dedupeKey: string;
  title: string;
  body: string;
  link: string | null;
  scheduledFor: Date;
  status?: 'pending' | 'suppressed';
}

/** Batched insert (unnest): ON CONFLICT (user_id, dedupe_key) DO NOTHING ⇒ re-running never duplicates. Returns rows created. */
async function insertNotifications(db: Db, orgId: string, list: (NewNotification & { userId: string })[], now: Date): Promise<number> {
  let created = 0;
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const col = <T>(f: (n: NewNotification & { userId: string }) => T) => chunk.map(f);
    const r = await db.query(
      `INSERT INTO notifications(org_id, workspace_id, user_id, kind, entity_type, entity_id, dedupe_key, title, body, link, scheduled_for, status, created_at)
       SELECT $1, w, u, k, et, ei, dk, t, b, l, sf, st, $2
         FROM unnest($3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::uuid[], $8::text[], $9::text[], $10::text[], $11::text[], $12::timestamptz[], $13::text[])
              AS x(w, u, k, et, ei, dk, t, b, l, sf, st)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
      [
        orgId,
        now,
        col((n) => n.workspaceId),
        col((n) => n.userId),
        col((n) => n.kind),
        col((n) => n.entityType),
        col((n) => n.entityId),
        col((n) => n.dedupeKey),
        col((n) => n.title),
        col((n) => n.body),
        col((n) => n.link),
        col((n) => n.scheduledFor),
        col((n) => n.status ?? 'pending'),
      ],
    );
    created += r.rowCount ?? 0;
  }
  return created;
}

/** Overdue digests are created in the user's morning (quiet end + 3h), at most once per local ISO week. */
const MORNING_WINDOW_MIN = 180;
/** Overdue counts in the digest stop here ("1000件以上"). */
export const OVERDUE_COUNT_CAP = 1000;

/**
 * Creates due notifications for one organization. Idempotent (dedupe keys) and bounded at spec §40 scale:
 * every candidate query is an index range (due-date window, recent confirmations, upcoming meetings, recent meetings);
 * overdue items are never iterated — each user's weekly digest is one top-10 query + one capped count.
 */
export async function generateNotifications(db: Db, orgId: string, users: Map<string, NotifyUser>, now: Date): Promise<number> {
  const out: (NewNotification & { userId: string })[] = [];
  const add = (userId: string, n: NewNotification) => out.push({ ...n, userId });
  const wsIds = (await rows<{ id: string }>(db, 'SELECT id FROM workspaces WHERE org_id = $1 AND deleted_at IS NULL', [orgId])).map((r) => r.id);
  if (!wsIds.length || !users.size) return 0;
  // per-user local date / clock, computed once (Intl formatting is expensive)
  const local = new Map<string, { today: string; minutes: number }>();
  for (const u of users.values()) local.set(u.id, { today: dateInTz(now, u.tz), minutes: minutesInTz(now, u.tz) });
  // Recipient must (still) be a member of a live workspace of this org.
  const wsMember = (wsCol: string, userCol: string) => `EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = ${wsCol} AND wm.user_id = ${userCol})`;
  const utcToday = now.toISOString().slice(0, 10);

  // 1) needs_review (T+0) → meeting owner. Recent meetings via meetings_ws_start; candidate counts grouped.
  const recent = await rows(
    db,
    `SELECT m.id, m.workspace_id, m.title, m.status, m.created_by AS user_id FROM meetings m
      WHERE m.workspace_id = ANY($1::uuid[]) AND m.deleted_at IS NULL AND m.status IN ('needs_review', 'ready')
        AND (m.scheduled_start >= $2::timestamptz - interval '15 days' OR (m.scheduled_start IS NULL AND m.created_at >= $2::timestamptz - interval '15 days'))
        AND coalesce(m.ended_at, m.scheduled_end, m.scheduled_start, m.created_at) >= $2::timestamptz - interval '14 days'
        AND ${wsMember('m.workspace_id', 'm.created_by')}`,
    [wsIds, now],
  );
  if (recent.length) {
    const ids = recent.map((r) => r.id);
    const cand = new Map<string, number>();
    for (const [table, cond] of [
      ['decisions', "review_state = 'candidate'"],
      ['actions', "status = 'candidate'"],
      ['commitments', "status = 'candidate'"],
      ['open_questions', "status = 'candidate'"],
    ] as const)
      for (const r of await rows<{ meeting_id: string; n: number }>(db, `SELECT meeting_id, count(*)::int AS n FROM ${table} WHERE meeting_id = ANY($1::uuid[]) AND ${cond} GROUP BY 1`, [ids]))
        cand.set(r.meeting_id, (cand.get(r.meeting_id) ?? 0) + r.n);
    for (const r of recent) {
      const u = users.get(r.user_id);
      const n = cand.get(r.id) ?? 0;
      if (!u || (r.status !== 'needs_review' && n === 0)) continue;
      add(u.id, {
        workspaceId: r.workspace_id,
        kind: 'needs_review',
        entityType: 'meeting',
        entityId: r.id,
        dedupeKey: `needs_review:${r.id}`,
        ...TEXT.needs_review(u.locale, { title: r.title, count: n }),
        link: `/w/${r.workspace_id}/meetings/${r.id}/review`,
        scheduledFor: applyQuietHours(now, u),
      });
    }
  }

  // 2) actions: due today (user tz) and T+1 after confirmation — two index ranges (due window / recent confirmations)
  const actionSql = (cond: string) => `
    SELECT a.id, a.workspace_id, a.description, a.due_date, a.confirmed_at, m.title AS meeting_title, r.user_id
      FROM actions a
      LEFT JOIN people ap ON ap.id = a.assignee_person_id
      LEFT JOIN meetings m ON m.id = a.meeting_id
      CROSS JOIN LATERAL (SELECT coalesce(a.assignee_user_id, ap.user_id) AS user_id) r
     WHERE a.workspace_id = ANY($1::uuid[]) AND a.status IN ('confirmed', 'in_progress') AND r.user_id IS NOT NULL AND ${cond}
       AND ${wsMember('a.workspace_id', 'r.user_id')}
       AND (a.meeting_id IS NULL OR ${meetingVisibleSql('m', 'r.user_id')})`;
  const dueActions = await rows(db, actionSql(`a.due_date BETWEEN $2::date - 1 AND $2::date + 1`), [wsIds, utcToday]);
  const t1Actions = await rows(db, actionSql(`a.confirmed_at >= $2::timestamptz - interval '4 days' AND a.confirmed_at <= $2::timestamptz`), [wsIds, now]);
  const seen = new Set<string>();
  for (const a of [...dueActions, ...t1Actions]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const u = users.get(a.user_id);
    if (!u) continue;
    const { today } = local.get(u.id)!;
    if (a.due_date && a.due_date < today) continue; // overdue → weekly digest
    if (a.due_date === today) {
      const morning = zonedTime(today, u.quietEndMin, u.tz);
      add(u.id, {
        workspaceId: a.workspace_id,
        kind: 'action_due',
        entityType: 'action',
        entityId: a.id,
        dedupeKey: `action_due:${a.id}:${a.due_date}`,
        ...TEXT.action_due(u.locale, { desc: a.description, meeting: a.meeting_title }),
        link: `/w/${a.workspace_id}/actions?assignee=me`,
        scheduledFor: applyQuietHours(morning > now ? morning : now, u),
      });
      continue;
    }
    if (a.confirmed_at) {
      const confirmedDay = dateInTz(new Date(a.confirmed_at), u.tz);
      if (today > confirmedDay && today <= addDays(confirmedDay, 2)) {
        add(u.id, {
          workspaceId: a.workspace_id,
          kind: 'action_t1',
          entityType: 'action',
          entityId: a.id,
          dedupeKey: `action_t1:${a.id}`,
          ...TEXT.action_t1(u.locale, { desc: a.description, meeting: a.meeting_title, due: a.due_date }),
          link: `/w/${a.workspace_id}/actions?assignee=me`,
          scheduledFor: applyQuietHours(now, u),
        });
      }
    }
  }

  // 3) my commitments due today (due window via commitments_ws_due)
  const dueCommitments = await rows(
    db,
    `SELECT c.id, c.workspace_id, c.description, c.due_date, m.title AS meeting_title, r.user_id,
            coalesce(pt.name, ptu.name, c.promised_to_text) AS to_name
       FROM commitments c
       LEFT JOIN people pb ON pb.id = c.promised_by_person_id
       LEFT JOIN people pt ON pt.id = c.promised_to_person_id
       LEFT JOIN users ptu ON ptu.id = c.promised_to_user_id
       LEFT JOIN meetings m ON m.id = c.meeting_id
       CROSS JOIN LATERAL (SELECT coalesce(c.promised_by_user_id, pb.user_id) AS user_id) r
      WHERE c.workspace_id = ANY($1::uuid[]) AND c.status = 'open' AND r.user_id IS NOT NULL
        AND c.due_date BETWEEN $2::date - 1 AND $2::date + 1
        AND ${wsMember('c.workspace_id', 'r.user_id')}
        AND (c.meeting_id IS NULL OR ${meetingVisibleSql('m', 'r.user_id')})`,
    [wsIds, utcToday],
  );
  for (const c of dueCommitments) {
    const u = users.get(c.user_id);
    if (!u || c.due_date !== local.get(u.id)!.today) continue;
    const morning = zonedTime(c.due_date, u.quietEndMin, u.tz);
    add(u.id, {
      workspaceId: c.workspace_id,
      kind: 'commitment_due',
      entityType: 'commitment',
      entityId: c.id,
      dedupeKey: `commitment_due:${c.id}:${c.due_date}`,
      ...TEXT.commitment_due(u.locale, { desc: c.description, to: c.to_name, meeting: c.meeting_title }),
      link: `/w/${c.workspace_id}/commitments?direction=mine`,
      scheduledFor: applyQuietHours(morning > now ? morning : now, u),
    });
  }

  // 4) overdue digest: once per local ISO week, in the user's morning; bounded per user (top 10 + capped count)
  const due: { u: NotifyUser; key: string; today: string }[] = [];
  for (const u of users.values()) {
    const { today, minutes } = local.get(u.id)!;
    const start = u.quietStartMin === u.quietEndMin ? 480 : u.quietEndMin;
    if (inQuietHours(minutes, u.quietStartMin, u.quietEndMin) || (minutes - start + 1440) % 1440 >= MORNING_WINDOW_MIN) continue;
    due.push({ u, key: `overdue_digest:${orgId}:${isoWeekKey(today)}`, today });
  }
  if (due.length) {
    const have = new Set(
      (
        await rows<{ user_id: string }>(db, 'SELECT user_id FROM notifications WHERE user_id = ANY($1::uuid[]) AND dedupe_key = ANY($2::text[])', [
          due.map((d) => d.u.id),
          [...new Set(due.map((d) => d.key))],
        ])
      ).map((r) => r.user_id),
    );
    for (const d of due) {
      if (have.has(d.u.id)) continue;
      const digest = await overdueFor(db, d.u, d.today);
      if (!digest.total) continue;
      add(d.u.id, {
        workspaceId: digest.wsIds.length === 1 ? digest.wsIds[0] : null,
        kind: 'overdue_digest',
        entityType: null,
        entityId: null,
        dedupeKey: d.key,
        ...TEXT.overdue_digest(d.u.locale, digest.items, digest.total, digest.capped),
        link: digest.wsIds.length === 1 ? `/w/${digest.wsIds[0]}/dashboard` : '/notifications',
        scheduledFor: now,
      });
    }
  }

  // 5) upcoming_brief: brief_lead_min before meetings the user takes part in (and can see) — meetings_ws_start range
  const upcoming = await rows(
    db,
    `SELECT DISTINCT m.id, m.workspace_id, m.title, m.scheduled_start, x.user_id
       FROM meetings m
       CROSS JOIN LATERAL (
         SELECT m.created_by AS user_id
         UNION SELECT p.user_id FROM participants p WHERE p.meeting_id = m.id AND p.user_id IS NOT NULL
         UNION SELECT pe.user_id FROM participants p JOIN people pe ON pe.id = p.person_id WHERE p.meeting_id = m.id AND pe.user_id IS NOT NULL
       ) x
      WHERE m.workspace_id = ANY($1::uuid[]) AND m.deleted_at IS NULL AND m.status = 'scheduled'
        AND m.scheduled_start > $2::timestamptz AND m.scheduled_start <= $2::timestamptz + interval '1440 minutes'
        AND ${wsMember('m.workspace_id', 'x.user_id')} AND ${meetingVisibleSql('m', 'x.user_id')}`,
    [wsIds, now],
  );
  for (const r of upcoming) {
    const u = users.get(r.user_id);
    if (!u || u.briefLeadMin <= 0) continue;
    const start = new Date(r.scheduled_start);
    if (now.getTime() < start.getTime() - u.briefLeadMin * 60_000) continue;
    const at = applyQuietHours(now, u);
    add(u.id, {
      workspaceId: r.workspace_id,
      kind: 'upcoming_brief',
      entityType: 'meeting',
      entityId: r.id,
      dedupeKey: `upcoming_brief:${r.id}:${start.toISOString()}`,
      ...TEXT.upcoming_brief(u.locale, { title: r.title, at: localClock(start, u.tz) }),
      link: `/w/${r.workspace_id}/meetings/${r.id}/brief`,
      scheduledFor: at,
      // Quiet hours would push it past the start: keep the dedupe record but do not deliver.
      status: at.getTime() >= start.getTime() ? 'suppressed' : 'pending',
    });
  }

  // 6) next_meeting: a series meeting ended recently and no next meeting exists in the series → owner
  const nexts = await rows(
    db,
    `SELECT m.id, m.workspace_id, m.created_by AS user_id, s.id AS series_id, s.title AS series_title
       FROM meetings m JOIN series s ON s.id = m.series_id
      WHERE m.workspace_id = ANY($1::uuid[]) AND m.deleted_at IS NULL
        AND (m.scheduled_start >= $2::timestamptz - interval '4 days' OR (m.scheduled_start IS NULL AND m.created_at >= $2::timestamptz - interval '4 days'))
        AND (m.ended_at IS NOT NULL OR m.status IN ('ready', 'needs_review', 'archived'))
        AND coalesce(m.ended_at, m.scheduled_end, m.scheduled_start) BETWEEN $2::timestamptz - interval '3 days' AND $2::timestamptz
        AND NOT EXISTS (SELECT 1 FROM meetings nm WHERE nm.series_id = m.series_id AND nm.id <> m.id AND nm.deleted_at IS NULL
                         AND coalesce(nm.scheduled_start, nm.created_at) > coalesce(m.scheduled_start, m.started_at, m.created_at))
        AND ${wsMember('m.workspace_id', 'm.created_by')}`,
    [wsIds, now],
  );
  for (const r of nexts) {
    const u = users.get(r.user_id);
    if (!u) continue;
    add(u.id, {
      workspaceId: r.workspace_id,
      kind: 'next_meeting',
      entityType: 'series',
      entityId: r.series_id,
      dedupeKey: `next_meeting:${r.id}`,
      ...TEXT.next_meeting(u.locale, { series: r.series_title }),
      link: `/w/${r.workspace_id}/series/${r.series_id}`,
      scheduledFor: applyQuietHours(now, u),
    });
  }
  return insertNotifications(db, orgId, out, now);
}

/** A user's overdue open actions (assigned to them) and commitments (promised by them): newest-due 10 + capped total. */
async function overdueFor(db: Db, u: NotifyUser, today: string) {
  const ws = (
    await rows<{ workspace_id: string }>(
      db,
      `SELECT wm.workspace_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id AND w.deleted_at IS NULL WHERE wm.user_id = $1`,
      [u.id],
    )
  ).map((r) => r.workspace_id);
  if (!ws.length) return { items: [], total: 0, capped: false, wsIds: [] as string[] };
  const persons = (await rows<{ id: string }>(db, 'SELECT id FROM people WHERE workspace_id = ANY($1::uuid[]) AND user_id = $2 AND deleted_at IS NULL', [ws, u.id])).map(
    (r) => r.id,
  );
  const vis = (alias: string) => `(${alias}.meeting_id IS NULL OR EXISTS (SELECT 1 FROM meetings vm WHERE vm.id = ${alias}.meeting_id AND ${meetingVisibleSql('vm', '$2')}))`;
  const who = (userCol: string, personCol: string) => (persons.length ? `(x.${userCol} = $2 OR x.${personCol} = ANY($4::uuid[]))` : `x.${userCol} = $2`);
  const parts = [
    `SELECT x.id, x.workspace_id, x.description, x.due_date FROM actions x
      WHERE x.workspace_id = ANY($1::uuid[]) AND ${who('assignee_user_id', 'assignee_person_id')} AND x.status IN ('confirmed', 'in_progress')
        AND x.due_date < $3::date AND ${vis('x')}`,
    `SELECT x.id, x.workspace_id, x.description, x.due_date FROM commitments x
      WHERE x.workspace_id = ANY($1::uuid[]) AND ${who('promised_by_user_id', 'promised_by_person_id')} AND x.status = 'open'
        AND x.due_date < $3::date AND ${vis('x')}`,
  ];
  const params = persons.length ? [ws, u.id, today, persons] : [ws, u.id, today];
  const top: any[] = [];
  let total = 0;
  for (const sql of parts) {
    top.push(...(await rows(db, `${sql} ORDER BY x.due_date DESC, x.id DESC LIMIT 10`, params)));
    total += (await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM (${sql} LIMIT ${OVERDUE_COUNT_CAP}) c`, params))[0].n;
  }
  top.sort((a, b) => (a.due_date < b.due_date ? 1 : a.due_date > b.due_date ? -1 : 0));
  const items = top.slice(0, 10).map((x) => ({ desc: x.description as string, due: x.due_date as string, ws: x.workspace_id as string }));
  return { items, total, capped: total >= OVERDUE_COUNT_CAP, wsIds: [...new Set(top.map((x) => x.workspace_id as string))] };
}

export interface DeliveryResult {
  delivered: number;
  digested: number;
  suppressed: number;
  emails: EmailMessage[];
}

/** Delivers due pending notifications with storm control. Returns e-mail copies to send after commit. */
export async function deliverNotifications(db: Db, orgId: string, users: Map<string, NotifyUser>, now: Date, appOrigin: string): Promise<DeliveryResult> {
  const res: DeliveryResult = { delivered: 0, digested: 0, suppressed: 0, emails: [] };
  // A brief reminder held back (quiet hours / storm control) past the meeting start is useless: suppress it.
  const exp = await db.query(
    `UPDATE notifications n SET status = 'suppressed' FROM meetings m
      WHERE n.org_id = $1 AND n.status = 'pending' AND n.kind = 'upcoming_brief' AND m.id = n.entity_id AND m.scheduled_start <= $2`,
    [orgId, now],
  );
  res.suppressed += exp.rowCount ?? 0;
  const pending = await rows(
    db,
    `SELECT * FROM notifications WHERE org_id = $1 AND status = 'pending' AND scheduled_for <= $2
      ORDER BY user_id, scheduled_for, created_at, id FOR UPDATE SKIP LOCKED`,
    [orgId, now],
  );
  const byUser = new Map<string, any[]>();
  for (const n of pending) byUser.set(n.user_id, [...(byUser.get(n.user_id) ?? []), n]);

  for (const [userId, list] of byUser) {
    const u = users.get(userId);
    if (!u) {
      // left the organization / disabled
      await db.query(`UPDATE notifications SET status = 'suppressed' WHERE id = ANY($1::uuid[])`, [list.map((n) => n.id)]);
      res.suppressed += list.length;
      continue;
    }
    const recent = await rows<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM notifications WHERE org_id = $1 AND user_id = $2 AND status = 'delivered' AND delivered_at > $3::timestamptz - interval '1 hour'`,
      [orgId, userId, now],
    );
    const allowance = u.maxPerHour - (recent[0]?.n ?? 0);
    if (allowance <= 0) continue; // stays pending; merged/delivered once the hourly window frees up
    list.sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9) || +new Date(a.scheduled_for) - +new Date(b.scheduled_for));
    const individual = list.length <= allowance ? list : list.slice(0, allowance - 1);
    const merged = list.length <= allowance ? [] : list.slice(allowance - 1);
    const out: { id: string; title: string; body: string; link: string | null }[] = [];
    if (individual.length) {
      await db.query(`UPDATE notifications SET status = 'delivered', delivered_at = $2 WHERE id = ANY($1::uuid[])`, [individual.map((n) => n.id), now]);
      res.delivered += individual.length;
      out.push(...individual);
    }
    if (merged.length) {
      const t = TEXT.digest(u.locale, merged.map((n) => n.title));
      const wsIds = [...new Set(merged.map((n) => n.workspace_id).filter(Boolean))];
      const d = await rows<{ id: string }>(
        db,
        `INSERT INTO notifications(org_id, workspace_id, user_id, kind, dedupe_key, title, body, link, scheduled_for, status, delivered_at, created_at)
         VALUES ($1,$2,$3,'digest',$4,$5,$6,'/notifications',$7,'delivered',$7,$7)
         ON CONFLICT (user_id, dedupe_key) DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key RETURNING id`,
        [orgId, wsIds.length === 1 ? wsIds[0] : null, userId, `digest:${merged[0].id}`, t.title, t.body, now],
      );
      await db.query(`UPDATE notifications SET status = 'digested', digest_id = $2 WHERE id = ANY($1::uuid[])`, [merged.map((n) => n.id), d[0].id]);
      res.delivered += 1;
      res.digested += merged.length;
      out.push({ id: d[0].id, ...t, link: '/notifications' });
    }
    if (u.emailEnabled && u.email) {
      for (const n of out) {
        res.emails.push({
          orgId,
          to: u.email,
          subject: `[MeetLedger] ${n.title}`,
          body: [
            n.body,
            ...(n.link ? [`${appOrigin}${n.link}`] : []),
            '',
            u.locale === 'ja' ? `通知設定: ${appOrigin}/settings/notifications` : `Notification settings: ${appOrigin}/settings/notifications`,
          ].join('\n'),
          dedupeKey: `notification:${n.id}`,
        });
      }
    }
  }
  return res;
}

export interface TickResult {
  orgs: number;
  created: number;
  delivered: number;
  digested: number;
  suppressed: number;
  emails: number;
  failedOrgs: number;
}

/** One engine pass over every (non-sample) organization. Safe to run repeatedly (dedupe + idempotent delivery). */
export async function runFollowupTick(deps: Deps, now: Date = deps.clock.now()): Promise<TickResult> {
  const orgs = await withSystem(deps.pool, (db) => rows<{ id: string }>(db, 'SELECT id FROM organizations WHERE is_sample = false ORDER BY created_at, id'));
  const res: TickResult = { orgs: orgs.length, created: 0, delivered: 0, digested: 0, suppressed: 0, emails: 0, failedOrgs: 0 };
  for (const org of orgs) {
    try {
      const d = await tenantTx(deps, org.id, async (db) => {
        const users = await loadOrgUsers(db, org.id);
        const created = await generateNotifications(db, org.id, users, now);
        const delivered = await deliverNotifications(db, org.id, users, now, deps.config.APP_ORIGIN);
        return { created, ...delivered };
      });
      res.created += d.created;
      res.delivered += d.delivered;
      res.digested += d.digested;
      res.suppressed += d.suppressed;
      // E-mail copies after the delivery state is committed; each in its own transaction (dedupeKey ⇒ never mailed twice).
      for (const msg of d.emails) {
        try {
          const r = await tenantTx(deps, org.id, (db) => deps.email.send(db, msg));
          if (!r.duplicate) res.emails++;
        } catch (e) {
          deps.log.error({ orgId: org.id, err: safeErrorMessage(e) }, 'notification email failed');
        }
      }
    } catch (e) {
      res.failedOrgs++;
      deps.log.error({ orgId: org.id, err: safeErrorMessage(e) }, 'followup.tick failed for org');
    }
  }
  return res;
}
