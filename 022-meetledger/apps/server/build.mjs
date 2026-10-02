// Bundles the server into dist/ (node_modules stay external) and copies SQL migrations.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const external = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})].filter((d) => d !== '@meetledger/shared');

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/index.ts', 'src/cli/index.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
cpSync('src/db/migrations', 'dist/migrations', { recursive: true });
console.log('server build complete');
