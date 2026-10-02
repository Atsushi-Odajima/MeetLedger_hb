import type { FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';
import { badRequest } from './errors';

/** Validates input with zod; throws 400 with field issues (never echoes values). */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      'Validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export const params = <T>(req: FastifyRequest, schema: ZodType<T>) => parse(schema, req.params);
export const body = <T>(req: FastifyRequest, schema: ZodType<T>) => parse(schema, req.body ?? {});
export const query = <T>(req: FastifyRequest, schema: ZodType<T>) => parse(schema, req.query ?? {});

export const zUuid = z.string().uuid();
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const zIso = z.string().datetime({ offset: true });
export const wsParams = z.object({ workspaceId: zUuid });
export const wsIdParams = z.object({ workspaceId: zUuid, id: zUuid });

export const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
