// Smoke test of the PACKAGED Linux build (release/linux-unpacked, from `electron-builder --linux dir`).
// Verifies: app starts from app.asar, fuses (RunAsNode / --inspect disabled), preload bridge, and that the ASR
// utility process + sherpa-onnx native addon load from app.asar.unpacked and transcribe ja.wav.
//   xvfb-run -a node scripts/smoke-packaged.mjs
// Uses the Chromium DevTools protocol (--remote-debugging-port), which the Node inspector fuse does not affect.

import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'release/linux-unpacked/meetledger-desktop');
const modelDir = process.env.MEETLEDGER_SMOKE_MODEL_DIR ?? path.resolve(root, '../../models');
const jaWav = path.join(modelDir, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/ja.wav');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).slice(0, 300)}` : ''}`);
};
if (!fs.existsSync(bin)) {
  console.error('release/linux-unpacked missing: run npx electron-builder --linux dir');
  process.exit(1);
}

// fuses: ELECTRON_RUN_AS_NODE must not turn the app into a Node runtime
const asNode = spawnSync(bin, ['--no-sandbox', '-e', 'console.log("RAN_AS_NODE")'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 8000, encoding: 'utf8' });
check('fuse RunAsNode disabled (ELECTRON_RUN_AS_NODE ignored)', !`${asNode.stdout}${asNode.stderr}`.includes('RAN_AS_NODE'));

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': req.url === '/' ? 'text/html' : 'application/json' });
  res.end(req.url === '/' ? '<!doctype html><title>Fake MeetLedger</title><p>ok</p>' : '{"ok":true}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-pkg-'));
const userData = path.join(home, 'MeetLedger Desktop');
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ schema: 1, serverUrl: origin, diarization: false }));
if (fs.existsSync(modelDir)) fs.symlinkSync(modelDir, path.join(userData, 'models'), 'dir');

const port = 9300 + Math.floor(Math.random() * 500);
const child = spawn(bin, ['--no-sandbox', `--remote-debugging-port=${port}`, '--inspect=9229'], { env: { ...process.env, XDG_CONFIG_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
try {
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 500));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
  }
  check('packaged app starts (CDP reachable)', !!browser);
  check('fuse: --inspect ignored (no Node debugger)', !/Debugger listening/.test(out));
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(origin)) ?? null;
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  check('main window loads the configured server', !!page, page?.url());
  const caps = await page.evaluate(() => window.meetledgerDesktop.capabilities());
  check('bridge + ASR utility process from app.asar: capabilities()', typeof caps.localTranscription.available === 'boolean', JSON.stringify(caps.localTranscription));
  if (fs.existsSync(jaWav)) {
    const r = await page.evaluate(async (arr) => {
      const d = window.meetledgerDesktop;
      const s = await d.saveRecording({ mimeType: 'audio/wav', data: new Uint8Array(arr).buffer });
      try {
        return await d.transcribeLocal(s.fileToken, { language: 'ja', diarization: false });
      } finally {
        await d.discardRecording(s.fileToken);
      }
    }, [...fs.readFileSync(jaWav)]);
    const text = r.segments.map((x) => x.text).join('');
    check('sherpa-onnx native addon loads from app.asar.unpacked and transcribes ja.wav', /弁当/.test(text), text);
  } else {
    console.log(`SKIP  real transcription (no models at ${modelDir})`);
  }
  await browser.close().catch(() => undefined);
} finally {
  child.kill('SIGTERM');
  server.close();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
