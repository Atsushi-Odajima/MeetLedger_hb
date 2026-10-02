import { useState, type FormEvent } from 'react';
import { Alert, Async, Badge, Button, Card, Checkbox, Dialog, EmptyState, TextArea, TextField } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useToast } from '../../state/toast';
import { api, listOf } from '../../lib/api';
import { copyText, useApi } from '../../lib/hooks';
import type { CalendarEventPreview, ConnectorDto, WebhookDto } from '../../lib/types';

interface PreviewState {
  connectorId: string | null;
  events: CalendarEventPreview[];
}

function readPreview(r: unknown, fallbackId: string | null = null): PreviewState {
  const o = (r ?? {}) as { connectorId?: string; connector?: { id: string }; id?: string; events?: CalendarEventPreview[]; preview?: { events?: CalendarEventPreview[] } };
  return {
    connectorId: o.connectorId ?? o.connector?.id ?? fallbackId ?? o.id ?? null,
    events: o.events ?? o.preview?.events ?? listOf<CalendarEventPreview>(r, 'events'),
  };
}

function EventPreview({ preview, onClose, onImported }: { preview: PreviewState | null; onClose(): void; onImported(): void }) {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const { a } = useWs();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  if (!preview) return null;
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const doImport = async () => {
    if (!preview.connectorId) return;
    setBusy(true);
    try {
      await api.post(a(`/connectors/${preview.connectorId}/import`), { eventIds: [...selected] });
      toast.success(t('connectors.imported', { n: selected.size }));
      onImported();
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
      size="lg"
      title={t('connectors.previewTitle', { n: preview.events.length })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={doImport} disabled={!selected.size || !preview.connectorId} loading={busy}>
            {t('connectors.importN', { n: selected.size })}
          </Button>
        </>
      }
    >
      <p className="field-hint">{t('connectors.previewHint')}</p>
      {preview.events.length ? (
        <>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(preview.events.filter((e) => !e.alreadyImported).map((e) => e.id)))}>
            {t('common.selectAll')}
          </Button>
          <ul className="items">
            {preview.events.map((ev) => (
              <li key={ev.id} className="item">
                <Checkbox
                  label={
                    <>
                      <strong>{ev.title}</strong> <span className="muted">{fmt.dateTime(ev.start ?? ev.startsAt ?? null)}</span>
                      {ev.alreadyImported && <Badge>{t('connectors.alreadyImported')}</Badge>}
                    </>
                  }
                  hint={ev.attendees?.length ? t('connectors.attendees', { n: ev.attendees.length }) : undefined}
                  checked={selected.has(ev.id)}
                  disabled={ev.alreadyImported}
                  onChange={() => toggle(ev.id)}
                />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">{t('connectors.noEvents')}</p>
      )}
    </Dialog>
  );
}

function IcsCard({ onPreview }: { onPreview(p: PreviewState): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { a } = useWs();
  const [url, setUrl] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post(a('/connectors/ics'), url.trim() ? { url: url.trim() } : { content });
      onPreview(readPreview(r));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('connectors.ics')}>
      <form className="stack" onSubmit={submit}>
        <p className="field-hint">{t('connectors.icsHint')}</p>
        <TextField label={t('connectors.icsUrl')} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/calendar.ics" />
        <div className="field">
          <label className="field-label" htmlFor="ics-file">
            {t('connectors.icsFile')}
          </label>
          <input
            id="ics-file"
            type="file"
            className="input"
            accept=".ics,text/calendar"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setContent(await f.text());
            }}
          />
        </div>
        {!url && <TextArea label={t('connectors.icsPaste')} value={content} onChange={(e) => setContent(e.target.value)} rows={3} />}
        <Button type="submit" loading={busy} disabled={!url.trim() && !content.trim()}>
          {t('connectors.preview')}
        </Button>
      </form>
    </Card>
  );
}

function Webhooks() {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const state = useApi<unknown>(a('/webhooks'));
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState('meeting.processed,decision.confirmed,action.confirmed');
  const [secret, setSecret] = useState<string | null>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.post<WebhookDto & { secret?: string }>(a('/webhooks'), {
        url: url.trim(),
        events: events
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      });
      setSecret(r.secret ?? null);
      setUrl('');
      state.reload();
    } catch (err) {
      toast.error(err);
    }
  };
  const remove = async (w: WebhookDto) => {
    if (!window.confirm(t('webhooks.deleteConfirm'))) return;
    try {
      await api.del(a(`/webhooks/${w.id}`));
      state.reload();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Card title={t('webhooks.title')}>
      <p className="field-hint">{t('webhooks.hint')}</p>
      <Async state={state}>
        {(d) => {
          const items = listOf<WebhookDto>(d, 'webhooks');
          return items.length ? (
            <ul className="items">
              {items.map((w) => (
                <li key={w.id} className="item">
                  <div className="item-main">
                    <code className="code-inline">{w.url}</code>
                    <span className="item-meta">
                      {(w.events ?? []).join(', ')} {w.createdAt && `· ${fmt.date(w.createdAt)}`}
                    </span>
                  </div>
                  {can('admin') && (
                    <Button size="sm" variant="ghost" onClick={() => remove(w)}>
                      {t('common.delete')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('webhooks.empty')}</p>
          );
        }}
      </Async>
      {secret && (
        <Alert tone="success" title={t('webhooks.secretOnce')}>
          <div className="copy-row">
            <code className="code-inline">{secret}</code>
            <Button size="sm" icon="copy" onClick={() => copyText(secret).then((ok) => ok && toast.success(t('common.copied')))}>
              {t('common.copy')}
            </Button>
          </div>
        </Alert>
      )}
      {can('admin') && (
        <form className="stack" onSubmit={create}>
          <TextField label={t('webhooks.url')} type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://example.com/hooks/meetledger" />
          <TextField label={t('webhooks.events')} value={events} onChange={(e) => setEvents(e.target.value)} hint={t('webhooks.eventsHint')} />
          <Button type="submit" disabled={!url.trim()}>
            {t('webhooks.add')}
          </Button>
        </form>
      )}
    </Card>
  );
}

export function ConnectorsSettings() {
  const { t, fmt, tm } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const state = useApi<unknown>(a('/connectors'));
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const admin = can('admin');
  const connect = async (provider: 'google_calendar' | 'microsoft_calendar') => {
    setBusy(provider);
    try {
      const r = await api.get<{ authorizeUrl: string }>(a(`/connectors/${provider}/start`));
      const u = new URL(r.authorizeUrl);
      if (u.protocol !== 'https:') throw new Error('Invalid authorize URL');
      window.location.assign(u.toString());
    } catch (e) {
      toast.error(e);
      setBusy(null);
    }
  };
  const sync = async (c: ConnectorDto) => {
    setBusy(c.id);
    try {
      setPreview(readPreview(await api.post(a(`/connectors/${c.id}/sync`)), c.id));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (c: ConnectorDto) => {
    if (!window.confirm(t('connectors.deleteConfirm'))) return;
    try {
      await api.del(a(`/connectors/${c.id}`));
      state.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="stack">
      <Alert tone="info">{t('connectors.intro')}</Alert>
      <Card title={t('connectors.connected')}>
        <Async state={state}>
          {(d) => {
            const items = listOf<ConnectorDto>(d, 'connectors');
            return items.length ? (
              <ul className="items">
                {items.map((c) => (
                  <li key={c.id} className="item">
                    <div className="item-main">
                      <span className="item-title">{c.displayName ?? c.name ?? tm(`connectorProvider.${c.provider}`, c.provider)}</span>
                      <span className="item-meta">
                        <Badge>{tm(`connectorProvider.${c.provider}`, c.provider)}</Badge>
                        {c.status && <Badge tone={c.status === 'active' || c.status === 'connected' ? 'success' : 'neutral'}>{tm(`connectorStatus.${c.status}`, c.status)}</Badge>}
                        {c.lastSyncAt && <span>{t('connectors.lastSync', { time: fmt.dateTime(c.lastSyncAt) })}</span>}
                      </span>
                    </div>
                    <div className="item-side button-row">
                      {['ics', 'google_calendar', 'microsoft_calendar'].includes(c.provider) && (
                        <Button size="sm" icon="sync" onClick={() => sync(c)} loading={busy === c.id}>
                          {t('connectors.sync')}
                        </Button>
                      )}
                      {admin && (
                        <Button size="sm" variant="ghost" onClick={() => remove(c)}>
                          {t('connectors.disconnect')}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon="plug" title={t('connectors.empty')} />
            );
          }}
        </Async>
      </Card>
      <Card title={t('connectors.calendars')}>
        <p className="field-hint">{t('connectors.oauthHint')}</p>
        <div className="button-row">
          <Button icon="calendar" onClick={() => connect('google_calendar')} loading={busy === 'google_calendar'} disabled={!admin}>
            {t('connectors.google')}
          </Button>
          <Button icon="calendar" onClick={() => connect('microsoft_calendar')} loading={busy === 'microsoft_calendar'} disabled={!admin}>
            {t('connectors.microsoft')}
          </Button>
        </div>
      </Card>
      <IcsCard onPreview={setPreview} />
      <Webhooks />
      <EventPreview preview={preview} onClose={() => setPreview(null)} onImported={state.reload} />
    </div>
  );
}
