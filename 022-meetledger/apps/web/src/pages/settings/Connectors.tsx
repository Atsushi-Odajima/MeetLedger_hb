import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Async, Badge, Button, Card, Checkbox, Dialog, EmptyState, SelectField, TextArea, TextField } from '../../components/ui';
import { useI18n, type MsgKey } from '../../i18n';
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
                      <strong>{ev.title}</strong>{' '}
                      <span className="muted">{ev.allDay ? fmt.date(ev.start ?? ev.startsAt ?? null) : fmt.dateTime(ev.start ?? ev.startsAt ?? null)}</span>
                      {(ev.alreadyImported || ev.imported) && <Badge>{t('connectors.alreadyImported')}</Badge>}
                      {ev.recurring && <Badge>{t('connectors.recurring')}</Badge>}
                    </>
                  }
                  hint={ev.attendees?.length ? t('connectors.attendees', { n: ev.attendees.length }) : undefined}
                  checked={selected.has(ev.id)}
                  disabled={ev.alreadyImported || ev.imported}
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

const FALLBACK_EVENTS = [
  'meeting.created',
  'meeting.ready',
  'decision.confirmed',
  'decision.changed',
  'action.created',
  'action.updated',
  'commitment.updated',
  'followup.approved',
  'external_write.executed',
];

function Webhooks() {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const admin = can('admin');
  const state = useApi<unknown>(admin ? a('/webhooks') : null);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['*']);
  const [secret, setSecret] = useState<{ value: string; header?: string } | null>(null);
  const known = ((state.data as { events?: string[] } | undefined)?.events ?? FALLBACK_EVENTS).filter((e) => e !== 'ping');
  if (!admin) return null;
  const toggle = (ev: string, on: boolean) => {
    if (ev === '*') return setEvents(on ? ['*'] : []);
    setEvents((cur) => {
      const base = cur.filter((x) => x !== '*');
      return on ? [...base, ev] : base.filter((x) => x !== ev);
    });
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.post<{ signingSecret?: string; secret?: string; signatureHeader?: string }>(a('/webhooks'), { url: url.trim(), events });
      const value = r.signingSecret ?? r.secret;
      setSecret(value ? { value, header: r.signatureHeader } : null);
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
  const test = async (w: WebhookDto) => {
    try {
      await api.post(a(`/webhooks/${w.id}/test`));
      toast.success(t('webhooks.testQueued'));
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Card title={t('webhooks.title')}>
      <p className="field-hint">{t('webhooks.hint')}</p>
      <Async state={state}>
        {(d) => {
          const items = listOf<WebhookDto & { lastDelivery?: { status: string; httpStatus: string; at: string | null } | null }>(d, 'webhooks');
          return items.length ? (
            <ul className="items">
              {items.map((w) => (
                <li key={w.id} className="item">
                  <div className="item-main">
                    <code className="code-inline">{w.url}</code>
                    <span className="item-meta">
                      {(w.events ?? []).join(', ')} {w.createdAt && `· ${fmt.date(w.createdAt)}`}
                      {w.lastDelivery && (
                        <Badge tone={w.lastDelivery.status === 'delivered' ? 'success' : 'warn'}>{t('webhooks.lastDelivery', { status: w.lastDelivery.httpStatus })}</Badge>
                      )}
                    </span>
                  </div>
                  <div className="item-side button-row">
                    <Button size="sm" onClick={() => test(w)}>
                      {t('webhooks.test')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(w)}>
                      {t('common.delete')}
                    </Button>
                  </div>
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
            <code className="code-inline">{secret.value}</code>
            <Button size="sm" icon="copy" onClick={() => copyText(secret.value).then((ok) => ok && toast.success(t('common.copied')))}>
              {t('common.copy')}
            </Button>
          </div>
          {secret.header && <p className="field-hint">{t('webhooks.signatureHeader', { header: secret.header })}</p>}
        </Alert>
      )}
      <form className="stack" onSubmit={create}>
        <TextField label={t('webhooks.url')} type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://example.com/hooks/meetledger" />
        <fieldset className="check-row">
          <legend className="field-label">{t('webhooks.events')}</legend>
          <Checkbox label={t('webhooks.allEvents')} checked={events.includes('*')} onChange={(e) => toggle('*', e.target.checked)} />
          {known.map((ev) => (
            <Checkbox
              key={ev}
              label={<code className="code-inline">{ev}</code>}
              checked={events.includes('*') || events.includes(ev)}
              disabled={events.includes('*')}
              onChange={(e) => toggle(ev, e.target.checked)}
            />
          ))}
        </fieldset>
        <Button type="submit" disabled={!url.trim() || !events.length}>
          {t('webhooks.add')}
        </Button>
      </form>
    </Card>
  );
}

type WriteKind = 'slack_webhook' | 'slack_bot' | 'hubspot' | 'webhook' | 'gmail';

/** Gmail drafts: a per-user connector (OAuth with the member's own Google account), so every member may connect. */
function GmailConnect({ available }: { available: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const [busy, setBusy] = useState(false);
  const connectGmail = async () => {
    setBusy(true);
    try {
      const r = await api.get<{ authorizeUrl: string }>(a('/connectors/gmail/start'));
      const u = new URL(r.authorizeUrl);
      if (u.protocol !== 'https:') throw new Error('Invalid authorize URL');
      window.location.assign(u.toString());
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <p className="field-hint">{t('connectors.gmailHint')}</p>
      <div>
        <Button type="button" icon="mail" onClick={connectGmail} loading={busy} disabled={!available || !can('member')}>
          {t('connectors.gmailConnect')}
        </Button>
      </div>
      {!available && <p className="field-hint">{t('connectors.notConfigured')}</p>}
    </div>
  );
}

/** Admin-only registration of shared write connectors. Credentials are write-only: sent once, stored encrypted, never shown again. */
function WriteConnectorForm({ onCreated, gmailAvailable }: { onCreated(): void; gmailAvailable: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const { a } = useWs();
  const [kind, setKind] = useState<WriteKind>('slack_webhook');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [channel, setChannel] = useState('');
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState<{ value: string; header?: string } | null>(null);
  const reset = () => {
    setSecret('');
    setChannel('');
    setName('');
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (kind === 'gmail') return;
    setBusy(true);
    setSigning(null);
    try {
      const displayName = name.trim() || undefined;
      const body =
        kind === 'slack_webhook'
          ? { provider: 'slack', mode: 'incoming_webhook', webhookUrl: secret.trim(), channelLabel: channel.trim() || undefined, displayName }
          : kind === 'slack_bot'
            ? { provider: 'slack', mode: 'bot', botToken: secret.trim(), defaultChannel: channel.trim() || undefined, displayName }
            : kind === 'hubspot'
              ? { provider: 'hubspot', accessToken: secret.trim(), displayName }
              : { provider: 'webhook', url: secret.trim(), displayName };
      const r = await api.post<{ signingSecret?: string; signatureHeader?: string }>(a('/connectors'), body);
      reset();
      if (r.signingSecret) setSigning({ value: r.signingSecret, header: r.signatureHeader });
      toast.success(t('connectors.writeCreated'));
      onCreated();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const secretLabel: Record<Exclude<WriteKind, 'gmail'>, MsgKey> = {
    slack_webhook: 'connectors.slackWebhookUrl',
    slack_bot: 'connectors.slackBotToken',
    hubspot: 'connectors.hubspotToken',
    webhook: 'connectors.webhookUrl',
  };
  return (
    <Card title={t('connectors.writeTitle')} id="write-connectors">
      <form className="stack" onSubmit={submit} autoComplete="off">
        <p className="field-hint">{t('connectors.writeHint')}</p>
        <div className="grid-2">
          <SelectField
            label={t('connectors.writeProvider')}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as WriteKind);
              setSecret('');
              setChannel('');
            }}
            options={[
              { value: 'slack_webhook', label: t('connectors.slackWebhook') },
              { value: 'slack_bot', label: t('connectors.slackBot') },
              { value: 'gmail', label: t('connectors.gmailDraft') },
              { value: 'hubspot', label: t('connectorProvider.hubspot') },
              { value: 'webhook', label: t('connectors.genericWebhook') },
            ]}
          />
          {kind !== 'gmail' && <TextField label={t('connectors.displayName')} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />}
        </div>
        {kind === 'gmail' ? (
          <GmailConnect available={gmailAvailable} />
        ) : (
          <>
            <TextField
              label={t(secretLabel[kind])}
              type={kind === 'webhook' ? 'url' : 'password'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required
              autoComplete="off"
              placeholder={
                kind === 'slack_webhook'
                  ? 'https://hooks.slack.com/services/…'
                  : kind === 'slack_bot'
                    ? 'xoxb-…'
                    : kind === 'webhook'
                      ? 'https://example.com/hooks/meetledger'
                      : undefined
              }
              hint={kind === 'webhook' ? t('connectors.webhookHint') : t('connectors.secretStored')}
            />
            {(kind === 'slack_webhook' || kind === 'slack_bot') && (
              <TextField
                label={kind === 'slack_webhook' ? t('connectors.slackChannelLabel') : t('connectors.slackDefaultChannel')}
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                maxLength={80}
                placeholder="#sales"
                hint={kind === 'slack_webhook' ? t('connectors.slackChannelLabelHint') : t('connectors.slackDefaultChannelHint')}
              />
            )}
            <div>
              <Button type="submit" loading={busy} disabled={!secret.trim()}>
                {t('connectors.writeAdd')}
              </Button>
            </div>
          </>
        )}
        {signing && (
          <Alert tone="success" title={t('webhooks.secretOnce')}>
            <div className="copy-row">
              <code className="code-inline">{signing.value}</code>
              <Button size="sm" icon="copy" onClick={() => copyText(signing.value).then((ok) => ok && toast.success(t('common.copied')))}>
                {t('common.copy')}
              </Button>
            </div>
            {signing.header && <p className="field-hint">{t('webhooks.signatureHeader', { header: signing.header })}</p>}
          </Alert>
        )}
      </form>
    </Card>
  );
}

export function ConnectorsSettings() {
  const { t, fmt, tm } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const [params, setParams] = useSearchParams();
  const oauthConnected = params.get('connected');
  const oauthError = params.get('error');
  const state = useApi<unknown>(a('/connectors'));
  const available = ((state.data as { available?: Record<string, boolean> } | undefined)?.available ?? {}) as Record<string, boolean>;
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
      {oauthConnected && (
        <Alert tone="success" title={t('connectors.oauthConnected', { provider: tm(`connectorProvider.${oauthConnected}`, oauthConnected) })}>
          <Button size="sm" variant="ghost" onClick={() => setParams({})}>
            {t('common.dismiss')}
          </Button>
        </Alert>
      )}
      {oauthError && (
        <Alert tone="warn" title={t('connectors.oauthFailed')}>
          <p>{tm(`oauthError.${oauthError}`, oauthError)}</p>
          <Button size="sm" variant="ghost" onClick={() => setParams({})}>
            {t('common.dismiss')}
          </Button>
        </Alert>
      )}
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
                        {c.lastError && <span className="text-danger">{c.lastError}</span>}
                      </span>
                    </div>
                    <div className="item-side button-row">
                      {['ics', 'google_calendar', 'microsoft_calendar'].includes(c.provider) && (
                        <Button size="sm" icon="sync" onClick={() => sync(c)} loading={busy === c.id}>
                          {t('connectors.sync')}
                        </Button>
                      )}
                      {(admin || (c.owned && !(c as { shared?: boolean }).shared)) && (
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
          <Button icon="calendar" onClick={() => connect('google_calendar')} loading={busy === 'google_calendar'} disabled={!can('member') || available.google_calendar === false}>
            {t('connectors.google')}
          </Button>
          <Button
            icon="calendar"
            onClick={() => connect('microsoft_calendar')}
            loading={busy === 'microsoft_calendar'}
            disabled={!can('member') || available.microsoft_calendar === false}
          >
            {t('connectors.microsoft')}
          </Button>
        </div>
        {(available.google_calendar === false || available.microsoft_calendar === false) && <p className="field-hint">{t('connectors.notConfigured')}</p>}
      </Card>
      <IcsCard onPreview={setPreview} />
      {admin ? (
        <WriteConnectorForm onCreated={state.reload} gmailAvailable={available.gmail !== false} />
      ) : (
        can('member') && (
          <Card title={t('connectors.gmailDraft')} id="gmail-connect">
            <GmailConnect available={available.gmail !== false} />
            <p className="field-hint">{t('connectors.sharedAdminOnly')}</p>
          </Card>
        )
      )}
      <Webhooks />
      <EventPreview preview={preview} onClose={() => setPreview(null)} onImported={state.reload} />
    </div>
  );
}
