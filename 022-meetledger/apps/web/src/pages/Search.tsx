import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SEARCH_ENTITY_TYPES, msToClock, type PersonDto } from '@meetledger/shared';
import { AiBadge, Badge, Button, CachedNotice, Checkbox, EmptyState, ErrorView, Loading, PageHeader, SelectField, TextField } from '../components/ui';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n';
import { useWs } from '../state/workspace';
import { listOf, qs } from '../lib/api';
import { useApi } from '../lib/hooks';
import { FILTER_FIELD_ID, TruncatedNotice } from '../components/SearchScope';
import type { ProjectDto, SearchHit } from '../lib/types';

/** Server snippets mark matches with [[…]]; otherwise highlight the query terms client-side (never HTML). */
function renderSnippet(text: string, q: string): ReactNode {
  if (text.includes('[[')) return text.split(/\[\[(.*?)\]\]/g).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>));
  return highlight(text, q);
}

function highlight(text: string, q: string): ReactNode {
  const terms = q
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return text;
  const re = new RegExp(`(${terms.join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>));
}

export function SearchPage() {
  const { t, tm, fmt } = useI18n();
  const { a, p } = useWs();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const [types, setTypes] = useState<string[]>(params.get('types')?.split(',').filter(Boolean) ?? []);
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [projectId, setProjectId] = useState(params.get('projectId') ?? '');
  const [personId, setPersonId] = useState(params.get('personId') ?? '');
  const projects = useApi<unknown>(a('/projects'));
  const people = useApi<unknown>(a('/people'));
  const path = q
    ? a(
        `/search${qs({
          q,
          types: params.get('types') ?? undefined,
          from: params.get('from') ? new Date(`${params.get('from')}T00:00:00`).toISOString() : undefined,
          to: params.get('to') ? new Date(`${params.get('to')}T23:59:59`).toISOString() : undefined,
          projectId: params.get('projectId') ?? undefined,
          personId: params.get('personId') ?? undefined,
          limit: 50,
        })}`,
      )
    : null;
  const state = useApi<unknown>(path);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams();
    if (text.trim()) next.set('q', text.trim());
    if (types.length) next.set('types', types.join(','));
    if (from) next.set('from', from);
    if (to) next.set('to', to);
    if (projectId) next.set('projectId', projectId);
    if (personId) next.set('personId', personId);
    setParams(next);
  };
  const hits = listOf<SearchHit>(state.data, 'hits', 'results');
  const truncInfo = (state.data ?? {}) as { truncated?: boolean; searchedFrom?: string | null; hint?: string | null };
  const startOf = (h: SearchHit) => (typeof h.citation?.startMs === 'number' ? h.citation.startMs : typeof h.startMs === 'number' ? h.startMs : null);
  const linkFor = (h: SearchHit): string | null => {
    const ts = startOf(h);
    if (h.meetingId) {
      const tab =
        h.entityType === 'segment' || ts !== null
          ? `transcript${ts !== null ? `?t=${ts}` : ''}`
          : h.entityType === 'summary'
            ? 'summary'
            : h.entityType === 'note'
              ? 'capture'
              : ['decision', 'action', 'commitment', 'question'].includes(h.entityType)
                ? 'ledger'
                : '';
      return p(`/meetings/${h.meetingId}/${tab}`);
    }
    if (h.entityType === 'person') return p(`/people/${h.entityId}`);
    return null;
  };
  return (
    <>
      <PageHeader title={t('nav.search')} subtitle={t('search.subtitle')} />
      <form className="search-form" onSubmit={submit} role="search">
        <div className="inline-form">
          <TextField label={t('search.query')} type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('search.placeholder')} autoFocus />
          <Button type="submit" variant="primary" icon="search" disabled={!text.trim()}>
            {t('nav.search')}
          </Button>
        </div>
        <details className="filters-details">
          <summary>{t('search.filters')}</summary>
          <fieldset className="check-row">
            <legend className="field-label">{t('search.types')}</legend>
            {SEARCH_ENTITY_TYPES.map((ty) => (
              <Checkbox key={ty} label={tm(`entity.${ty}`, ty)} checked={types.includes(ty)} onChange={(e) => setTypes((s) => (e.target.checked ? [...s, ty] : s.filter((x) => x !== ty)))} />
            ))}
          </fieldset>
          <div className="filters">
            <TextField id={FILTER_FIELD_ID.period} label={t('search.from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <TextField label={t('search.to')} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            <SelectField
              id={FILTER_FIELD_ID.project}
              label={t('meeting.project')}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              options={[{ value: '', label: t('common.all') }, ...listOf<ProjectDto>(projects.data).map((x) => ({ value: x.id, label: x.name }))]}
            />
            <SelectField
              id={FILTER_FIELD_ID.person}
              label={t('nav.people')}
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
              options={[{ value: '', label: t('common.all') }, ...listOf<PersonDto>(people.data).map((x) => ({ value: x.id, label: x.name }))]}
            />
          </div>
        </details>
      </form>
      {!q ? (
        <EmptyState icon="search" title={t('search.start')} body={t('search.startBody')} />
      ) : state.loading && !state.data ? (
        <Loading />
      ) : state.error ? (
        <ErrorView error={state.error} onRetry={state.reload} />
      ) : (
        <>
          <CachedNotice at={state.cachedAt} />
          <TruncatedNotice {...truncInfo} />
          <p className="muted" aria-live="polite">
            {t('search.resultsN', { n: hits.length })}
          </p>
          {hits.length ? (
            <ol className="results">
              {hits.map((h, i) => {
                const to = linkFor(h);
                const ts = startOf(h);
                const meetingTitle = h.citation?.meetingTitle ?? h.meetingTitle ?? null;
                const meetingDate = h.citation?.meetingDate ?? h.meetingDate ?? null;
                return (
                  <li key={`${h.entityType}-${h.entityId}-${i}`} className="result">
                    <div className="result-head">
                      <Badge>{tm(`entity.${h.entityType}`, h.entityType)}</Badge>
                      {h.aiGenerated && <AiBadge />}
                      {to ? (
                        <Link to={to} className="result-title">
                          {h.title ?? meetingTitle ?? t('source.open')}
                        </Link>
                      ) : (
                        <span className="result-title">{h.title ?? meetingTitle}</span>
                      )}
                      {meetingTitle && h.title && h.title !== meetingTitle && <span className="muted">{meetingTitle}</span>}
                      {meetingDate && <span className="muted">{fmt.date(meetingDate)}</span>}
                      {h.speaker && <span className="muted">{h.speaker}</span>}
                      {ts !== null && (
                        <span className="timestamp">
                          <Icon name="clock" size={12} /> {msToClock(ts)}
                        </span>
                      )}
                    </div>
                    <p className="result-snippet">{renderSnippet(h.snippet ?? '', q)}</p>
                  </li>
                );
              })}
            </ol>
          ) : (
            <EmptyState icon="search" title={t('search.noResults')} body={t('search.noResultsBody')} />
          )}
        </>
      )}
    </>
  );
}
