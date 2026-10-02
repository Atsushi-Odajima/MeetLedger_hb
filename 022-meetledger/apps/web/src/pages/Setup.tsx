import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Alert, Button, Checkbox, TextField } from '../components/ui';
import { Logo } from '../components/Logo';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n';
import { useSession } from '../state/session';
import { api, ApiError, errorMessage } from '../lib/api';

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-top">
          <Logo />
          <button type="button" className="icon-btn lang-toggle" onClick={() => setLang(lang === 'ja' ? 'en' : 'ja')} aria-label={t('lang.switch')}>
            <Icon name="globe" />
            <span className="lang-code">{lang === 'ja' ? 'EN' : '日本語'}</span>
          </button>
        </div>
        <p className="auth-tagline">{t('brand.tagline')}</p>
        <main id="main">
          <h1 className="auth-title">{title}</h1>
          {subtitle && <p className="auth-subtitle">{subtitle}</p>}
          {children}
        </main>
      </div>
    </div>
  );
}

export function SetupPage() {
  const { t } = useI18n();
  const { setup, me, refresh } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', name: '', password: '', orgName: '', workspaceName: 'Main' });
  const [withSample, setWithSample] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (setup && !setup.needsSetup && !busy) return <Navigate to={me ? '/' : '/login'} replace />;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const fe: Record<string, string> = {};
    if (form.password.length < 10) fe.password = t('auth.passwordMin');
    setFieldErrors(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    try {
      await api.post('/api/setup', form);
      const m = await refresh();
      if (withSample && setup?.sampleAvailable) {
        try {
          await api.post('/api/sample-workspace');
          await refresh();
        } catch {
          /* optional: the sample can be created later from the workspace switcher */
        }
      }
      const main = m?.workspaces.find((w) => !w.isSample) ?? m?.workspaces[0];
      navigate(main ? `/w/${main.id}` : '/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        const d: Record<string, string> = {};
        for (const i of err.details as { path: string; message: string }[]) d[i.path] = i.message;
        setFieldErrors(d);
      }
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t('setup.title')} subtitle={t('setup.subtitle')}>
      <form onSubmit={submit} className="stack" noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <TextField label={t('auth.name')} value={form.name} onChange={set('name')} required autoComplete="name" maxLength={100} error={fieldErrors.name} />
        <TextField label={t('auth.email')} type="email" value={form.email} onChange={set('email')} required autoComplete="email" error={fieldErrors.email} />
        <TextField
          label={t('auth.password')}
          type="password"
          value={form.password}
          onChange={set('password')}
          required
          autoComplete="new-password"
          hint={t('auth.passwordMin')}
          error={fieldErrors.password}
        />
        <TextField label={t('setup.orgName')} value={form.orgName} onChange={set('orgName')} required maxLength={100} hint={t('setup.orgHint')} error={fieldErrors.orgName} />
        <TextField label={t('setup.workspaceName')} value={form.workspaceName} onChange={set('workspaceName')} required maxLength={100} error={fieldErrors.workspaceName} />
        {setup?.sampleAvailable && <Checkbox label={t('setup.withSample')} hint={t('setup.withSampleHint')} checked={withSample} onChange={(e) => setWithSample(e.target.checked)} />}
        <Alert tone="info" title={t('setup.privacyTitle')}>
          {t('setup.privacyBody')}
        </Alert>
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!form.email || !form.name || !form.orgName}>
          {t('setup.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
