// Desktop recorder page (app://desktop/recorder/index.html).
// Flow: 1 select meeting → 2 consent recorded (server consent API) → 3 options → prepare (main verifies consent and
// calls POST /start) → 4 record (explicit click) → stop → 5 local ASR + review + submit text / upload audio.
// All DOM writes use textContent (meeting titles / transcripts are untrusted data).

import type { Capabilities, LocalTranscriptResult, RecState } from '../../shared/ipc';
import type { MeetingSummaryDto } from '../../shared/dto';
import '../../shared/bridge';
import { DualChannelRecorder } from './capture';

const D = window.meetledgerDesktop!;
const L = window.meetledgerLocal!;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  banner: $('rec-banner'),
  recLabel: $('rec-label'),
  elapsed: $('rec-elapsed'),
  sources: $('rec-sources'),
  loginHint: $('login-hint'),
  ws: $<HTMLSelectElement>('ws'),
  meeting: $<HTMLSelectElement>('meeting'),
  reload: $<HTMLButtonElement>('reload'),
  newTitle: $<HTMLInputElement>('new-title'),
  create: $<HTMLButtonElement>('create'),
  info: $('meeting-info'),
  consentState: $('consent-state'),
  consentForm: $('consent-form'),
  consentCheck: $<HTMLInputElement>('consent-check'),
  consentMethod: $<HTMLSelectElement>('consent-method'),
  consentKind: $<HTMLSelectElement>('consent-kind'),
  consentSave: $<HTMLButtonElement>('consent-save'),
  uploadAudio: $<HTMLInputElement>('upload-audio'),
  useSystem: $<HTMLInputElement>('use-system'),
  capSystem: $('cap-system'),
  capLocal: $('cap-local'),
  prepare: $<HTMLButtonElement>('prepare'),
  start: $<HTMLButtonElement>('start'),
  stop: $<HTMLButtonElement>('stop'),
  cancelPrep: $<HTMLButtonElement>('cancel-prep'),
  lvlMic: $<HTMLMeterElement>('lvl-mic'),
  lvlSys: $<HTMLMeterElement>('lvl-sys'),
  resultInfo: $('result-info'),
  transcribe: $<HTMLButtonElement>('transcribe'),
  submit: $<HTMLButtonElement>('submit'),
  upload: $<HTMLButtonElement>('upload'),
  finish: $<HTMLButtonElement>('finish'),
  segments: $<HTMLTableElement>('segments'),
  status: $('status'),
  warnings: $('warnings'),
  openSettings: $<HTMLButtonElement>('open-settings'),
};

let caps: Capabilities | null = null;
let current: MeetingSummaryDto | null = null;
let state: RecState | null = null;
let rec: DualChannelRecorder | null = null;
let result: LocalTranscriptResult | null = null;
let submitted = false;
let uploaded = false;
let busy = false;
let meterTimer: number | null = null;

const CONSENT_LABEL: Record<string, string> = {
  not_recording: '録音しない設定',
  pending: '未確認（通知/同意の記録が必要です）',
  notified: '参加者に通知済み',
  confirmed: '参加者の同意あり',
  declined: '参加者が録音を拒否（録音できません）',
};
const MODE_LABEL: Record<string, string> = { local: 'ローカル（外部APIに送らない）', cloud: 'クラウド可', none: '文字起こししない' };

function setStatus(msg: string): void {
  el.status.textContent = msg;
}

function warn(msg: string): void {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString('ja-JP')} ${msg}`;
  el.warnings.prepend(li);
}

function errMsg(e: unknown): string {
  const err = e as { code?: string; message?: string };
  return err?.message ?? String(e);
}

async function guarded(label: string, fn: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  try {
    await fn();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'unauthenticated') showLoginHint();
    warn(`${label}: ${errMsg(e)}`);
    setStatus(`${label}に失敗しました: ${errMsg(e)}`);
  } finally {
    busy = false;
    render();
  }
}

function showLoginHint(): void {
  el.loginHint.hidden = false;
  el.loginHint.textContent = 'MeetLedger にログインしていません。メインウィンドウでログインしてから「再読み込み」を押してください。';
}

function mode(): 'device' | 'server' {
  return (document.querySelector('input[name="mode"]:checked') as HTMLInputElement | null)?.value === 'server' ? 'server' : 'device';
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function option(sel: HTMLSelectElement, value: string, text: string): void {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  sel.append(o);
}

// ---------------------------------------------------------------- data loading

async function loadWorkspaces(preselect?: string | null): Promise<void> {
  const me = await L.api.me();
  el.loginHint.hidden = true;
  el.ws.replaceChildren();
  for (const w of me.workspaces) option(el.ws, w.id, `${w.name}${w.isSample ? '（サンプル）' : ''}`);
  if (preselect && me.workspaces.some((w) => w.id === preselect)) el.ws.value = preselect;
  if (me.workspaces.length === 0) setStatus('参加しているワークスペースがありません');
}

async function loadMeetings(preselect?: string | null): Promise<void> {
  el.meeting.replaceChildren();
  current = null;
  if (!el.ws.value) return;
  const items = await L.api.meetings(el.ws.value);
  option(el.meeting, '', items.length ? '— 会議を選択 —' : '（会議がありません。新規作成してください）');
  for (const m of items) {
    const when = m.scheduledStart ?? m.startedAt;
    option(el.meeting, m.id, `${m.title}${when ? ` (${new Date(when).toLocaleString('ja-JP')})` : ''} [${m.status}]`);
  }
  if (preselect && items.some((m) => m.id === preselect)) {
    el.meeting.value = preselect;
    await loadMeeting(preselect);
  }
}

async function loadMeeting(id: string): Promise<void> {
  current = id ? await L.api.meeting(el.ws.value, id) : null;
  renderMeeting();
}

function renderMeeting(): void {
  el.info.replaceChildren();
  if (!current) {
    el.consentState.textContent = '会議を選択してください';
    return;
  }
  const rows: [string, string][] = [
    ['タイトル', current.title],
    ['状態', current.status],
    ['同意', CONSENT_LABEL[current.consentState] ?? current.consentState],
    ['文字起こし設定', MODE_LABEL[current.transcriptionMode] ?? current.transcriptionMode],
    ['機密', current.isConfidential ? 'はい' : 'いいえ'],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    el.info.append(dt, dd);
  }
  el.consentState.textContent = `現在の状態: ${CONSENT_LABEL[current.consentState] ?? current.consentState}`;
  if (current.transcriptionMode === 'none') {
    (document.querySelector('input[name="mode"][value="server"]') as HTMLInputElement).checked = true;
  }
}

function consentOk(): boolean {
  return !!current && (current.consentState === 'notified' || current.consentState === 'confirmed');
}

// ---------------------------------------------------------------- capabilities

async function loadCaps(): Promise<void> {
  el.capSystem.textContent = 'システム音声: 確認中…';
  el.capLocal.textContent = '端末内文字起こし: 確認中…';
  caps = await D.capabilities();
  const sys = caps.systemAudio === true ? '取得できます' : caps.systemAudio === 'unknown' ? '取得できる見込み（未検証）' : '取得できません';
  el.capSystem.textContent = `システム音声: ${sys} — ${caps.reason}`;
  el.capLocal.textContent = `端末内文字起こし: ${caps.localTranscription.available ? '利用可能' : '利用不可'} — ${caps.localTranscription.reason}`;
  if (caps.systemAudio === false) {
    el.useSystem.checked = false;
    el.useSystem.disabled = true;
  }
  if (!caps.localTranscription.available) {
    (document.querySelector('input[name="mode"][value="server"]') as HTMLInputElement).checked = true;
    (document.querySelector('input[name="mode"][value="device"]') as HTMLInputElement).disabled = true;
  }
}

// ---------------------------------------------------------------- render

function render(): void {
  const phase = state?.phase ?? 'idle';
  const idle = phase === 'idle';
  const active = phase === 'ready' || phase === 'recording' || (phase === 'busy' && !!rec);

  el.banner.hidden = !(phase === 'ready' || phase === 'recording' || phase === 'busy');
  el.banner.classList.toggle('armed', phase === 'ready');
  el.recLabel.textContent = phase === 'recording' ? '● 録音中' : phase === 'ready' ? '● 録音準備完了（まだ録音していません）' : '● 処理中';
  el.sources.textContent =
    phase === 'recording' ? (state?.systemAudioActive ? 'マイク（左）＋ システム音声（右）' : 'マイクのみ') : (state?.meetingTitle ?? '');

  for (const x of [el.ws, el.meeting, el.reload, el.create, el.newTitle, el.uploadAudio, el.useSystem]) x.disabled = !idle || busy;
  if (caps?.systemAudio === false) el.useSystem.disabled = true;
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
    r.disabled = !idle || busy || (r.value === 'device' && caps !== null && !caps.localTranscription.available);
  }
  el.uploadAudio.disabled = !idle || busy || mode() === 'server';

  el.consentForm.hidden = !current || consentOk() || current.consentState === 'declined';
  el.consentSave.disabled = !idle || busy || !el.consentCheck.checked || !current;

  el.prepare.disabled = !idle || busy || !current || !consentOk();
  el.start.disabled = phase !== 'ready' || busy;
  el.cancelPrep.disabled = phase !== 'ready' || busy;
  el.stop.disabled = phase !== 'recording' || busy;

  const stopped = phase === 'stopped';
  el.transcribe.disabled = !stopped || busy || state?.mode !== 'device' || !!result || submitted || (state?.wavBytes ?? 0) === 0;
  el.submit.disabled = !stopped || busy || !result || submitted;
  el.upload.disabled = !stopped || busy || !state?.uploadAudio || uploaded || (state?.webmBytes ?? 0) === 0;
  el.finish.disabled = !stopped || busy;

  if (state?.message && !busy) setStatus(state.message);
  if (!active && meterTimer !== null) {
    clearInterval(meterTimer);
    meterTimer = null;
    el.lvlMic.value = 0;
    el.lvlSys.value = 0;
  }
}

function tick(): void {
  if (state?.phase === 'recording' && state.startedAt) el.elapsed.textContent = fmtTime(Date.now() - state.startedAt);
  if (rec) {
    const lv = rec.levels();
    el.lvlMic.value = Math.min(1, lv.mic * 4);
    el.lvlSys.value = Math.min(1, lv.system * 4);
  }
}

function renderSegments(r: LocalTranscriptResult): void {
  const body = el.segments.tBodies[0]!;
  body.replaceChildren();
  for (const s of r.segments.slice(0, 2000)) {
    const tr = document.createElement('tr');
    for (const text of [fmtTime(s.startMs), s.speaker ?? '', s.text]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    body.append(tr);
  }
  el.segments.hidden = false;
  el.resultInfo.textContent = `モデル: ${r.model} / 言語: ${r.language} / ${r.segments.length} セグメント${r.segments.length > 2000 ? '（先頭2000件を表示）' : ''}。送信されるのはテキストと時刻・話者ラベルのみです。`;
}

// ---------------------------------------------------------------- actions

el.ws.addEventListener('change', () => void guarded('会議一覧の取得', () => loadMeetings()));
el.meeting.addEventListener('change', () => void guarded('会議の取得', () => loadMeeting(el.meeting.value)));
el.reload.addEventListener('click', () =>
  void guarded('再読み込み', async () => {
    const keepWs = el.ws.value;
    const keepM = el.meeting.value;
    await loadWorkspaces(keepWs);
    await loadMeetings(keepM);
  }),
);
el.create.addEventListener('click', () =>
  void guarded('会議の作成', async () => {
    const title = el.newTitle.value.trim() || `デスクトップ録音 ${new Date().toLocaleString('ja-JP')}`;
    const m = await L.api.createMeeting(el.ws.value, title);
    el.newTitle.value = '';
    await loadMeetings(m.id);
    setStatus('会議を作成しました。参加者への通知・同意を記録してください。');
  }),
);
el.consentCheck.addEventListener('change', render);
el.consentSave.addEventListener('click', () =>
  void guarded('同意の記録', async () => {
    if (!current || !el.consentCheck.checked) return;
    current = await L.api.recordConsent({
      workspaceId: el.ws.value,
      meetingId: current.id,
      state: el.consentKind.value === 'confirmed' ? 'confirmed' : 'notified',
      method: el.consentMethod.value,
    });
    el.consentCheck.checked = false;
    renderMeeting();
    setStatus('通知/同意を記録しました。');
  }),
);
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) r.addEventListener('change', render);

el.prepare.addEventListener('click', () =>
  void guarded('録音の準備', async () => {
    if (!current) return;
    const m = mode();
    state = await L.recorder.prepare({
      workspaceId: el.ws.value,
      meetingId: current.id,
      mode: m,
      uploadAudio: m === 'server' ? true : el.uploadAudio.checked,
      systemAudio: el.useSystem.checked && caps?.systemAudio !== false,
    });
    result = null;
    submitted = uploaded = false;
    el.segments.hidden = true;
  }),
);

el.start.addEventListener('click', () =>
  void guarded('録音開始', async () => {
    if (!state || state.phase !== 'ready') return;
    const r = new DualChannelRecorder({
      systemAudio: state.systemAudioRequested,
      tapPcm: state.mode === 'device',
      recordWebm: state.uploadAudio,
      onData: (c) => L.recorder.data(c),
      onWarning: warn,
    });
    let res;
    try {
      res = await r.start();
    } catch (e) {
      r.abort();
      throw new Error(`マイクを使用できません（${(e as Error).name}: ${(e as Error).message}）。OS のマイク許可を確認してください。`);
    }
    try {
      state = await L.recorder.started({ systemAudioActive: res.systemAudioActive, mimeType: res.mimeType });
    } catch (e) {
      r.abort(); // never keep devices open without the main-process session (and its indicator) being "recording"
      throw e;
    }
    rec = r;
    meterTimer = window.setInterval(tick, 200);
  }),
);

el.stop.addEventListener('click', () =>
  void guarded('録音停止', async () => {
    const r = rec;
    if (r) {
      setStatus('録音データを保存しています…');
      await r.stop();
      if (r.needsFallbackConversion && r.fallbackChunks.length) {
        setStatus('音声を 16 kHz に変換しています…');
        const { convertToAsrPcm } = (await import(new URL('./convert.js', location.href).href)) as typeof import('./convert');
        const c = await convertToAsrPcm(new Blob(r.fallbackChunks, { type: 'audio/webm' }));
        const step = 16_000 * 2 * 60; // 1 minute of PCM per IPC call
        for (let off = 0; off < c.pcm.byteLength; off += step) {
          await L.recorder.data({ pcm: c.pcm.buffer.slice(off, Math.min(off + step, c.pcm.byteLength)) as ArrayBuffer });
        }
        for (let off = 0; off < c.env.length; off += 1200) {
          await L.recorder.data({ env: c.env.slice(off, off + 1200).buffer as ArrayBuffer });
        }
      }
    }
    rec = null;
    state = await L.recorder.stop();
  }),
);

el.cancelPrep.addEventListener('click', () =>
  void guarded('準備の取り消し', async () => {
    await L.recorder.stop();
    state = await L.recorder.discard();
  }),
);

el.transcribe.addEventListener('click', () =>
  void guarded('文字起こし', async () => {
    result = await L.recorder.transcribe();
    renderSegments(result);
  }),
);
el.submit.addEventListener('click', () =>
  void guarded('送信', async () => {
    await L.recorder.submit();
    submitted = true;
  }),
);
el.upload.addEventListener('click', () =>
  void guarded('アップロード', async () => {
    await L.recorder.upload();
    uploaded = true;
  }),
);
el.finish.addEventListener('click', () =>
  void guarded('完了処理', async () => {
    const pending = state?.mode === 'device' && !submitted ? '文字起こし結果を送信していません。' : state?.uploadAudio && !uploaded ? '音声をアップロードしていません。' : '';
    if (pending && !window.confirm(`${pending}端末内の録音ファイルを削除して終了しますか？`)) return;
    state = await L.recorder.discard();
    result = null;
    el.segments.hidden = true;
    el.resultInfo.textContent = '録音停止後に表示されます。';
    if (current) await loadMeeting(current.id);
  }),
);
el.openSettings.addEventListener('click', () => void D.openSettings());

L.recorder.onState((s) => {
  state = s;
  render();
});

// ---------------------------------------------------------------- init
(async () => {
  render();
  const params = new URLSearchParams(location.search);
  const wsParam = params.get('ws');
  const mParam = params.get('m');
  void loadCaps()
    .then(render)
    .catch((e) => warn(`機能の確認に失敗: ${errMsg(e)}`));
  try {
    await loadWorkspaces(wsParam);
    await loadMeetings(mParam);
    setStatus('会議を選択してください。');
  } catch (e) {
    if ((e as { code?: string }).code === 'unauthenticated' || (e as { code?: string }).code === 'not_configured') showLoginHint();
    setStatus(errMsg(e));
  }
  render();
})();
