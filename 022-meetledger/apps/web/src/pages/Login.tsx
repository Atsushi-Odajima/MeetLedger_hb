import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, TextField } from '../components/ui';
import { useI18n } from '../i18n';
import { useSession } from '../state/session';
import { api, errorMessage } from '../lib/api';
import { AuthLayout } from './Setup';

function safeNext(next: string | null): string {
  // Only same-app relative paths (no protocol-relative or absolute URLs).
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/';
}

export function LoginPage() {
  const { t } = useI18n();
  const { me, setup, refresh } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = safeNext(params.get('next'));

  if (setup?.needsSetup) return <Navigate to="/setup" replace />;
  if (me && !busy) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { email, password });
      await refresh();
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t('auth.loginTitle')}>
      <form onSubmit={submit} className="stack">
        {error && (
          <Alert tone="danger" title={t('auth.loginFailed')}>
            {error}
          </Alert>
        )}
        <TextField label={t('auth.email')} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" autoFocus />
        <TextField label={t('auth.password')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!email || !password}>
          {t('auth.login')}
        </Button>
        <p className="field-hint">{t('auth.inviteHint')}</p>
      </form>
    </AuthLayout>
  );
}
