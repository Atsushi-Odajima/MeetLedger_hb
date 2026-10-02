import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { MeetingDto, Paged, PersonDto } from '@meetledger/shared';
import { Async, Badge, Button, Card, Dialog, EmptyState, LoadMore, PageHeader, TextArea, TextField } from '../components/ui';
import { MeetingRow } from '../components/ledger';
import { MemoryView, type MemoryDto, type TimelineEvent } from '../components/MemoryView';
import { useI18n } from '../i18n';
import { useWs } from '../state/workspace';
import { useToast } from '../state/toast';
import { api, listOf, qs } from '../lib/api';
import { useApi, useDebounced, usePaged } from '../lib/hooks';

interface PersonForm {
  name: string;
  organization: string;
  roleTitle: string;
  email: string;
  tags: string;
  notes: string;
}
const emptyForm: PersonForm = { name: '', organization: '', roleTitle: '', email: '', tags: '', notes: '' };

function toBody(f: PersonForm) {
  return {
    name: f.name.trim(),
    organization: f.organization.trim() || null,
    roleTitle: f.roleTitle.trim() || null,
    email: f.email.trim() || null,
    notes: f.notes || null,
    tags: f.tags
      .split(/[,、\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 30),
  };
}

function PersonDialog({ open, initial, onClose, onSave, title }: { open: boolean; initial: PersonForm; onClose(): void; onSave(f: PersonForm): Promise<void>; title: string }) {
  const { t } = useI18n();
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(initial), [initial, open]);
  const set = (k: keyof PersonForm) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(f);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form className="stack" onSubmit={submit}>
        <TextField label={t('people.name')} value={f.name} onChange={set('name')} required maxLength={100} />
        <div className="grid-2">
          <TextField label={t('people.organization')} value={f.organization} onChange={set('organization')} maxLength={200} />
          <TextField label={t('people.roleTitle')} value={f.roleTitle} onChange={set('roleTitle')} maxLength={200} />
        </div>
        <TextField label={t('auth.email')} type="email" value={f.email} onChange={set('email')} />
        <TextField label={t('people.tags')} value={f.tags} onChange={set('tags')} hint={t('people.tagsHint')} />
        <TextArea label={t('people.profileNotes')} value={f.notes} onChange={set('notes')} rows={3} hint={t('people.notesHint')} />
        <div className="form-actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!f.name.trim()}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function PeoplePage() {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const { a, p, can } = useWs();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const state = useApi<unknown>(a(`/people${qs({ q: dq })}`), { keepPrevious: true });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('nav.people')}
        subtitle={t('people.subtitle')}
        actions={
          can('member') && (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              {t('people.add')}
            </Button>
          )
        }
      />
      <div className="filters" role="search">
        <TextField label={t('common.search')} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('people.searchPlaceholder')} />
      </div>
      <Async state={state}>
        {(d) => {
          const items = listOf<PersonDto>(d, 'people');
          return items.length ? (
            <ul className="rows rows-card">
              {items.map((x) => (
                <li key={x.id} className="row">
                  <div className="avatar" aria-hidden="true">
                    {x.name.slice(0, 1)}
                  </div>
                  <div className="row-main">
                    <Link to={p(`/people/${x.id}`)} className="row-title">
                      {x.name}
                    </Link>
                    <div className="row-meta">
                      {[x.organization, x.roleTitle].filter(Boolean).join(' · ')}
                      {x.lastMeetingAt && (
                        <span>
                          {t('people.lastMeeting')}: {fmt.date(x.lastMeetingAt)}
                        </span>
                      )}
                      {x.nextMeetingAt && (
                        <span>
                          {t('people.nextMeeting')}: {fmt.date(x.nextMeetingAt)}
                        </span>
                      )}
                      {!!x.openCommitments && <Badge tone="info">{t('people.openCommitments', { n: x.openCommitments })}</Badge>}
                      {x.userId && <Badge>{t('people.member')}</Badge>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="users" title={t('people.empty')} body={t('people.emptyBody')} />
          );
        }}
      </Async>
      <PersonDialog
        open={creating}
        initial={emptyForm}
        title={t('people.add')}
        onClose={() => setCreating(false)}
        onSave={async (f) => {
          try {
            const created = await api.post<PersonDto>(a('/people'), toBody(f));
            setCreating(false);
            navigate(p(`/people/${created.id}`));
          } catch (e) {
            toast.error(e);
          }
        }}
      />
    </>
  );
}

export function PersonPage() {
  const { personId = '' } = useParams();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const { a, p, can } = useWs();
  const navigate = useNavigate();
  const person = useApi<PersonDto & { personNotes?: { id: string; body: string; created_at?: string; createdAt?: string; author?: string | null }[] }>(a(`/people/${personId}`));
  const timeline = usePaged<TimelineEvent>(a(`/people/${personId}/timeline`), 'events', 'timeline');
  const meetings = useApi<Paged<MeetingDto>>(a(`/meetings${qs({ personId, limit: 20 })}`));
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const addNote = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(a(`/people/${personId}/notes`), { body: note });
      setNote('');
      person.reload();
    } catch (err) {
      toast.error(err);
    }
  };
  const remove = async () => {
    if (!window.confirm(t('people.deleteConfirm'))) return;
    try {
      await api.del(a(`/people/${personId}`));
      toast.success(t('people.deleted'));
      navigate(p('/people'));
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Async state={person}>
      {(x) => (
        <>
          <PageHeader
            title={x.name}
            subtitle={[x.organization, x.roleTitle, x.email].filter(Boolean).join(' · ')}
            badges={x.tags?.map((tag) => (
              <Badge key={tag}>#{tag}</Badge>
            ))}
            actions={
              can('member') && (
                <>
                  <Button icon="edit" onClick={() => setEditing(true)}>
                    {t('common.edit')}
                  </Button>
                  {can('admin') && (
                    <Button variant="danger" icon="trash" onClick={remove}>
                      {t('common.delete')}
                    </Button>
                  )}
                </>
              )
            }
          />
          <div className="two-col">
            <div className="stack">
              <Card title={t('people.timeline')}>
                <Async state={timeline}>
                  {(tl) => (
                    <MemoryView
                      data={{ ...(Array.isArray(tl) ? {} : (tl as MemoryDto)), timeline: timeline.items ?? [], events: undefined }}
                      timelineFooter={
                        <LoadMore
                          shown={timeline.items?.length ?? 0}
                          hasMore={timeline.hasMore}
                          loading={timeline.loadingMore}
                          error={timeline.moreError}
                          onMore={timeline.loadMore}
                        />
                      }
                    />
                  )}
                </Async>
              </Card>
              <Card title={t('people.meetings')}>
                <Async state={meetings}>
                  {(m) =>
                    listOf<MeetingDto>(m).length ? (
                      <ul className="rows">
                        {listOf<MeetingDto>(m).map((mm) => (
                          <MeetingRow key={mm.id} m={mm} />
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">{t('people.noMeetings')}</p>
                    )
                  }
                </Async>
              </Card>
            </div>
            <div className="stack">
              {x.notes && (
                <Card title={t('people.profileNotes')}>
                  <p className="pre">{x.notes}</p>
                </Card>
              )}
              <Card title={t('people.notes')}>
                {can('member') && (
                  <form className="stack" onSubmit={addNote}>
                    <TextArea label={t('people.addNote')} value={note} onChange={(e) => setNote(e.target.value)} rows={3} hint={t('people.notesHint')} />
                    <Button type="submit" disabled={!note.trim()}>
                      {t('common.add')}
                    </Button>
                  </form>
                )}
                <ul className="items">
                  {(x.personNotes ?? []).map((n) => (
                    <li key={n.id} className="item">
                      <div className="item-main">
                        <p className="pre">{n.body}</p>
                        <span className="item-meta">
                          {n.author ?? ''} · {fmt.dateTime(n.created_at ?? n.createdAt ?? null)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
          <PersonDialog
            open={editing}
            title={t('people.edit')}
            initial={{
              name: x.name,
              organization: x.organization ?? '',
              roleTitle: x.roleTitle ?? '',
              email: x.email ?? '',
              tags: (x.tags ?? []).join(', '),
              notes: x.notes ?? '',
            }}
            onClose={() => setEditing(false)}
            onSave={async (f) => {
              try {
                await api.patch(a(`/people/${personId}`), toBody(f));
                setEditing(false);
                person.reload();
              } catch (e) {
                toast.error(e);
              }
            }}
          />
        </>
      )}
    </Async>
  );
}
