import { useState, type FormEvent } from 'react';
import type { AskResponseDto } from '@meetledger/shared';
import { Alert, Button, ErrorView, Loading, TextField } from '../../components/ui';
import { AskAnswer } from '../../components/AskAnswer';
import { useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { useMeeting } from './context';

export function MeetingAskTab() {
  const { t } = useI18n();
  const { meeting, ma } = useMeeting();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<AskResponseDto | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!meeting.aiEnabled)
    return (
      <Alert tone="info" title={t('privacy.aiOff')}>
        {t('ask.aiOffMeeting')}
      </Alert>
    );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.post<AskResponseDto>(ma('/ask'), { question: q.trim() }));
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <p className="field-hint">{t('ask.meetingIntro')}</p>
      <form className="inline-form" onSubmit={submit} role="search">
        <TextField label={t('ask.question')} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('ask.meetingPlaceholder')} maxLength={1000} />
        <Button type="submit" variant="primary" icon="sparkle" disabled={!q.trim()} loading={busy}>
          {t('ask.submit')}
        </Button>
      </form>
      {busy && <Loading label={t('ask.thinking')} />}
      {err !== null && <ErrorView error={err} />}
      {res && <AskAnswer res={res} />}
    </div>
  );
}
