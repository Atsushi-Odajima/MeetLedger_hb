import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Alert, Button, TextField } from '../components/ui';
import { useI18n } from '../i18n';
import { useSession } from '../state/session';
import { api, errorMessage } from '../lib/api';
import { AuthLayout } from './Setup';

/** Self-service sign-up (only when the installation sets ALLOW_SIGNUP): creates a new organization + workspace. */
export function SignupPage() {
  const { t } = useI18n();
  const { me, setup, refresh } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', orgName: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (setup?.needsSetup) return <Navigate to="/setup" replace />;
  if (me && !busy) return <Navigate to="/" replace />;
  if (setup && !setup.allowSignup) return <Navigate to="/login" replace />;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/signup', form);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <AuthLayout title={t('signup.title')} subtitle={t('signup.subtitle')}>
      <form onSubmit={submit} className="stack">
        {error && (
          <Alert tone="danger" title={t('signup.failed')}>
            {error}
          </Alert>
        )}
        <TextField label={t('auth.name')} value={form.name} onChange={set('name')} required maxLength={100} autoComplete="name" autoFocus />
        <TextField label={t('auth.email')} type="email" value={form.email} onChange={set('email')} required autoComplete="username" />
        <TextField label={t('auth.password')} type="password" value={form.password} onChange={set('password')} required minLength={10} autoComplete="new-password" hint={t('auth.passwordMin')} />
        <TextField label={t('setup.orgName')} value={form.orgName} onChange={set('orgName')} required maxLength={100} hint={t('setup.orgHint')} />
        <Alert tone="info" title={t('setup.privacyTitle')}>
          {t('setup.privacyBody')}
        </Alert>
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!form.name || !form.email || form.password.length < 10 || !form.orgName}>
          {t('signup.submit')}
        </Button>
        <p className="field-hint">
          {t('signup.haveAccount')} <Link to="/login">{t('auth.login')}</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
