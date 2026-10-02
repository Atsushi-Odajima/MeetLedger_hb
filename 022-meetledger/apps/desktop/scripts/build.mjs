// Bundles main / preload / ASR worker / local pages with esbuild.
//   node scripts/build.mjs [--outdir=dist] [--local-asr=auto|real|stub|none]
// --local-asr:
//   auto (default) real packages/local-asr/src/index.ts if it bundles, otherwise "none" with a loud warning
//   real           must bundle the real package (use for release builds)
//   stub           test fixture (test/fixtures/local-asr-stub.ts) — smoke tests only, never ship
//   none           no local ASR (capabilities report "未実装")

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureIcon } from './make-placeholder-icon.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const outdir = path.resolve(root, args.outdir ?? 'dist');
const asrMode = args['local-asr'] ?? 'auto';

const LOCAL_ASR = {
  real: path.resolve(root, '../../packages/local-asr/src/index.ts'),
  stub: path.resolve(root, 'test/fixtures/local-asr-stub.ts'),
  none: path.resolve(root, 'src/worker/local-asr-none.ts'),
};

const common = { bundle: true, logLevel: 'warning', legalComments: 'none', sourcemap: false, charset: 'utf8' };

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

// ---- main + preload (CommonJS, node)
await build({
  ...common,
  entryPoints: { main: path.join(root, 'src/main/main.ts') },
  outdir,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'sherpa-onnx-node'],
});
await build({
  ...common,
  entryPoints: { preload: path.join(root, 'src/preload/preload.ts') },
  outdir,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});

// ---- ASR utility process (CommonJS with import.meta shims so the ESM local-asr source bundles cleanly)
async function buildWorker(target) {
  await build({
    ...common,
    entryPoints: { 'asr-worker': path.join(root, 'src/worker/asrWorker.ts') },
    outdir,
    outExtension: { '.js': '.cjs' },
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', 'sherpa-onnx-node', 'sherpa-onnx-*'],
    alias: { '@meetledger/local-asr': target },
    define: { 'import.meta.url': '__ml_import_meta_url', 'import.meta.dirname': '__dirname', 'import.meta.filename': '__filename' },
    banner: { js: "const __ml_import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
    logOverride: { 'import-is-undefined': 'silent' },
  });
}
let asrUsed = asrMode;
if (asrMode === 'auto') {
  asrUsed = fs.existsSync(LOCAL_ASR.real) ? 'real' : 'none';
  try {
    await buildWorker(LOCAL_ASR[asrUsed]);
  } catch (e) {
    console.warn('\n[build] WARNING: packages/local-asr did not bundle — building WITHOUT local ASR (capabilities will say 未実装).');
    console.warn(`[build] ${String(e.message).split('\n').slice(0, 6).join('\n')}\n`);
    asrUsed = 'none';
    await buildWorker(LOCAL_ASR.none);
  }
} else {
  if (!LOCAL_ASR[asrMode]) throw new Error(`unknown --local-asr=${asrMode}`);
  await buildWorker(LOCAL_ASR[asrMode]);
}

// ---- local pages (ES modules, browser)
const rendererOut = path.join(outdir, 'renderer');
await build({
  ...common,
  entryPoints: {
    'recorder/recorder': path.join(root, 'src/renderer/recorder/recorder.ts'),
    'recorder/convert': path.join(root, 'src/renderer/recorder/convert.ts'),
    'recorder/pcm-tap-worklet': path.join(root, 'src/renderer/recorder/pcmTap.worklet.ts'),
    'settings/settings': path.join(root, 'src/renderer/settings/settings.ts'),
  },
  outdir: rendererOut,
  platform: 'browser',
  format: 'esm',
  target: 'chrome140',
});
for (const rel of ['recorder/index.html', 'settings/index.html', 'common/common.css']) {
  fs.mkdirSync(path.dirname(path.join(rendererOut, rel)), { recursive: true });
  fs.copyFileSync(path.join(root, 'src/renderer', rel), path.join(rendererOut, rel));
}

// ---- assets (tray / window icon); placeholder only if the brand icon is missing
const icon = ensureIcon(path.join(root, 'build/icon.png'));
fs.mkdirSync(path.join(outdir, 'assets'), { recursive: true });
fs.copyFileSync(icon.path, path.join(outdir, 'assets/icon.png'));

fs.writeFileSync(path.join(outdir, 'build-info.json'), JSON.stringify({ localAsr: asrUsed, iconPlaceholder: icon.placeholder, builtAt: new Date().toISOString() }, null, 2));
console.log(`[build] ok → ${path.relative(root, outdir)} (local-asr: ${asrUsed}, icon: ${icon.placeholder ? 'placeholder' : 'build/icon.png'})`);
