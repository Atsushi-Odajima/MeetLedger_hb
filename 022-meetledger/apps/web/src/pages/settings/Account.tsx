import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, SelectField, TextField } from '../../components/ui';
import { useI18n, type Lang } from '../../i18n';
import { useSession } from '../../state/session';
import { useToast } from '../../state/toast';
import { api } from '../../lib/api';

function zones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (fn) return fn('timeZone');
  } catch {
    /* ignore */
  }
  return ['Asia/Tokyo', 'UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London'];
}

export function AccountSettings() {
  const { t, setLang } = useI18n();
  const toast = useToast();
  const { me, refresh, logout } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState(me?.user.name ?? '');
  const [tz, setTz] = useState(me?.user.timezone ?? 'Asia/Tokyo');
  const [locale, setLocale] = useState<Lang>((me?.user.locale as Lang) === 'en' ? 'en' : 'ja');
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const tzs = useMemo(zones, []);
  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('profile');
    try {
      await api.patch('/api/me', { name: name.trim(), timezone: tz, locale });
      setLang(locale);
      await refresh();
      toast.success(t('common.saved'));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };
  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('pw');
    try {
      await api.post('/api/auth/change-password', { currentPassword: cur, newPassword: next });
      setCur('');
      setNext('');
      toast.success(t('account.passwordChanged'));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="stack">
      <Card title={t('account.profile')}>
        <form className="stack" onSubmit={saveProfile}>
          <TextField label={t('auth.name')} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          <TextField label={t('auth.email')} value={me?.user.email ?? ''} readOnly />
          <div className="grid-2">
            <SelectField label={t('notif.timezone')} value={tz} onChange={(e) => setTz(e.target.value)} options={tzs.map((z) => ({ value: z, label: z }))} />
            <SelectField
              label={t('account.language')}
              value={locale}
              onChange={(e) => setLocale(e.target.value as Lang)}
              options={[
                { value: 'ja', label: '日本語' },
                { value: 'en', label: 'English' },
              ]}
            />
          </div>
          <Button type="submit" variant="primary" loading={busy === 'profile'} disabled={!name.trim()}>
            {t('common.save')}
          </Button>
        </form>
      </Card>
      <Card title={t('account.password')}>
        <form className="stack" onSubmit={changePassword}>
          <TextField label={t('account.currentPassword')} type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
          <TextField label={t('account.newPassword')} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required hint={t('auth.passwordMin')} />
          <Button type="submit" loading={busy === 'pw'} disabled={!cur || next.length < 10}>
            {t('account.changePassword')}
          </Button>
          <p className="field-hint">{t('account.passwordHint')}</p>
        </form>
      </Card>
      <Card title={t('account.session')}>
        <Button
          icon="logout"
          onClick={async () => {
            await logout();
            navigate('/login');
          }}
        >
          {t('auth.logout')}
        </Button>
        <p className="field-hint">{t('account.logoutHint')}</p>
      </Card>
    </div>
  );
}
