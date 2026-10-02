// First-run / settings page (app://desktop/settings/index.html).

import type { DesktopConfigPublic, ModelInfo, ModelProgress } from '../../shared/ipc';
import '../../shared/bridge';
import { formatBytes } from '../../shared/models';

const D = window.meetledgerDesktop!;
const L = window.meetledgerLocal!;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  loadError: $('load-error'),
  url: $<HTMLInputElement>('server-url'),
  test: $<HTMLButtonElement>('test'),
  saveServer: $<HTMLButtonElement>('save-server'),
  serverResult: $('server-result'),
  uploadDefault: $<HTMLInputElement>('upload-default'),
  language: $<HTMLSelectElement>('language'),
  threads: $<HTMLInputElement>('threads'),
  diarization: $<HTMLInputElement>('diarization'),
  model: $<HTMLSelectElement>('model'),
  saveDefaults: $<HTMLButtonElement>('save-defaults'),
  defaultsResult: $('defaults-result'),
  localCap: $('local-cap'),
  models: $<HTMLTableElement>('models'),
  credits: $('credits'),
  recordings: $('recordings'),
  clear: $<HTMLButtonElement>('clear-recordings'),
  systemCap: $('system-cap'),
  macOptions: $('mac-options'),
  macPicker: $<HTMLInputElement>('mac-picker'),
  macLegacy: $<HTMLInputElement>('mac-legacy'),
  saveMac: $<HTMLButtonElement>('save-mac'),
  about: $('about'),
};

let cfg: DesktopConfigPublic | null = null;
const progress = new Map<string, ModelProgress>();

const msg = (e: unknown) => (e as Error)?.message ?? String(e);

function fillConfig(c: DesktopConfigPublic): void {
  cfg = c;
  el.url.value = c.serverUrl ?? '';
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) r.checked = r.value === c.processingMode;
  el.uploadDefault.checked = c.uploadAudioDefault;
  el.language.value = c.language;
  el.threads.value = String(c.numThreads);
  el.diarization.checked = c.diarization;
  el.macPicker.checked = c.macUseSystemPicker;
  el.macLegacy.checked = c.macLegacyLoopback;
}

async function loadConfig(): Promise<void> {
  const r = await L.config.get();
  fillConfig(r.config);
  el.recordings.textContent = `端末に保存されている録音ファイル: ${r.recordings.files} 件（${formatBytes(r.recordings.bytes)}）。送信・アップロード後の作業ファイルは自動で削除されます。`;
  el.clear.disabled = r.recordings.files === 0;
  el.about.textContent = `MeetLedger Desktop ${D.version} / ${D.platform} ${r.osVersion}`;
}

function renderModels(models: ModelInfo[]): void {
  const body = el.models.tBodies[0]!;
  body.replaceChildren();
  const keep = el.model.value || cfg?.model || '';
  el.model.replaceChildren();
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '自動（ダウンロード済みの最初のモデル）';
  el.model.append(auto);
  el.credits.replaceChildren();
  for (const m of models) {
    const tr = document.createElement('tr');
    const p = progress.get(m.id);
    const status = m.installed ? 'ダウンロード済み' : p?.error ? `失敗: ${p.error}` : p ? `ダウンロード中 ${p.fraction !== null ? Math.round(p.fraction * 100) + '%' : formatBytes(p.receivedBytes)}` : '未ダウンロード';
    for (const t of [m.name + (m.diarization ? '（話者分離）' : ''), m.languages.join(', ') || '—', formatBytes(m.sizeBytes), m.license, status]) {
      const td = document.createElement('td');
      td.textContent = t;
      tr.append(td);
    }
    const td = document.createElement('td');
    if (!m.installed) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'secondary';
      b.textContent = 'ダウンロード…';
      b.disabled = !!p && !p.done && !p.error;
      b.addEventListener('click', () => void download(m.id));
      td.append(b);
    }
    tr.append(td);
    body.append(tr);
    if (m.installed && !m.diarization) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name;
      el.model.append(o);
    }
    if (m.installed && (m.attribution || m.license)) {
      const li = document.createElement('li');
      li.textContent = `${m.name}: ${m.license}${m.attribution ? ` — ${m.attribution}` : ''}${m.sourceUrl ? ` (${m.sourceUrl})` : ''}`;
      el.credits.append(li);
    }
  }
  el.model.value = [...el.model.options].some((o) => o.value === keep) ? keep : '';
  if (el.credits.childElementCount === 0) {
    const li = document.createElement('li');
    li.textContent = 'ダウンロード済みのモデルはありません。';
    el.credits.append(li);
  }
}

async function loadModels(): Promise<void> {
  try {
    renderModels(await D.listModels());
  } catch (e) {
    el.models.tBodies[0]!.replaceChildren();
    el.localCap.textContent = `端末内文字起こし: 利用不可 — ${msg(e)}`;
  }
}

async function loadCaps(): Promise<void> {
  const c = await D.capabilities();
  el.localCap.textContent = `端末内文字起こし: ${c.localTranscription.available ? '利用可能' : '利用不可'} — ${c.localTranscription.reason}`;
  const s = c.systemAudio === true ? '取得できます' : c.systemAudio === 'unknown' ? '取得できる見込み（未検証）' : '取得できません';
  el.systemCap.textContent = `システム音声: ${s} — ${c.reason}`;
  el.macOptions.hidden = c.platform !== 'darwin';
}

async function download(id: string): Promise<void> {
  try {
    progress.set(id, { id, receivedBytes: 0, totalBytes: null, fraction: 0 });
    const r = await D.downloadModel(id); // main shows the size/license confirmation dialog
    if (r.cancelled) progress.delete(id);
  } catch (e) {
    progress.set(id, { id, receivedBytes: null, totalBytes: null, fraction: null, error: msg(e) });
  }
  await loadModels();
  await loadCaps().catch(() => undefined);
}

D.onModelDownloadProgress((p) => {
  progress.set(p.id, p);
  if (p.done) progress.delete(p.id);
  void loadModels();
});

el.test.addEventListener('click', async () => {
  el.serverResult.textContent = '接続を確認しています…';
  try {
    const r = await L.config.testServer(el.url.value);
    el.serverResult.textContent = r.ok ? `接続できました: ${r.origin}（${r.detail}）` : `${r.origin}: ${r.detail}`;
  } catch (e) {
    el.serverResult.textContent = msg(e);
  }
});

el.saveServer.addEventListener('click', async () => {
  el.serverResult.textContent = '確認しています…';
  try {
    const r = await L.config.testServer(el.url.value);
    if (!r.ok && !window.confirm(`${r.detail}\nこのまま保存しますか？`)) {
      el.serverResult.textContent = r.detail;
      return;
    }
    const c = await L.config.set({ serverUrl: r.origin });
    fillConfig(c);
    el.serverResult.textContent = `保存しました: ${c.serverUrl}。メインウィンドウでサーバーを開きます。`;
  } catch (e) {
    el.serverResult.textContent = msg(e);
  }
});

el.saveDefaults.addEventListener('click', async () => {
  try {
    const mode = (document.querySelector('input[name="mode"]:checked') as HTMLInputElement | null)?.value === 'server' ? 'server' : 'device';
    const c = await L.config.set({
      processingMode: mode,
      uploadAudioDefault: el.uploadDefault.checked,
      language: el.language.value as DesktopConfigPublic['language'],
      numThreads: Number(el.threads.value),
      diarization: el.diarization.checked,
      model: el.model.value || null,
    });
    fillConfig(c);
    el.defaultsResult.textContent = '保存しました。';
  } catch (e) {
    el.defaultsResult.textContent = msg(e);
  }
});

el.saveMac.addEventListener('click', async () => {
  try {
    fillConfig(await L.config.set({ macUseSystemPicker: el.macPicker.checked, macLegacyLoopback: el.macLegacy.checked }));
    el.systemCap.textContent += '（保存しました。再起動後に反映されます）';
  } catch (e) {
    el.systemCap.textContent = msg(e);
  }
});

el.clear.addEventListener('click', async () => {
  if (!window.confirm('端末に保存されている録音ファイルをすべて削除しますか？（録音中のファイルは削除されません）')) return;
  try {
    const r = await L.config.clearRecordings();
    el.recordings.textContent = `${r.removed} 件削除しました。`;
    await loadConfig();
  } catch (e) {
    el.recordings.textContent = msg(e);
  }
});

(async () => {
  const err = new URLSearchParams(location.search).get('error');
  if (err) {
    el.loadError.hidden = false;
    el.loadError.textContent = `サーバーに接続できませんでした: ${err}。URL とネットワークを確認してください。`;
  }
  try {
    await loadConfig();
  } catch (e) {
    el.loadError.hidden = false;
    el.loadError.textContent = msg(e);
  }
  void loadCaps().catch((e) => (el.localCap.textContent = msg(e)));
  void loadModels();
})();
