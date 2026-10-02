import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useSession } from './state/session';
import { WorkspaceProvider, LAST_WS_KEY, useWs } from './state/workspace';
import { AppShell } from './components/Layout';
import { ErrorView, Loading, EmptyState, LinkButton } from './components/ui';
import { useI18n } from './i18n';
import { SetupPage } from './pages/Setup';
import { LoginPage } from './pages/Login';
import { SignupPage } from './pages/Signup';
import { AcceptInvitePage } from './pages/AcceptInvite';
import { NoWorkspacePage } from './pages/NoWorkspace';
import { DashboardPage } from './pages/Dashboard';
import { MeetingsPage } from './pages/Meetings';
import { MeetingNewPage } from './pages/MeetingNew';
import { MeetingDetailPage } from './pages/meeting/MeetingDetail';
import { ReviewInboxPage } from './pages/ReviewInbox';
import { LedgerPage } from './pages/Ledger';
import { SearchPage } from './pages/Search';
import { AskPage } from './pages/Ask';
import { MemoryPage } from './pages/Memory';
import { PeoplePage, PersonPage } from './pages/People';
import { ProjectsPage, ProjectPage } from './pages/Projects';
import { SeriesListPage, SeriesPage } from './pages/Series';
import { NotificationsPage } from './pages/Notifications';
import { SettingsPage } from './pages/settings/Settings';

function lastWorkspace(ids: string[]): string | null {
  try {
    const v = localStorage.getItem(LAST_WS_KEY);
    if (v && ids.includes(v)) return v;
  } catch {
    /* ignore */
  }
  return null;
}

function Boot({ children }: { children: ReactNode }) {
  const { ready, unreachable } = useSession();
  const { t } = useI18n();
  if (!ready) return <Loading label={t('common.starting')} />;
  if (unreachable)
    return (
      <div className="center-page">
        <ErrorView error={new Error(t('error.unreachable'))} onRetry={() => window.location.reload()} />
      </div>
    );
  return <>{children}</>;
}

function RootRedirect() {
  const { setup, me } = useSession();
  if (setup?.needsSetup) return <Navigate to="/setup" replace />;
  if (!me) return <Navigate to="/login" replace />;
  const real = me.workspaces.filter((w) => !w.isSample);
  const target = lastWorkspace(me.workspaces.map((w) => w.id)) ?? real[0]?.id ?? me.workspaces[0]?.id;
  if (!target) return <Navigate to="/no-workspace" replace />;
  return <Navigate to={`/w/${target}`} replace />;
}

/** /go/:target shortcuts (PWA manifest shortcuts, user-level notification links) resolve into the last used workspace. */
function GoRedirect({ fixed }: { fixed?: string }) {
  const params = useParams();
  const target = fixed ?? params.target;
  const { me } = useSession();
  if (!me) return <Navigate to="/login" replace />;
  const ws = lastWorkspace(me.workspaces.map((w) => w.id)) ?? me.workspaces.find((w) => !w.isSample)?.id ?? me.workspaces[0]?.id;
  if (!ws) return <Navigate to="/no-workspace" replace />;
  const map: Record<string, string> = { review: '/review', 'new-meeting': '/meetings/new', search: '/search', notifications: '/notifications' };
  return <Navigate to={`/w/${ws}${map[target ?? ''] ?? ''}`} replace />;
}

/** Server redirects (e.g. OAuth callback → /settings/connectors?connected=…) land outside a workspace: forward them. */
function SettingsRedirect() {
  const { me } = useSession();
  const loc = useLocation();
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  const ws = lastWorkspace(me.workspaces.map((w) => w.id)) ?? me.workspaces.find((w) => !w.isSample)?.id ?? me.workspaces[0]?.id;
  if (!ws) return <Navigate to="/no-workspace" replace />;
  return <Navigate to={`/w/${ws}${loc.pathname}${loc.search}`} replace />;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, setup } = useSession();
  const loc = useLocation();
  if (setup?.needsSetup) return <Navigate to="/setup" replace />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

function WorkspaceGate({ children }: { children: ReactNode }) {
  const { ws, error, loading, reload } = useWs();
  const { t } = useI18n();
  if (!ws && loading) return <Loading />;
  if (!ws)
    return (
      <div className="center-page">
        <ErrorView error={error} onRetry={reload} />
        <LinkButton to="/" variant="primary">
          {t('ws.backHome')}
        </LinkButton>
      </div>
    );
  return <>{children}</>;
}

function WorkspaceRoutes() {
  const { wsId = '' } = useParams();
  return (
    <WorkspaceProvider wsId={wsId} key={wsId}>
      <AppShell>
        <WorkspaceGate>
          <Routes>
            <Route index element={<DashboardPage />} />
            <Route path="meetings" element={<MeetingsPage />} />
            <Route path="meetings/new" element={<MeetingNewPage />} />
            <Route path="meetings/:meetingId/*" element={<MeetingDetailPage />} />
            <Route path="review" element={<ReviewInboxPage />} />
            <Route path="ledger" element={<LedgerPage />} />
            {/* aliases used by server-generated links (notifications, emails) */}
            <Route path="dashboard" element={<Navigate to=".." relative="path" replace />} />
            <Route path="actions" element={<LedgerAlias tab="actions" />} />
            <Route path="commitments" element={<LedgerAlias tab="commitments" />} />
            <Route path="decisions" element={<LedgerAlias tab="decisions" />} />
            <Route path="questions" element={<LedgerAlias tab="questions" />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="ask" element={<AskPage />} />
            <Route path="memory" element={<MemoryPage />} />
            <Route path="people" element={<PeoplePage />} />
            <Route path="people/:personId" element={<PersonPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/:projectId" element={<ProjectPage />} />
            <Route path="series" element={<SeriesListPage />} />
            <Route path="series/:seriesId" element={<SeriesPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="settings/*" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </WorkspaceGate>
      </AppShell>
    </WorkspaceProvider>
  );
}

function LedgerAlias({ tab }: { tab: string }) {
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  q.set('tab', tab);
  return <Navigate to={`../ledger?${q.toString()}`} relative="path" replace />;
}

function NotFound() {
  const { t } = useI18n();
  return <EmptyState title={t('error.pageNotFound')} action={<LinkButton to="/">{t('ws.backHome')}</LinkButton>} />;
}

export function App() {
  return (
    <Boot>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/invite" element={<AcceptInvitePage />} />
        <Route path="/no-workspace" element={<RequireAuth><NoWorkspacePage /></RequireAuth>} />
        <Route path="/go/:target" element={<GoRedirect />} />
        <Route path="/notifications" element={<GoRedirect fixed="notifications" />} />
        <Route path="/settings/*" element={<SettingsRedirect />} />
        <Route
          path="/w/:wsId/*"
          element={
            <RequireAuth>
              <WorkspaceRoutes />
            </RequireAuth>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Boot>
  );
}
