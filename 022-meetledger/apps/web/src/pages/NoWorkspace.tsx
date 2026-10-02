import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button } from '../components/ui';
import { useI18n } from '../i18n';
import { useSession } from '../state/session';
import { api, errorMessage } from '../lib/api';
import { AuthLayout } from './Setup';

export function NoWorkspacePage() {
  const { t } = useI18n();
  const { setup, refresh, logout } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createSample = async () => {
    setBusy(true);
    try {
      await api.post('/api/sample-workspace');
      const m = await refresh();
      const ws = m?.workspaces[0];
      if (ws) navigate(`/w/${ws.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout title={t('ws.none')} subtitle={t('ws.noneBody')}>
      <div className="stack">
        {error && <Alert tone="danger">{error}</Alert>}
        {setup?.sampleAvailable !== false && (
          <Button variant="primary" onClick={createSample} loading={busy}>
            {t('sample.create')}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={async () => {
            await logout();
            navigate('/login');
          }}
        >
          {t('auth.logout')}
        </Button>
      </div>
    </AuthLayout>
  );
}
