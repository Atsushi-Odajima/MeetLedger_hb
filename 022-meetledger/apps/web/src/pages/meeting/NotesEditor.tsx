import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useToast } from '../../state/toast';
import { api, NetworkError, ApiError } from '../../lib/api';
import { copyText, useOnline, useOutbox } from '../../lib/hooks';
import {
  cacheServerNotes,
  getCachedServerNotes,
  getOp,
  notesOpId,
  onNotesSaved,
  queueNotes,
  replayOutbox,
  resolveNotesConflict,
  type NotesOp,
} from '../../lib/offline/outbox';
import type { NotesDto } from '../../lib/types';
import { useMeeting } from './context';

type SaveState = 'loading' | 'saved' | 'typing' | 'saving' | 'unsynced' | 'conflict' | 'failed' | 'error';

const DEBOUNCE_MS = 600;

export function NotesEditor() {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const { wsId } = useWs();
  const { meeting } = useMeeting();
  const notesPath = `/api/w/${wsId}/meetings/${meeting.id}/notes`;
  const online = useOnline();
  const { ops } = useOutbox();
  const opId = notesOpId(wsId, meeting.id);
  const op = ops.find((o) => o.id === opId) as NotesOp | undefined;

  const [body, setBody] = useState('');
  const [baseVersion, setBaseVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [typing, setTyping] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [others, setOthers] = useState<NotesDto['others']>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ body: '', baseVersion: 0 });
  latest.current = { body, baseVersion };
  const readOnly = !meeting.canEdit;

  // ---- load: local unsynced copy wins over the server copy (it is never discarded silently)
  useEffect(() => {
    let alive = true;
    (async () => {
      const queued = await getOp<NotesOp>(opId).catch(() => undefined);
      let server: { body: string; version: number; updatedAt: string | null } | undefined;
      try {
        const r = await api.get<NotesDto>(notesPath);
        server = r.mine;
        if (alive) setOthers(r.others ?? []);
        await cacheServerNotes(wsId, meeting.id, r.mine);
      } catch (e) {
        if (e instanceof NetworkError) server = await getCachedServerNotes(wsId, meeting.id);
        else if (alive) setLoadError(e);
      }
      if (!alive) return;
      if (queued) {
        setBody(queued.body);
        setBaseVersion(queued.baseVersion);
        if (queued.status === 'pending') replayOutbox(api).catch(() => undefined);
      } else if (server) {
        setBody(server.body);
        setBaseVersion(server.version);
        setSavedAt(server.updatedAt);
      }
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
    // Only re-load when the target changes (never while the user is typing because the meeting object refreshed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opId, notesPath]);

  // ---- keep version in sync when the queue saved our text
  useEffect(
    () =>
      onNotesSaved((e) => {
        if (e.wsId !== wsId || e.meetingId !== meeting.id) return;
        setBaseVersion(e.version);
        setSavedAt(new Date().toISOString());
      }),
    [wsId, meeting.id],
  );

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setTyping(false);
    const { body: b, baseVersion: v } = latest.current;
    await queueNotes({ wsId, meetingId: meeting.id, body: b, baseVersion: v, meetingTitle: meeting.title });
    replayOutbox(api).catch(() => undefined);
  }, [wsId, meeting.id, meeting.title]);

  // flush pending typing when leaving the page / tab is hidden
  useEffect(() => {
    const onHide = () => {
      if (timer.current) flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      if (timer.current) flush();
    };
  }, [flush]);

  const onChange = (v: string) => {
    setBody(v);
    latest.current.body = v;
    setTyping(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      flush();
    }, DEBOUNCE_MS);
  };

  const state: SaveState = !loaded
    ? 'loading'
    : loadError && !op
      ? 'error'
      : typing
        ? 'typing'
        : op?.status === 'conflict'
          ? 'conflict'
          : op?.status === 'failed'
            ? 'failed'
            : op
              ? online
                ? 'saving'
                : 'unsynced'
              : 'saved';

  const resolve = async (choice: 'server' | 'mine' | 'merge') => {
    if (!op?.conflict) return;
    const merged = `${op.body}\n\n―― ${t('notes.serverCopy', { v: op.conflict.serverVersion })} ――\n${op.conflict.serverBody}`;
    const r = await resolveNotesConflict(op.id, choice === 'merge' ? { choice, body: merged } : { choice });
    if (!r) return;
    setBody(r.body);
    setBaseVersion(r.baseVersion);
    if (r.queued) replayOutbox(api).catch(() => undefined);
    toast.announce(t('notes.resolved'));
  };

  const statusLabel: Record<SaveState, string> = {
    loading: t('common.loading'),
    saved: t('notes.saved'),
    typing: t('notes.typing'),
    saving: t('notes.saving'),
    unsynced: t('notes.unsynced'),
    conflict: t('notes.conflict'),
    failed: t('notes.failed'),
    error: t('notes.loadError'),
  };

  return (
    <Card
      title={t('notes.title')}
      id="notes"
      actions={
        <span className={`save-state save-${state}`} role="status" aria-live="polite" data-testid="notes-status">
          {state === 'unsynced' && <Badge tone="warn" icon="sync">{t('sync.unsynced')}</Badge>}
          {statusLabel[state]}
          {state === 'saved' && savedAt && <span className="muted"> · {fmt.time(savedAt)}</span>}
        </span>
      }
    >
      <p className="field-hint">{t('notes.hint')}</p>
      {state === 'failed' && op?.error && <Alert tone="danger">{op.error}</Alert>}
      {loadError instanceof ApiError && <Alert tone="danger">{loadError.message}</Alert>}
      {op?.status === 'conflict' && op.conflict && (
        <div className="conflict" role="region" aria-label={t('notes.conflictTitle')}>
          <Alert tone="warn" title={t('notes.conflictTitle')}>
            {t('notes.conflictBody')}
          </Alert>
          <div className="conflict-grid">
            <div>
              <h3 className="small-title">{t('notes.yourCopy')}</h3>
              <pre className="conflict-text">{op.body}</pre>
            </div>
            <div>
              <h3 className="small-title">{t('notes.serverCopy', { v: op.conflict.serverVersion })}</h3>
              <pre className="conflict-text">{op.conflict.serverBody}</pre>
            </div>
          </div>
          <div className="button-row">
            <Button onClick={() => resolve('merge')} variant="primary">
              {t('notes.keepBoth')}
            </Button>
            <Button onClick={() => resolve('server')}>{t('notes.useServer')}</Button>
            <Button onClick={() => resolve('mine')}>{t('notes.useMine')}</Button>
            <Button variant="ghost" icon="copy" onClick={() => copyText(op.body).then((ok) => ok && toast.success(t('common.copied')))}>
              {t('notes.copyMine')}
            </Button>
          </div>
        </div>
      )}
      <label htmlFor="notes-body" className="sr-only">
        {t('notes.title')}
      </label>
      <textarea
        id="notes-body"
        className="input textarea notes-area"
        value={body}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => timer.current && flush()}
        readOnly={readOnly || !loaded || op?.status === 'conflict'}
        placeholder={t('notes.placeholder')}
        rows={14}
        spellCheck
        data-testid="notes-editor"
      />
      {readOnly && <p className="field-hint">{t('common.readOnly')}</p>}
      {others.length > 0 && (
        <details className="others-notes">
          <summary>{t('notes.others', { n: others.length })}</summary>
          {others.map((o, i) => (
            <div key={i} className="other-note">
              <p className="small-title">
                {o.author} · {fmt.dateTime(o.updatedAt ?? o.updated_at ?? null)}
              </p>
              <pre className="conflict-text">{o.body}</pre>
            </div>
          ))}
        </details>
      )}
    </Card>
  );
}
