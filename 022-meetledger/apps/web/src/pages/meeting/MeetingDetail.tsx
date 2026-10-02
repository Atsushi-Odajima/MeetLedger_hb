import { useMemo, useState } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Badge, Button, CachedNotice, ErrorView, Loading, PageHeader, TabNav } from '../../components/ui';
import { MeetingPrivacyBadges } from '../../components/ledger';
import { useI18n, type MsgKey } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useToast } from '../../state/toast';
import { useApi } from '../../lib/hooks';
import { api } from '../../lib/api';
import type { MeetingDetailDto } from '../../lib/types';
import { MeetingContext, type MeetingCtx } from './context';
import { BriefTab } from './BriefTab';
import { CaptureTab } from './CaptureTab';
import { TranscriptTab } from './TranscriptTab';
import { SummaryTab } from './SummaryTab';
import { MeetingLedgerTab } from './LedgerTab';
import { FollowupTab } from './FollowupTab';
import { MeetingAskTab } from './AskTab';
import { CoachTab } from './CoachTab';
import { AgendaTab } from './AgendaTab';
import { MeetingSettingsTab } from './SettingsTab';
import { ExportTab } from './ExportTab';

export const MEETING_TABS = ['brief', 'capture', 'transcript', 'summary', 'ledger', 'followup', 'ask', 'coach', 'agenda', 'settings', 'export'] as const;
export type MeetingTab = (typeof MEETING_TABS)[number];

function defaultTab(m: MeetingDetailDto): MeetingTab {
  if (m.status === 'scheduled') return 'brief';
  if (m.status === 'live') return 'capture';
  return 'summary';
}

export function MeetingDetailPage() {
  const { meetingId = '' } = useParams();
  const { a, p } = useWs();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const state = useApi<MeetingDetailDto>(a(`/meetings/${meetingId}`));
  const [busy, setBusy] = useState(false);
  const meeting = state.data;

  const ctx = useMemo<MeetingCtx | null>(
    () =>
      meeting
        ? {
            meeting,
            setMeeting: (m) => state.setData(m),
            reload: state.reload,
            ma: (path = '') => a(`/meetings/${meeting.id}${path}`),
            mp: (path = '') => p(`/meetings/${meeting.id}${path}`),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meeting, state.setData, state.reload, a, p],
  );

  if (!meeting) return state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : <Loading />;

  const end = async () => {
    setBusy(true);
    try {
      const m = await api.post<MeetingDetailDto>(ctx!.ma('/end'), { expectMedia: false });
      state.setData(m);
      toast.success(t('meeting.ended'));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const when = meeting.scheduledStart ?? meeting.startedAt ?? meeting.createdAt;
  return (
    <MeetingContext.Provider value={ctx}>
      <PageHeader
        title={meeting.title}
        subtitle={`${fmt.dateTime(when)} · ${t(`meetingType.${meeting.meetingType}` as MsgKey)}${meeting.participants?.length ? ` · ${t('meeting.participantsN', { n: meeting.participants.length })}` : ''}`}
        badges={
          <>
            <Badge tone={meeting.status === 'live' ? 'danger' : meeting.status === 'needs_review' ? 'candidate' : 'neutral'}>{t(`meetingStatus.${meeting.status}` as MsgKey)}</Badge>
            <Badge tone={meeting.consentState === 'declined' ? 'warn' : 'neutral'}>{t(`consentState.${meeting.consentState}` as MsgKey)}</Badge>
            <MeetingPrivacyBadges m={meeting} />
          </>
        }
        actions={
          meeting.canEdit && meeting.status === 'live' ? (
            <Button onClick={end} loading={busy} icon="stop">
              {t('meeting.end')}
            </Button>
          ) : undefined
        }
      />
      <CachedNotice at={state.cachedAt} />
      <TabNav
        label={t('meeting.tabs')}
        items={MEETING_TABS.map((tab) => ({ to: p(`/meetings/${meeting.id}/${tab}`), label: t(`meeting.tab.${tab}` as MsgKey) }))}
      />
      <div className="tab-panel">
        <Routes>
          <Route index element={<Navigate to={defaultTab(meeting)} replace />} />
          <Route path="brief" element={<BriefTab />} />
          <Route path="capture" element={<CaptureTab />} />
          <Route path="transcript" element={<TranscriptTab />} />
          <Route path="summary" element={<SummaryTab />} />
          <Route path="ledger" element={<MeetingLedgerTab />} />
          <Route path="followup" element={<FollowupTab />} />
          <Route path="ask" element={<MeetingAskTab />} />
          <Route path="coach" element={<CoachTab />} />
          <Route path="agenda" element={<AgendaTab />} />
          <Route path="settings" element={<MeetingSettingsTab />} />
          <Route path="export" element={<ExportTab />} />
          <Route path="review" element={<Navigate to={p(`/review?meetingId=${meeting.id}`)} replace />} />
          <Route path="*" element={<Navigate to={defaultTab(meeting)} replace />} />
        </Routes>
      </div>
    </MeetingContext.Provider>
  );
}
