// MeetLedger Desktop — main process entry.

import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, dialog, Menu, net, session, type WebContents, type WebPreferences } from 'electron';
import { CH, type Capabilities, type ModelInfo, type RecState } from '../shared/ipc';
import { LOCAL_PAGES, originOf } from '../shared/urlPolicy';
import { localAsrPlatformSupport, systemAudioCapability } from '../shared/capability';
import { formatBytes, normalizeProgress } from '../shared/models';
import { loadConfig, saveConfig, type DesktopConfig } from './config';
import { registerAppScheme, handleAppScheme } from './appProtocol';
import { hardenWebContents, installSessionSecurity, type SecurityDeps } from './security';
import { MeetLedgerApi, type FetchFn } from './apiClient';
import { AsrError, AsrHost } from './asrHost';
import { RecordingStore } from './recordingStore';
import { RecorderSession, type RawTranscript } from './recorderSession';
import { RecordingIndicator } from './indicator';
import { registerIpc } from './ipc';
import type { CatalogResult, ProbeResult } from '../worker/protocol';

// ---------------------------------------------------------------- pre-ready setup
if (!app.isPackaged && process.env.MEETLEDGER_USER_DATA_DIR) {
  // development / smoke tests only: isolate profile
  app.setPath('userData', path.resolve(process.env.MEETLEDGER_USER_DATA_DIR));
}
app.enableSandbox();

const log = (msg: string, meta?: Record<string, unknown>) => {
  // Never log transcript text, audio, tokens or URLs with credentials — ids / counts / codes only.
  console.info(`[meetledger] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`);
};

const userData = app.getPath('userData');
const configFile = path.join(userData, 'config.json');
let config: DesktopConfig = loadConfig(configFile);
const startupUseSystemPicker = process.platform === 'darwin' && config.macUseSystemPicker;

if (process.platform === 'darwin' && config.macLegacyLoopback) {
  // Electron 44: fall back from Core Audio taps to the older ScreenCaptureKit loopback path (removed in Electron 45).
  app.commandLine.appendSwitch('disable-features', 'MacCatapLoopbackAudioForScreenShare');
}
app.userAgentFallback = `${app.userAgentFallback} MeetLedgerDesktop/${app.getVersion()}`;

registerAppScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------------------------------------------------------------- state
const distDir = __dirname;
const rendererDir = path.join(distDir, 'renderer');
const iconPath = path.join(distDir, 'assets', 'icon.png');
const preloadPath = path.join(distDir, 'preload.cjs');
const modelDir = path.join(userData, 'models');
const store = new RecordingStore(path.join(userData, 'recordings'));

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let recorderWindow: BrowserWindow | null = null;
let quitting = false;

const serverOrigin = () => config.serverUrl;
const osVersion = process.getSystemVersion();
const isWin = (w: BrowserWindow | null, wc: WebContents) => !!w && !w.isDestroyed() && w.webContents === wc;

const nativeBase = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules') : path.join(app.getAppPath(), 'node_modules');
const sherpaPlatform = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const asr = new AsrHost(path.join(distDir, 'asr-worker.cjs'), [path.join(nativeBase, `sherpa-onnx-${sherpaPlatform}`)]);

function updateConfig(patch: Partial<DesktopConfig>): DesktopConfig {
  const prevServer = config.serverUrl;
  config = { ...config, ...patch };
  saveConfig(configFile, config);
  if (patch.serverUrl !== undefined && patch.serverUrl !== prevServer) {
    log('server changed');
    // recreate the main window so the preload gets the new allowed origin (deferred: the caller may be that window)
    setTimeout(() => {
      recreateMainWindow();
      settingsWindow?.close();
    }, 50);
  }
  return config;
}

// ---------------------------------------------------------------- capabilities / models / ASR
function systemAudio() {
  return systemAudioCapability(process.platform, osVersion, config.verifiedSystemAudioOsVersion);
}

let probeCache: ProbeResult | null = null;
async function probe(): Promise<ProbeResult | null> {
  if (probeCache) return probeCache;
  try {
    probeCache = await asr.call<ProbeResult>('probe', {}, undefined, 30_000);
    log('asr probe', { module: probeCache.module.ok, missing: probeCache.module.missing, runtime: probeCache.runtime.ok });
    return probeCache;
  } catch (e) {
    log('asr probe failed', { code: (e as AsrError).code });
    return null;
  }
}

async function listModels(): Promise<ModelInfo[]> {
  const support = localAsrPlatformSupport(process.platform, process.arch);
  if (!support.supported) throw new AsrError('local_asr_unsupported', support.reason);
  const p = await probe();
  if (!p?.module.ok) throw new AsrError('local_asr_unavailable', localUnavailableReason(p));
  const r = await asr.call<CatalogResult>('catalog', { modelDir }, undefined, 60_000);
  return r.models;
}

function localUnavailableReason(p: ProbeResult | null): string {
  if (!p) return '文字起こしプロセスを起動できませんでした';
  if (p.module.error) return `ローカル文字起こしモジュール（@meetledger/local-asr）を読み込めません: ${p.module.error}`;
  if (!p.module.ok) return `ローカル文字起こしモジュール（@meetledger/local-asr）が未実装です（不足: ${p.module.missing.join(', ')}）`;
  if (!p.runtime.ok) return `sherpa-onnx ネイティブランタイムを読み込めません: ${p.runtime.error ?? ''}`;
  return '';
}

async function capabilities(): Promise<Capabilities> {
  const sys = systemAudio();
  const base = { systemAudio: sys.systemAudio, reason: sys.reason, platform: process.platform, arch: process.arch, osVersion };
  const support = localAsrPlatformSupport(process.platform, process.arch);
  if (!support.supported) return { ...base, localTranscription: { available: false, reason: support.reason } };
  const p = await probe();
  const why = localUnavailableReason(p);
  if (why) return { ...base, localTranscription: { available: false, reason: why } };
  try {
    const models = await listModels();
    const asrModels = models.filter((m) => m.installed && !m.diarization);
    if (asrModels.length === 0) {
      return { ...base, localTranscription: { available: false, reason: 'モデルが未ダウンロードです。設定画面でモデルをダウンロードしてください。' } };
    }
    return { ...base, localTranscription: { available: true, reason: `利用可能（${asrModels.map((m) => m.name).join(', ')}）` } };
  } catch (e) {
    return { ...base, localTranscription: { available: false, reason: (e as Error).message } };
  }
}

const downloading = new Set<string>();
async function downloadModel(wc: WebContents, id: string) {
  const models = await listModels();
  const m = models.find((x) => x.id === id);
  if (!m) throw new AsrError('not_found', 'モデルが見つかりません');
  if (m.installed) return { ok: true, alreadyInstalled: true };
  if (downloading.has(id)) throw new AsrError('busy', 'このモデルはダウンロード中です');
  const win = BrowserWindow.fromWebContents(wc);
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['ダウンロード', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: '文字起こしモデルのダウンロード',
    message: `「${m.name}」をダウンロードしますか？`,
    detail: [
      `サイズ: ${formatBytes(m.sizeBytes)}`,
      `ライセンス: ${m.license}`,
      m.attribution ? `クレジット表記: ${m.attribution}` : null,
      m.sourceUrl ? `配布元: ${m.sourceUrl}` : null,
      `保存先: ${modelDir}`,
      '',
      'ダウンロードはこの端末とモデル配布元の間だけで行われます。会議の音声や内容は送信されません。',
      'ライセンス条件（商用利用・クレジット表記など）を確認のうえダウンロードしてください。',
    ]
      .filter((x) => x !== null)
      .join('\n'),
  };
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (r.response !== 0) return { ok: false, cancelled: true };
  downloading.add(id);
  log('model download start', { id });
  try {
    await asr.call('download', { id, modelDir }, (args) => {
      if (!wc.isDestroyed()) wc.send(CH.evtModelProgress, normalizeProgress(id, args));
    });
    if (!wc.isDestroyed()) wc.send(CH.evtModelProgress, { id, receivedBytes: null, totalBytes: null, fraction: 1, done: true });
    log('model download done', { id });
    return { ok: true };
  } catch (e) {
    if (!wc.isDestroyed()) wc.send(CH.evtModelProgress, { id, receivedBytes: null, totalBytes: null, fraction: null, error: (e as Error).message });
    throw e;
  } finally {
    downloading.delete(id);
  }
}

async function transcribeWav(wavPath: string, opts: { model?: string; language?: string; diarization?: boolean }): Promise<RawTranscript> {
  let model = opts.model ?? config.model ?? undefined;
  if (!model) {
    const installed = (await listModels()).filter((m) => m.installed && !m.diarization);
    if (installed.length === 0) throw new AsrError('no_model', '文字起こしモデルがダウンロードされていません（設定画面）');
    model = installed[0]!.id;
  }
  const language = opts.language && opts.language !== 'auto' ? opts.language : config.language;
  return asr.call<RawTranscript>('transcribe', {
    wavPath,
    modelDir,
    model,
    numThreads: config.numThreads,
    diarization: opts.diarization ?? config.diarization,
    language,
  });
}

// ---------------------------------------------------------------- server API (shares the main window's cookies)
const sessionFetch: FetchFn = (url, init) => session.defaultSession.fetch(url, init);
const netFetch: FetchFn = (url, init) => net.fetch(url, { ...init, credentials: 'omit' });
const api = new MeetLedgerApi(sessionFetch, serverOrigin, { appVersion: app.getVersion(), platform: process.platform });

// ---------------------------------------------------------------- recording session + indicator
const indicator = new RecordingIndicator({
  iconPath,
  windows: () => [mainWindow, settingsWindow, recorderWindow].filter((w): w is BrowserWindow => !!w && !w.isDestroyed()),
  recorderWindow: () => recorderWindow,
  onOpenMain: () => showMain(),
  onOpenRecorder: () => openRecorder(null),
  onQuit: () => app.quit(),
});

const recSession = new RecorderSession({
  api,
  store,
  transcribeWav: (p, o) => transcribeWav(p, o),
  emit: (ownerId, state: RecState) => {
    const w = recorderWindow;
    if (w && !w.isDestroyed() && w.webContents.id === ownerId) w.webContents.send(CH.evtRecState, state);
  },
  onStateChange: (s) => {
    indicator.update(s);
    log('recording state', { phase: s.phase, mode: s.mode, systemAudio: s.systemAudioActive });
  },
  onSystemAudioObserved: () => {
    if (process.platform === 'darwin' && config.verifiedSystemAudioOsVersion !== osVersion) {
      updateConfig({ verifiedSystemAudioOsVersion: osVersion });
      log('system audio verified on this macOS version');
    }
  },
  platform: process.platform,
});

// ---------------------------------------------------------------- windows
function prefs(extra: string[] = []): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    safeDialogs: true,
    devTools: !app.isPackaged,
    additionalArguments: [`--meetledger-version=${app.getVersion()}`, ...extra],
  };
}

function decorateTitles(win: BrowserWindow): void {
  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    win.setTitle(indicator.decorate(title || 'MeetLedger'));
  });
}

function loadMainContent(win: BrowserWindow): void {
  if (config.serverUrl) void win.loadURL(`${config.serverUrl}/`);
  else void win.loadURL(LOCAL_PAGES.settings);
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: 'MeetLedger',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#ffffff',
    webPreferences: prefs(config.serverUrl ? [`--meetledger-server-origin=${config.serverUrl}`] : []),
  });
  decorateTitles(win);
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */) return;
    if (config.serverUrl && originOf(url) === config.serverUrl) {
      log('server load failed', { code });
      void win.loadURL(`${LOCAL_PAGES.settings}?error=${encodeURIComponent(`${desc} (${code})`)}`);
    }
  });
  const wcId = win.webContents.id;
  win.webContents.on('destroyed', () => void store.discardOwner(wcId));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  loadMainContent(win);
  return win;
}

function recreateMainWindow(): void {
  const old = mainWindow;
  mainWindow = createMainWindow();
  old?.destroy();
}

function showMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openSettings(): void {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL().startsWith(LOCAL_PAGES.settings)) {
    mainWindow.focus();
    return;
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 760,
    height: 820,
    title: 'MeetLedger Desktop 設定',
    parent: mainWindow ?? undefined,
    show: false,
    webPreferences: prefs(),
  });
  decorateTitles(settingsWindow);
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  settingsWindow.on('closed', () => (settingsWindow = null));
  void settingsWindow.loadURL(LOCAL_PAGES.settings);
}

function openRecorder(ref: { workspaceId: string; meetingId: string } | null): void {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    // never retarget a window that is recording; otherwise reload with the requested meeting
    if (ref && !recSession.isActive()) void recorderWindow.loadURL(`${LOCAL_PAGES.recorder}?ws=${ref.workspaceId}&m=${ref.meetingId}`);
    recorderWindow.show();
    recorderWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 520,
    height: 820,
    minWidth: 420,
    minHeight: 520,
    title: 'MeetLedger 録音',
    show: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: prefs(),
  });
  recorderWindow = win;
  const wcId = win.webContents.id;
  decorateTitles(win);
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (!recSession.isActive() || win.isDestroyed()) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['録音を停止して閉じる', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: '録音中です',
      message: '録音中です。ウィンドウを閉じると録音を停止します。',
      detail: '録音済みの音声はこの端末に保存されたまま残ります（設定画面から削除できます）。',
    });
    if (choice === 0) void recSession.abandon(wcId).finally(() => win.destroy());
  });
  win.webContents.on('render-process-gone', () => void recSession.abandon(wcId));
  win.webContents.on('did-start-navigation', (e) => {
    // a reload kills capture in the renderer: close the session instead of leaving it armed
    if (e.isMainFrame && !e.isSameDocument && recSession.isActive()) void recSession.abandon(wcId);
  });
  win.on('closed', () => {
    if (recorderWindow === win) recorderWindow = null;
    void recSession.abandon(wcId);
  });
  const q = ref ? `?ws=${ref.workspaceId}&m=${ref.meetingId}` : '';
  void win.loadURL(`${LOCAL_PAGES.recorder}${q}`);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'ファイル',
      submenu: [
        { label: '設定…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
        { label: 'デスクトップ録音…', accelerator: 'CmdOrCtrl+Shift+R', click: () => openRecorder(null) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: '終了' },
      ],
    },
    { role: 'editMenu', label: '編集' },
    {
      label: '表示',
      submenu: [
        { role: 'reload', label: '再読み込み' },
        ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu', label: 'ウィンドウ' },
    {
      label: 'ヘルプ',
      submenu: [
        {
          label: 'バージョン情報',
          click: () =>
            void dialog.showMessageBox({
              type: 'info',
              title: 'MeetLedger Desktop',
              message: `MeetLedger Desktop ${app.getVersion()}`,
              detail: `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}\n${process.platform} ${process.arch} ${osVersion}\n\n文字起こしモデルのライセンスとクレジットは「設定」に表示されます。`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- lifecycle
app.on('second-instance', () => showMain());

app.on('web-contents-created', (_e, contents) => hardenWebContents(contents, securityDeps));

const securityDeps: SecurityDeps = {
  serverOrigin,
  isMainWindow: (wc) => isWin(mainWindow, wc) || isWin(settingsWindow, wc),
  isRecorderWindow: (wc) => isWin(recorderWindow, wc),
  captureAllowed: (wc) => recSession.captureAllowedFor(wc.id),
  systemAudioSupported: () => systemAudio().systemAudio !== false,
  useSystemPicker: startupUseSystemPicker,
  log,
};

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('jp.meetledger.desktop');
  const ses = session.defaultSession;
  installSessionSecurity(ses, securityDeps);
  handleAppScheme(ses, rendererDir);
  registerIpc({
    serverOrigin,
    isMainWindow: (wc) => isWin(mainWindow, wc),
    isSettingsWindow: (wc) => isWin(settingsWindow, wc),
    isRecorderWindow: (wc) => isWin(recorderWindow, wc),
    config: () => config,
    updateConfig,
    capabilities,
    listModels,
    downloadModel,
    transcribeWav,
    openRecorder,
    openSettings,
    api,
    netFetch,
    session: recSession,
    store,
    osVersion,
    systemAudioPossible: () => systemAudio().systemAudio !== false,
    log,
  });
  buildMenu();
  mainWindow = createMainWindow();
  indicator.initTray();
  log('ready', { version: app.getVersion(), electron: process.versions.electron, platform: process.platform, configured: !!config.serverUrl });
});

app.on('activate', () => showMain());

app.on('before-quit', (e) => {
  if (quitting) return;
  if (recSession.isActive()) {
    e.preventDefault();
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['録音を停止して終了', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: '録音中です',
      message: '録音中です。終了すると録音を停止します。',
    });
    if (choice !== 0) return;
    quitting = true;
    void recSession.abandon(null).finally(() => app.quit());
    return;
  }
  quitting = true;
});

app.on('will-quit', () => {
  asr.dispose();
  indicator.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
