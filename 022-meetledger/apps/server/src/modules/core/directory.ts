// People, Projects/Clients and Recurring Series (basic CRUD). Timelines & memory views live in the followup module.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MEETING_TYPES, VISIBILITIES } from '@meetledger/shared';
import type { Deps } from '../../context';
import { one, rows } from '../../db/pool';
import { notFound } from '../../lib/errors';
import { body, parse, query, wsIdParams, wsParams } from '../../lib/http';
import { meetingVisibleSql, workspaceCtx } from '../../rbac/access';
import { audit } from '../../lib/audit';
import { personDto } from './mappers';

const personFields = {
  name: z.string().trim().min(1).max(100),
  organization: z.string().trim().max(200).nullable().optional(),
  roleTitle: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
};

export default async function directoryRoutes(app: FastifyInstance, deps: Deps) {
  // ------------------------------------------------------------------ people
  app.get('/api/w/:workspaceId/people', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(req, z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }));
    return ctx.tx(async (db) => {
      const params: unknown[] = [workspaceId, ctx.userId, q.limit];
      let filter = '';
      if (q.q) {
        params.push(q.q.replace(/[%_\\]/g, (c) => '\\' + c));
        filter = `AND (p.name ILIKE '%' || $4 || '%' OR p.organization ILIKE '%' || $4 || '%' OR p.email ILIKE '%' || $4 || '%')`;
      }
      const list = await rows(
        db,
        `SELECT p.*,
           (SELECT max(coalesce(m.scheduled_start, m.created_at)) FROM participants pa JOIN meetings m ON m.id = pa.meeting_id
             WHERE pa.person_id = p.id AND coalesce(m.scheduled_start, m.created_at) <= now() AND ${meetingVisibleSql('m', '$2')}) AS last_meeting_at,
           (SELECT min(m.scheduled_start) FROM participants pa JOIN meetings m ON m.id = pa.meeting_id
             WHERE pa.person_id = p.id AND m.scheduled_start > now() AND ${meetingVisibleSql('m', '$2')}) AS next_meeting_at,
           (SELECT count(*) FROM commitments c WHERE (c.promised_by_person_id = p.id OR c.promised_to_person_id = p.id) AND c.status = 'open') AS open_commitments
         FROM people p WHERE p.workspace_id = $1 AND p.deleted_at IS NULL ${filter}
         ORDER BY p.name LIMIT $3`,
        params,
      );
      return { items: list.map(personDto) };
    });
  });

  app.post('/api/w/:workspaceId/people', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object(personFields));
    return ctx.tx(async (db) => {
      const p = await one(
        db,
        `INSERT INTO people(org_id, workspace_id, name, organization, role_title, email, notes, tags, created_by,
                            user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                 (SELECT u.id FROM users u JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=$2 WHERE $6::text IS NOT NULL AND u.email=$6))
         RETURNING *`,
        [ctx.orgId, workspaceId, b.name, b.organization ?? null, b.roleTitle ?? null, b.email ?? null, b.notes ?? null, b.tags ?? [], ctx.userId],
      );
      await ctx.deps.jobs.enqueue(db, { orgId: ctx.orgId, type: 'index.person', key: `index-person:${p.id}:${Date.now()}`, payload: { personId: p.id } });
      return personDto(p);
    });
  });

  app.get('/api/w/:workspaceId/people/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const p = await one(db, 'SELECT * FROM people WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [id, workspaceId]);
      if (!p) throw notFound('Person not found');
      const notes = await rows(
        db,
        'SELECT n.id, n.body, n.created_at, u.name AS author FROM person_notes n LEFT JOIN users u ON u.id = n.author_user_id WHERE n.person_id=$1 ORDER BY n.created_at DESC',
        [id],
      );
      return { ...personDto(p), personNotes: notes };
    });
  });

  app.patch('/api/w/:workspaceId/people/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ ...personFields, name: personFields.name.optional() }));
    return ctx.tx(async (db) => {
      const p = await one(
        db,
        `UPDATE people SET name=coalesce($3,name), organization=CASE WHEN $4::boolean THEN $5 ELSE organization END,
                role_title=CASE WHEN $6::boolean THEN $7 ELSE role_title END, email=CASE WHEN $8::boolean THEN $9 ELSE email END,
                notes=CASE WHEN $10::boolean THEN $11 ELSE notes END, tags=coalesce($12, tags), updated_at=now()
          WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL RETURNING *`,
        [
          id,
          workspaceId,
          b.name ?? null,
          b.organization !== undefined,
          b.organization ?? null,
          b.roleTitle !== undefined,
          b.roleTitle ?? null,
          b.email !== undefined,
          b.email ?? null,
          b.notes !== undefined,
          b.notes ?? null,
          b.tags ?? null,
        ],
      );
      if (!p) throw notFound('Person not found');
      await ctx.deps.jobs.enqueue(db, { orgId: ctx.orgId, type: 'index.person', key: `index-person:${id}:${Date.now()}`, payload: { personId: id } });
      return personDto(p);
    });
  });

  /** Deletes a person's profile data (name anonymized, notes removed). Meeting records keep the display name as spoken. */
  app.delete('/api/w/:workspaceId/people/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    await ctx.tx(async (db) => {
      const p = await one(db, 'SELECT id FROM people WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [id, workspaceId]);
      if (!p) throw notFound('Person not found');
      await db.query('DELETE FROM person_notes WHERE person_id=$1', [id]);
      await db.query(
        `UPDATE people SET name='(削除済みの人物)', organization=NULL, role_title=NULL, email=NULL, notes=NULL, tags='{}', user_id=NULL, deleted_at=now(), updated_at=now() WHERE id=$1`,
        [id],
      );
      await db.query("DELETE FROM search_docs WHERE entity_type='person' AND entity_id=$1", [id]);
      await db.query("DELETE FROM ai_chunks WHERE entity_type='person' AND entity_id=$1", [id]);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'person.deleted', entityType: 'person', entityId: id });
    });
    return { ok: true };
  });

  app.post('/api/w/:workspaceId/people/:id/notes', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ body: z.string().trim().min(1).max(20_000) }));
    return ctx.tx(async (db) => {
      const p = await one(db, 'SELECT id FROM people WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [id, workspaceId]);
      if (!p) throw notFound('Person not found');
      const n = await one(db, 'INSERT INTO person_notes(org_id, workspace_id, person_id, body, author_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, body, created_at', [
        ctx.orgId,
        workspaceId,
        id,
        b.body,
        ctx.userId,
      ]);
      await ctx.deps.jobs.enqueue(db, { orgId: ctx.orgId, type: 'index.person', key: `index-person:${id}:${Date.now()}`, payload: { personId: id } });
      return n;
    });
  });

  // ------------------------------------------------------------------ projects / clients
  const projectFields = {
    name: z.string().trim().min(1).max(200),
    kind: z.enum(['project', 'client']).default('project'),
    clientName: z.string().trim().max(200).nullable().optional(),
    description: z.string().max(5000).nullable().optional(),
  };

  app.get('/api/w/:workspaceId/projects', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const list = await rows(
        db,
        `SELECT p.*, (SELECT count(*) FROM meetings m WHERE m.project_id = p.id AND ${meetingVisibleSql('m', '$2')}) AS meeting_count
           FROM projects p WHERE p.workspace_id=$1 ORDER BY p.status, p.name`,
        [workspaceId, ctx.userId],
      );
      return { items: list.map(projectDto) };
    });
  });

  app.post('/api/w/:workspaceId/projects', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object(projectFields));
    return ctx.tx(async (db) =>
      projectDto(
        await one(db, 'INSERT INTO projects(org_id, workspace_id, name, kind, client_name, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [
          ctx.orgId,
          workspaceId,
          b.name,
          b.kind,
          b.clientName ?? null,
          b.description ?? null,
          ctx.userId,
        ]),
      ),
    );
  });

  app.get('/api/w/:workspaceId/projects/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const p = await one(db, 'SELECT * FROM projects WHERE id=$1 AND workspace_id=$2', [id, workspaceId]);
      if (!p) throw notFound('Project not found');
      return projectDto(p);
    });
  });

  app.patch('/api/w/:workspaceId/projects/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(
      req,
      z.object({ name: projectFields.name.optional(), clientName: projectFields.clientName, description: projectFields.description, status: z.enum(['active', 'archived']).optional() }),
    );
    return ctx.tx(async (db) => {
      const p = await one(
        db,
        `UPDATE projects SET name=coalesce($3,name), client_name=CASE WHEN $4::boolean THEN $5 ELSE client_name END,
                description=CASE WHEN $6::boolean THEN $7 ELSE description END, status=coalesce($8,status), updated_at=now()
          WHERE id=$1 AND workspace_id=$2 RETURNING *`,
        [id, workspaceId, b.name ?? null, b.clientName !== undefined, b.clientName ?? null, b.description !== undefined, b.description ?? null, b.status ?? null],
      );
      if (!p) throw notFound('Project not found');
      return projectDto(p);
    });
  });

  // ------------------------------------------------------------------ recurring series
  app.get('/api/w/:workspaceId/series', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const list = await rows(
        db,
        `SELECT s.*,
           (SELECT max(coalesce(m.scheduled_start, m.created_at)) FROM meetings m WHERE m.series_id = s.id AND ${meetingVisibleSql('m', '$2')}) AS last_meeting_at,
           (SELECT count(*) FROM meetings m WHERE m.series_id = s.id AND ${meetingVisibleSql('m', '$2')}) AS meeting_count
          FROM series s WHERE s.workspace_id=$1 ORDER BY s.title`,
        [workspaceId, ctx.userId],
      );
      return { items: list.map(seriesDto) };
    });
  });

  app.post('/api/w/:workspaceId/series', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(
      req,
      z.object({
        title: z.string().trim().min(1).max(200),
        cadence: z.string().max(100).nullable().optional(),
        projectId: z.string().uuid().nullable().optional(),
        meetingType: z.enum(MEETING_TYPES).default('internal'),
        templateKey: z.string().max(64).nullable().optional(),
        defaultVisibility: z.enum(VISIBILITIES).default('workspace'),
      }),
    );
    return ctx.tx(async (db) =>
      seriesDto(
        await one(
          db,
          'INSERT INTO series(org_id, workspace_id, title, cadence, project_id, meeting_type, template_key, default_visibility, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [ctx.orgId, workspaceId, b.title, b.cadence ?? null, b.projectId ?? null, b.meetingType, b.templateKey ?? null, b.defaultVisibility, ctx.userId],
        ),
      ),
    );
  });

  app.get('/api/w/:workspaceId/series/:id', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const s = await one(db, 'SELECT * FROM series WHERE id=$1 AND workspace_id=$2', [id, workspaceId]);
      if (!s) throw notFound('Series not found');
      return seriesDto(s);
    });
  });
}

export function projectDto(p: any) {
  return {
    id: p.id,
    workspaceId: p.workspace_id,
    name: p.name,
    kind: p.kind,
    clientName: p.client_name,
    description: p.description,
    status: p.status,
    meetingCount: p.meeting_count !== undefined ? Number(p.meeting_count) : undefined,
    createdAt: p.created_at,
  };
}

export function seriesDto(s: any) {
  return {
    id: s.id,
    workspaceId: s.workspace_id,
    title: s.title,
    cadence: s.cadence,
    projectId: s.project_id,
    meetingType: s.meeting_type,
    templateKey: s.template_key,
    defaultVisibility: s.default_visibility,
    lastMeetingAt: s.last_meeting_at ?? null,
    meetingCount: s.meeting_count !== undefined ? Number(s.meeting_count) : undefined,
    createdAt: s.created_at,
  };
}
