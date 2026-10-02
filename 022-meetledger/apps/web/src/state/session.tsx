import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MeDto } from '@meetledger/shared';
import { api, ApiError, NetworkError } from '../lib/api';
import { useI18n, LANG_STORAGE_KEY } from '../i18n';
import { replayOutbox, setOutboxUser } from '../lib/offline/outbox';
import { clearServiceWorkerApiCache } from '../lib/sw';

export interface SetupStatus {
  needsSetup: boolean;
  allowSignup: boolean;
  sampleAvailable: boolean;
}

interface SessionValue {
  ready: boolean;
  setup: SetupStatus | null;
  me: MeDto | null;
  /** The server could not be reached and nothing was cached. */
  unreachable: boolean;
  refresh(): Promise<MeDto | null>;
  logout(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
const LAST_USER_KEY = 'ml.lastUser';

export function SessionProvider({ children }: { children: ReactNode }) {
  const { setTimeZone, setLang } = useI18n();
  const [ready, setReady] = useState(false);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [me, setMe] = useState<MeDto | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  const applyMe = useCallback(
    (m: MeDto | null) => {
      setMe(m);
      setOutboxUser(m?.user.id ?? null);
      if (!m) return;
      if (m.csrfToken) api.setCsrf(m.csrfToken);
      if (m.user.timezone) setTimeZone(m.user.timezone);
      try {
        if (!localStorage.getItem(LANG_STORAGE_KEY) && (m.user.locale === 'en' || m.user.locale === 'ja')) setLang(m.user.locale);
        const last = localStorage.getItem(LAST_USER_KEY);
        if (last && last !== m.user.id) clearServiceWorkerApiCache();
        localStorage.setItem(LAST_USER_KEY, m.user.id);
      } catch {
        /* ignore */
      }
    },
    [setLang, setTimeZone],
  );

  const refresh = useCallback(async () => {
    let unreach = false;
    const [s, m] = await Promise.all([
      api.get<SetupStatus>('/api/setup/status').catch((e) => {
        if (e instanceof NetworkError) unreach = true;
        return null;
      }),
      api.get<MeDto>('/api/me').catch((e) => {
        if (e instanceof NetworkError) unreach = true;
        if (e instanceof ApiError && e.status === 401) return null;
        return null;
      }),
    ]);
    setSetup(s);
    applyMe(m);
    setUnreachable(unreach && !m && !s);
    setReady(true);
    if (m) replayOutbox(api).catch(() => undefined);
    return m;
  }, [applyMe]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* even if the server is unreachable we drop local state */
    }
    api.setCsrf(null);
    clearServiceWorkerApiCache();
    applyMe(null);
  }, [applyMe]);

  const value = useMemo(() => ({ ready, setup, me, unreachable, refresh, logout }), [ready, setup, me, unreachable, refresh, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
