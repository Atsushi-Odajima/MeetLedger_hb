// search module: cross-meeting FTS search, cross-meeting RAG (ask), AI privacy preview, index jobs.
// See docs/AI_RAG_SECURITY.md for the retrieval pipeline and the security model.
import { z } from 'zod';
import type { ModuleDef } from '../types';
import { body, parse, query, wsParams } from '../../lib/http';
import { isUuid, workspaceCtx } from '../../rbac/access';
import { permanentError } from '../../jobs/queue';
import { askBodySchema, runAsk } from './ask';
import { runSearch, searchQuerySchema } from './search';
import { meetingPreview, workspacePreview } from './preview';
import { indexMeeting, indexPerson } from './indexer';

export { enqueueMeetingIndex, enqueuePersonIndex, indexMeeting, indexPerson, purgeMeetingAiIndex, purgeMeetingIndex } from './indexer';
export { runAsk, UNKNOWN_ANSWER_JA } from './ask';
export { runSearch } from './search';

const mod: ModuleDef = {
  name: 'search',
  routes(app, deps) {
    app.get('/api/w/:workspaceId/search', async (req) => {
      const { workspaceId } = parse(wsParams, req.params);
      const ctx = await workspaceCtx(deps, req, workspaceId);
      const q = query(req, searchQuerySchema);
      return ctx.tx((db) => runSearch(db, ctx, q));
    });

    app.post('/api/w/:workspaceId/ask', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      const { workspaceId } = parse(wsParams, req.params);
      const ctx = await workspaceCtx(deps, req, workspaceId);
      const b = body(req, askBodySchema);
      return runAsk(ctx, b);
    });

    app.get('/api/w/:workspaceId/ai/privacy-preview', async (req) => {
      const { workspaceId } = parse(wsParams, req.params);
      const ctx = await workspaceCtx(deps, req, workspaceId);
      const q = query(req, z.object({ meetingId: z.string().uuid().optional() }));
      return ctx.tx<unknown>((db) => (q.meetingId ? meetingPreview(db, ctx, q.meetingId) : workspacePreview(db, ctx)));
    });
  },
  jobs(worker, deps) {
    worker.register('index.meeting', async (job) => {
      const meetingId = job.payload?.meetingId;
      if (!job.org_id || !isUuid(meetingId)) throw permanentError('index.meeting: invalid payload');
      return indexMeeting(deps, job.org_id, meetingId, { jobId: job.id });
    });
    worker.register('index.person', async (job) => {
      const personId = job.payload?.personId;
      if (!job.org_id || !isUuid(personId)) throw permanentError('index.person: invalid payload');
      return indexPerson(deps, job.org_id, personId, { jobId: job.id });
    });
  },
};
export default mod;
