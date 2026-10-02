import type { ModuleDef } from '../types';
import { apiTokenRoutes } from './apiTokens';
import { externalWriteRoutes } from './externalWrites';
import { connectorRoutes } from './routes';
import { runBackgroundSync } from './sync';
import { webhookJobs, webhookRoutes } from './webhooks';

export { emitWebhookEvent, WEBHOOK_EVENTS } from './webhooks';
export type { CalendarConnector, CalendarEvent, CalendarRange } from './calendar';

// Connectors: calendar (Google / Microsoft / ICS, read-only, preview → explicit import), external writes
// (Slack / Gmail draft / HubSpot note / generic webhook — preview + explicit approval, executed once),
// outbound webhooks (HMAC signed, retried), API tokens (MCP / integrations). See docs/CONNECTORS.md.
const mod: ModuleDef = {
  name: 'connectors',
  routes(app, deps) {
    connectorRoutes(app, deps);
    externalWriteRoutes(app, deps);
    webhookRoutes(app, deps);
    apiTokenRoutes(app, deps);
  },
  jobs(worker, deps) {
    // Org-less system job (enqueued by modules/scheduler.ts every 15 min): refreshes previews only.
    worker.register('connectors.sync', () => runBackgroundSync(deps));
    webhookJobs(worker, deps);
  },
};
export default mod;
