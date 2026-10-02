import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AUDIO_RETENTIONS, MEETING_STATUSES, MEETING_TYPES, VISIBILITIES, defaultTemplateFor, findBuiltinTemplate } from '@meetledger/shared';
import type { Deps, WsCtx } from '../../context';
import { one, rows, type Db } from '../../db/pool';
import { badRequest, conflict } from '../../lib/errors';
import { body, parse, query, wsIdParams, wsParams, zIso } from '../../lib/http';
import { loadMeeting, meetingVisibleSql, workspaceCtx } from '../../rbac/access';
import { audit } from '../../lib/audit';
import { decideAi, decideTranscription, wsSettings } from '../../privacy/policy';
import { meetingDto } from './mappers';
import { emitWebhookEvent } from '../connectors/webhooks';

const zParticipant = z.object({
  personId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional().nullable(),
  role: z.enum(['organizer', 'attendee', 'optional']).default('attendee'),
});
type ParticipantIn = z.infer<typeof zParticipant>;

const meetingFields = {
  title: z.string().trim().min(1).max(300),
  scheduledStart: zIso.nullable().optional(),
  scheduledEnd: zIso.nullable().optional(),
  meetingType: z.enum(MEETING_TYPES).optional(),
  projectId: z.string().uuid().nullable().optional(),
  seriesId: z.string().uuid().nullable().optional(),
  templateKey: z.string().max(64).nullable().optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  transcriptionMode: z.enum(['local', 'cloud', 'none']).optional(),
  aiEnabled: z.boolean().optional(),
  isConfidential: z.boolean().optional(),
  audioRetention: z.enum(AUDIO_RETENTIONS).optional(),
  audioRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  language: z.enum(['ja', 'en', 'auto']).nullable().optional(),
};

const createSchema = z.object({
  ...meetingFields,
  source: z.enum(['manual', 'calendar', 'upload', 'transcript_import', 'browser_capture', 'desktop_capture', 'mcp']).default('manual'),
  calendarEventId: z.string().max(300).nullable().optional(),
  participants: z.array(zParticipant).max(200).default([]),
  accessUserIds: z.array(z.string().uuid()).max(200).default([]),
});

const patchSchema = z.object({ ...meetingFields, title: meetingFields.title.optional(), version: z.number().int(), status: z.enum(['archived', 'ready', 'needs_review']).optional() });

/** Finds or creates the Person for a participant (match by email within the workspace). */
export async function resolvePerson(db: Db, ctx: Pick<WsCtx, 'orgId' | 'workspaceId' | 'userId'>, p: ParticipantIn): Promise<{ personId: string; name: string; email: string | null; userId: string | null }> {
  if (p.personId) {
    const person = await one<any>(db, 'SELECT id, name, email, user_id FROM people WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [p.personId, ctx.workspaceId]);
    if (!person) throw badRequest('Unknown personId');
    return { personId: person.id, name: person.name, email: person.email, userId: person.user_id };
  }
  if (!p.name && !p.email) throw badRequest('participant requires personId, name or email');
  if (p.email) {
    const existing = await one<any>(db, 'SELECT id, name, email, user_id FROM people WHERE workspace_id=$1 AND lower(email)=lower($2) AND deleted_at IS NULL LIMIT 1', [ctx.workspaceId, p.email]);
    if (existing) return { personId: existing.id, name: existing.name, email: existing.email, userId: existing.user_id };
  }
  const user = p.email
    ? await one<{ id: string }>(db, 'SELECT u.id FROM users u JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=$2 WHERE u.email=$1', [p.email, ctx.workspaceId])
    : null;
  const created = await one<{ id: string }>(
    db,
    'INSERT INTO people(org_id, workspace_id, name, email, user_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [ctx.orgId, ctx.workspaceId, p.name ?? p.email, p.email ?? null, user?.id ?? null, ctx.userId],
  );
  return { personId: created!.id, name: p.name ?? p.email!, email: p.email ?? null, userId: user?.id ?? null };
}

export async function setParticipants(db: Db, ctx: Pick<WsCtx, 'orgId' | 'workspaceId' | 'userId'>, meetingId: string, list: ParticipantIn[]) {
  await db.query('DELETE FROM participants WHERE meeting_id=$1', [meetingId]);
  let organizer: string | null = null;
  for (const p of list) {
    const r = await resolvePerson(db, ctx, p);
    await db.query('INSERT INTO participants(org_id, meeting_id, person_id, user_id, display_name, email, role) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      ctx.orgId,
      meetingId,
      r.personId,
      r.userId,
      r.name,
      r.email,
      p.role,
    ]);
    if (p.role === 'organizer' && !organizer) organizer = r.personId;
  }
  await db.query('UPDATE meetings SET organizer_person_id=$2 WHERE id=$1', [meetingId, organizer]);
}

async function setAccess(db: Db, ctx: WsCtx, meetingId: string, userIds: string[]) {
  await db.query('DELETE FROM meeting_access WHERE meeting_id=$1', [meetingId]);
  if (!userIds.length) return;
  // Only members of this workspace can be granted access.
  await db.query(
    `INSERT INTO meeting_access(meeting_id, org_id, user_id)
     SELECT $1, $2, wm.user_id FROM workspace_members wm WHERE wm.workspace_id=$3 AND wm.user_id = ANY($4) ON CONFLICT DO NOTHING`,
    [meetingId, ctx.orgId, ctx.workspaceId, userIds],
  );
}

/** Creates a meeting applying workspace + template defaults. Used by REST, calendar import, MCP and sample seeding. */
export async function createMeeting(db: Db, ctx: WsCtx, input: z.infer<typeof createSchema>) {
  const w = await one<any>(db, 'SELECT settings FROM workspaces WHERE id=$1', [ctx.workspaceId]);
  const s = wsSettings(w.settings);
  let meetingType = input.meetingType;
  let templateKey = input.templateKey ?? null;
  let series: any = null;
  if (input.seriesId) {
    series = await one<any>(db, 'SELECT * FROM series WHERE id=$1 AND workspace_id=$2', [input.seriesId, ctx.workspaceId]);
    if (!series) throw badRequest('Unknown seriesId');
    meetingType = meetingType ?? series.meeting_type;
    templateKey = templateKey ?? series.template_key;
  }
  meetingType = meetingType ?? 'other';
  const template = findBuiltinTemplate(templateKey) ?? defaultTemplateFor(meetingType);
  templateKey = templateKey ?? template.key;
  if (input.projectId && !(await one(db, 'SELECT 1 FROM projects WHERE id=$1 AND workspace_id=$2', [input.projectId, ctx.workspaceId]))) throw badRequest('Unknown projectId');
  const confidential = input.isConfidential ?? false;
  // Confidential preset: AI OFF, never cloud transcription, audio deleted right after processing, not workspace-wide.
  const aiEnabled = confidential ? false : (input.aiEnabled ?? s.defaults.aiEnabled);
  let transcriptionMode = input.transcriptionMode ?? s.defaults.transcriptionMode;
  if (confidential && transcriptionMode === 'cloud') transcriptionMode = 'local';
  let visibility = input.visibility ?? (series?.default_visibility as any) ?? (meetingType === 'one_on_one' ? 'private' : template.defaultVisibility ?? s.defaults.visibility);
  if (confidential && visibility === 'workspace') visibility = 'private';
  let audioRetention = input.audioRetention ?? s.defaults.audioRetention;
  if (confidential && !['never', 'until_processed'].includes(audioRetention)) audioRetention = 'until_processed';
  const audioRetentionDays = audioRetention === 'custom' ? (input.audioRetentionDays ?? s.defaults.audioRetentionDays) : null;
  if (audioRetention === 'custom' && !audioRetentionDays) throw badRequest('custom audio retention requires audioRetentionDays');
  const m = await one<any>(
    db,
    `INSERT INTO meetings(org_id, workspace_id, title, scheduled_start, scheduled_end, source, calendar_event_id, meeting_type, project_id, series_id,
                          template_key, visibility, audio_retention, audio_retention_days, transcription_mode, ai_enabled, is_confidential, language, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [
      ctx.orgId,
      ctx.workspaceId,
      input.title,
      input.scheduledStart ?? null,
      input.scheduledEnd ?? null,
      input.source,
      input.calendarEventId ?? null,
      meetingType,
      input.projectId ?? series?.project_id ?? null,
      input.seriesId ?? null,
      templateKey,
      visibility,
      audioRetention,
      audioRetentionDays,
      transcriptionMode,
      aiEnabled,
      confidential,
      input.language ?? null,
      ctx.userId,
    ],
  );
  await setParticipants(db, ctx, m.id, input.participants);
  await setAccess(db, ctx, m.id, input.accessUserIds);
  await audit(db, { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId, action: 'meeting.created', entityType: 'meeting', entityId: m.id, meta: { source: input.source } });
  if (m.visibility === 'workspace') await emitWebhookEvent(db, ctx.deps, { orgId: ctx.orgId, workspaceId: ctx.workspaceId }, 'meeting.created', { meetingId: m.id }, `meeting.created:${m.id}`);
  await deps_enqueueIndex(ctx, db, m.id);
  return m;
}

async function deps_enqueueIndex(ctx: WsCtx, db: Db, meetingId: string) {
  await ctx.deps.jobs.enqueue(db, { orgId: ctx.orgId, type: 'index.meeting', key: `index:${meetingId}:${Date.now()}`, payload: { meetingId } });
}

export async function meetingDetail(db: Db, ctx: WsCtx, m: any) {
  const participants = await rows(db, 'SELECT * FROM participants WHERE meeting_id=$1 ORDER BY role, display_name', [m.id]);
  const access = await rows(db, 'SELECT u.id, u.name, u.email FROM meeting_access ma JOIN users u ON u.id = ma.user_id WHERE ma.meeting_id=$1', [m.id]);
  const consents = await rows(db, 'SELECT id, kind, state, method, details, recorded_by, created_at FROM consent_records WHERE meeting_id=$1 ORDER BY created_at', [m.id]);
  const w = await one<any>(db, 'SELECT settings FROM workspaces WHERE id=$1', [ctx.workspaceId]);
  const s = wsSettings(w.settings);
  return {
    ...meetingDto(m, participants),
    accessUsers: access,
    consents,
    privacy: { transcription: decideTranscription(m, s, ctx.deps.config), ai: decideAi(m, s, ctx.deps.config) },
    canEdit: ctx.role !== 'viewer',
  };
}

export default async function meetingRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/w/:workspaceId/meetings', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(
      req,
      z.object({
        from: zIso.optional(),
        to: zIso.optional(),
        status: z.enum(MEETING_STATUSES).optional(),
        type: z.enum(MEETING_TYPES).optional(),
        projectId: z.string().uuid().optional(),
        seriesId: z.string().uuid().optional(),
        personId: z.string().uuid().optional(),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: zIso.optional(),
        order: z.enum(['asc', 'desc']).default('desc'),
      }),
    );
    return ctx.tx(async (db) => {
      const where = ['m.workspace_id = $1', meetingVisibleSql('m', '$2')];
      const params: unknown[] = [workspaceId, ctx.userId];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (q.from) add('coalesce(m.scheduled_start, m.created_at) >= ?', q.from);
      if (q.to) add('coalesce(m.scheduled_start, m.created_at) < ?', q.to);
      if (q.before) add('coalesce(m.scheduled_start, m.created_at) < ?', q.before);
      if (q.status) add('m.status = ?', q.status);
      if (q.type) add('m.meeting_type = ?', q.type);
      if (q.projectId) add('m.project_id = ?', q.projectId);
      if (q.seriesId) add('m.series_id = ?', q.seriesId);
      if (q.personId) add('EXISTS (SELECT 1 FROM participants p WHERE p.meeting_id = m.id AND p.person_id = ?)', q.personId);
      if (q.q) add("m.title ILIKE '%' || ? || '%'", q.q.replace(/[%_\\]/g, (c) => '\\' + c));
      params.push(q.limit + 1);
      const list = await rows(
        db,
        `SELECT m.*, (SELECT count(*) FROM participants p WHERE p.meeting_id = m.id)::int AS participant_count
           FROM meetings m WHERE ${where.join(' AND ')}
          ORDER BY coalesce(m.scheduled_start, m.created_at) ${q.order === 'asc' ? 'ASC' : 'DESC'} LIMIT $${params.length}`,
        params,
      );
      const more = list.length > q.limit;
      const items = list.slice(0, q.limit).map((m) => ({ ...meetingDto(m), participantCount: m.participant_count }));
      const last = list[q.limit - 1];
      return { items, nextCursor: more && last ? new Date(last.scheduled_start ?? last.created_at).toISOString() : null };
    });
  });

  app.post('/api/w/:workspaceId/meetings', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const input = body(req, createSchema);
    return ctx.tx(async (db) => meetingDetail(db, ctx, await createMeeting(db, ctx, input)));
  });

  app.get('/api/w/:workspaceId/meetings/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => meetingDetail(db, ctx, await loadMeeting(db, ctx, id)));
  });

  app.patch('/api/w/:workspaceId/meetings/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, patchSchema);
    return ctx.tx(async (db) => {
      const m = await loadMeeting(db, ctx, id, 'write');
      if (m.version !== b.version) throw conflict('Meeting was modified elsewhere', { current: meetingDto(m) });
      const next: Record<string, unknown> = {};
      const map: Record<string, string> = {
        title: 'title',
        scheduledStart: 'scheduled_start',
        scheduledEnd: 'scheduled_end',
        meetingType: 'meeting_type',
        projectId: 'project_id',
        seriesId: 'series_id',
        templateKey: 'template_key',
        visibility: 'visibility',
        transcriptionMode: 'transcription_mode',
        aiEnabled: 'ai_enabled',
        isConfidential: 'is_confidential',
        audioRetention: 'audio_retention',
        audioRetentionDays: 'audio_retention_days',
        language: 'language',
        status: 'status',
      };
      for (const [k, col] of Object.entries(map)) if ((b as any)[k] !== undefined) next[col] = (b as any)[k];
      // Visibility changes (private/selected) are restricted to the meeting creator or admins.
      if (next.visibility && next.visibility !== m.visibility && m.created_by !== ctx.userId && ctx.role !== 'admin' && ctx.role !== 'owner')
        throw badRequest('Only the meeting owner can change visibility');
      const confidential = (next.is_confidential ?? m.is_confidential) as boolean;
      if (confidential) {
        next.ai_enabled = false;
        if ((next.transcription_mode ?? m.transcription_mode) === 'cloud') next.transcription_mode = 'local';
        if (!['never', 'until_processed'].includes((next.audio_retention ?? m.audio_retention) as string)) next.audio_retention = 'until_processed';
      }
      if ((next.audio_retention ?? m.audio_retention) === 'custom' && !(next.audio_retention_days ?? m.audio_retention_days)) throw badRequest('custom audio retention requires audioRetentionDays');
      const cols = Object.keys(next);
      if (!cols.length) return meetingDetail(db, ctx, m);
      const sets = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
      const updated = await one<any>(db, `UPDATE meetings SET ${sets}, version = version + 1, updated_at = now() WHERE id=$1 AND version=$2 RETURNING *`, [
        id,
        b.version,
        ...cols.map((c) => next[c]),
      ]);
      if (!updated) throw conflict('Meeting was modified elsewhere');
      // Privacy changes take effect immediately: AI index is rebuilt or purged by the index job.
      if ('ai_enabled' in next || 'visibility' in next || 'is_confidential' in next || 'title' in next) await deps_enqueueIndex(ctx, db, id);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'meeting.updated', entityType: 'meeting', entityId: id, meta: { fields: cols } });
      return meetingDetail(db, ctx, updated);
    });
  });

  app.put('/api/w/:workspaceId/meetings/:id/participants', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ participants: z.array(zParticipant).max(200) }));
    return ctx.tx(async (db) => {
      const m = await loadMeeting(db, ctx, id, 'write');
      await setParticipants(db, ctx, id, b.participants);
      await db.query('UPDATE meetings SET updated_at=now(), version=version+1 WHERE id=$1', [id]);
      return meetingDetail(db, ctx, { ...m, version: m.version + 1 });
    });
  });

  app.put('/api/w/:workspaceId/meetings/:id/access', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ userIds: z.array(z.string().uuid()).max(200) }));
    return ctx.tx(async (db) => {
      const m = await loadMeeting(db, ctx, id, 'write');
      if (m.created_by !== ctx.userId && ctx.role !== 'admin' && ctx.role !== 'owner') throw badRequest('Only the meeting owner can change access');
      await setAccess(db, ctx, id, b.userIds);
      await deps_enqueueIndex(ctx, db, id);
      return meetingDetail(db, ctx, m);
    });
  });

  // ---- consent: MeetLedger helps you notify participants and keeps a record; it does not guarantee legal compliance.
  app.post('/api/w/:workspaceId/meetings/:id/consent', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(
      req,
      z.object({
        kind: z.enum(['recording', 'transcription', 'ai_processing', 'disclosure_shown', 'external_transfer']),
        state: z.enum(['notified', 'confirmed', 'declined', 'acknowledged']),
        method: z.enum(['in_app', 'verbal', 'calendar_note', 'email', 'chat_message', 'other']).default('in_app'),
        details: z.record(z.string(), z.union([z.string().max(500), z.boolean(), z.number()])).default({}),
      }),
    );
    return ctx.tx(async (db) => {
      await loadMeeting(db, ctx, id, 'write');
      const rec = await one(db, 'INSERT INTO consent_records(org_id, meeting_id, kind, state, method, details, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [
        ctx.orgId,
        id,
        b.kind,
        b.state,
        b.method,
        b.details,
        ctx.userId,
      ]);
      if (b.kind === 'recording') {
        const state = b.state === 'acknowledged' ? 'notified' : b.state;
        await db.query('UPDATE meetings SET consent_state=$2, updated_at=now() WHERE id=$1', [id, state]);
      }
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'consent.recorded', entityType: 'meeting', entityId: id, meta: { kind: b.kind, state: b.state, method: b.method } });
      return { consent: rec };
    });
  });

  app.post('/api/w/:workspaceId/meetings/:id/start', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ capture: z.enum(['notes_only', 'browser_mic', 'desktop', 'upload_later']) }));
    return ctx.tx(async (db) => {
      const m = await loadMeeting(db, ctx, id, 'write');
      if (b.capture !== 'notes_only' && !['notified', 'confirmed'].includes(m.consent_state)) {
        throw conflict('録音前に参加者への通知/同意の記録が必要です', { code: 'consent_required' });
      }
      if (m.consent_state === 'declined' && b.capture !== 'notes_only') throw conflict('参加者が録音を拒否しています', { code: 'consent_declined' });
      const u = await one<any>(db, `UPDATE meetings SET status='live', started_at=coalesce(started_at, now()), version=version+1, updated_at=now() WHERE id=$1 RETURNING *`, [id]);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'meeting.started', entityType: 'meeting', entityId: id, meta: { capture: b.capture } });
      return meetingDetail(db, ctx, u);
    });
  });

  app.post('/api/w/:workspaceId/meetings/:id/end', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ expectMedia: z.boolean().default(false) }));
    return ctx.tx(async (db) => {
      await loadMeeting(db, ctx, id, 'write');
      const status = b.expectMedia ? 'processing' : 'needs_review';
      const u = await one<any>(db, `UPDATE meetings SET status=$2, ended_at=coalesce(ended_at, now()), version=version+1, updated_at=now() WHERE id=$1 RETURNING *`, [id, status]);
      await deps_enqueueIndex(ctx, db, id);
      return meetingDetail(db, ctx, u);
    });
  });

  // ---- manual notes (work without recording; offline edits are merged with optimistic concurrency, never silently overwritten)
  app.get('/api/w/:workspaceId/meetings/:id/notes', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      await loadMeeting(db, ctx, id);
      const mine = await one<any>(db, 'SELECT body, version, updated_at FROM meeting_notes WHERE meeting_id=$1 AND author_user_id=$2', [id, ctx.userId]);
      const others = await rows(
        db,
        `SELECT n.body, n.version, n.updated_at, u.name AS author FROM meeting_notes n JOIN users u ON u.id = n.author_user_id
          WHERE n.meeting_id=$1 AND n.author_user_id <> $2 ORDER BY n.updated_at DESC`,
        [id, ctx.userId],
      );
      return { mine: mine ? { body: mine.body, version: mine.version, updatedAt: mine.updated_at } : { body: '', version: 0, updatedAt: null }, others };
    });
  });

  app.put('/api/w/:workspaceId/meetings/:id/notes', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ body: z.string().max(200_000), baseVersion: z.number().int().min(0) }));
    return ctx.tx(async (db) => {
      await loadMeeting(db, ctx, id, 'write');
      const cur = await one<any>(db, 'SELECT body, version FROM meeting_notes WHERE meeting_id=$1 AND author_user_id=$2 FOR UPDATE', [id, ctx.userId]);
      const curVersion = cur?.version ?? 0;
      if (b.baseVersion !== curVersion) throw conflict('Notes were changed on another device', { serverBody: cur?.body ?? '', serverVersion: curVersion });
      const saved = cur
        ? await one<any>(db, 'UPDATE meeting_notes SET body=$3, version=version+1, updated_at=now() WHERE meeting_id=$1 AND author_user_id=$2 RETURNING version, updated_at', [id, ctx.userId, b.body])
        : await one<any>(db, 'INSERT INTO meeting_notes(org_id, meeting_id, author_user_id, body, version) VALUES ($1,$2,$3,$4,1) RETURNING version, updated_at', [ctx.orgId, id, ctx.userId, b.body]);
      await deps_enqueueIndex(ctx, db, id);
      return { version: saved.version, updatedAt: saved.updated_at };
    });
  });

}
