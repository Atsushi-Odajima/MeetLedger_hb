import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { msToClock } from '@meetledger/shared';
import { Alert, Badge, Button, Card, Checkbox, ProgressBar, SelectField, TextArea } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useI18n, type MsgKey } from '../../i18n';
import { useToast } from '../../state/toast';
import { api, ApiError, listOf } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { computeCapabilities, countCues, currentCaptureEnv, detectTranscriptFormat } from '../../lib/media';
import { BrowserRecorder, deleteStoredRecording, listStoredRecordings, storedRecordingBlob, type RecordingState, type StoredRecording } from '../../lib/recorder';
import { formatBytes, uploadWithProgress, type UploadHandle } from '../../lib/upload';
import { extensionForMime } from '../../lib/media';
import type { JobDto, MeetingDetailDto } from '../../lib/types';
import { consentOk, useMeeting } from './context';
import { ConsentDialog } from './ConsentDialog';
import { NotesEditor } from './NotesEditor';

interface UploadState {
  name: string;
  loaded: number;
  total: number;
  handle: UploadHandle<unknown>;
}

function useUploader(onDone: () => void) {
  const { ma } = useMeeting();
  const toast = useToast();
  const { t } = useI18n();
  const [upload, setUpload] = useState<UploadState | null>(null);
  const start = async (blob: Blob, filename: string): Promise<boolean> => {
    const handle = uploadWithProgress(ma('/media'), blob, filename, (loaded, total) => setUpload((u) => (u ? { ...u, loaded, total } : u)));
    setUpload({ name: filename, loaded: 0, total: blob.size, handle });
    try {
      await handle.promise;
      toast.success(t('upload.done'));
      onDone();
      return true;
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') toast.error(e);
      return false;
    } finally {
      setUpload(null);
    }
  };
  return { upload, start };
}

function UploadProgress({ u }: { u: UploadState }) {
  const { t } = useI18n();
  const pct = u.total ? Math.round((u.loaded / u.total) * 100) : 0;
  return (
    <div className="upload-progress" aria-live="polite">
      <p>
        {t('upload.progress', { name: u.name, pct })} <span className="muted">({formatBytes(u.loaded)} / {formatBytes(u.total)})</span>
      </p>
      <ProgressBar value={u.loaded} max={u.total || 1} label={t('upload.progressLabel')} />
      <Button size="sm" variant="ghost" onClick={() => u.handle.abort()}>
        {t('common.cancel')}
      </Button>
    </div>
  );
}

function CapabilityNotice() {
  const { t } = useI18n();
  const caps = useMemo(() => computeCapabilities(currentCaptureEnv()), []);
  return (
    <Alert tone="info" title={t('capture.capsTitle')}>
      <ul className="notice-list">
        {caps.notices.map((k) => (
          <li key={k}>{t(k as MsgKey)}</li>
        ))}
      </ul>
    </Alert>
  );
}

function Recorder({ onUploaded }: { onUploaded: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { meeting, ma, setMeeting } = useMeeting();
  const caps = useMemo(() => computeCapabilities(currentCaptureEnv()), []);
  const [consentOpen, setConsentOpen] = useState(false);
  const [includeTab, setIncludeTab] = useState(false);
  const [state, setState] = useState<RecordingState>('idle');
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [warning, setWarning] = useState<string | null>(null);
  const [pending, setPending] = useState<StoredRecording[]>([]);
  const rec = useRef<BrowserRecorder | null>(null);
  const { upload, start: startUpload } = useUploader(onUploaded);

  const refreshPending = () => listStoredRecordings(meeting.id).then((r) => setPending(r.filter((x) => x.id !== rec.current?.id)));
  useEffect(() => {
    refreshPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting.id]);

  const active = state === 'recording' || state === 'paused' || state === 'starting' || state === 'stopping';
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setElapsed(rec.current?.elapsedMs() ?? 0), 500);
    const prevTitle = document.title;
    document.title = `● ${t('capture.recording')} — MeetLedger`;
    const onHide = () => {
      if (document.visibilityState === 'hidden' && caps.stopsInBackground) setWarning('capture.warn.background');
    };
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      clearInterval(id);
      document.title = prevTitle;
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [active, caps.stopsInBackground, t]);

  const begin = async (m: MeetingDetailDto = meeting) => {
    if (!consentOk(m)) {
      setConsentOpen(true);
      return;
    }
    setWarning(null);
    try {
      const started = await api.post<MeetingDetailDto>(ma('/start'), { capture: 'browser_mic' });
      setMeeting(started);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConsentOpen(true);
        return;
      }
      toast.error(e);
      return;
    }
    const r = new BrowserRecorder(meeting.workspaceId, meeting.id, {
      onLevel: setLevel,
      onState: setState,
      onWarning: (k) => setWarning(k),
    });
    rec.current = r;
    try {
      await r.start({ includeTabAudio: includeTab && caps.tabAudio });
      toast.announce(t('capture.started'));
    } catch (e) {
      setState('error');
      const name = (e as Error)?.name;
      toast.error(name === 'NotAllowedError' ? t('capture.micDenied') : name === 'NotFoundError' ? t('capture.noMicDevice') : (e as Error).message);
      await r.discard().catch(() => undefined);
      rec.current = null;
      setState('idle');
    }
  };

  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    const out = await r.stop();
    toast.announce(t('capture.stopped'));
    const ok = await startUpload(out.blob, out.filename);
    if (ok) await deleteStoredRecording(out.id);
    rec.current = null;
    setState('idle');
    setLevel(0);
    refreshPending();
  };

  const discard = async () => {
    if (!window.confirm(t('capture.discardConfirm'))) return;
    await rec.current?.discard();
    rec.current = null;
    setState('idle');
    setLevel(0);
  };

  const uploadStored = async (r: StoredRecording) => {
    const ok = await startUpload(storedRecordingBlob(r), `meetledger-${r.startedAt.replace(/[:.]/g, '-')}.${extensionForMime(r.mimeType)}`);
    if (ok) await deleteStoredRecording(r.id);
    refreshPending();
  };

  const download = (r: StoredRecording) => {
    const url = URL.createObjectURL(storedRecordingBlob(r));
    const aEl = document.createElement('a');
    aEl.href = url;
    aEl.download = `meetledger-${r.startedAt.replace(/[:.]/g, '-')}.${extensionForMime(r.mimeType)}`;
    aEl.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const declined = meeting.consentState === 'declined';
  const disabled = !meeting.canEdit || !caps.mic || declined || meeting.transcriptionMode === 'none';

  return (
    <Card title={t('capture.recordTitle')} id="recorder">
      {meeting.transcriptionMode === 'none' && <Alert tone="info">{t('capture.transcriptionOff')}</Alert>}
      {declined && <Alert tone="warn">{t('capture.declined')}</Alert>}
      {warning && <Alert tone="warn">{t(warning as MsgKey)}</Alert>}
      {active ? (
        <div className="recorder-live" role="group" aria-label={t('capture.recording')}>
          <div className="rec-indicator" aria-live="polite">
            <span className={`rec-dot${state === 'paused' ? ' rec-dot-paused' : ''}`} aria-hidden="true" />
            <strong>{state === 'paused' ? t('capture.paused') : t('capture.recording')}</strong>
            <span className="rec-timer" aria-label={t('capture.elapsed')}>
              {msToClock(elapsed)}
            </span>
          </div>
          <div className="level" role="meter" aria-label={t('capture.level')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
            <div className="level-bar" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          <div className="button-row">
            {state === 'paused' ? (
              <Button icon="play" onClick={() => rec.current?.resume()}>
                {t('capture.resume')}
              </Button>
            ) : (
              <Button icon="pause" onClick={() => rec.current?.pause()} disabled={state !== 'recording'}>
                {t('capture.pause')}
              </Button>
            )}
            <Button variant="primary" icon="stop" onClick={stop} loading={state === 'stopping'}>
              {t('capture.stopAndUpload')}
            </Button>
            <Button variant="ghost" onClick={discard}>
              {t('capture.discard')}
            </Button>
          </div>
          <p className="field-hint">{t('capture.liveHint')}</p>
        </div>
      ) : (
        <div className="stack">
          {caps.tabAudio && (
            <Checkbox label={t('capture.includeTab')} hint={t('capture.includeTabHint')} checked={includeTab} onChange={(e) => setIncludeTab(e.target.checked)} disabled={disabled} />
          )}
          <div className="button-row">
            <Button variant="primary" size="lg" icon="mic" onClick={() => begin()} disabled={disabled || !!upload}>
              {t('capture.start')}
            </Button>
            {!consentOk(meeting) && !declined && <span className="field-hint">{t('capture.consentFirst')}</span>}
          </div>
        </div>
      )}
      {upload && <UploadProgress u={upload} />}
      {pending.length > 0 && (
        <div className="pending-recordings">
          <h3 className="small-title">{t('capture.pendingTitle')}</h3>
          <ul className="items">
            {pending.map((r) => (
              <li key={r.id} className="item">
                <div className="item-main">
                  <span>{t('capture.pendingItem', { duration: msToClock(r.durationMs), size: formatBytes(r.chunks.reduce((n, c) => n + c.size, 0)) })}</span>
                </div>
                <div className="item-side button-row">
                  <Button size="sm" icon="upload" onClick={() => uploadStored(r)} disabled={!!upload}>
                    {t('capture.upload')}
                  </Button>
                  <Button size="sm" variant="ghost" icon="download" onClick={() => download(r)}>
                    {t('common.download')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    onClick={async () => {
                      if (window.confirm(t('capture.deletePendingConfirm'))) {
                        await deleteStoredRecording(r.id);
                        refreshPending();
                      }
                    }}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ConsentDialog
        open={consentOpen}
        mode="record"
        onClose={() => setConsentOpen(false)}
        onConsented={(m) => {
          setConsentOpen(false);
          if (m) {
            setMeeting(m);
            begin(m);
          }
        }}
      />
    </Card>
  );
}

function FileUpload({ onUploaded }: { onUploaded: () => void }) {
  const { t } = useI18n();
  const { meeting, setMeeting } = useMeeting();
  const [file, setFile] = useState<File | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const { upload, start } = useUploader(onUploaded);
  const inputRef = useRef<HTMLInputElement>(null);
  const go = async (m = meeting) => {
    if (!file) return;
    if (!consentOk(m)) {
      setConsentOpen(true);
      return;
    }
    const ok = await start(file, file.name);
    if (ok) {
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };
  return (
    <Card title={t('capture.uploadTitle')} id="file-upload">
      <p className="field-hint">{t('capture.uploadHint')}</p>
      <div className="field">
        <label className="field-label" htmlFor="media-file">
          {t('capture.chooseFile')}
        </label>
        <input
          ref={inputRef}
          id="media-file"
          type="file"
          className="input"
          accept="audio/*,video/*,.m4a,.mp3,.wav,.webm,.mp4,.mov,.ogg,.aac,.flac"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={!meeting.canEdit || !!upload || meeting.transcriptionMode === 'none'}
        />
        {file && <p className="field-hint">{t('capture.fileInfo', { name: file.name, size: formatBytes(file.size) })}</p>}
      </div>
      <Button icon="upload" onClick={() => go()} disabled={!file || !!upload}>
        {t('capture.upload')}
      </Button>
      {upload && <UploadProgress u={upload} />}
      <ConsentDialog
        open={consentOpen}
        mode="upload"
        onClose={() => setConsentOpen(false)}
        onConsented={(m) => {
          setConsentOpen(false);
          if (m) {
            setMeeting(m);
            go(m);
          }
        }}
      />
    </Card>
  );
}

function TranscriptImport() {
  const { t } = useI18n();
  const toast = useToast();
  const { meeting, ma, mp } = useMeeting();
  const [content, setContent] = useState('');
  const [name, setName] = useState('');
  const [format, setFormat] = useState<'auto' | 'srt' | 'vtt' | 'txt' | 'json'>('auto');
  const [language, setLanguage] = useState<'auto' | 'ja' | 'en'>('auto');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const detected = detectTranscriptFormat(name, content);
  const fmt = format === 'auto' ? detected : format;
  const cues = content ? countCues(fmt, content) : 0;
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      toast.error(t('import.tooLarge'));
      return;
    }
    setName(f.name);
    setContent(await f.text());
  };
  const submit = async () => {
    setBusy(true);
    try {
      await api.post(ma('/transcript/import'), { format: fmt, content, ...(language !== 'auto' ? { language } : {}) });
      toast.success(t('import.done'));
      setDone(true);
      setContent('');
      setName('');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('import.title')} id="transcript-import">
      <p className="field-hint">{t('import.hint')}</p>
      <div className="field">
        <label className="field-label" htmlFor="transcript-file">
          {t('import.file')}
        </label>
        <input id="transcript-file" type="file" className="input" accept=".srt,.vtt,.txt,.json,text/plain,text/vtt" onChange={(e) => onFile(e.target.files?.[0])} disabled={!meeting.canEdit} />
      </div>
      <TextArea label={t('import.paste')} value={content} onChange={(e) => setContent(e.target.value)} rows={5} disabled={!meeting.canEdit} />
      <div className="grid-2">
        <SelectField
          label={t('import.format')}
          value={format}
          onChange={(e) => setFormat(e.target.value as typeof format)}
          options={[
            { value: 'auto', label: t('import.formatAuto', { f: detected.toUpperCase() }) },
            { value: 'srt', label: 'SRT' },
            { value: 'vtt', label: 'WebVTT' },
            { value: 'txt', label: t('import.formatTxt') },
            { value: 'json', label: 'JSON' },
          ]}
        />
        <SelectField
          label={t('meeting.language')}
          value={language}
          onChange={(e) => setLanguage(e.target.value as typeof language)}
          options={[
            { value: 'auto', label: t('language.auto') },
            { value: 'ja', label: t('language.ja') },
            { value: 'en', label: t('language.en') },
          ]}
        />
      </div>
      {content && <p className="field-hint">{t('import.preview', { n: cues, f: fmt.toUpperCase() })}</p>}
      <div className="button-row">
        <Button icon="file" onClick={submit} disabled={!content.trim() || busy || !meeting.canEdit} loading={busy}>
          {t('import.submit')}
        </Button>
        {done && (
          <Link to={mp('/transcript')} className="btn btn-sm btn-ghost">
            {t('import.open')}
          </Link>
        )}
      </div>
    </Card>
  );
}

function ProcessingStatus({ nonce }: { nonce: number }) {
  const { t, tm, fmt } = useI18n();
  const toast = useToast();
  const { meeting, ma } = useMeeting();
  const [poll, setPoll] = useState(false);
  const state = useApi<unknown>(ma('/processing'), { pollMs: poll ? 4000 : undefined, keepPrevious: true });
  const reloadRef = useRef(state.reload);
  reloadRef.current = state.reload;
  useEffect(() => {
    if (nonce) {
      reloadRef.current();
      setPoll(true);
    }
  }, [nonce]);
  const jobs = listOf<JobDto>(state.data, 'jobs');
  const running = jobs.some((j) => ['queued', 'running', 'pending', 'processing'].includes(j.status));
  useEffect(() => setPoll(running), [running]);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (kind: 'process' | 'extract') => {
    setBusy(kind);
    try {
      await api.post(ma(kind === 'process' ? '/process' : '/extract'), { rerun: true });
      toast.success(t('processing.queued'));
      state.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  if (state.error && !state.data) return null;
  return (
    <Card title={t('processing.title')} id="processing">
      {jobs.length ? (
        <ul className="items" aria-live="polite">
          {jobs.map((j, i) => (
            <li key={j.id ?? i} className="item">
              <div className="item-main">
                <span className="item-title">{tm(`job.${j.type}`, j.type)}</span>
                <span className="item-meta">
                  <Badge tone={j.status === 'failed' ? 'danger' : j.status === 'done' || j.status === 'succeeded' || j.status === 'completed' ? 'success' : 'info'}>{tm(`jobStatus.${j.status}`, j.status)}</Badge>
                  {(j.updatedAt || j.createdAt) && <span>{fmt.dateTime(j.updatedAt ?? j.createdAt)}</span>}
                  {j.error && <span className="text-danger">{j.error}</span>}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('processing.none')}</p>
      )}
      {meeting.canEdit && (
        <div className="button-row">
          <Button size="sm" icon="sync" onClick={() => run('process')} loading={busy === 'process'} disabled={meeting.transcriptionMode === 'none'}>
            {t('processing.rerun')}
          </Button>
          <Button size="sm" icon="sparkle" onClick={() => run('extract')} loading={busy === 'extract'} disabled={!meeting.aiEnabled}>
            {t('processing.extract')}
          </Button>
          {!meeting.aiEnabled && <span className="field-hint">{t('privacy.aiOff.hint')}</span>}
        </div>
      )}
    </Card>
  );
}

export function CaptureTab() {
  const { t } = useI18n();
  const [nonce, setNonce] = useState(0);
  const bump = () => setNonce((n) => n + 1);
  return (
    <div className="capture-layout">
      <div className="capture-main">
        <NotesEditor />
      </div>
      <div className="capture-side">
        <CapabilityNotice />
        <Recorder onUploaded={bump} />
        <FileUpload onUploaded={bump} />
        <TranscriptImport />
        <ProcessingStatus nonce={nonce} />
        <p className="field-hint">
          <Icon name="info" size={14} /> {t('capture.desktopNote')}
        </p>
      </div>
    </div>
  );
}
