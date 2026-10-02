import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { roleAtLeast } from '@meetledger/shared';
import { Icon, type IconName } from './Icon';
import { Logo } from './Logo';
import { Badge, Button, Dialog, IconButton, Popover } from './ui';
import { useI18n, type MsgKey } from '../i18n';
import { useSession } from '../state/session';
import { useWs } from '../state/workspace';
import { useToast } from '../state/toast';
import { api, listOf } from '../lib/api';
import { useApi, useOnline, useOutbox } from '../lib/hooks';
import { discardOp, replayOutbox, resolveActionConflict, type OutboxOp } from '../lib/offline/outbox';
import { applyUpdate, canPromptInstall, onInstallAvailability, onUpdateAvailable, promptInstall } from '../lib/sw';
import type { NotificationDto } from '../lib/types';

interface NavItem {
  to: string;
  key: MsgKey;
  icon: IconName;
  end?: boolean;
}

function useNavGroups(): NavItem[][] {
  return [
    [
      { to: '', key: 'nav.dashboard', icon: 'home', end: true },
      { to: '/meetings', key: 'nav.meetings', icon: 'calendar' },
      { to: '/review', key: 'nav.review', icon: 'inbox' },
      { to: '/ledger', key: 'nav.ledger', icon: 'book' },
    ],
    [
      { to: '/search', key: 'nav.search', icon: 'search' },
      { to: '/ask', key: 'nav.ask', icon: 'sparkle' },
      { to: '/memory', key: 'nav.memory', icon: 'memory' },
    ],
    [
      { to: '/people', key: 'nav.people', icon: 'users' },
      { to: '/projects', key: 'nav.projects', icon: 'folder' },
      { to: '/series', key: 'nav.series', icon: 'repeat' },
    ],
    [
      { to: '/notifications', key: 'nav.notifications', icon: 'bell' },
      { to: '/settings', key: 'nav.settings', icon: 'sliders' },
    ],
  ];
}

export function WorkspaceSwitcher({ compact }: { compact?: boolean }) {
  const { me, setup, refresh } = useSession();
  const { wsId, ws } = useWs();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [newWs, setNewWs] = useState<{ orgId: string; name: string } | null>(null);
  if (!me) return null;
  const hasSample = me.workspaces.some((w) => w.isSample);
  const adminOrgs = me.orgs.filter((o) => !o.isSample && roleAtLeast(o.role, 'admin'));
  const orgName = (id: string) => me.orgs.find((o) => o.id === id)?.name ?? '';
  const current = me.workspaces.find((w) => w.id === wsId);

  const createSample = async (close: () => void) => {
    setCreating(true);
    try {
      const r = await api.post<{ workspaceId?: string; id?: string }>('/api/sample-workspace');
      const m = await refresh();
      const target = r?.workspaceId ?? r?.id ?? m?.workspaces.find((w) => w.isSample)?.id;
      toast.success(t('sample.created'));
      close();
      if (target) navigate(`/w/${target}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setCreating(false);
    }
  };

  const createWorkspace = async () => {
    if (!newWs?.name.trim()) return;
    try {
      const r = await api.post<{ id: string }>(`/api/orgs/${newWs.orgId}/workspaces`, { name: newWs.name.trim() });
      await refresh();
      setNewWs(null);
      navigate(`/w/${r.id}`);
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <>
      <Popover
        label={t('ws.switch')}
        align="left"
        buttonClassName={`ws-switcher${compact ? ' ws-switcher-compact' : ''}`}
        buttonLabel={`${t('ws.switch')}: ${ws?.name ?? current?.name ?? ''}`}
        buttonContent={
          <>
            <span className="ws-name">{ws?.name ?? current?.name ?? '…'}</span>
            {(ws?.isSample ?? current?.isSample) && <span className="ws-sample-dot" title={t('sample.label')} />}
            <Icon name="chevronDown" size={16} />
          </>
        }
      >
        {(close) => (
          <div className="menu">
            <p className="menu-heading">{t('ws.title')}</p>
            {me.workspaces.map((w) => (
              <Link
                key={w.id}
               
                to={`/w/${w.id}`}
                className={`menu-item${w.id === wsId ? ' menu-item-active' : ''}`}
                aria-current={w.id === wsId ? 'true' : undefined}
                onClick={close}
              >
                <span className="menu-item-main">
                  <span>{w.name}</span>
                  <span className="menu-item-sub">{orgName(w.orgId)}</span>
                </span>
                {w.isSample && <Badge tone="sample">{t('sample.label')}</Badge>}
                {w.id === wsId && <Icon name="check" size={16} />}
              </Link>
            ))}
            <div className="menu-sep" />
            {setup?.sampleAvailable !== false && !hasSample && (
              <button type="button" className="menu-item" onClick={() => createSample(close)} disabled={creating}>
                <Icon name="plus" size={16} /> {t('sample.create')}
              </button>
            )}
            {adminOrgs.map((o) => (
              <button
                key={o.id}
                type="button"
               
                className="menu-item"
                onClick={() => {
                  close();
                  setNewWs({ orgId: o.id, name: '' });
                }}
              >
                <Icon name="plus" size={16} /> {t('ws.create', { org: o.name })}
              </button>
            ))}
          </div>
        )}
      </Popover>
      <Dialog
        open={!!newWs}
        onClose={() => setNewWs(null)}
        title={t('ws.createTitle')}
        footer={
          <>
            <Button onClick={() => setNewWs(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={createWorkspace} disabled={!newWs?.name.trim()}>
              {t('common.create')}
            </Button>
          </>
        }
      >
        <div className="field">
          <label className="field-label" htmlFor="new-ws-name">
            {t('ws.name')}
          </label>
          <input id="new-ws-name" className="input" value={newWs?.name ?? ''} onChange={(e) => setNewWs((n) => (n ? { ...n, name: e.target.value } : n))} maxLength={100} />
        </div>
      </Dialog>
    </>
  );
}

function SyncBadge() {
  const { t } = useI18n();
  const { ops, pending, conflicts, failed } = useOutbox();
  const toast = useToast();
  const { p } = useWs();
  const [busy, setBusy] = useState(false);
  const total = pending + conflicts + failed;
  if (!total) return null;
  const syncNow = async () => {
    setBusy(true);
    try {
      const r = await replayOutbox(api);
      if (r.offline) toast.info(t('sync.stillOffline'));
      else if (r.conflicts) toast.info(t('sync.conflicts', { n: r.conflicts }));
      else toast.success(t('sync.done'));
    } finally {
      setBusy(false);
    }
  };
  const label = (o: OutboxOp) => (o.kind === 'notes.put' ? t('sync.op.notes', { title: o.meetingTitle ?? '' }) : t('sync.op.action', { title: o.label ?? '' }));
  return (
    <Popover
      label={t('sync.title')}
      buttonLabel={conflicts ? t('sync.badgeConflict', { n: conflicts }) : t('sync.badge', { n: total })}
      buttonClassName={`sync-badge${conflicts ? ' sync-badge-conflict' : ''}`}
      buttonContent={
        <>
          <Icon name="sync" size={16} />
          <span className="sync-badge-text">{conflicts ? t('sync.badgeConflict', { n: conflicts }) : t('sync.badge', { n: total })}</span>
          <span className="sync-badge-count" aria-hidden="true">
            {conflicts || total}
          </span>
        </>
      }
    >
      {(close) => (
        <div className="sync-panel">
          <p className="menu-heading">{t('sync.title')}</p>
          <p className="field-hint">{t('sync.explain')}</p>
          <ul className="sync-list">
            {ops.map((o) => (
              <li key={o.id} className={`sync-item sync-${o.status}`}>
                <div>
                  <span className="sync-item-title">{label(o)}</span>
                  <Badge tone={o.status === 'conflict' ? 'warn' : o.status === 'failed' ? 'danger' : 'neutral'}>{t(`sync.status.${o.status}`)}</Badge>
                  {o.error && <p className="field-hint">{o.error}</p>}
                </div>
                <div className="sync-item-actions">
                  {o.kind === 'notes.put' && o.status === 'conflict' && (
                    <Link className="btn btn-sm btn-secondary" to={p(`/meetings/${o.meetingId}/capture`)} onClick={close}>
                      {t('sync.resolve')}
                    </Link>
                  )}
                  {o.kind === 'action.status' && o.status === 'conflict' && (
                    <>
                      <span className="field-hint">{t('sync.actionConflict', { server: t(`actionStatus.${o.conflict?.serverStatus ?? 'confirmed'}` as MsgKey) })}</span>
                      <Button size="sm" onClick={() => resolveActionConflict(o.id, 'server')}>
                        {t('sync.useServer')}
                      </Button>
                      <Button size="sm" onClick={() => resolveActionConflict(o.id, 'mine').then(syncNow)}>
                        {t('sync.useMine')}
                      </Button>
                    </>
                  )}
                  {o.status === 'failed' && (
                    <Button size="sm" variant="ghost" onClick={() => discardOp(o.id)}>
                      {t('sync.discard')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="primary" icon="sync" loading={busy} onClick={syncNow} disabled={!pending}>
            {t('sync.now')}
          </Button>
        </div>
      )}
    </Popover>
  );
}

function NotificationsBell() {
  const { t } = useI18n();
  const { p } = useWs();
  const state = useApi<unknown>('/api/notifications?unread=1', { pollMs: 60000, keepPrevious: true });
  const data = state.data as { unreadCount?: number } | undefined;
  const n = typeof data?.unreadCount === 'number' ? data.unreadCount : listOf<NotificationDto>(state.data, 'notifications').length;
  return (
    <Link to={p('/notifications')} className="icon-btn bell" aria-label={n ? t('notif.bellUnread', { n }) : t('nav.notifications')} title={t('nav.notifications')}>
      <Icon name="bell" />
      {n > 0 && <span className="bell-count">{n > 99 ? '99+' : n}</span>}
    </Link>
  );
}

function LangToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <button type="button" className="icon-btn lang-toggle" onClick={() => setLang(lang === 'ja' ? 'en' : 'ja')} aria-label={t('lang.switch')} title={t('lang.switch')}>
      <Icon name="globe" />
      <span className="lang-code">{lang === 'ja' ? 'EN' : '日本語'}</span>
    </button>
  );
}

function UserMenu() {
  const { me, logout } = useSession();
  const { t } = useI18n();
  const { p } = useWs();
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <Popover label={t('user.menu')} buttonLabel={`${t('user.menu')}: ${me.user.name}`} buttonClassName="avatar-btn" buttonContent={<span className="avatar" aria-hidden="true">{me.user.name.slice(0, 1).toUpperCase()}</span>}>
      {(close) => (
        <div className="menu">
          <p className="menu-heading">
            {me.user.name}
            <span className="menu-item-sub">{me.user.email}</span>
          </p>
          <Link className="menu-item" to={p('/settings/account')} onClick={close}>
            <Icon name="user" size={16} /> {t('settings.account')}
          </Link>
          <button
            type="button"
           
            className="menu-item"
            onClick={async () => {
              close();
              await logout();
              navigate('/login');
            }}
          >
            <Icon name="logout" size={16} /> {t('auth.logout')}
          </button>
        </div>
      )}
    </Popover>
  );
}

export function OfflineBanner() {
  const online = useOnline();
  const { t } = useI18n();
  if (online) return null;
  return (
    <div className="banner banner-offline" role="status" aria-live="polite">
      <Icon name="offline" size={16} />
      <span>{t('offline.banner')}</span>
    </div>
  );
}

function UpdateBanner() {
  const { t } = useI18n();
  const [available, setAvailable] = useState(false);
  useEffect(() => onUpdateAvailable(() => setAvailable(true)), []);
  if (!available) return null;
  return (
    <div className="banner banner-info" role="status">
      <span>{t('pwa.update')}</span>
      <Button size="sm" variant="primary" onClick={applyUpdate}>
        {t('pwa.reload')}
      </Button>
    </div>
  );
}

const INSTALL_DISMISS_KEY = 'ml.installHintDismissed';

export function InstallHint() {
  const { t } = useI18n();
  const [canPrompt, setCanPrompt] = useState(canPromptInstall());
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(INSTALL_DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => onInstallAvailability(() => setCanPrompt(canPromptInstall())), []);
  const ua = navigator.userAgent;
  const isIos = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (dismissed || standalone || (!canPrompt && !isIos)) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(INSTALL_DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="banner banner-install" role="region" aria-label={t('pwa.installTitle')}>
      <Icon name="install" size={16} />
      <span>{canPrompt ? t('pwa.installHint') : t('pwa.installHintIos')}</span>
      {canPrompt && (
        <Button size="sm" variant="primary" onClick={() => promptInstall().then(() => setCanPrompt(canPromptInstall()))}>
          {t('pwa.install')}
        </Button>
      )}
      <IconButton icon="x" label={t('common.dismiss')} onClick={dismiss} />
    </div>
  );
}

/** Replays the offline queue when connectivity returns / the app becomes visible. */
function OutboxSync() {
  const online = useOnline();
  const { pending } = useOutbox();
  const toast = useToast();
  const { t } = useI18n();
  useEffect(() => {
    if (!online || !pending) return;
    let cancelled = false;
    replayOutbox(api)
      .then((r) => {
        if (cancelled) return;
        if (r.sent && !r.conflicts) toast.announce(t('sync.done'));
        if (r.conflicts) toast.info(t('sync.conflicts', { n: r.conflicts }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, pending]);
  useEffect(() => {
    const onVis = () => document.visibilityState === 'visible' && replayOutbox(api).catch(() => undefined);
    document.addEventListener('visibilitychange', onVis);
    const id = setInterval(() => replayOutbox(api).catch(() => undefined), 30000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(id);
    };
  }, []);
  return null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { p, ws } = useWs();
  const groups = useNavGroups();
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMoreOpen(false), [location.pathname]);
  const bottom: NavItem[] = [
    { to: '', key: 'nav.home', icon: 'home', end: true },
    { to: '/meetings', key: 'nav.meetings', icon: 'calendar' },
    { to: '/review', key: 'nav.review.short', icon: 'inbox' },
    { to: '/search', key: 'nav.search', icon: 'search' },
  ];
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        {t('a11y.skip')}
      </a>
      <OutboxSync />
      <aside className="sidebar" aria-label={t('nav.label')}>
        <Link to={p()} className="sidebar-logo">
          <Logo />
        </Link>
        <WorkspaceSwitcher />
        <nav aria-label={t('nav.label')}>
          {groups.map((g, i) => (
            <ul className="nav-group" key={i}>
              {g.map((it) => (
                <li key={it.to}>
                  <NavLink to={p(it.to)} end={it.end} className={({ isActive }) => `nav-link${isActive ? ' nav-link-active' : ''}`}>
                    <Icon name={it.icon} />
                    <span>{t(it.key)}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          ))}
        </nav>
        <p className="sidebar-tagline">{t('brand.tagline')}</p>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <Link to={p()} className="topbar-logo">
            <Logo variant="mark" />
          </Link>
          <div className="topbar-ws">
            <WorkspaceSwitcher compact />
          </div>
          <div className="topbar-spacer" />
          <SyncBadge />
          <NotificationsBell />
          <LangToggle />
          <UserMenu />
        </header>
        <OfflineBanner />
        <UpdateBanner />
        {ws?.isSample && (
          <div className="banner banner-sample" role="note">
            <Icon name="info" size={16} />
            <span>{t('sample.banner')}</span>
          </div>
        )}
        <InstallHint />
        <main id="main" className="main" tabIndex={-1}>
          {children}
        </main>
      </div>
      <nav className="bottom-nav" aria-label={t('nav.label')}>
        {bottom.map((it) => (
          <NavLink key={it.to} to={p(it.to)} end={it.end} className={({ isActive }) => `bottom-link${isActive ? ' bottom-link-active' : ''}`}>
            <Icon name={it.icon} size={22} />
            <span>{t(it.key)}</span>
          </NavLink>
        ))}
        <button type="button" className="bottom-link" onClick={() => setMoreOpen(true)} aria-haspopup="dialog">
          <Icon name="menu" size={22} />
          <span>{t('nav.more')}</span>
        </button>
      </nav>
      <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title={t('nav.more')} size="sm">
        <ul className="more-list">
          {groups.flat().map((it) => (
            <li key={it.to}>
              <NavLink to={p(it.to)} end={it.end} className={({ isActive }) => `nav-link${isActive ? ' nav-link-active' : ''}`}>
                <Icon name={it.icon} />
                <span>{t(it.key)}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
