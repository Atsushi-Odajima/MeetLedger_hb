import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { MeetingDto, Paged } from '@meetledger/shared';
import { Async, Badge, Button, Card, Dialog, EmptyState, LinkButton, PageHeader, SelectField, TextArea, TextField } from '../components/ui';
import { Icon } from '../components/Icon';
import { MeetingRow } from '../components/ledger';
import { MemoryView, type MemoryDto } from '../components/MemoryView';
import { useI18n } from '../i18n';
import { useWs } from '../state/workspace';
import { useToast } from '../state/toast';
import { api, listOf, qs } from '../lib/api';
import { useApi } from '../lib/hooks';
import type { ProjectDto } from '../lib/types';

export function ProjectsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { a, p, can } = useWs();
  const navigate = useNavigate();
  const state = useApi<unknown>(a('/projects'));
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', kind: 'project' as 'project' | 'client', clientName: '', description: '' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const pr = await api.post<ProjectDto>(a('/projects'), { name: f.name.trim(), kind: f.kind, clientName: f.clientName || null, description: f.description || null });
      setOpen(false);
      navigate(p(`/projects/${pr.id}`));
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <>
      <PageHeader
        title={t('nav.projects')}
        subtitle={t('projects.subtitle')}
        actions={
          can('member') && (
            <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
              {t('projects.add')}
            </Button>
          )
        }
      />
      <Async state={state}>
        {(d) => {
          const items = listOf<ProjectDto>(d, 'projects');
          return items.length ? (
            <ul className="rows rows-card">
              {items.map((x) => (
                <li key={x.id} className="row">
                  <Icon name="folder" />
                  <div className="row-main">
                    <Link to={p(`/projects/${x.id}`)} className="row-title">
                      {x.name}
                    </Link>
                    <div className="row-meta">
                      <Badge>{t(x.kind === 'client' ? 'projects.kind.client' : 'projects.kind.project')}</Badge>
                      {x.clientName && <span>{x.clientName}</span>}
                      {typeof x.meetingCount === 'number' && <span>{t('projects.meetingsN', { n: x.meetingCount })}</span>}
                      {x.status === 'archived' && <Badge>{t('projects.archived')}</Badge>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="folder" title={t('projects.empty')} body={t('projects.emptyBody')} />
          );
        }}
      </Async>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('projects.add')}>
        <form className="stack" onSubmit={submit}>
          <TextField label={t('projects.name')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={200} />
          <SelectField
            label={t('projects.kind')}
            value={f.kind}
            onChange={(e) => setF({ ...f, kind: e.target.value as 'project' | 'client' })}
            options={[
              { value: 'project', label: t('projects.kind.project') },
              { value: 'client', label: t('projects.kind.client') },
            ]}
          />
          <TextField label={t('projects.clientName')} value={f.clientName} onChange={(e) => setF({ ...f, clientName: e.target.value })} maxLength={200} />
          <TextArea label={t('projects.description')} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={3} />
          <div className="form-actions">
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!f.name.trim()}>
              {t('common.create')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const { t } = useI18n();
  const toast = useToast();
  const { a, p, can } = useWs();
  const project = useApi<ProjectDto>(a(`/projects/${projectId}`));
  const memory = useApi<MemoryDto>(a(`/projects/${projectId}/memory`));
  const meetings = useApi<Paged<MeetingDto>>(a(`/meetings${qs({ projectId, limit: 30 })}`));
  const toggleArchive = async (pr: ProjectDto) => {
    try {
      await api.patch(a(`/projects/${pr.id}`), { status: pr.status === 'archived' ? 'active' : 'archived' });
      project.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Async state={project}>
      {(pr) => (
        <>
          <PageHeader
            title={pr.name}
            subtitle={[pr.clientName, pr.description].filter(Boolean).join(' · ')}
            badges={<Badge>{t(pr.kind === 'client' ? 'projects.kind.client' : 'projects.kind.project')}</Badge>}
            actions={
              <>
                {can('member') && (
                  <LinkButton to={p(`/meetings/new?projectId=${pr.id}`)} variant="primary" icon="plus">
                    {t('meeting.new')}
                  </LinkButton>
                )}
                <a className="btn btn-secondary btn-md" href={a(`/projects/${pr.id}/book?format=md`)} download>
                  <Icon name="download" />
                  <span>{t('projects.book')}</span>
                </a>
                <a className="btn btn-ghost btn-md" href={a(`/projects/${pr.id}/book?format=html`)} download>
                  <span>HTML</span>
                </a>
                {can('member') && <Button onClick={() => toggleArchive(pr)}>{pr.status === 'archived' ? t('projects.unarchive') : t('projects.archive')}</Button>}
              </>
            }
          />
          <div className="two-col">
            <Card title={t('projects.memory')}>
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
        </>
      )}
    </Async>
  );
}
