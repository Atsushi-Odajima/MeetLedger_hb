// Bundles the server into dist/ (node_modules stay external) and copies SQL migrations.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
// Workspace packages (@meetledger/*) are TypeScript sources -> bundled. Native/runtime deps stay external.
const external = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), 'sherpa-onnx-node'].filter((d) => !d.startsWith('@meetledger/'));

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/index.ts', 'src/cli/index.ts', 'src/mcp/stdio.ts'],
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
