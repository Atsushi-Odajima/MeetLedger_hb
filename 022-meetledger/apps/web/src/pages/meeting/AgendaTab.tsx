import { useState, type FormEvent } from 'react';
import { Async, Badge, Button, Card, CandidateBadge, EmptyState, TextField } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useToast } from '../../state/toast';
import { api, listOf } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import type { AgendaItemDto } from '../../lib/types';
import { useMeeting } from './context';

/** Agenda: manual items + suggestions (carry-overs from earlier meetings and template items) that stay candidates until accepted. */
export function AgendaTab() {
  const { t, tm } = useI18n();
  const toast = useToast();
  const { a } = useWs();
  const { meeting, ma } = useMeeting();
  const state = useApi<unknown>(ma('/agenda'));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [showRejected, setShowRejected] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(ma('/agenda'), { text: text.trim() });
      setText('');
      state.reload();
    } catch (err) {
      toast.error(err);
    }
  };
  const suggest = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ created?: number; items?: AgendaItemDto[] }>(ma('/agenda/suggest'));
      if (r?.items) state.setData(r);
      else state.reload();
      toast.info(r?.created ? t('agenda.suggested', { n: r.created }) : t('agenda.noSuggestions'));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const patch = async (item: AgendaItemDto, body: Record<string, unknown>) => {
    try {
      await api.patch(a(`/agenda/${item.id}`), body);
      state.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="stack">
      <Async state={state}>
        {(data) => {
          const all = listOf<AgendaItemDto>(data, 'agenda').sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
          const items = all.filter((x) => showRejected || x.status !== 'rejected');
          const rejected = all.length - all.filter((x) => x.status !== 'rejected').length;
          return items.length ? (
            <Card title={t('agenda.title')} actions={rejected > 0 ? <Button size="sm" variant="ghost" onClick={() => setShowRejected((v) => !v)}>{showRejected ? t('agenda.hideRejected') : t('agenda.showRejected', { n: rejected })}</Button> : undefined}>
              <ol className="items agenda-list">
                {items.map((it) => {
                  const label = it.text ?? it.title ?? '';
                  const candidate = it.status === 'candidate';
                  const done = it.status === 'done';
                  return (
                    <li key={it.id} className={`item${candidate ? ' item-candidate' : ''}${done ? ' item-done' : ''}${it.status === 'rejected' ? ' item-read' : ''}`}>
                      {meeting.canEdit && !candidate && it.status !== 'rejected' && (
                        <input
                          type="checkbox"
                          className="item-check"
                          checked={done}
                          onChange={(e) => patch(it, { status: e.target.checked ? 'done' : 'accepted' })}
                          aria-label={t('agenda.markDone', { title: label })}
                        />
                      )}
                      <div className="item-main">
                        <div className="item-title">
                          {candidate && <CandidateBadge />}
                          <span className={it.status === 'rejected' ? 'strike' : undefined}>{label}</span>
                        </div>
                        {it.sourceType && it.sourceType !== 'manual' && (
                          <div className="item-meta">
                            <Badge>{tm(`agendaSource.${it.sourceType}`, it.sourceType)}</Badge>
                          </div>
                        )}
                      </div>
                      {candidate && meeting.canEdit && (
                        <div className="item-side button-row">
                          <Button size="sm" onClick={() => patch(it, { status: 'accepted' })}>
                            {t('review.accept')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => patch(it, { status: 'rejected' })}>
                            {t('review.reject')}
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </Card>
          ) : (
            <EmptyState icon="list" title={t('agenda.empty')} body={meeting.canEdit ? t('agenda.emptyBody') : undefined} />
          );
        }}
      </Async>
      {meeting.canEdit && (
        <>
          <form className="inline-form" onSubmit={submit}>
            <TextField label={t('agenda.add')} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
            <Button type="submit" icon="plus" disabled={!text.trim()}>
              {t('common.add')}
            </Button>
          </form>
          <div className="button-row">
            <Button icon="sparkle" onClick={suggest} loading={busy}>
              {t('agenda.suggest')}
            </Button>
          </div>
          <p className="field-hint">{t('agenda.suggestHint')}</p>
        </>
      )}
    </div>
  );
}
