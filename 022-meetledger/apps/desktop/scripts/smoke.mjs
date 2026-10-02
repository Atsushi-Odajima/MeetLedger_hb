// Electron smoke test (Linux/xvfb friendly). Launches the real app with Playwright's Electron driver against a fake
// MeetLedger server and checks: secure bridge exposure, navigation/permission policy, IPC validation, consent-gated
// recording with the persistent indicator, mic→L / system→R channel layout, 16 kHz WAV tap, local ASR → POST
// /transcript/local, audio upload → POST /media.
//
//   npm run smoke            (builds dist-smoke with the local-asr TEST STUB, then runs phase A)
//   phase B runs automatically when dist/ (real packages/local-asr) and downloaded models exist:
//     models are looked up in $MEETLEDGER_SMOKE_MODEL_DIR or ../../models (scripts/download-models.sh)
//
// Run under a display:  xvfb-run -a npm run smoke

import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronPath = require('electron');
const WS = '11111111-1111-4111-8111-111111111111';
const MEETING = '22222222-2222-4222-8222-222222222222';
const SID = 's3cret-session';
const CSRF = 'csrf-123';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).slice(0, 300)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 15000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

// ------------------------------------------------------------------ fake MeetLedger server
function startFakeServer() {
  const state = { consentState: 'pending', requests: [], consents: [], starts: [], ends: [], transcripts: [], media: [] };
  const meeting = () => ({
    id: MEETING,
    workspaceId: WS,
    title: 'スモークテスト会議',
    status: 'scheduled',
    consentState: state.consentState,
    transcriptionMode: 'local',
    isConfidential: false,
    aiEnabled: true,
    scheduledStart: '2026-10-02T10:00:00.000Z',
    startedAt: null,
    language: 'ja',
  });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const cookie = req.headers.cookie ?? '';
      state.requests.push({ method: req.method, path: url.pathname, cookie: cookie.includes(`ml_sid=${SID}`), origin: req.headers.origin ?? null, csrf: req.headers['x-csrf-token'] ?? null, ua: req.headers['user-agent'] ?? '' });
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `ml_sid=${SID}; HttpOnly; SameSite=Lax; Path=/` });
        return res.end('<!doctype html><html><head><title>Fake MeetLedger</title></head><body><h1>Fake MeetLedger web app</h1><a id="ext" href="https://example.com/">ext</a></body></html>');
      }
      if (url.pathname === '/api/health') return send(200, { ok: true, version: 'fake' });
      if (!url.pathname.startsWith('/api/')) return send(404, { error: { code: 'not_found', message: 'nf' } });
      if (!cookie.includes(`ml_sid=${SID}`)) return send(401, { error: { code: 'unauthorized', message: 'Authentication required' } });
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && origin !== serverOrigin) return send(403, { error: { code: 'forbidden', message: 'Cross-origin request rejected' } });
        if (req.headers['x-csrf-token'] !== CSRF) return send(403, { error: { code: 'forbidden', message: 'CSRF token missing or invalid' } });
      }
      const p = url.pathname;
      const json = () => (body.length ? JSON.parse(body.toString('utf8')) : {});
      if (req.method === 'GET' && p === '/api/me') return send(200, { user: { id: 'u1', email: 'a@example.com', name: 'テスト', locale: 'ja', timezone: 'Asia/Tokyo' }, orgs: [], workspaces: [{ id: WS, orgId: 'o', name: 'テストWS', role: 'member', isSample: false }], csrfToken: CSRF });
      if (req.method === 'GET' && p === `/api/w/${WS}/meetings`) return send(200, { items: [meeting()], nextCursor: null });
      if (req.method === 'GET' && p === `/api/w/${WS}/meetings/${MEETING}`) return send(200, meeting());
      if (req.method === 'POST' && p === `/api/w/${WS}/meetings/${MEETING}/consent`) {
        const b = json();
        state.consents.push(b);
        if (b.kind === 'recording') state.consentState = b.state === 'acknowledged' ? 'notified' : b.state;
        return send(200, { consent: { id: 'c1', ...b } });
      }
      if (req.method === 'POST' && p === `/api/w/${WS}/meetings/${MEETING}/start`) {
        const b = json();
        state.starts.push(b);
        if (b.capture !== 'notes_only' && !['notified', 'confirmed'].includes(state.consentState)) return send(409, { error: { code: 'conflict', message: '録音前に参加者への通知/同意の記録が必要です', details: { code: 'consent_required' } } });
        return send(200, { ...meeting(), status: 'live' });
      }
      if (req.method === 'POST' && p === `/api/w/${WS}/meetings/${MEETING}/end`) {
        state.ends.push(json());
        return send(200, meeting());
      }
      if (req.method === 'POST' && p === `/api/w/${WS}/meetings/${MEETING}/transcript/local`) {
        state.transcripts.push(json());
        return send(200, { transcriptId: 't1' });
      }
      if (req.method === 'POST' && p === `/api/w/${WS}/meetings/${MEETING}/media`) {
        const ct = req.headers['content-type'] ?? '';
        const boundary = /boundary=(.+)$/.exec(ct)?.[1];
        let file = null;
        if (boundary) {
          const sep = Buffer.from(`--${boundary}`);
          let start = body.indexOf(sep);
          while (start !== -1) {
            const next = body.indexOf(sep, start + sep.length);
            if (next === -1) break;
            const part = body.subarray(start + sep.length + 2, next - 2);
            const headerEnd = part.indexOf('\r\n\r\n');
            const headers = part.subarray(0, headerEnd).toString();
            if (/name="file"/.test(headers)) file = { headers, data: part.subarray(headerEnd + 4) };
            start = next;
          }
        }
        state.media.push({ contentType: ct, file });
        return send(200, { assetId: 'a1', jobId: 'j1', created: true });
      }
      return send(404, { error: { code: 'not_found', message: `no route ${req.method} ${p}` } });
    });
  });
  let serverOrigin = '';
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      serverOrigin = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, state, origin: serverOrigin });
    });
  });
}

// ------------------------------------------------------------------ helpers
function wavInfo(file) {
  const b = fs.readFileSync(file);
  return { riff: b.toString('ascii', 0, 4), channels: b.readUInt16LE(22), rate: b.readUInt32LE(24), bits: b.readUInt16LE(34), dataBytes: b.readUInt32LE(40), durationS: b.readUInt32LE(40) / 2 / b.readUInt32LE(24) };
}

function channelStats(file) {
  let probe = {};
  try {
    probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]).toString()).streams?.[0] ?? {};
  } catch {
    /* ffprobe missing or file unreadable */
  }
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'astats=measure_overall=none:measure_perchannel=RMS_level', '-f', 'null', '-'], { encoding: 'utf8' });
  return { codec: probe.codec_name, channels: probe.channels, sampleRate: probe.sample_rate, raw: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function perChannelRms(raw) {
  // astats prints "Channel: N" blocks with "RMS level dB: x"
  const out = {};
  let ch = null;
  for (const line of raw.split('\n')) {
    const c = /Channel: (\d+)/.exec(line);
    if (c) ch = Number(c[1]);
    const r = /RMS level dB: (-?[\d.]+|-inf)/.exec(line);
    if (r && ch !== null) out[ch] = r[1] === '-inf' ? -Infinity : Number(r[1]);
  }
  return out;
}

async function launch(appDir, userData, extraArgs = []) {
  const app = await electron.launch({
    executablePath: electronPath,
    // NOTE: no --use-fake-ui-for-media-stream: it would auto-accept capture and bypass Electron's permission handlers
    args: ['--no-sandbox', appDir, '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...extraArgs],
    env: { ...process.env, MEETLEDGER_USER_DATA_DIR: userData, ELECTRON_ENABLE_LOGGING: '0' },
    timeout: 60000,
  });
  const logs = [];
  app.process().stdout?.on('data', (d) => logs.push(String(d)));
  app.process().stderr?.on('data', (d) => logs.push(String(d)));
  await app.evaluate(({ dialog, shell }) => {
    globalThis.__smoke = { external: [], dialogs: [] };
    shell.openExternal = async (u) => void globalThis.__smoke.external.push(u);
    dialog.showMessageBox = async (...a) => {
      const opts = a.length > 1 ? a[1] : a[0];
      globalThis.__smoke.dialogs.push({ message: opts.message, detail: opts.detail });
      return { response: globalThis.__smoke.dialogResponse ?? 0, checkboxChecked: false };
    };
  });
  return { app, logs };
}

function prepareAppDir(distDir) {
  // electron <dir> needs a package.json; version/name come from the real package.json
  fs.writeFileSync(path.join(distDir, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: 'main.cjs' }, null, 2));
  return distDir;
}

function newUserData(origin, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-smoke-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ schema: 1, serverUrl: origin, ...extra }, null, 2));
  return dir;
}

async function recorderFlow(app, mainPage, fake, userData, opts) {
  const tag = opts.tag;
  const windowP = app.waitForEvent('window', { timeout: 20000 });
  await mainPage.evaluate(({ ws, m }) => window.meetledgerDesktop.openRecorder({ workspaceId: ws, meetingId: m }), { ws: WS, m: MEETING });
  const rec = await windowP;
  await rec.waitForURL(/app:\/\/desktop\/recorder\//, { timeout: 20000 });
  await rec.waitForFunction(() => document.querySelector('#meeting')?.value?.length > 0, null, { timeout: 20000 });
  check(`${tag} recorder: local bridge only on app:// page`, await rec.evaluate(() => typeof window.meetledgerLocal === 'object' && typeof window.require === 'undefined'));

  const preArm = await rec.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => (s.getTracks().forEach((t) => t.stop()), 'granted'), (e) => e.name));
  check(`${tag} recorder: microphone denied before consent/arming`, preArm === 'NotAllowedError', preArm);

  if (fake.state.consentState === 'pending') {
    check(`${tag} recorder: 「録音を準備」 disabled while consent is pending`, await rec.isDisabled('#prepare'));
    await rec.check('#consent-check');
    await rec.selectOption('#consent-method', 'verbal');
    await rec.click('#consent-save');
    await waitFor(() => fake.state.consentState === 'notified');
    check(`${tag} consent: POST /consent {kind:recording,state:notified}`, fake.state.consents.at(-1)?.kind === 'recording' && fake.state.consentState === 'notified', JSON.stringify(fake.state.consents.at(-1)));
  }
  await rec.waitForFunction(() => !document.querySelector('#prepare').disabled, null, { timeout: 10000 });

  // options
  await rec.waitForFunction(() => !document.querySelector('#cap-local').textContent.includes('確認中'), null, { timeout: 30000 });
  const capText = await rec.textContent('#cap-local');
  if (opts.mode === 'device') {
    await rec.waitForFunction(() => !document.querySelector('input[name="mode"][value="device"]').disabled, null, { timeout: 30000 }).catch(() => undefined);
    await rec.check('input[name="mode"][value="device"]');
  } else {
    await rec.check('input[name="mode"][value="server"]');
  }
  if (opts.uploadAudio && opts.mode === 'device') await rec.check('#upload-audio');
  else if (opts.mode === 'device') await rec.uncheck('#upload-audio');

  await rec.click('#prepare');
  await rec.waitForSelector('#rec-banner:not([hidden])', { timeout: 15000 });
  check(`${tag} prepare: POST /start {capture:"desktop"} after consent`, fake.state.starts.at(-1)?.capture === 'desktop', JSON.stringify(fake.state.starts.at(-1)));
  const armedTitles = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
  check(`${tag} indicator: window titles show 録音準備中 when armed`, armedTitles.every((t) => t.startsWith('● 録音準備中')), armedTitles.join(' | '));

  await rec.click('#start');
  await rec.waitForFunction(() => document.querySelector('#rec-label').textContent.includes('録音中') && !document.querySelector('#stop').disabled, null, { timeout: 20000 });
  const winInfo = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), top: w.isAlwaysOnTop(), min: w.isMinimizable(), url: w.webContents.getURL() })));
  const recWin = winInfo.find((w) => w.url.includes('/recorder/'));
  // setMinimizable() is macOS/Windows only; on every OS a minimize is undone while recording
  check(`${tag} indicator: recorder window always-on-top${process.platform === 'linux' ? '' : ' & not minimizable'} while recording`, recWin?.top === true && (process.platform === 'linux' || recWin?.min === false), JSON.stringify(recWin));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/recorder/'))?.minimize());
  await sleep(700);
  const minimized = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/recorder/'))?.isMinimized());
  check(`${tag} indicator: minimizing the recorder window while recording is undone`, minimized === false, String(minimized));
  check(`${tag} indicator: every window title starts with "● 録音中"`, winInfo.every((w) => w.title.startsWith('● 録音中')), winInfo.map((w) => w.title).join(' | '));
  const pageTitleOverride = await mainPage.evaluate(() => {
    document.title = 'page tries to hide it';
    return new Promise((r) => setTimeout(r, 300));
  });
  void pageTitleOverride;
  const mainTitle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('app://'))?.getTitle());
  check(`${tag} indicator: web page cannot remove the title prefix`, mainTitle?.startsWith('● 録音中'), mainTitle);

  await sleep(opts.seconds * 1000);
  const lv = await rec.evaluate(() => [document.querySelector('#lvl-mic').value, document.querySelector('#lvl-sys').value]);
  check(`${tag} capture: mic level meter moves (fake device)`, lv[0] > 0, `mic=${lv[0]} system=${lv[1]}`);

  await rec.click('#stop');
  await rec.waitForFunction(() => !document.querySelector('#finish').disabled, null, { timeout: 30000 });
  check(`${tag} stop: POST /end {expectMedia:${!!opts.uploadAudio}}`, fake.state.ends.at(-1)?.expectMedia === !!opts.uploadAudio, JSON.stringify(fake.state.ends.at(-1)));
  const after = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), top: w.isAlwaysOnTop() })));
  check(`${tag} indicator cleared after stop`, after.every((w) => !w.title.startsWith('●') && !w.top), JSON.stringify(after));

  const recDir = path.join(userData, 'recordings');
  const files = fs.readdirSync(recDir);
  const wav = files.find((f) => f.endsWith('.wav'));
  const webm = files.find((f) => f.endsWith('.webm'));
  if (opts.mode === 'device') {
    const w = wav ? wavInfo(path.join(recDir, wav)) : null;
    check(`${tag} WAV tap: 16 kHz / mono / 16-bit, duration ≈ recording`, w && w.riff === 'RIFF' && w.rate === 16000 && w.channels === 1 && w.bits === 16 && w.durationS > opts.seconds - 1.5 && w.durationS < opts.seconds + 3, JSON.stringify(w));
  }
  if (opts.uploadAudio) {
    const st = webm ? channelStats(path.join(recDir, webm)) : null;
    const rms = st ? perChannelRms(st.raw) : {};
    check(`${tag} webm: opus, 2 channels (L=mic, R=system)`, st?.codec === 'opus' && st?.channels === 2, st ? `${st.codec} ch=${st.channels} ${st.sampleRate}Hz` : 'missing');
    check(`${tag} webm: mic signal on LEFT, right silent (no system audio on Linux)`, rms[1] > -60 && (rms[2] === -Infinity || rms[2] < -80), `L=${rms[1]} dB, R=${rms[2]} dB`);
  }

  let rows = [];
  if (opts.mode === 'device') {
    await rec.click('#transcribe');
    await rec.waitForFunction(() => !document.querySelector('#segments').hidden || /失敗/.test(document.querySelector('#status').textContent), null, { timeout: opts.asrTimeout ?? 60000 });
    rows = await rec.$$eval('#segments tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
    const status = await rec.textContent('#status');
    check(`${tag} local ASR in utility process returned segments`, rows.length > 0, `${rows.length} rows; ${status}`);
    await rec.click('#submit');
    await waitFor(() => fake.state.transcripts.length >= opts.expectTranscripts);
    const t = fake.state.transcripts.at(-1);
    check(
      `${tag} POST /transcript/local {provider,model,language,segments}`,
      t && t.provider === 'local-sherpa' && typeof t.model === 'string' && Array.isArray(t.segments) && t.segments.length === rows.length,
      t ? JSON.stringify({ provider: t.provider, model: t.model, language: t.language, n: t.segments.length, first: t.segments[0] }) : 'none',
    );
    const wavLeft = fs.readdirSync(recDir).filter((f) => f.endsWith('.wav'));
    check(`${tag} 16 kHz working WAV deleted after text-only submit`, wavLeft.length === 0, wavLeft.join(','));
  }
  if (opts.uploadAudio) {
    await rec.click('#upload');
    await waitFor(() => fake.state.media.length >= 1);
    const m = fake.state.media.at(-1);
    const f = m?.file;
    let ok = false;
    let detail = 'no file part';
    if (f) {
      const tmp = path.join(os.tmpdir(), `ml-upload-${Date.now()}.webm`);
      fs.writeFileSync(tmp, f.data);
      const st = channelStats(tmp);
      ok = /filename="desktop-.*\.webm"/.test(f.headers) && /audio\/webm/.test(f.headers) && st.codec === 'opus' && st.channels === 2;
      detail = `${f.data.length} bytes, ${st.codec} ch=${st.channels}; ${f.headers.replace(/\r\n/g, ' ')}`;
      fs.rmSync(tmp, { force: true });
    }
    check(`${tag} POST /media multipart file=stereo opus webm`, ok, detail);
  }
  await rec.click('#finish');
  await rec.waitForFunction(() => document.querySelector('#rec-banner').hidden && !document.querySelector('#prepare').disabled, null, { timeout: 10000 }).catch(() => undefined);
  check(`${tag} finish: no recordings left on disk`, fs.readdirSync(recDir).length === 0, fs.readdirSync(recDir).join(','));
  return { rec, rows, capText };
}

// ------------------------------------------------------------------ phase 0: first run (no server configured)
async function phaseFirstRun() {
  const distDir = path.join(root, 'dist-smoke');
  const fake = await startFakeServer();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-smoke-first-'));
  const { app } = await launch(prepareAppDir(distDir), userData);
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/app:\/\/desktop\/settings\/index\.html/, { timeout: 30000 });
    check('0 first run: main window shows the local settings page', true, page.url());
    const csp = await page.evaluate(() => {
      const s = document.createElement('script');
      s.textContent = 'window.__inline = 1';
      document.head.append(s);
      return typeof window.__inline;
    });
    check('0 settings page CSP blocks inline script', csp === 'undefined', csp);
    await page.fill('#server-url', 'http://evil.example');
    await page.click('#test');
    await page.waitForFunction(() => document.querySelector('#server-result').textContent.length > 0 && !document.querySelector('#server-result').textContent.includes('確認しています'));
    check('0 settings: plain http to a non-loopback host is rejected', /localhost/.test(await page.textContent('#server-result')), await page.textContent('#server-result'));
    await page.fill('#server-url', fake.origin + '/some/path');
    await page.click('#test');
    await page.waitForFunction(() => /接続できました/.test(document.querySelector('#server-result').textContent), null, { timeout: 15000 });
    check('0 settings: connection test against /api/health', true, await page.textContent('#server-result'));
    const winP = app.waitForEvent('window', { timeout: 20000 });
    await page.click('#save-server');
    const main = await winP;
    await main.waitForURL(`${fake.origin}/`, { timeout: 20000 });
    const cfg = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
    check('0 save: config.json stores the normalized origin and the main window opens the server', cfg.serverUrl === fake.origin && (await main.title()) === 'Fake MeetLedger', JSON.stringify({ serverUrl: cfg.serverUrl }));
    check('0 bridge available after switching origin (preload re-created with new allowed origin)', await main.evaluate(() => typeof window.meetledgerDesktop === 'object'));
  } finally {
    await app.close().catch(() => undefined);
    fake.server.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ phase A: stub local-asr
async function phaseA() {
  const distDir = path.join(root, 'dist-smoke');
  if (!fs.existsSync(path.join(distDir, 'main.cjs'))) throw new Error('dist-smoke missing: run node scripts/build.mjs --outdir=dist-smoke --local-asr=stub');
  const fake = await startFakeServer();
  const userData = newUserData(fake.origin);
  const { app, logs } = await launch(prepareAppDir(distDir), userData);
  try {
    const page = await app.firstWindow();
    await page.waitForURL(`${fake.origin}/`, { timeout: 30000 });
    await page.waitForLoadState('domcontentloaded');

    // --- bridge exposure / isolation
    const bridge = await page.evaluate(() => ({
      type: typeof window.meetledgerDesktop,
      keys: window.meetledgerDesktop ? Object.keys(window.meetledgerDesktop).sort() : [],
      version: window.meetledgerDesktop?.version,
      platform: window.meetledgerDesktop?.platform,
      local: typeof window.meetledgerLocal,
      require: typeof window.require,
      process: typeof window.process,
      ipc: typeof window.ipcRenderer,
      electron: typeof window.electron,
    }));
    check('A web page: window.meetledgerDesktop exposed', bridge.type === 'object' && bridge.version === pkg.version && bridge.platform === process.platform, JSON.stringify(bridge.keys));
    check('A web page: no Node / ipcRenderer / local bridge in page world', bridge.local === 'undefined' && bridge.require === 'undefined' && bridge.process === 'undefined' && bridge.ipc === 'undefined' && bridge.electron === 'undefined', JSON.stringify(bridge));
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const p = w.webContents.getLastWebPreferences();
      return { contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity, webviewTag: p.webviewTag };
    });
    check('A webPreferences: contextIsolation, sandbox, no nodeIntegration, webSecurity', prefs.contextIsolation === true && prefs.sandbox === true && prefs.nodeIntegration === false && prefs.webSecurity !== false && !prefs.webviewTag, JSON.stringify(prefs));
    const ua = fake.state.requests.find((r) => r.path === '/')?.ua ?? '';
    check('A user agent carries MeetLedgerDesktop/<version>', ua.includes(`MeetLedgerDesktop/${pkg.version}`), ua.slice(-40));

    // --- capabilities
    const caps = await page.evaluate(() => window.meetledgerDesktop.capabilities());
    check('A capabilities(): Linux → systemAudio false with reason', caps.systemAudio === false && /Linux/.test(caps.reason), JSON.stringify(caps));
    check('A capabilities(): stub local-asr loaded, model not yet downloaded', caps.localTranscription.available === false && /未ダウンロード/.test(caps.localTranscription.reason), caps.localTranscription.reason);

    // --- IPC validation from the web page
    const v = await page.evaluate(async () => {
      const d = window.meetledgerDesktop;
      const err = (p) => p.then(() => 'resolved', (e) => (/^\[([a-z0-9_]+)\] /.exec(e.message) ?? [])[1] ?? `nocode:${e.message}`);
      return {
        badModel: await err(d.downloadModel('../../etc')),
        badMime: await err(d.saveRecording({ mimeType: 'text/html', data: new ArrayBuffer(8) })),
        extraKey: await err(d.saveRecording({ mimeType: 'audio/wav', data: new ArrayBuffer(8), path: '/etc/passwd' })),
        badToken: await err(d.transcribeLocal('../../x')),
        unknownToken: await err(d.transcribeLocal('a'.repeat(64))),
        badRef: await err(d.openRecorder({ workspaceId: 'x', meetingId: 'y' })),
      };
    });
    check('A IPC validation rejects bad input (model id, mime, unknown keys, tokens, ids)', v.badModel === 'invalid_input' && v.badMime === 'invalid_input' && v.extraKey === 'invalid_input' && v.badToken === 'invalid_input' && v.unknownToken === 'not_found' && v.badRef === 'invalid_input', JSON.stringify(v));

    // --- model download: explicit confirmation dialog with size + license
    await app.evaluate(() => (globalThis.__smoke.dialogResponse = 1));
    const cancelled = await page.evaluate(() => window.meetledgerDesktop.downloadModel('stub-ja'));
    const dlg = await app.evaluate(() => globalThis.__smoke.dialogs.at(-1));
    check('A downloadModel: confirmation dialog shows size + license; cancel downloads nothing', cancelled.cancelled === true && /サイズ: 2 KB/.test(dlg?.detail) && /ライセンス: MIT/.test(dlg?.detail), JSON.stringify({ cancelled, detail: dlg?.detail?.split('\n').slice(0, 3) }));
    await app.evaluate(() => (globalThis.__smoke.dialogResponse = 0));
    const progress = await page.evaluate(async () => {
      const seen = [];
      const off = window.meetledgerDesktop.onModelDownloadProgress((p) => seen.push(p));
      const r = await window.meetledgerDesktop.downloadModel('stub-ja');
      await new Promise((res) => setTimeout(res, 200));
      off();
      return { r, seen };
    });
    const models = await page.evaluate(() => window.meetledgerDesktop.listModels());
    check('A downloadModel: accepted → progress events → installed', progress.r.ok && progress.seen.some((p) => p.fraction === 1) && models[0]?.installed === true, JSON.stringify({ events: progress.seen.length, models }));
    const caps2 = await page.evaluate(() => window.meetledgerDesktop.capabilities());
    check('A capabilities(): local transcription available after download', caps2.localTranscription.available === true, caps2.localTranscription.reason);

    // --- web bridge: saveRecording + transcribeLocal (WAV only)
    const web = await page.evaluate(async () => {
      const n = 16000 * 2;
      const buf = new ArrayBuffer(44 + n * 2);
      const v = new DataView(buf);
      const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), true);
      const d = window.meetledgerDesktop;
      const saved = await d.saveRecording({ mimeType: 'audio/wav', data: buf });
      const r = await d.transcribeLocal(saved.fileToken, { language: 'ja' });
      const webmTok = await d.saveRecording({ mimeType: 'audio/webm', data: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]).buffer });
      const code = (e) => (/^\[([a-z0-9_]+)\] /.exec(e.message) ?? [])[1];
      const wrong = await d.transcribeLocal(webmTok.fileToken).then(() => 'resolved', code);
      await d.discardRecording(webmTok.fileToken);
      await d.discardRecording(saved.fileToken);
      const gone = await d.transcribeLocal(saved.fileToken).then(() => 'resolved', code);
      return { token: saved.fileToken.length, n: r.segments.length, provider: r.provider, wrong, gone };
    });
    check('A web bridge: saveRecording → transcribeLocal (WAV), webm refused, discard works', web.token === 64 && web.n === 2 && web.provider === 'local-sherpa' && web.wrong === 'invalid_input' && web.gone === 'not_found', JSON.stringify(web));

    // --- permissions: web origin may use the microphone (audio only); no camera / screen
    const perms = await page.evaluate(async () => {
      const r = (p) => p.then((s) => (s.getTracks().forEach((t) => t.stop()), 'granted'), (e) => e.name);
      return {
        mic: await r(navigator.mediaDevices.getUserMedia({ audio: true })),
        cam: await r(navigator.mediaDevices.getUserMedia({ video: true })),
        screen: await r(navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })),
        notif: await Notification.requestPermission(),
      };
    });
    check('A permissions: web origin mic granted; camera, display capture, notifications denied', perms.mic === 'granted' && perms.cam === 'NotAllowedError' && perms.screen !== 'granted' && perms.notif === 'denied', JSON.stringify(perms));

    // --- navigation restriction
    const opened = await page.evaluate(() => String(window.open('https://example.com/popup')));
    await page.evaluate(() => (location.href = 'https://example.com/nav'));
    await sleep(800);
    await page.evaluate(() => (location.href = 'file:///etc/passwd')).catch(() => undefined);
    await sleep(500);
    const ext = await app.evaluate(() => globalThis.__smoke.external);
    check('A navigation: other origins blocked in-window (stays on server), https opened externally, file: denied', page.url() === `${fake.origin}/` && opened === 'null' && ext.includes('https://example.com/popup') && ext.includes('https://example.com/nav') && !ext.some((u) => u.startsWith('file:')), JSON.stringify({ url: page.url(), opened, ext }));

    // --- recorder flow (stub ASR, upload)
    const { capText } = await recorderFlow(app, page, fake, userData, { tag: 'A', mode: 'device', uploadAudio: true, seconds: 4, expectTranscripts: 1 });
    void capText;
    const t = fake.state.transcripts.at(-1);
    check('A attribution without system audio keeps neutral diarization labels (never claims あなた)', t && t.segments.every((s) => s.speaker === '話者1' || s.speaker === '話者2'), JSON.stringify(t?.segments?.slice(0, 3)));

    // --- server checks: cookies + CSRF + Origin from the main-process client
    const writes = fake.state.requests.filter((r) => r.method === 'POST');
    check('A main-process API calls carry session cookie + CSRF; Origin is absent or the server origin', writes.length > 0 && writes.every((r) => r.cookie && r.csrf === CSRF && (r.origin === null || r.origin === fake.origin)), JSON.stringify(writes.map((w) => `${w.path.split('/').pop()} origin=${w.origin}`)));

    // --- consent gate on the server side as well: reset to pending and try to start directly via the recorder bridge
    fake.state.consentState = 'pending';
    const rec = app.windows().find((w) => w.url().includes('/recorder/'));
    const startsBefore = fake.state.starts.length;
    const gate = await rec.evaluate(({ ws, m }) => window.meetledgerLocal.recorder.prepare({ workspaceId: ws, meetingId: m, mode: 'server', uploadAudio: true, systemAudio: false }).then(() => 'armed', (e) => (/^\[([a-z0-9_]+)\] /.exec(e.message) ?? [])[1]), { ws: WS, m: MEETING });
    check('A consent gate: prepare refused while consent pending (no /start call)', gate === 'consent_required' && fake.state.starts.length === startsBefore, gate);
  } finally {
    await app.close().catch(() => undefined);
    fake.server.close();
  }
  const errors = logs.join('').split('\n').filter((l) => /\[meetledger\] ipc internal error|Uncaught|TypeError/.test(l));
  check('A main process logged no internal errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  fs.rmSync(userData, { recursive: true, force: true });
}

// ------------------------------------------------------------------ phase B: real packages/local-asr + SenseVoice
async function phaseB() {
  const distDir = path.join(root, 'dist');
  const modelDir = process.env.MEETLEDGER_SMOKE_MODEL_DIR ?? path.resolve(root, '../../models');
  const jaWav = path.join(modelDir, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/ja.wav');
  const info = fs.existsSync(path.join(distDir, 'build-info.json')) ? JSON.parse(fs.readFileSync(path.join(distDir, 'build-info.json'), 'utf8')) : null;
  if (!info || info.localAsr !== 'real' || !fs.existsSync(jaWav)) {
    console.log(`SKIP  phase B (real local-asr): ${!info ? 'dist/ not built' : info.localAsr !== 'real' ? 'dist built without local-asr' : `no models at ${modelDir}`}`);
    return;
  }
  const fake = await startFakeServer();
  fake.state.consentState = 'confirmed';
  const userData = newUserData(fake.origin, { diarization: false });
  fs.symlinkSync(modelDir, path.join(userData, 'models'), 'dir'); // read-only reuse of already downloaded models
  // the fake microphone plays the SenseVoice Japanese sample
  const { app, logs } = await launch(root, userData, [`--use-file-for-fake-audio-capture=${jaWav}`]); // package.json main → dist/main.cjs
  try {
    const page = await app.firstWindow();
    await page.waitForURL(`${fake.origin}/`, { timeout: 30000 });
    const caps = await page.evaluate(() => window.meetledgerDesktop.capabilities());
    check('B capabilities(): real local-asr + sherpa-onnx-node + SenseVoice available', caps.localTranscription.available === true, caps.localTranscription.reason);
    const models = await page.evaluate(() => window.meetledgerDesktop.listModels());
    check('B listModels(): real catalog with size + license', models.length >= 2 && models.every((m) => m.sizeBytes > 0 && m.license !== '不明'), JSON.stringify(models.map((m) => ({ id: m.id, installed: m.installed, size: m.sizeBytes, license: m.license.slice(0, 60) }))));
    const bytes = [...fs.readFileSync(jaWav)];
    const t0 = Date.now();
    const r = await page.evaluate(async (arr) => {
      const d = window.meetledgerDesktop;
      const s = await d.saveRecording({ mimeType: 'audio/wav', data: new Uint8Array(arr).buffer });
      try {
        return await d.transcribeLocal(s.fileToken, { language: 'ja', diarization: false });
      } finally {
        await d.discardRecording(s.fileToken);
      }
    }, bytes);
    const text = r.segments.map((s) => s.text).join('');
    check('B web bridge transcribeLocal(ja.wav) → Japanese text via SenseVoice in utility process', /中学/.test(text) && /弁当/.test(text), `${Date.now() - t0} ms: ${text.slice(0, 80)}`);

    const { rows } = await recorderFlow(app, page, fake, userData, { tag: 'B', mode: 'device', uploadAudio: false, seconds: 8, expectTranscripts: 1, asrTimeout: 120000 });
    const recText = rows.map((x) => x[2]).join('');
    check('B recorder: fake mic playing ja.wav → on-device transcript contains the spoken Japanese', /弁当|中学/.test(recText), recText.slice(0, 120));
    check('B device mode without upload: no POST /media', fake.state.media.length === 0);
  } finally {
    await app.close().catch(() => undefined);
    fake.server.close();
  }
  const errors = logs.join('').split('\n').filter((l) => /ipc internal error|Uncaught/.test(l));
  check('B main process logged no internal errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  fs.rmSync(userData, { recursive: true, force: true });
}

try {
  await phaseFirstRun();
  await phaseA();
  if (!process.argv.includes('--a-only')) await phaseB();
} catch (e) {
  check('smoke run completed', false, e.stack ?? e.message);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
