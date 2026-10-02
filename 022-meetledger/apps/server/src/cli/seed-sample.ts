// `npm run seed:sample -w @meetledger/server -- --email you@example.com` (alias of `cli seed-sample`).
import { runCli } from './main';

process.exitCode = await runCli(['seed-sample', ...process.argv.slice(2)]);
