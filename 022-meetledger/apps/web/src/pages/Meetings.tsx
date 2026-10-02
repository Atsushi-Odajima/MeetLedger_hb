import { useState } from 'react';
import { MEETING_STATUSES, MEETING_TYPES, type MeetingDto, type Paged } from '@meetledger/shared';
import { Async, Button, EmptyState, LinkButton, PageHeader, SelectField, TextField } from '../components/ui';
import { MeetingRow } from '../components/ledger';
import { useI18n, type MsgKey } from '../i18n';
import { useWs } from '../state/workspace';
import { useApi, useDebounced } from '../lib/hooks';
import { api, listOf, qs } from '../lib/api';
import type { ProjectDto } from '../lib/types';
import { useToast } from '../state/toast';

export function MeetingsPage() {
  const { t } = useI18n();
  const { a, p, can } = useWs();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [projectId, setProjectId] = useState('');
  const [view, setView] = useState<'upcoming' | 'past' | 'all'>('all');
  const dq = useDebounced(q, 300);
  const projects = useApi<unknown>(a('/projects'));
  const now = new Date().toISOString();
  const path = a(
    `/meetings${qs({
      q: dq,
      status,
      type,
      projectId,
      limit: 50,
      from: view === 'upcoming' ? now : undefined,
      to: view === 'past' ? now : undefined,
      order: view === 'upcoming' ? 'asc' : 'desc',
    })}`,
  );
  const list = useApi<Paged<MeetingDto>>(path, { keepPrevious: true });
  const [extra, setExtra] = useState<{ path: string; items: MeetingDto[]; cursor: string | null } | null>(null);
  const items = [...listOf<MeetingDto>(list.data), ...(extra?.path === path ? extra.items : [])];
  const cursor = extra?.path === path ? extra.cursor : (list.data?.nextCursor ?? null);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await api.get<Paged<MeetingDto>>(`${path}&before=${encodeURIComponent(cursor)}`);
      setExtra({ path, items: [...(extra?.path === path ? extra.items : []), ...listOf<MeetingDto>(r)], cursor: r.nextCursor });
    } catch (e) {
      toast.error(e);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('nav.meetings')}
        actions={
          can('member') ? (
            <LinkButton to={p('/meetings/new')} variant="primary" icon="plus">
              {t('meeting.new')}
            </LinkButton>
          ) : undefined
        }
      />
      <div className="filters" role="search">
        <TextField label={t('common.search')} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('meetings.searchPlaceholder')} />
        <SelectField
          label={t('meetings.view')}
          value={view}
          onChange={(e) => setView(e.target.value as typeof view)}
          options={[
            { value: 'all', label: t('meetings.view.all') },
            { value: 'upcoming', label: t('meetings.view.upcoming') },
            { value: 'past', label: t('meetings.view.past') },
          ]}
        />
        <SelectField
          label={t('meeting.status')}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[{ value: '', label: t('common.all') }, ...MEETING_STATUSES.map((s) => ({ value: s, label: t(`meetingStatus.${s}` as MsgKey) }))]}
        />
        <SelectField
          label={t('meeting.type')}
          value={type}
          onChange={(e) => setType(e.target.value)}
          options={[{ value: '', label: t('common.all') }, ...MEETING_TYPES.map((s) => ({ value: s, label: t(`meetingType.${s}` as MsgKey) }))]}
        />
        <SelectField
          label={t('meeting.project')}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          options={[{ value: '', label: t('common.all') }, ...listOf<ProjectDto>(projects.data).map((pr) => ({ value: pr.id, label: pr.name }))]}
        />
      </div>
      <Async state={list}>
        {() =>
          items.length ? (
            <>
              <ul className="rows rows-card">
                {items.map((m) => (
                  <MeetingRow key={m.id} m={m} />
                ))}
              </ul>
              {cursor && (
                <Button onClick={loadMore} loading={loadingMore} className="load-more">
                  {t('common.loadMore')}
                </Button>
              )}
            </>
          ) : (
            <EmptyState
              icon="calendar"
              title={t('meetings.empty')}
              body={t('meetings.emptyBody')}
              action={
                can('member') ? (
                  <LinkButton to={p('/meetings/new')} variant="primary" icon="plus">
                    {t('meeting.new')}
                  </LinkButton>
                ) : undefined
              }
            />
          )
        }
      </Async>
    </>
  );
}
