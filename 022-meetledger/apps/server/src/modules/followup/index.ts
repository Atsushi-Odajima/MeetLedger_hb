import type { ModuleDef } from '../types';
import draftRoutes from './drafts';
import notificationRoutes from './notificationRoutes';
import briefRoutes from './brief';
import memoryRoutes from './memory';
import dashboardRoutes from './dashboard';
import agendaRoutes from './agenda';
import templateRoutes from './templates';
import { runFollowupTick } from './engine';

// followup: follow-up drafts, notifications (engine + inbox + prefs), pre-meeting brief, meeting memory,
// person timeline, dashboard, agenda, templates.
const mod: ModuleDef = {
  name: 'followup',
  async routes(app, deps) {
    await draftRoutes(app, deps);
    await notificationRoutes(app, deps);
    await briefRoutes(app, deps);
    await memoryRoutes(app, deps);
    await dashboardRoutes(app, deps);
    await agendaRoutes(app, deps);
    await templateRoutes(app, deps);
  },
  jobs(worker, deps) {
    // Org-less system job (scheduler): iterates organizations, tenant work inside tenantTx per org.
    worker.register('followup.tick', async () => runFollowupTick(deps));
  },
};
export default mod;

export { runFollowupTick } from './engine';
export { buildBrief } from './brief';
export { buildDashboard } from './dashboard';
export { composeDraft, validatePolish } from './drafts';
