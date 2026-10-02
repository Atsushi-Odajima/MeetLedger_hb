import { useState, type FormEvent } from 'react';
import type { AskResponseDto, PersonDto } from '@meetledger/shared';
import { Alert, Button, ErrorView, Loading, PageHeader, SelectField, TextArea, TextField } from '../components/ui';
import { AskAnswer } from '../components/AskAnswer';
import { useI18n } from '../i18n';
import { useWs } from '../state/workspace';
import { api, listOf } from '../lib/api';
import { useApi } from '../lib/hooks';
import { FILTER_FIELD_ID, TruncatedNotice } from '../components/SearchScope';
import type { ProjectDto } from '../lib/types';

interface AskScopeInfo {
  persons?: { id: string; name: string }[];
  projects?: { id: string; name: string }[];
  dateLabel?: string | null;
  from?: string | null;
  to?: string | null;
  truncated?: boolean;
  searchedFrom?: string | null;
}

/** What the server understood as the scope of the question (people / projects / period). */
function AskScope({ scope }: { scope?: AskScopeInfo }) {
  const { t, fmt } = useI18n();
  if (!scope) return null;
  const parts = [
    ...(scope.persons ?? []).map((p) => p.name),
    ...(scope.projects ?? []).map((p) => p.name),
    scope.dateLabel ?? (scope.from || scope.to ? `${scope.from ? fmt.date(scope.from) : ''}〜${scope.to ? fmt.date(scope.to) : ''}` : ''),
  ].filter(Boolean);
  if (!parts.length) return null;
  return <p className="field-hint">{t('ask.scopeUsed', { scope: parts.join(' / ') })}</p>;
}

export function AskPage() {
  const { t } = useI18n();
  const { a, ws } = useWs();
  const projects = useApi<unknown>(a('/projects'));
  const people = useApi<unknown>(a('/people'));
  const [q, setQ] = useState('');
  const [projectId, setProjectId] = useState('');
  const [personId, setPersonId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [res, setRes] = useState<AskResponseDto | null>(null);
  const [asked, setAsked] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      const r = await api.post<AskResponseDto>(a('/ask'), {
        question: q.trim(),
        ...(projectId ? { projectId } : {}),
        ...(personId ? { personId } : {}),
        ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
        ...(to ? { to: new Date(`${to}T23:59:59`).toISOString() } : {}),
      });
      setRes(r);
      setAsked(q.trim());
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };
  const ai = ws?.processing.ai;
  return (
    <>
      <PageHeader title={t('nav.ask')} subtitle={t('ask.subtitle')} />
      <Alert tone="info">
        {t('ask.scope')} {ai && <span>{t('ask.provider', { provider: ai.provider, where: ai.isLocal ? t('privacy.local') : t('privacy.cloud') })}</span>}
      </Alert>
      <form className="stack ask-form" onSubmit={submit}>
        <TextArea label={t('ask.question')} value={q} onChange={(e) => setQ(e.target.value)} rows={3} placeholder={t('ask.placeholder')} maxLength={1000} required />
        <details className="filters-details">
          <summary>{t('search.filters')}</summary>
          <div className="filters">
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
            <TextField id={FILTER_FIELD_ID.period} label={t('search.from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <TextField label={t('search.to')} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </details>
        <Button type="submit" variant="primary" icon="sparkle" loading={busy} disabled={!q.trim()}>
          {t('ask.submit')}
        </Button>
      </form>
      {busy && <Loading label={t('ask.thinking')} />}
      {err !== null && <ErrorView error={err} />}
      {res && (
        <section className="card" aria-label={t('ask.answer')}>
          <p className="small-title">{t('ask.youAsked', { q: asked })}</p>
          <AskScope scope={(res as { scope?: AskScopeInfo }).scope} />
          <TruncatedNotice {...((res as { scope?: AskScopeInfo }).scope ?? {})} />
          <AskAnswer res={res} />
        </section>
      )}
    </>
  );
}
