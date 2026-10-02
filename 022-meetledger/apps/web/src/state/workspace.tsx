import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { roleAtLeast, type Role } from '@meetledger/shared';
import { useApi } from '../lib/hooks';
import type { WorkspaceInfo } from '../lib/types';

interface WorkspaceValue {
  wsId: string;
  ws: WorkspaceInfo | undefined;
  loading: boolean;
  error: unknown;
  cachedAt: string | null;
  reload(): void;
  can(min: Role): boolean;
  /** App route inside this workspace. */
  p(path?: string): string;
  /** API path inside this workspace. */
  a(path?: string): string;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);
export const LAST_WS_KEY = 'ml.lastWorkspace';

export function WorkspaceProvider({ wsId, children }: { wsId: string; children: ReactNode }) {
  const state = useApi<WorkspaceInfo>(`/api/w/${wsId}`);
  useEffect(() => {
    if (state.data) {
      try {
        localStorage.setItem(LAST_WS_KEY, wsId);
      } catch {
        /* ignore */
      }
    }
  }, [state.data, wsId]);
  const value = useMemo<WorkspaceValue>(
    () => ({
      wsId,
      ws: state.data,
      loading: state.loading,
      error: state.error,
      cachedAt: state.cachedAt,
      reload: state.reload,
      can: (min) => roleAtLeast(state.data?.role, min),
      p: (path = '') => `/w/${wsId}${path}`,
      a: (path = '') => `/api/w/${wsId}${path}`,
    }),
    [wsId, state.data, state.loading, state.error, state.cachedAt, state.reload],
  );
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWs(): WorkspaceValue {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useWs outside WorkspaceProvider');
  return v;
}
