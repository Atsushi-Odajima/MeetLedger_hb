import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MEETING_TYPES, type MeetingType, type Visibility } from '@meetledger/shared';
import { Alert, Badge, Button, Card, Dialog, SelectField, TextField } from '../../components/ui';
import { ParticipantsInput, PrivacyFields, VisibilityFields, applyConfidential, fromLocalInput, toLocalInput, type ParticipantInput, type PrivacyValue } from '../../components/MeetingForm';
import { useI18n, type MsgKey } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useSession } from '../../state/session';
import { useToast } from '../../state/toast';
import { api, ApiError, listOf } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import type { MeetingDetailDto, ProjectDto, SeriesDto } from '../../lib/types';
import { useMeeting } from './context';
import { ConsentDialog } from './ConsentDialog';

export function MeetingSettingsTab() {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const { a, p, can } = useWs();
  const { me } = useSession();
  const navigate = useNavigate();
  const { meeting, setMeeting, ma, reload } = useMeeting();
  const projects = useApi<unknown>(a('/projects'));
  const series = useApi<unknown>(a('/series'));
  const ro = !meeting.canEdit;
  const isOwner = meeting.createdBy === me?.user.id || can('admin');

  const [title, setTitle] = useState(meeting.title);
  const [start, setStart] = useState(toLocalInput(meeting.scheduledStart));
  const [type, setType] = useState<MeetingType>(meeting.meetingType);
  const [projectId, setProjectId] = useState(meeting.projectId ?? '');
  const [seriesId, setSeriesId] = useState(meeting.seriesId ?? '');
  const [privacy, setPrivacy] = useState<PrivacyValue>({
    transcriptionMode: meeting.transcriptionMode,
    aiEnabled: meeting.aiEnabled,
    isConfidential: meeting.isConfidential,
    audioRetention: meeting.audioRetention,
    audioRetentionDays: meeting.audioRetentionDays,
  });
  const [visibility, setVisibility] = useState<Visibility>(meeting.visibility);
  const [access, setAccess] = useState<string[]>(meeting.accessUsers?.map((u) => u.id) ?? []);
  const [participants, setParticipants] = useState<ParticipantInput[]>(
    (meeting.participants ?? []).map((x) => (x.personId ? { personId: x.personId, role: x.role } : { name: x.displayName, email: x.email, role: x.role })),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<null | 'audio' | 'transcript' | 'ai' | 'meeting'>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    setConflict(false);
  }, [meeting.version]);

  const patch = async (name: string, body: Record<string, unknown>) => {
    setBusy(name);
    try {
      const m = await api.patch<MeetingDetailDto>(ma(), { ...body, version: meeting.version });
      setMeeting(m);
      toast.success(t('common.saved'));
      return m;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      else toast.error(e);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const saveBasics = () =>
    patch('basics', {
      title: title.trim(),
      scheduledStart: fromLocalInput(start),
      meetingType: type,
      projectId: projectId || null,
      seriesId: seriesId || null,
    });

  const saveAccess = async () => {
    const m = visibility !== meeting.visibility ? await patch('access', { visibility }) : meeting;
    if (!m) return;
    if (visibility === 'selected') {
      setBusy('access');
      try {
        setMeeting(await api.put<MeetingDetailDto>(ma('/access'), { userIds: access }));
      } catch (e) {
        toast.error(e);
      } finally {
        setBusy(null);
      }
    }
  };

  const saveParticipants = async () => {
    setBusy('participants');
    try {
      setMeeting(await api.put<MeetingDetailDto>(ma('/participants'), { participants }));
      toast.success(t('common.saved'));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async () => {
    const kind = confirmDelete;
    if (!kind) return;
    setBusy('delete');
    try {
      if (kind === 'meeting') {
        await api.del(ma());
        toast.success(t('meetingSettings.deleted'));
        navigate(p('/meetings'));
        return;
      }
      await api.post(ma(kind === 'audio' ? '/delete-audio' : kind === 'transcript' ? '/delete-transcript' : '/delete-ai-index'));
      toast.success(t('meetingSettings.deleteRequested'));
      reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
      setConfirmDelete(null);
      setTyped('');
    }
  };

  return (
    <div className="stack">
      {conflict && (
        <Alert tone="warn" title={t('meetingSettings.conflict')}>
          <p>{t('meetingSettings.conflictBody')}</p>
          <Button size="sm" onClick={() => window.location.reload()}>
            {t('common.reload')}
          </Button>
        </Alert>
      )}
      {ro && <Alert tone="info">{t('common.readOnly')}</Alert>}
      <Card title={t('meetingSettings.basics')}>
        <div className="stack">
          <TextField label={t('meeting.title')} value={title} onChange={(e) => setTitle(e.target.value)} disabled={ro} maxLength={300} />
          <div className="grid-2">
            <TextField label={t('meeting.start')} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} disabled={ro} />
            <SelectField
              label={t('meeting.type')}
              value={type}
              onChange={(e) => setType(e.target.value as MeetingType)}
              disabled={ro}
              options={MEETING_TYPES.map((x) => ({ value: x, label: t(`meetingType.${x}` as MsgKey) }))}
            />
          </div>
          <div className="grid-2">
            <SelectField
              label={t('meeting.project')}
              value={projectId}
              disabled={ro}
              onChange={(e) => setProjectId(e.target.value)}
              options={[{ value: '', label: t('common.none') }, ...listOf<ProjectDto>(projects.data).map((x) => ({ value: x.id, label: x.name }))]}
            />
            <SelectField
              label={t('meeting.series')}
              value={seriesId}
              disabled={ro}
              onChange={(e) => setSeriesId(e.target.value)}
              options={[{ value: '', label: t('common.none') }, ...listOf<SeriesDto>(series.data).map((x) => ({ value: x.id, label: x.title }))]}
            />
          </div>
          {!ro && (
            <Button variant="primary" onClick={saveBasics} loading={busy === 'basics'} disabled={!title.trim()}>
              {t('common.save')}
            </Button>
          )}
        </div>
      </Card>

      <Card title={t('meetingSettings.privacy')}>
        <PrivacyFields value={privacy} onChange={setPrivacy} disabled={ro} />
        <p className="field-hint">{t('meetingSettings.privacyEffect')}</p>
        {!ro && (
          <Button variant="primary" onClick={() => patch('privacy', { ...applyConfidential(privacy) })} loading={busy === 'privacy'}>
            {t('common.save')}
          </Button>
        )}
        <div className="kv-inline">
          <span>
            {t('consent.transcription')}: {meeting.privacy?.transcription.reason}
          </span>
          <span>
            {t('consent.ai')}: {meeting.privacy?.ai.reason}
          </span>
        </div>
      </Card>

      <Card title={t('meetingSettings.access')}>
        {!isOwner && <p className="field-hint">{t('meetingSettings.ownerOnly')}</p>}
        <VisibilityFields
          visibility={visibility}
          onVisibility={setVisibility}
          accessUserIds={access}
          onAccess={setAccess}
          disabled={ro || !isOwner}
          confidential={privacy.isConfidential}
        />
        {!ro && isOwner && (
          <Button variant="primary" onClick={saveAccess} loading={busy === 'access'}>
            {t('common.save')}
          </Button>
        )}
      </Card>

      <Card title={t('meeting.participants')}>
        <ParticipantsInput value={participants} onChange={setParticipants} disabled={ro} />
        {!ro && (
          <Button variant="primary" onClick={saveParticipants} loading={busy === 'participants'}>
            {t('common.save')}
          </Button>
        )}
      </Card>

      <Card title={t('meetingSettings.consent')} actions={!ro && <Button size="sm" onClick={() => setConsentOpen(true)}>{t('meetingSettings.recordConsent')}</Button>}>
        <p>
          {t('meetingSettings.consentState')}: <Badge>{t(`consentState.${meeting.consentState}` as MsgKey)}</Badge>
        </p>
        {meeting.consents?.length ? (
          <ul className="items">
            {meeting.consents.map((c) => (
              <li key={c.id} className="item">
                <div className="item-main">
                  <span className="item-title">
                    {t(`consentKind.${c.kind}` as MsgKey)} · {t(`consentRecordState.${c.state}` as MsgKey)}
                  </span>
                  <span className="item-meta">
                    {t(`consent.method.${c.method}` as MsgKey)} · {fmt.dateTime(c.created_at ?? c.createdAt ?? null)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('meetingSettings.noConsent')}</p>
        )}
        <p className="field-hint">{t('consent.disclaimer')}</p>
      </Card>

      {!ro && (
        <Card title={t('meetingSettings.data')}>
          <div className="stack">
            {meeting.status !== 'archived' && (
              <Button onClick={() => patch('archive', { status: 'archived' })} loading={busy === 'archive'}>
                {t('meetingSettings.archive')}
              </Button>
            )}
            <div className="button-row">
              <Button variant="danger" icon="trash" onClick={() => setConfirmDelete('audio')}>
                {t('meetingSettings.deleteAudio')}
              </Button>
              <Button variant="danger" icon="trash" onClick={() => setConfirmDelete('transcript')}>
                {t('meetingSettings.deleteTranscript')}
              </Button>
              <Button variant="danger" icon="trash" onClick={() => setConfirmDelete('ai')}>
                {t('meetingSettings.deleteAiIndex')}
              </Button>
              {isOwner && (
                <Button variant="danger" icon="trash" onClick={() => setConfirmDelete('meeting')}>
                  {t('meetingSettings.deleteMeeting')}
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}

      <ConsentDialog
        open={consentOpen}
        mode="record"
        onClose={() => setConsentOpen(false)}
        onConsented={(m) => {
          setConsentOpen(false);
          if (m) setMeeting(m);
          else reload();
        }}
      />
      <Dialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={t('meetingSettings.confirmTitle')}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={doDelete} loading={busy === 'delete'} disabled={confirmDelete === 'meeting' && typed !== meeting.title}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {confirmDelete && <p>{t(`meetingSettings.confirm.${confirmDelete}` as MsgKey)}</p>}
        {confirmDelete === 'meeting' && (
          <TextField label={t('meetingSettings.typeTitle', { title: meeting.title })} value={typed} onChange={(e) => setTyped(e.target.value)} />
        )}
      </Dialog>
    </div>
  );
}
