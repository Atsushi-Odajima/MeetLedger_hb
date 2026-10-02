import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, TextField } from '../components/ui';
import { useI18n } from '../i18n';
import { useSession } from '../state/session';
import { api, errorMessage } from '../lib/api';
import { AuthLayout } from './Setup';

export function AcceptInvitePage() {
  const { t } = useI18n();
  const { me, refresh } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/accept-invite', me ? { token } : { token, name, password });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (!token)
    return (
      <AuthLayout title={t('invite.title')}>
        <Alert tone="warn">{t('invite.noToken')}</Alert>
      </AuthLayout>
    );

  return (
    <AuthLayout title={t('invite.title')} subtitle={t('invite.subtitle')}>
      {error && <Alert tone="danger">{error}</Alert>}
      {me ? (
        <div className="stack">
          <p>{t('invite.asUser', { name: me.user.name, email: me.user.email })}</p>
          <Button variant="primary" size="lg" loading={busy} onClick={() => accept()}>
            {t('invite.accept')}
          </Button>
        </div>
      ) : (
        <form className="stack" onSubmit={accept}>
          <TextField label={t('auth.name')} value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
          <TextField
            label={t('auth.password')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            hint={t('auth.passwordMin')}
          />
          <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!name || password.length < 10}>
            {t('invite.createAndAccept')}
          </Button>
          <p className="field-hint">
            {t('invite.haveAccount')} <Link to={`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`}>{t('auth.login')}</Link>
          </p>
        </form>
      )}
    </AuthLayout>
  );
}
