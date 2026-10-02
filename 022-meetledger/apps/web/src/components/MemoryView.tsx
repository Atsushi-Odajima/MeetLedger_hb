import type { ReactNode } from 'react';
import type { ActionDto, CommitmentDto, DecisionDto, MeetingDto, QuestionDto } from '@meetledger/shared';
import { AiBadge, Badge, Card } from './ui';
import { Link } from 'react-router-dom';
import { ActionItem, CommitmentItem, DecisionChangeItem, DecisionItem, MeetingRow, QuestionItem, SourceLink, toSourceRef } from './ledger';
import { useWs } from '../state/workspace';
import type { DecisionChangeDto, SourceInfo } from '../lib/types';
import { useI18n, type MsgKey } from '../i18n';
import { listOf } from '../lib/api';

/** Renders a "Meeting Memory" response (project / series / topic / person timeline) — tolerant to missing keys. */
export interface TimelineEvent {
  id?: string;
  type?: string;
  kind?: string;
  at?: string | null;
  date?: string;
  title?: string;
  text?: string;
  description?: string;
  subject?: string | null;
  body?: string;
  author?: string | null;
  status?: string;
  role?: string;
  meeting?: { id: string; title: string } | null;
  meetingId?: string | null;
  meetingTitle?: string | null;
  startMs?: number | null;
  source?: SourceInfo | null;
}

export interface MemoryDto {
  summary?: string | null;
  aiGenerated?: boolean;
  decisions?: DecisionDto[];
  currentDecisions?: DecisionDto[];
  actions?: ActionDto[];
  openActions?: ActionDto[];
  commitments?: CommitmentDto[];
  openCommitments?: CommitmentDto[];
  outstandingCommitments?: CommitmentDto[];
  questions?: QuestionDto[];
  openQuestions?: QuestionDto[];
  recentChanges?: DecisionChangeDto[];
  meetings?: MeetingDto[];
  recentMeetings?: MeetingDto[];
  upcomingMeetings?: MeetingDto[];
  timeline?: TimelineEvent[];
  events?: TimelineEvent[];
  stats?: Record<string, number>;
  [k: string]: unknown;
}

function Group({ titleKey, n, children }: { titleKey: MsgKey; n: number; children: ReactNode }) {
  const { t } = useI18n();
  if (!n) return null;
  return (
    <Card
      title={
        <>
          {t(titleKey)} <Badge>{n}</Badge>
        </>
      }
    >
      {children}
    </Card>
  );
}

function eventText(e: TimelineEvent, t: (k: MsgKey) => string, tm: (k: string, f: string) => string): string {
  if (e.type === 'meeting') return e.meeting?.title ?? e.title ?? '';
  if (e.type === 'followup') return `${tm(`followupKind.${e.kind ?? ''}`, e.kind ?? '')}${e.subject ? `：${e.subject}` : ''}`;
  if (e.type === 'note') return e.body ?? '';
  if (e.type === 'commitment' && e.role) return `${e.description ?? ''}（${t(e.role === 'promised_by' ? 'memory.role.promisedBy' : 'memory.role.promisedTo')}）`;
  return e.title ?? e.text ?? e.description ?? e.body ?? '';
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  const { t, fmt, tm } = useI18n();
  const { p } = useWs();
  return (
    <ol className="timeline">
      {events.map((e, i) => {
        const type = e.type ?? e.kind ?? 'meeting';
        const meetingId = e.meeting?.id ?? e.source?.meetingId ?? e.meetingId ?? null;
        return (
          <li key={e.id ?? i} className="timeline-item">
            <span className="timeline-date">{fmt.date(e.at ?? e.date ?? null)}</span>
            <div>
              <Badge tone={type === 'decision' ? 'success' : type === 'note' ? 'neutral' : 'info'}>{tm(`entity.${type}`, type)}</Badge>{' '}
              {type === 'meeting' && meetingId ? <Link to={p(`/meetings/${meetingId}`)}>{eventText(e, t, tm)}</Link> : <span className={type === 'note' ? 'pre' : undefined}>{eventText(e, t, tm)}</span>}
              {e.status && type !== 'meeting' && type !== 'note' && <span className="muted"> · {tm(`${type}Status.${e.status}`, e.status)}</span>}
              {e.author && <span className="muted"> · {e.author}</span>}
              {type !== 'meeting' && meetingId && (
                <SourceLink
                  source={toSourceRef({
                    meetingId,
                    meetingTitle: e.source?.meetingTitle ?? e.meeting?.title ?? e.meetingTitle ?? null,
                    meetingDate: e.source?.meetingDate ?? null,
                    startMs: e.source?.startMs ?? e.startMs ?? null,
                  })}
                />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function MemoryView({ data }: { data: MemoryDto }) {
  const { t, tm } = useI18n();
  const decisions = data.currentDecisions ?? data.decisions ?? [];
  const actions = data.openActions ?? data.actions ?? [];
  const commitments = data.outstandingCommitments ?? data.openCommitments ?? data.commitments ?? [];
  const questions = data.openQuestions ?? data.questions ?? [];
  const changes = data.recentChanges ?? [];
  const meetings = listOf<MeetingDto>(data.recentMeetings ?? data.meetings);
  const upcoming = listOf<MeetingDto>(data.upcomingMeetings);
  const timeline = data.timeline ?? data.events ?? [];
  const stats = data.stats && typeof data.stats === 'object' ? Object.entries(data.stats).filter(([, v]) => typeof v === 'number') : [];
  const empty =
    !data.summary && !decisions.length && !actions.length && !commitments.length && !questions.length && !changes.length && !meetings.length && !upcoming.length && !timeline.length;
  if (empty) return <p className="muted calm">{t('memory.empty')}</p>;
  return (
    <div className="stack">
      {stats.length > 0 && (
        <div className="stat-grid">
          {stats.map(([k, v]) => (
            <div className="stat" key={k}>
              <span className="stat-value">{v}</span>
              <span className="stat-label">{tm(`memory.stat.${k}`, k)}</span>
            </div>
          ))}
        </div>
      )}
      {data.summary && (
        <Card title={t('memory.summary')} actions={data.aiGenerated !== false ? <AiBadge /> : undefined}>
          <p className="summary-text">{data.summary}</p>
        </Card>
      )}
      <Group titleKey="memory.upcoming" n={upcoming.length}>
        <ul className="rows">
          {upcoming.map((m) => (
            <MeetingRow key={m.id} m={m} />
          ))}
        </ul>
      </Group>
      <Group titleKey="memory.decisions" n={decisions.length}>
        <ul className="items">
          {decisions.map((d) => (
            <DecisionItem key={d.id} decision={d} />
          ))}
        </ul>
      </Group>
      <Group titleKey="memory.changes" n={changes.length}>
        <ul className="items">
          {changes.map((c, i) => (
            <DecisionChangeItem key={c.previous.id ?? i} change={c} />
          ))}
        </ul>
      </Group>
      <Group titleKey="memory.actions" n={actions.length}>
        <ul className="items">
          {actions.map((d) => (
            <ActionItem key={d.id} action={d} />
          ))}
        </ul>
      </Group>
      <Group titleKey="memory.commitments" n={commitments.length}>
        <ul className="items">
          {commitments.map((d) => (
            <CommitmentItem key={d.id} c={d} />
          ))}
        </ul>
      </Group>
      <Group titleKey="memory.questions" n={questions.length}>
        <ul className="items">
          {questions.map((d) => (
            <QuestionItem key={d.id} q={d} />
          ))}
        </ul>
      </Group>
      <Group titleKey="memory.timeline" n={timeline.length}>
        <Timeline events={timeline} />
      </Group>
      <Group titleKey="memory.meetings" n={meetings.length}>
        <ul className="rows">
          {meetings.map((m) => (
            <MeetingRow key={m.id} m={m} />
          ))}
        </ul>
      </Group>
    </div>
  );
}
