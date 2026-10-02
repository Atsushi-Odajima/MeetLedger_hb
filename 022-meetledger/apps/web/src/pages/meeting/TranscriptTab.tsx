import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { INAUDIBLE_TOKEN, MAX_INAUDIBLE_CONFIDENCE, msToClock, type SegmentDto, type SpeakerDto, type TranscriptDto } from '@meetledger/shared';
import { Alert, Badge, Button, Dialog, EmptyState, ErrorView, Loading, Popover, SelectField, TextField, CachedNotice } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { usePeople } from '../../components/ledger';
import { useI18n } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useToast } from '../../state/toast';
import { api, ApiError, listOf } from '../../lib/api';
import { useApi, useDebounced } from '../../lib/hooks';
import type { MediaAssetDto, SegmentRevisionDto } from '../../lib/types';
import { useMeeting } from './context';

const PAGE = 300;

function speakerColor(id: string | null): number {
  if (!id) return 0;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 8) + 1;
}

function isLowConfidence(s: SegmentDto) {
  return (s.confidence !== null && s.confidence < MAX_INAUDIBLE_CONFIDENCE) || s.flags?.includes('low_confidence') || s.flags?.includes('inaudible');
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const { t } = useI18n();
  const parts = text.split(INAUDIBLE_TOKEN);
  const out: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (i > 0)
      out.push(
        <span key={`in-${i}`} className="inaudible" title={t('transcript.inaudibleTitle')}>
          {t('transcript.inaudible')}
        </span>,
      );
    if (!query) {
      out.push(<span key={`t-${i}`}>{part}</span>);
      return;
    }
    const lower = part.toLowerCase();
    const q = query.toLowerCase();
    let idx = 0;
    let k = 0;
    while (true) {
      const at = lower.indexOf(q, idx);
      if (at < 0) break;
      if (at > idx) out.push(<span key={`t-${i}-${k++}`}>{part.slice(idx, at)}</span>);
      out.push(<mark key={`m-${i}-${k++}`}>{part.slice(at, at + q.length)}</mark>);
      idx = at + q.length;
    }
    out.push(<span key={`t-${i}-end`}>{part.slice(idx)}</span>);
  });
  return <>{out}</>;
}

function RevisionHistory({ segmentId }: { segmentId: string }) {
  const { a } = useWs();
  const { t, fmt } = useI18n();
  const state = useApi<unknown>(a(`/segments/${segmentId}/revisions`));
  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorView error={state.error} compact />;
  const items = listOf<SegmentRevisionDto>(state.data, 'revisions');
  if (!items.length) return <p className="muted">{t('transcript.noRevisions')}</p>;
  return (
    <ol className="revisions">
      {items.map((r) => (
        <li key={r.revision}>
          <p className="small-title">
            {t('transcript.revision', { n: r.revision })} · {r.editedByName ?? r.editedBy ?? ''} {(r.editedAt ?? r.createdAt) && `· ${fmt.dateTime(r.editedAt ?? r.createdAt)}`}
          </p>
          {r.oldText !== undefined && r.oldText !== (r.newText ?? r.text) && <p className="strike">{r.oldText}</p>}
          <p>{r.newText ?? r.text}</p>
          {r.oldSpeakerLabel && r.newSpeakerLabel && r.oldSpeakerLabel !== r.newSpeakerLabel && (
            <p className="field-hint">
              {r.oldSpeakerLabel} → {r.newSpeakerLabel}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function SpeakerDialog({ speaker, onClose, onSaved }: { speaker: SpeakerDto | null; onClose(): void; onSaved(): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { ma } = useMeeting();
  const { people } = usePeople();
  const [name, setName] = useState('');
  const [personId, setPersonId] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(speaker?.displayName ?? '');
    setPersonId(speaker?.personId ?? '');
  }, [speaker]);
  if (!speaker) return null;
  const suggestion = speaker.suggestion ? people.find((p) => p.id === speaker.suggestion || p.name === speaker.suggestion) : undefined;
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(ma(`/speakers/${speaker.id}`), { personId: personId || null, displayName: name.trim() || null });
      toast.success(t('transcript.speakerSaved'));
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('transcript.speakerTitle', { label: speaker.label })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} loading={busy}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="field-hint">{t('transcript.speakerHint')}</p>
        {speaker.suggestion && (
          <Alert tone="info" title={t('transcript.suggestion')}>
            <p>
              {t('transcript.suggestionBody', { name: suggestion?.name ?? speaker.suggestion })}{' '}
              <Button
                size="sm"
                onClick={() => {
                  if (suggestion) setPersonId(suggestion.id);
                  setName(suggestion?.name ?? speaker.suggestion ?? '');
                }}
              >
                {t('transcript.useSuggestion')}
              </Button>
            </p>
            <p className="field-hint">{t('transcript.suggestionNote')}</p>
          </Alert>
        )}
        <TextField label={t('transcript.displayName')} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        <SelectField
          label={t('transcript.mapPerson')}
          value={personId}
          onChange={(e) => {
            setPersonId(e.target.value);
            const p = people.find((x) => x.id === e.target.value);
            if (p && !name) setName(p.name);
          }}
          options={[{ value: '', label: t('common.none') }, ...people.map((p) => ({ value: p.id, label: p.organization ? `${p.name}（${p.organization}）` : p.name }))]}
        />
      </div>
    </Dialog>
  );
}

function SegmentRow({
  s,
  speakers,
  query,
  active,
  onSeek,
  onSpeaker,
  onSaved,
  canEdit,
}: {
  s: SegmentDto;
  speakers: SpeakerDto[];
  query: string;
  active: boolean;
  onSeek(ms: number): void;
  onSpeaker(sp: SpeakerDto | null): void;
  onSaved(seg: SegmentDto): void;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { a } = useWs();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.text);
  const [speakerId, setSpeakerId] = useState(s.speakerId ?? '');
  const [conflict, setConflict] = useState<{ text: string; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const sp = speakers.find((x) => x.id === s.speakerId) ?? null;
  const name = sp?.displayName ?? s.speakerName ?? sp?.label ?? s.speakerLabel;
  const low = isLowConfidence(s);

  const save = async (expectedRevision = s.revision) => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { expectedRevision };
      if (text !== s.text) body.text = text;
      // The API moves a segment to another speaker but cannot clear the speaker (speakerId is not nullable).
      if (speakerId && speakerId !== (s.speakerId ?? '')) body.speakerId = speakerId;
      if (body.text === undefined && body.speakerId === undefined) {
        setEditing(false);
        return;
      }
      const r = await api.patch<SegmentDto | { segment: SegmentDto }>(a(`/segments/${s.id}`), body);
      const seg = (r && 'segment' in (r as object) ? (r as { segment: SegmentDto }).segment : (r as SegmentDto)) ?? null;
      onSaved(seg && seg.id ? seg : { ...s, text, speakerId: speakerId || null, revision: expectedRevision + 1 });
      setEditing(false);
      setConflict(null);
      toast.announce(t('transcript.saved'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const d = (e.details ?? {}) as { server?: SegmentDto; current?: SegmentDto; text?: string; revision?: number };
        const cur = d.server ?? d.current;
        setConflict({ text: cur?.text ?? d.text ?? '', revision: cur?.revision ?? d.revision ?? s.revision + 1 });
      } else toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li id={`seg-${s.id}`} className={`seg${low ? ' seg-low' : ''}${active ? ' seg-active' : ''}`} data-start={s.startMs}>
      <button type="button" className="timestamp" onClick={() => onSeek(s.startMs)} aria-label={t('transcript.seekTo', { time: msToClock(s.startMs) })}>
        {msToClock(s.startMs)}
      </button>
      <button type="button" className={`speaker-chip sp-${speakerColor(s.speakerId)}`} onClick={() => onSpeaker(sp)} disabled={!canEdit || !sp} title={t('transcript.editSpeaker')}>
        {name}
        {sp && !sp.personId && !sp.displayName && <span className="sr-only"> {t('transcript.unmapped')}</span>}
      </button>
      <div className="seg-body">
        {editing ? (
          <div className="stack">
            <label className="sr-only" htmlFor={`seg-text-${s.id}`}>
              {t('transcript.text')}
            </label>
            <textarea id={`seg-text-${s.id}`} className="input textarea" value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus />
            <SelectField
              label={t('transcript.speaker')}
              value={speakerId}
              onChange={(e) => setSpeakerId(e.target.value)}
              options={[...(s.speakerId ? [] : [{ value: '', label: t('transcript.noSpeaker') }]), ...speakers.map((x) => ({ value: x.id, label: x.displayName ?? x.label }))]}
            />
            {conflict && (
              <Alert tone="warn" title={t('transcript.conflict')}>
                <p>{t('transcript.conflictBody')}</p>
                <blockquote className="quote">{conflict.text}</blockquote>
                <div className="button-row">
                  <Button
                    size="sm"
                    onClick={() => {
                      setText(conflict.text);
                      onSaved({ ...s, text: conflict.text, revision: conflict.revision });
                      setConflict(null);
                      setEditing(false);
                    }}
                  >
                    {t('transcript.useServer')}
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => save(conflict.revision)}>
                    {t('transcript.applyMine')}
                  </Button>
                </div>
              </Alert>
            )}
            <div className="button-row">
              <Button size="sm" variant="primary" onClick={() => save()} loading={busy} disabled={!!conflict}>
                {t('common.save')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setText(s.text);
                  setConflict(null);
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <p className="seg-text" title={low ? t('transcript.lowConfidence') : undefined}>
            <Highlighted text={s.text} query={query} />
            {low && <span className="sr-only"> ({t('transcript.lowConfidence')})</span>}
          </p>
        )}
      </div>
      <div className="seg-actions">
        {canEdit && !editing && (
          <button type="button" className="icon-btn icon-btn-sm" aria-label={t('transcript.edit', { time: msToClock(s.startMs) })} title={t('common.edit')} onClick={() => setEditing(true)}>
            <Icon name="edit" size={16} />
          </button>
        )}
        {s.revision > 1 && (
          <Popover label={t('transcript.history')} icon="history">
            {() => <RevisionHistory segmentId={s.id} />}
          </Popover>
        )}
      </div>
    </li>
  );
}

export function TranscriptTab() {
  const { t, fmt } = useI18n();
  const { meeting, ma, mp } = useMeeting();
  const [params] = useSearchParams();
  const [version, setVersion] = useState('');
  const tr = useApi<TranscriptDto | null>(ma(`/transcript${version ? `?version=${version}` : ''}`));
  const versions = useApi<unknown>(ma('/transcript/versions'));
  const media = useApi<unknown>(ma('/media'));
  const [segments, setSegments] = useState<SegmentDto[]>([]);
  const [query, setQuery] = useState('');
  const dq = useDebounced(query, 200);
  const [matchIdx, setMatchIdx] = useState(0);
  const [limit, setLimit] = useState(PAGE);
  const [speakerEdit, setSpeakerEdit] = useState<SpeakerDto | null>(null);
  const [remapped, setRemapped] = useState(false);
  const [reextracting, setReextracting] = useState(false);
  const toast = useToast();
  const [currentMs, setCurrentMs] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const initialSeek = useRef<number | null>(params.get('t') ? Number(params.get('t')) : null);

  useEffect(() => setSegments(tr.data?.segments ?? []), [tr.data]);
  const assets = listOf<MediaAssetDto>(media.data, 'assets', 'media');
  const asset = assets.find((x) => x.url && x.playable !== false && /audio|video/.test(x.mime ?? x.mimeType ?? x.mime_type ?? 'audio')) ?? assets.find((x) => x.url);
  useEffect(() => setAudioSrc(asset?.url ?? null), [asset?.url]);

  const matches = useMemo(() => (dq ? segments.filter((s) => s.text.toLowerCase().includes(dq.toLowerCase())).map((s) => s.id) : []), [segments, dq]);
  useEffect(() => setMatchIdx(0), [dq]);

  const scrollTo = useCallback(
    (id: string) => {
      const idx = segments.findIndex((s) => s.id === id);
      if (idx >= limit) setLimit(Math.ceil((idx + 1) / PAGE) * PAGE);
      setTimeout(() => document.getElementById(`seg-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 30);
    },
    [segments, limit],
  );

  useEffect(() => {
    if (matches.length) scrollTo(matches[Math.min(matchIdx, matches.length - 1)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchIdx, matches]);

  const seek = useCallback((ms: number) => {
    setCurrentMs(ms);
    const el = audioRef.current;
    if (el) {
      el.currentTime = ms / 1000;
      el.play().catch(() => undefined);
    }
  }, []);

  // ?t=ms from citations: scroll to the segment and seek once
  useEffect(() => {
    const target = initialSeek.current;
    if (target === null || !segments.length) return;
    const seg = segments.find((s) => s.startMs <= target && s.endMs >= target) ?? segments.find((s) => s.startMs >= target) ?? segments[segments.length - 1];
    if (seg) {
      scrollTo(seg.id);
      setCurrentMs(seg.startMs);
      if (audioRef.current) audioRef.current.currentTime = seg.startMs / 1000;
    }
    initialSeek.current = null;
  }, [segments, scrollTo]);

  const onAudioError = async () => {
    // Signed media URLs are short-lived: fetch a fresh one and continue at the same position.
    const pos = audioRef.current?.currentTime ?? 0;
    try {
      const r = await api.get(ma('/media'));
      const fresh = listOf<MediaAssetDto>(r, 'assets', 'media').find((x) => x.id === asset?.id)?.url;
      if (fresh && fresh !== audioSrc) {
        setAudioSrc(fresh);
        setTimeout(() => {
          if (audioRef.current) audioRef.current.currentTime = pos;
        }, 50);
      }
    } catch {
      /* ignore */
    }
  };

  const activeId = useMemo(() => {
    if (currentMs === null) return null;
    return segments.find((s) => s.startMs <= currentMs && s.endMs > currentMs)?.id ?? null;
  }, [segments, currentMs]);

  if (tr.loading && tr.data === undefined) return <Loading />;
  if (tr.error && tr.data === undefined) return <ErrorView error={tr.error} onRetry={tr.reload} />;
  const transcript = tr.data;
  if (!transcript)
    return (
      <EmptyState
        icon="file"
        title={t('transcript.empty')}
        body={meeting.transcriptionMode === 'none' ? t('capture.transcriptionOff') : t('transcript.emptyBody')}
        action={
          <Link to={mp('/capture')} className="btn btn-primary btn-md">
            {t('meeting.tab.capture')}
          </Link>
        }
      />
    );

  const speakers = transcript.speakers ?? [];
  const unmapped = speakers.filter((s) => !s.personId && !s.displayName);
  const versionList = listOf<{ version: number; provider?: string; createdAt?: string; isLocal?: boolean }>(versions.data, 'versions');

  return (
    <div className="transcript">
      <CachedNotice at={tr.cachedAt} />
      <div className="transcript-toolbar">
        <div className="search-box">
          <label htmlFor="tr-search" className="sr-only">
            {t('transcript.search')}
          </label>
          <Icon name="search" size={16} />
          <input
            id="tr-search"
            className="input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('transcript.search')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches.length) setMatchIdx((i) => (e.shiftKey ? (i - 1 + matches.length) % matches.length : (i + 1) % matches.length));
            }}
          />
          {dq && (
            <span className="muted" aria-live="polite">
              {matches.length ? t('transcript.matchN', { i: Math.min(matchIdx, matches.length - 1) + 1, n: matches.length }) : t('transcript.noMatch')}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => setMatchIdx((i) => (i - 1 + matches.length) % Math.max(1, matches.length))} disabled={!matches.length}>
            {t('common.prev')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMatchIdx((i) => (i + 1) % Math.max(1, matches.length))} disabled={!matches.length}>
            {t('common.next')}
          </Button>
        </div>
        {versionList.length > 1 && (
          <SelectField
            label={t('transcript.version')}
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            options={[
              { value: '', label: t('transcript.current') },
              ...versionList.map((v) => ({ value: String(v.version), label: `v${v.version}${v.provider ? ` · ${v.provider}` : ''}${v.createdAt ? ` · ${fmt.date(v.createdAt)}` : ''}` })),
            ]}
          />
        )}
      </div>
      <div className="transcript-meta">
        <Badge tone={transcript.isLocal ? 'info' : 'neutral'}>{transcript.isLocal ? t('privacy.local') : t('privacy.cloud')}</Badge>
        <span className="muted">
          {t('transcript.provider', { provider: transcript.provider })} · v{transcript.version} · {fmt.dateTime(transcript.createdAt)}
        </span>
      </div>
      {audioSrc ? (
        <audio
          ref={audioRef}
          className="audio-player"
          controls
          preload="metadata"
          src={audioSrc}
          onError={onAudioError}
          onTimeUpdate={(e) => setCurrentMs(Math.round((e.target as HTMLAudioElement).currentTime * 1000))}
          aria-label={t('transcript.audio')}
        />
      ) : (
        <p className="field-hint">{t('transcript.noAudio')}</p>
      )}
      {speakers.length > 0 && (
        <div className="speakers" aria-label={t('transcript.speakers')}>
          <span className="small-title">{t('transcript.speakers')}</span>
          {speakers.map((sp) => (
            <button key={sp.id} type="button" className={`speaker-chip sp-${speakerColor(sp.id)}`} onClick={() => setSpeakerEdit(sp)} disabled={!meeting.canEdit}>
              {sp.displayName ?? sp.label}
              {sp.suggestion && !sp.personId && <span className="chip-hint">{t('transcript.hasSuggestion')}</span>}
            </button>
          ))}
          {unmapped.length > 0 && <span className="field-hint">{t('transcript.unmappedN', { n: unmapped.length })}</span>}
        </div>
      )}
      {remapped && meeting.canEdit && meeting.aiEnabled !== false && !version && (
        <Alert tone="info" title={t('transcript.reextractTitle')}>
          <p>{t('transcript.reextractHint')}</p>
          <Button
            size="sm"
            icon="sparkle"
            loading={reextracting}
            onClick={async () => {
              setReextracting(true);
              try {
                await api.post(ma('/extract'), { rerun: true });
                toast.success(t('transcript.reextractQueued'));
                setRemapped(false);
              } catch (e) {
                toast.error(e);
              } finally {
                setReextracting(false);
              }
            }}
          >
            {t('transcript.reextract')}
          </Button>
        </Alert>
      )}
      <p className="field-hint legend">
        <span className="legend-low">{t('transcript.lowConfidence')}</span> <span className="inaudible">{t('transcript.inaudible')}</span> {t('transcript.legend')}
      </p>
      <ol className="segments">
        {segments.slice(0, limit).map((s) => (
          <SegmentRow
            key={s.id}
            s={s}
            speakers={speakers}
            query={dq}
            active={s.id === activeId || s.id === matches[matchIdx]}
            onSeek={seek}
            onSpeaker={setSpeakerEdit}
            onSaved={(seg) => setSegments((list) => list.map((x) => (x.id === seg.id ? { ...x, ...seg } : x)))}
            canEdit={meeting.canEdit && !version}
          />
        ))}
      </ol>
      {segments.length > limit && (
        <Button onClick={() => setLimit((l) => l + PAGE)} className="load-more">
          {t('transcript.showMore', { n: segments.length - limit })}
        </Button>
      )}
      <SpeakerDialog
        speaker={speakerEdit}
        onClose={() => setSpeakerEdit(null)}
        onSaved={() => {
          tr.reload();
          setRemapped(true);
        }}
      />
    </div>
  );
}
