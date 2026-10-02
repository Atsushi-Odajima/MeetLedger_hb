import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Async, Badge, Button, Card, Checkbox, EmptyState, PageHeader, SelectField, TabPanel, Tabs, TextField, Toggle } from '../components/ui';
import { useI18n } from '../i18n';
import { useWs } from '../state/workspace';
import { useToast } from '../state/toast';
import { api, listOf } from '../lib/api';
import { useApi } from '../lib/hooks';
import type { NotificationDto, NotificationPrefsDto } from '../lib/types';

function safeLink(link: string | null | undefined): string | null {
  if (!link) return null;
  if (link.startsWith('/') && !link.startsWith('//')) return link;
  try {
    const u = new URL(link);
    if (u.origin === window.location.origin) return u.pathname + u.search;
  } catch {
    /* ignore */
  }
  return null;
}

function List() {
  const { t, tm, fmt } = useI18n();
  const toast = useToast();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const state = useApi<unknown>(`/api/notifications${unreadOnly ? '?unread=1' : ''}`);
  const read = async (n: NotificationDto) => {
    try {
      await api.post(`/api/notifications/${n.id}/read`);
      state.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const readAll = async () => {
    try {
      await api.post('/api/notifications/read-all');
      state.reload();
      toast.announce(t('notif.allRead'));
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <>
      <div className="filters">
        <Checkbox label={t('notif.unreadOnly')} checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
        <div className="filters-end">
          <Button size="sm" icon="check" onClick={readAll}>
            {t('notif.readAll')}
          </Button>
        </div>
      </div>
      <Async state={state}>
        {(d) => {
          const items = listOf<NotificationDto>(d, 'notifications');
          return items.length ? (
            <ul className="items items-card">
              {items.map((n) => {
                const to = safeLink(n.link) ?? (n.workspaceId && n.meetingId ? `/w/${n.workspaceId}/meetings/${n.meetingId}` : null);
                return (
                  <li key={n.id} className={`item${n.readAt ? ' item-read' : ' item-unread'}`}>
                    <div className="item-main">
                      <div className="item-title">
                        {!n.readAt && <span className="unread-dot" aria-label={t('notif.unread')} />}
                        {to ? (
                          <Link to={to} onClick={() => !n.readAt && read(n)}>
                            {n.title}
                          </Link>
                        ) : (
                          <span>{n.title}</span>
                        )}
                      </div>
                      {n.body && <p className="item-meta">{n.body}</p>}
                      {n.items && n.items.length > 0 && (
                        <ul className="plain-list">
                          {n.items.map((c) => {
                            const cl = safeLink(c.link);
                            return <li key={c.id}>{cl ? <Link to={cl}>{c.title}</Link> : c.title}</li>;
                          })}
                        </ul>
                      )}
                      <p className="item-meta">
                        <Badge>{tm(`notifKind.${n.kind}`, n.kind)}</Badge> <span>{fmt.relative(n.createdAt)}</span>
                        {n.orgName && <span>{n.orgName}</span>}
                      </p>
                    </div>
                    {!n.readAt && (
                      <Button size="sm" variant="ghost" onClick={() => read(n)}>
                        {t('notif.markRead')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon="bell" title={t('notif.empty')} body={t('notif.emptyBody')} />
          );
        }}
      </Async>
    </>
  );
}

function timeZones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (fn) return fn('timeZone');
  } catch {
    /* ignore */
  }
  return ['Asia/Tokyo', 'UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Europe/Berlin', 'Asia/Singapore'];
}

function Prefs() {
  const { t, timeZone } = useI18n();
  const toast = useToast();
  const { a } = useWs();
  const state = useApi<NotificationPrefsDto>(a('/notification-prefs'));
  const [f, setF] = useState<NotificationPrefsDto | null>(null);
  const [busy, setBusy] = useState(false);
  const zones = useMemo(timeZones, []);
  useEffect(() => {
    if (state.data) setF({ quietStart: '22:00', quietEnd: '08:00', timezone: timeZone, emailEnabled: true, maxPerHour: 3, briefLeadMin: 30, ...state.data });
  }, [state.data, timeZone]);
  const save = async () => {
    if (!f) return;
    setBusy(true);
    try {
      const saved = await api.put<NotificationPrefsDto>(a('/notification-prefs'), {
        timezone: f.timezone || null,
        ...(f.quietStart ? { quietStart: f.quietStart } : {}),
        ...(f.quietEnd ? { quietEnd: f.quietEnd } : {}),
        emailEnabled: !!f.emailEnabled,
        ...(f.maxPerHour ? { maxPerHour: Math.max(1, Math.min(60, f.maxPerHour)) } : {}),
        ...(typeof f.briefLeadMin === 'number' ? { briefLeadMin: Math.max(0, Math.min(1440, f.briefLeadMin)) } : {}),
      });
      state.setData(saved);
      toast.success(t('common.saved'));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Async state={state}>
      {() =>
        f && (
          <Card title={t('notif.prefs')}>
            <div className="stack">
              <p className="field-hint">{t('notif.prefsIntro')}</p>
              <div className="grid-2">
                <TextField label={t('notif.quietStart')} type="time" value={f.quietStart ?? ''} onChange={(e) => setF({ ...f, quietStart: e.target.value || null })} />
                <TextField label={t('notif.quietEnd')} type="time" value={f.quietEnd ?? ''} onChange={(e) => setF({ ...f, quietEnd: e.target.value || null })} />
              </div>
              <SelectField
                label={t('notif.timezone')}
                value={f.timezone ?? timeZone}
                onChange={(e) => setF({ ...f, timezone: e.target.value })}
                hint={f.timezoneSource === 'profile' ? t('notif.timezoneFromProfile') : undefined}
                options={zones.map((z) => ({ value: z, label: z }))}
              />
              <Toggle
                label={t('notif.email')}
                hint={f.emailDriver === 'outbox' ? t('notif.emailOutbox') : t('notif.emailHint')}
                checked={!!f.emailEnabled}
                onChange={(v) => setF({ ...f, emailEnabled: v })}
              />
              <div className="grid-2">
                <TextField
                  label={t('notif.maxPerHour')}
                  type="number"
                  min={1}
                  max={60}
                  value={f.maxPerHour ?? ''}
                  onChange={(e) => setF({ ...f, maxPerHour: e.target.value === '' ? null : Number(e.target.value) })}
                  hint={t('notif.maxPerHourHint')}
                />
                <TextField
                  label={t('notif.briefLead')}
                  type="number"
                  min={0}
                  max={1440}
                  value={f.briefLeadMin ?? ''}
                  onChange={(e) => setF({ ...f, briefLeadMin: e.target.value === '' ? null : Number(e.target.value) })}
                />
              </div>
              <Button variant="primary" onClick={save} loading={busy}>
                {t('common.save')}
              </Button>
            </div>
          </Card>
        )
      }
    </Async>
  );
}

export function NotificationsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'list' | 'prefs'>('list');
  return (
    <>
      <PageHeader title={t('nav.notifications')} subtitle={t('notif.subtitle')} />
      <Tabs<'list' | 'prefs'>
        label={t('nav.notifications')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'list', label: t('notif.list') },
          { id: 'prefs', label: t('notif.prefs') },
        ]}
      />
      <TabPanel id={tab}>{tab === 'list' ? <List /> : <Prefs />}</TabPanel>
    </>
  );
}
