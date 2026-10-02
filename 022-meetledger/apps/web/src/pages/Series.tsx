import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BUILTIN_TEMPLATES, MEETING_TYPES, type MeetingDto, type MeetingType, type Paged, type Visibility } from '@meetledger/shared';
import { Async, Badge, Button, Card, Dialog, EmptyState, PageHeader, SelectField, TextField } from '../components/ui';
import { Icon } from '../components/Icon';
import { MeetingRow } from '../components/ledger';
import { MemoryView, type MemoryDto } from '../components/MemoryView';
import { fromLocalInput, toLocalInput } from '../components/MeetingForm';
import { useI18n, type MsgKey } from '../i18n';
import { useWs } from '../state/workspace';
import { useToast } from '../state/toast';
import { api, listOf, qs } from '../lib/api';
import { useApi } from '../lib/hooks';
import type { ProjectDto, SeriesDto } from '../lib/types';

export function SeriesListPage() {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const { a, p, can } = useWs();
  const navigate = useNavigate();
  const state = useApi<unknown>(a('/series'));
  const projects = useApi<unknown>(a('/projects'));
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: '', cadence: '', projectId: '', meetingType: 'internal' as MeetingType, templateKey: '', defaultVisibility: 'workspace' as Visibility });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const s = await api.post<SeriesDto>(a('/series'), {
        title: f.title.trim(),
        cadence: f.cadence || null,
        projectId: f.projectId || null,
        meetingType: f.meetingType,
        templateKey: f.templateKey || null,
        defaultVisibility: f.defaultVisibility,
      });
      setOpen(false);
      navigate(p(`/series/${s.id}`));
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <>
      <PageHeader
        title={t('nav.series')}
        subtitle={t('series.subtitle')}
        actions={
          can('member') && (
            <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
              {t('series.add')}
            </Button>
          )
        }
      />
      <Async state={state}>
        {(d) => {
          const items = listOf<SeriesDto>(d, 'series');
          return items.length ? (
            <ul className="rows rows-card">
              {items.map((x) => (
                <li key={x.id} className="row">
                  <Icon name="repeat" />
                  <div className="row-main">
                    <Link to={p(`/series/${x.id}`)} className="row-title">
                      {x.title}
                    </Link>
                    <div className="row-meta">
                      <span>{t(`meetingType.${x.meetingType}` as MsgKey)}</span>
                      {x.cadence && <span>{x.cadence}</span>}
                      {typeof x.meetingCount === 'number' && <span>{t('projects.meetingsN', { n: x.meetingCount })}</span>}
                      {x.lastMeetingAt && <span>{t('people.lastMeeting')}: {fmt.date(x.lastMeetingAt)}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="repeat" title={t('series.empty')} body={t('series.emptyBody')} />
          );
        }}
      </Async>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('series.add')}>
        <form className="stack" onSubmit={submit}>
          <TextField label={t('series.title')} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required maxLength={200} />
          <TextField label={t('series.cadence')} value={f.cadence} onChange={(e) => setF({ ...f, cadence: e.target.value })} placeholder={t('series.cadencePlaceholder')} maxLength={100} />
          <div className="grid-2">
            <SelectField
              label={t('meeting.type')}
              value={f.meetingType}
              onChange={(e) => setF({ ...f, meetingType: e.target.value as MeetingType })}
              options={MEETING_TYPES.map((x) => ({ value: x, label: t(`meetingType.${x}` as MsgKey) }))}
            />
            <SelectField
              label={t('meeting.template')}
              value={f.templateKey}
              onChange={(e) => setF({ ...f, templateKey: e.target.value })}
              options={[{ value: '', label: t('series.templateAuto') }, ...BUILTIN_TEMPLATES.map((x) => ({ value: x.key, label: x.name }))]}
            />
          </div>
          <div className="grid-2">
            <SelectField
              label={t('meeting.project')}
              value={f.projectId}
              onChange={(e) => setF({ ...f, projectId: e.target.value })}
              options={[{ value: '', label: t('common.none') }, ...listOf<ProjectDto>(projects.data).map((x) => ({ value: x.id, label: x.name }))]}
            />
            <SelectField
              label={t('meeting.visibility')}
              value={f.defaultVisibility}
              onChange={(e) => setF({ ...f, defaultVisibility: e.target.value as Visibility })}
              options={(['private', 'workspace', 'selected'] as const).map((v) => ({ value: v, label: t(`visibility.${v}` as MsgKey) }))}
            />
          </div>
          <div className="form-actions">
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!f.title.trim()}>
              {t('common.create')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function nextWeekSameTime(last: string | null | undefined): string {
  const base = last ? new Date(last) : new Date();
  const d = new Date(base.getTime() + 7 * 86400000);
  if (!last) d.setMinutes(0, 0, 0);
  while (d.getTime() < Date.now()) d.setTime(d.getTime() + 7 * 86400000);
  return d.toISOString();
}

export function SeriesPage() {
  const { seriesId = '' } = useParams();
  const { t } = useI18n();
  const toast = useToast();
  const { a, p, can } = useWs();
  const navigate = useNavigate();
  const series = useApi<SeriesDto>(a(`/series/${seriesId}`));
  const memory = useApi<MemoryDto>(a(`/series/${seriesId}/memory`));
  const meetings = useApi<Paged<MeetingDto>>(a(`/meetings${qs({ seriesId, limit: 30 })}`));
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const openDialog = (s: SeriesDto) => {
    const last = listOf<MeetingDto>(meetings.data)[0];
    setStart(toLocalInput(nextWeekSameTime(last?.scheduledStart ?? s.lastMeetingAt)));
    setTitle(s.title);
    setOpen(true);
  };
  const create = async () => {
    setBusy(true);
    try {
      const m = await api.post<{ id: string } & Partial<MeetingDto>>(a(`/series/${seriesId}/meetings`), { scheduledStart: fromLocalInput(start), title: title.trim() || undefined });
      setOpen(false);
      toast.success(t('series.nextCreated'));
      navigate(p(`/meetings/${m.id}/brief`));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Async state={series}>
      {(s) => (
        <>
          <PageHeader
            title={s.title}
            subtitle={[t(`meetingType.${s.meetingType}` as MsgKey), s.cadence].filter(Boolean).join(' · ')}
            badges={<Badge>{t(`visibility.${s.defaultVisibility}` as MsgKey)}</Badge>}
            actions={
              can('member') && (
                <Button variant="primary" icon="plus" onClick={() => openDialog(s)}>
                  {t('series.createNext')}
                </Button>
              )
            }
          />
          <div className="two-col">
            <Card title={t('series.memory')}>
              <Async state={memory}>{(m) => <MemoryView data={m} />}</Async>
            </Card>
            <Card title={t('nav.meetings')}>
              <Async state={meetings}>
                {(m) =>
                  listOf<MeetingDto>(m).length ? (
                    <ul className="rows">
                      {listOf<MeetingDto>(m).map((mm) => (
                        <MeetingRow key={mm.id} m={mm} />
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">{t('meetings.empty')}</p>
                  )
                }
              </Async>
            </Card>
          </div>
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title={t('series.createNext')}
            footer={
              <>
                <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
                <Button variant="primary" onClick={create} loading={busy} disabled={!start}>
                  {t('common.create')}
                </Button>
              </>
            }
          >
            <div className="stack">
              <TextField label={t('meeting.title')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
              <TextField label={t('meeting.start')} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
              <p className="field-hint">{t('series.nextHint')}</p>
            </div>
          </Dialog>
        </>
      )}
    </Async>
  );
}
