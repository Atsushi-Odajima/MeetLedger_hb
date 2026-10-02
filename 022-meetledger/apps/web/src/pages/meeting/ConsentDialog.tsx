import { useState } from 'react';
import { Alert, Badge, Button, Checkbox, Dialog, KeyValue, RadioGroup, TextArea } from '../../components/ui';
import { useI18n, type MsgKey } from '../../i18n';
import { useToast } from '../../state/toast';
import { api } from '../../lib/api';
import type { MeetingDetailDto } from '../../lib/types';
import { useMeeting } from './context';

export type ConsentMethod = 'verbal' | 'calendar_note' | 'chat_message' | 'email';
const METHODS: ConsentMethod[] = ['verbal', 'calendar_note', 'chat_message', 'email'];

/** What will happen with the recording, derived from the meeting's server-side privacy decisions. */
export function useProcessingSummary(m: MeetingDetailDto) {
  const { t } = useI18n();
  const tr = m.privacy?.transcription;
  const ai = m.privacy?.ai;
  const external: string[] = [];
  if (tr?.allowed && !tr.isLocal) external.push(t('consent.externalTranscription', { provider: tr.provider }));
  if (ai?.allowed && !ai.isLocal) external.push(t('consent.externalAi', { provider: ai.provider }));
  const retention =
    m.audioRetention === 'custom' ? t('audioRetention.customDays', { n: m.audioRetentionDays ?? '?' }) : t(`audioRetention.${m.audioRetention}` as MsgKey);
  return {
    recording: t('consent.recordingWhat'),
    transcription: tr ? (tr.allowed ? `${tr.reason}` : t('consent.transcriptionOff', { reason: tr.reason })) : t(`transcriptionMode.${m.transcriptionMode}` as MsgKey),
    transcriptionLocal: tr ? tr.isLocal : m.transcriptionMode !== 'cloud',
    retention,
    ai: ai ? (ai.allowed ? ai.reason : t('consent.aiOff')) : m.aiEnabled ? t('privacy.aiOn.hint') : t('consent.aiOff'),
    aiLocal: ai ? ai.isLocal : true,
    external,
  };
}

export function ConsentDialog({
  open,
  mode,
  onClose,
  onConsented,
}: {
  open: boolean;
  mode: 'record' | 'upload';
  onClose(): void;
  /** Called after the notification was recorded on the server. */
  onConsented(m: MeetingDetailDto | null): void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { meeting, ma, reload } = useMeeting();
  const s = useProcessingSummary(meeting);
  const [method, setMethod] = useState<ConsentMethod | ''>('');
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const record = async (state: 'notified' | 'declined') => {
    setBusy(true);
    try {
      await api.post(ma('/consent'), {
        kind: 'recording',
        state,
        method: state === 'declined' ? (method || 'verbal') : method,
        details: {
          mode,
          transcription: s.transcription.slice(0, 500),
          ai: s.ai.slice(0, 500),
          retention: s.retention.slice(0, 500),
          external: (s.external.join(' / ') || t('consent.noExternal')).slice(0, 500),
          ...(note ? { note: note.slice(0, 500) } : {}),
          disclaimerShown: true,
        },
      });
      let updated: MeetingDetailDto | null = null;
      try {
        updated = await api.get<MeetingDetailDto>(ma());
      } catch {
        reload();
      }
      if (state === 'declined') {
        toast.info(t('consent.declinedRecorded'));
        onClose();
        if (updated) onConsented(null);
      } else {
        toast.announce(t('consent.recorded'));
        onConsented(updated);
      }
      setConfirmed(false);
      setNote('');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={mode === 'record' ? t('consent.titleRecord') : t('consent.titleUpload')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {mode === 'record' && (
            <Button onClick={() => record('declined')} loading={busy}>
              {t('consent.declined')}
            </Button>
          )}
          <Button variant="primary" onClick={() => record('notified')} disabled={!method || !confirmed} loading={busy}>
            {mode === 'record' ? t('consent.confirmRecord') : t('consent.confirmUpload')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>{mode === 'record' ? t('consent.introRecord') : t('consent.introUpload')}</p>
        <KeyValue
          items={[
            { k: t('consent.recording'), v: s.recording },
            {
              k: t('consent.transcription'),
              v: (
                <>
                  {s.transcription} <Badge tone={s.transcriptionLocal ? 'info' : 'warn'}>{s.transcriptionLocal ? t('privacy.local') : t('privacy.cloud')}</Badge>
                </>
              ),
            },
            { k: t('consent.retention'), v: s.retention },
            {
              k: t('consent.ai'),
              v: (
                <>
                  {s.ai} {meeting.aiEnabled && <Badge tone={s.aiLocal ? 'info' : 'warn'}>{s.aiLocal ? t('privacy.local') : t('privacy.cloud')}</Badge>}
                </>
              ),
            },
            { k: t('consent.external'), v: s.external.length ? s.external.join(' / ') : t('consent.noExternal') },
          ]}
        />
        <RadioGroup<ConsentMethod>
          legend={t('consent.method')}
          value={method}
          onChange={setMethod}
          inline
          options={METHODS.map((m) => ({ value: m, label: t(`consent.method.${m}` as MsgKey) }))}
        />
        <Checkbox label={mode === 'record' ? t('consent.checkRecord') : t('consent.checkUpload')} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <TextArea label={t('consent.note')} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} hint={t('consent.noteHint')} />
        <Alert tone="warn" title={t('consent.disclaimerTitle')}>
          {t('consent.disclaimer')}
        </Alert>
      </div>
    </Dialog>
  );
}
