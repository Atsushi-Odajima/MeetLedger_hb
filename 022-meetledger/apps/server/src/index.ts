import { loadConfig, describeConfig } from './config';
import { buildApp } from './app';
import { migrate } from './db/migrate';
import { startSchedulers } from './modules/scheduler';

const config = loadConfig();
const { app, deps, worker } = await buildApp({ config });
await migrate(deps.pool, (m) => app.log.info(m));
app.log.info({ config: describeConfig(config) }, 'MeetLedger starting');
if (config.RUN_WORKER) {
  worker.start();
  startSchedulers(deps);
}
await app.listen({ host: config.HOST, port: config.PORT });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.log.info(`received ${sig}, shutting down`);
    app.close().then(() => process.exit(0));
  });
}
