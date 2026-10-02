import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BUILTIN_TEMPLATES, MEETING_TYPES, defaultTemplateFor, type MeetingType, type Visibility } from '@meetledger/shared';
import { Alert, Button, Card, PageHeader, SelectField, TextField } from '../components/ui';
import { ParticipantsInput, PrivacyFields, VisibilityFields, applyConfidential, fromLocalInput, toLocalInput, type ParticipantInput, type PrivacyValue } from '../components/MeetingForm';
import { useI18n, type MsgKey } from '../i18n';
import { useWs } from '../state/workspace';
import { useApi } from '../lib/hooks';
import { api, ApiError, errorMessage, listOf } from '../lib/api';
import type { MeetingDetailDto, ProjectDto, SeriesDto, TemplateDto } from '../lib/types';

function nextHalfHour(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d.toISOString();
}

export function MeetingNewPage() {
  const { t } = useI18n();
  const { a, p, ws } = useWs();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useApi<unknown>(a('/projects'));
  const series = useApi<unknown>(a('/series'));
  const templatesApi = useApi<unknown>(a('/templates'));
  const templates: TemplateDto[] = useMemo(() => {
    const fromApi = listOf<TemplateDto>(templatesApi.data, 'templates');
    return fromApi.length ? fromApi : BUILTIN_TEMPLATES.map((x) => ({ key: x.key, name: x.name, meetingType: x.meetingType }));
  }, [templatesApi.data]);

  const d = ws?.settings.defaults;
  const [title, setTitle] = useState('');
  const [start, setStart] = useState(toLocalInput(nextHalfHour()));
  const [durationMin, setDurationMin] = useState(30);
  const [meetingType, setMeetingType] = useState<MeetingType>('other');
  const [templateKey, setTemplateKey] = useState<string>('other');
  const [projectId, setProjectId] = useState(params.get('projectId') ?? '');
  const [seriesId, setSeriesId] = useState(params.get('seriesId') ?? '');
  const [participants, setParticipants] = useState<ParticipantInput[]>([]);
  const [visibility, setVisibility] = useState<Visibility>(d?.visibility ?? 'workspace');
  const [visTouched, setVisTouched] = useState(false);
  const [accessUserIds, setAccess] = useState<string[]>([]);
  const [language, setLanguage] = useState<'auto' | 'ja' | 'en'>('auto');
  const [privacy, setPrivacy] = useState<PrivacyValue>({
    transcriptionMode: d?.transcriptionMode ?? 'local',
    aiEnabled: d?.aiEnabled ?? true,
    isConfidential: false,
    audioRetention: d?.audioRetention ?? 'until_processed',
    audioRetentionDays: d?.audioRetentionDays ?? null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeType = (tp: MeetingType) => {
    setMeetingType(tp);
    const tpl = defaultTemplateFor(tp);
    setTemplateKey(tpl.key);
    if (!visTouched) setVisibility(tp === 'one_on_one' ? 'private' : tpl.defaultVisibility);
  };
  const changeTemplate = (key: string) => {
    setTemplateKey(key);
    const tpl = templates.find((x) => x.key === key);
    if (tpl) setMeetingType(tpl.meetingType);
  };
  const changePrivacy = (v: PrivacyValue) => {
    setPrivacy(v);
    if (v.isConfidential && visibility === 'workspace') setVisibility('private');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const scheduledStart = fromLocalInput(start);
    const pv = applyConfidential(privacy);
    try {
      const m = await api.post<MeetingDetailDto>(a('/meetings'), {
        title: title.trim(),
        scheduledStart,
        scheduledEnd: scheduledStart ? new Date(Date.parse(scheduledStart) + durationMin * 60000).toISOString() : null,
        meetingType,
        templateKey,
        projectId: projectId || null,
        seriesId: seriesId || null,
        visibility,
        accessUserIds: visibility === 'selected' ? accessUserIds : [],
        participants,
        language,
        ...pv,
      });
      navigate(p(`/meetings/${m.id}/capture`), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && Array.isArray(err.details) ? (err.details as { path: string; message: string }[]).map((x) => `${x.path}: ${x.message}`).join(' / ') : errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t('meeting.new')} subtitle={t('meetingNew.subtitle')} />
      <form onSubmit={submit} className="form-layout">
        {error && <Alert tone="danger">{error}</Alert>}
        <Card title={t('meetingNew.basics')}>
          <div className="stack">
            <TextField label={t('meeting.title')} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} autoFocus placeholder={t('meetingNew.titlePlaceholder')} />
            <div className="grid-2">
              <TextField label={t('meeting.start')} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
              <SelectField
                label={t('meeting.duration')}
                value={String(durationMin)}
                onChange={(e) => setDurationMin(Number(e.target.value))}
                options={[15, 30, 45, 60, 90, 120].map((n) => ({ value: String(n), label: t('meeting.minutes', { n }) }))}
              />
            </div>
            <div className="grid-2">
              <SelectField
                label={t('meeting.type')}
                value={meetingType}
                onChange={(e) => changeType(e.target.value as MeetingType)}
                options={MEETING_TYPES.map((x) => ({ value: x, label: t(`meetingType.${x}` as MsgKey) }))}
              />
              <SelectField
                label={t('meeting.template')}
                value={templateKey}
                onChange={(e) => changeTemplate(e.target.value)}
                hint={t('meeting.template.hint')}
                options={templates.map((x) => ({ value: x.key, label: x.name }))}
              />
            </div>
            <div className="grid-2">
              <SelectField
                label={t('meeting.project')}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                options={[{ value: '', label: t('common.none') }, ...listOf<ProjectDto>(projects.data).map((x) => ({ value: x.id, label: x.name }))]}
              />
              <SelectField
                label={t('meeting.series')}
                value={seriesId}
                onChange={(e) => setSeriesId(e.target.value)}
                options={[{ value: '', label: t('common.none') }, ...listOf<SeriesDto>(series.data).map((x) => ({ value: x.id, label: x.title }))]}
              />
            </div>
            <SelectField
              label={t('meeting.language')}
              value={language}
              onChange={(e) => setLanguage(e.target.value as typeof language)}
              options={[
                { value: 'auto', label: t('language.auto') },
                { value: 'ja', label: t('language.ja') },
                { value: 'en', label: t('language.en') },
              ]}
            />
            <ParticipantsInput value={participants} onChange={setParticipants} />
          </div>
        </Card>
        <Card title={t('meetingNew.access')}>
          <VisibilityFields
            visibility={visibility}
            onVisibility={(v) => {
              setVisTouched(true);
              setVisibility(v);
            }}
            accessUserIds={accessUserIds}
            onAccess={setAccess}
            confidential={privacy.isConfidential}
          />
        </Card>
        <Card title={t('meetingNew.privacy')}>
          <PrivacyFields value={privacy} onChange={changePrivacy} />
        </Card>
        <div className="form-actions">
          <Button onClick={() => navigate(-1)}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!title.trim()}>
            {t('meetingNew.submit')}
          </Button>
        </div>
      </form>
    </>
  );
}
