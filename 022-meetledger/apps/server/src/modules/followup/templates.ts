// Meeting templates: built-ins (packages/shared) + workspace custom templates (templates table).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BUILTIN_TEMPLATES, FOLLOWUP_KINDS, MEETING_TYPES, SUMMARY_SECTIONS, VISIBILITIES, defaultTemplateFor, findBuiltinTemplate } from '@meetledger/shared';
import type { Deps } from '../../context';
import { one, rows } from '../../db/pool';
import { conflict } from '../../lib/errors';
import { body, iso, parse, wsParams } from '../../lib/http';
import { audit } from '../../lib/audit';
import { workspaceCtx } from '../../rbac/access';
import { mergeTemplate } from './util';

const definitionSchema = z.object({
  defaultVisibility: z.enum(VISIBILITIES).optional(),
  agenda: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  summarySections: z.array(z.enum(SUMMARY_SECTIONS)).min(1).max(SUMMARY_SECTIONS.length).optional(),
  extractionRules: z
    .object({
      decisions: z.boolean(),
      actions: z.boolean(),
      commitments: z.boolean(),
      questions: z.boolean(),
      risks: z.boolean(),
      /** Hints for extraction providers. They never change policy (AI output stays a candidate). */
      hints: z.array(z.string().trim().min(1).max(200)).max(10),
    })
    .partial()
    .optional(),
  followupStyle: z.object({ defaultKinds: z.array(z.enum(FOLLOWUP_KINDS)).max(4), tone: z.enum(['formal', 'neutral', 'casual']) }).partial().optional(),
});

export default async function templateRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/w/:workspaceId/templates', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const custom = await rows(db, 'SELECT * FROM templates WHERE workspace_id=$1 ORDER BY name', [workspaceId]);
      return {
        items: [
          ...BUILTIN_TEMPLATES.map((t) => ({ ...t, builtIn: true, id: null, createdAt: null })),
          ...custom.map((c) => ({
            ...mergeTemplate(defaultTemplateFor(c.meeting_type), { ...(c.definition ?? {}), key: c.key, name: c.name, meetingType: c.meeting_type }),
            builtIn: false,
            id: c.id,
            createdAt: iso(c.created_at),
          })),
        ],
      };
    });
  });

  /** Custom template (admin). Starts from `basedOn` (a built-in key) or the default template of the meeting type. */
  app.post('/api/w/:workspaceId/templates', async (req) => {
    const { workspaceId } = parse(wsParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'admin');
    const b = body(
      req,
      z
        .object({
          key: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
          name: z.string().trim().min(1).max(100),
          meetingType: z.enum(MEETING_TYPES),
          basedOn: z.string().max(64).optional(),
        })
        .merge(definitionSchema),
    );
    if (findBuiltinTemplate(b.key)) throw conflict('Template key is reserved by a built-in template', { code: 'reserved_key' });
    const base = findBuiltinTemplate(b.basedOn) ?? defaultTemplateFor(b.meetingType);
    const { key, name, meetingType, basedOn: _b, ...def } = b;
    const merged = mergeTemplate(base, { ...def, key, name, meetingType } as any);
    const definition = {
      defaultVisibility: merged.defaultVisibility,
      agenda: merged.agenda,
      summarySections: merged.summarySections,
      extractionRules: merged.extractionRules,
      followupStyle: merged.followupStyle,
    };
    return ctx.tx(async (db) => {
      const r = await one<any>(
        db,
        `INSERT INTO templates(org_id, workspace_id, key, name, meeting_type, definition) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (workspace_id, key) DO NOTHING RETURNING *`,
        [ctx.orgId, workspaceId, key, name, meetingType, definition],
      );
      if (!r) throw conflict('Template key already exists', { code: 'duplicate_key' });
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'template.created', entityType: 'template', entityId: r.id, meta: { key } });
      return { ...merged, builtIn: false, id: r.id, createdAt: iso(r.created_at) };
    });
  });
}
