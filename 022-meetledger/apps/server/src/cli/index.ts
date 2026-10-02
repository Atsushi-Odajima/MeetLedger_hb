// Entry point: node dist/cli/index.js <command> ... (or: npx tsx src/cli/index.ts <command> ...)
import { runCli } from './main';

process.exitCode = await runCli(process.argv.slice(2));
