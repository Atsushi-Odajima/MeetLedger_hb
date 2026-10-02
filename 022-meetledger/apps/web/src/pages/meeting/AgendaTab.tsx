import { useState, type FormEvent } from 'react';
import { findBuiltinTemplate } from '@meetledger/shared';
import { Async, Badge, Button, Card, CandidateBadge, EmptyState, TextField } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useToast } from '../../state/toast';
import { api, listOf } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import type { AgendaItemDto } from '../../lib/types';
import { useMeeting } from './context';

export function AgendaTab() {
  const { t } = useI18n();
  const toast = useToast();
  const { a } = useWs();
  const { meeting, ma } = useMeeting();
  const state = useApi<unknown>(ma('/agenda'));
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<AgendaItemDto[]>([]);
  const tpl = findBuiltinTemplate(meeting.templateKey);

  const add = async (text: string, source = 'manual') => {
    try {
      await api.post(ma('/agenda'), { title: text, source });
      state.reload();
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await add(title.trim())) setTitle('');
  };
  const suggest = async () => {
    setBusy(true);
    try {
      const r = await api.post<unknown>(ma('/agenda/suggest'));
      const items = listOf<AgendaItemDto>(r, 'suggestions', 'agenda');
      const existing = new Set(listOf<AgendaItemDto>(state.data, 'agenda').map((x) => x.id));
      setSuggestions(items.filter((x) => !existing.has(x.id)));
      state.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const patch = async (item: AgendaItemDto, body: Partial<AgendaItemDto>) => {
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
          const items = listOf<AgendaItemDto>(data, 'agenda').sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
          return items.length ? (
            <Card title={t('agenda.title')}>
              <ol className="items agenda-list">
                {items.map((it) => {
                  const candidate = it.reviewState === 'candidate' || it.status === 'suggested';
                  return (
                    <li key={it.id} className={`item${candidate ? ' item-candidate' : ''}${it.status === 'done' || it.status === 'covered' ? ' item-done' : ''}`}>
                      {meeting.canEdit && !candidate && (
                        <input
                          type="checkbox"
                          className="item-check"
                          checked={it.status === 'done' || it.status === 'covered'}
                          onChange={(e) => patch(it, { status: e.target.checked ? 'done' : 'open' })}
                          aria-label={t('agenda.markDone', { title: it.title })}
                        />
                      )}
                      <div className="item-main">
                        <div className="item-title">
                          {candidate && <CandidateBadge />}
                          <span>{it.title}</span>
                        </div>
                        {it.notes && <p className="item-meta">{it.notes}</p>}
                        {it.source && it.source !== 'manual' && <Badge>{t('agenda.fromSource', { source: it.source })}</Badge>}
                      </div>
                      {candidate && meeting.canEdit && (
                        <div className="item-side button-row">
                          <Button size="sm" onClick={() => patch(it, { reviewState: 'confirmed', status: 'open' })}>
                            {t('review.accept')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => patch(it, { reviewState: 'rejected', status: 'dropped' })}>
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
            <EmptyState icon="list" title={t('agenda.empty')} body={tpl?.agenda.length ? t('agenda.templateHint') : undefined} />
          );
        }}
      </Async>
      {suggestions.length > 0 && (
        <Card title={t('agenda.suggestions')} candidate>
          <ul className="items">
            {suggestions.map((s, i) => (
              <li key={s.id ?? i} className="item item-candidate">
                <div className="item-main">
                  <div className="item-title">
                    <CandidateBadge />
                    <span>{s.title}</span>
                  </div>
                </div>
                <Button size="sm" onClick={() => add(s.title, 'suggested').then((ok) => ok && setSuggestions((l) => l.filter((x) => x !== s)))}>
                  {t('common.add')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {meeting.canEdit && (
        <>
          <form className="inline-form" onSubmit={submit}>
            <TextField label={t('agenda.add')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
            <Button type="submit" icon="plus" disabled={!title.trim()}>
              {t('common.add')}
            </Button>
          </form>
          <div className="button-row">
            <Button icon="sparkle" onClick={suggest} loading={busy}>
              {t('agenda.suggest')}
            </Button>
            {tpl && tpl.agenda.length > 0 && (
              <Button
                variant="ghost"
                onClick={async () => {
                  for (const x of tpl.agenda) await add(x, 'template');
                }}
              >
                {t('agenda.fromTemplate', { name: tpl.name })}
              </Button>
            )}
          </div>
          <p className="field-hint">{t('agenda.suggestHint')}</p>
        </>
      )}
    </div>
  );
}
