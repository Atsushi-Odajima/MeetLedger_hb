import type { ReactNode } from 'react';
import type { ActionDto, CommitmentDto, DecisionDto, MeetingDto, QuestionDto } from '@meetledger/shared';
import { AiBadge, Badge, Card } from './ui';
import { ActionItem, CommitmentItem, DecisionItem, MeetingRow, QuestionItem, SourceLink } from './ledger';
import { useI18n, type MsgKey } from '../i18n';
import { listOf } from '../lib/api';

/** Renders a "Meeting Memory" response (project / series / topic / person timeline) — tolerant to missing keys. */
export interface MemoryDto {
  summary?: string | null;
  aiGenerated?: boolean;
  decisions?: DecisionDto[];
  currentDecisions?: DecisionDto[];
  decisionHistory?: DecisionDto[];
  actions?: ActionDto[];
  openActions?: ActionDto[];
  commitments?: CommitmentDto[];
  openCommitments?: CommitmentDto[];
  questions?: QuestionDto[];
  openQuestions?: QuestionDto[];
  meetings?: MeetingDto[];
  recentMeetings?: MeetingDto[];
  timeline?: { id?: string; type?: string; kind?: string; at?: string; date?: string; title?: string; text?: string; meetingId?: string | null; meetingTitle?: string | null; startMs?: number | null }[];
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

export function MemoryView({ data }: { data: MemoryDto }) {
  const { t, fmt, tm } = useI18n();
  const decisions = data.currentDecisions ?? data.decisions ?? [];
  const actions = data.openActions ?? data.actions ?? [];
  const commitments = data.openCommitments ?? data.commitments ?? [];
  const questions = data.openQuestions ?? data.questions ?? [];
  const meetings = listOf<MeetingDto>(data.recentMeetings ?? data.meetings);
  const timeline = data.timeline ?? [];
  const empty = !data.summary && !decisions.length && !actions.length && !commitments.length && !questions.length && !meetings.length && !timeline.length;
  if (empty) return <p className="muted calm">{t('memory.empty')}</p>;
  return (
    <div className="stack">
      {data.summary && (
        <Card title={t('memory.summary')} actions={data.aiGenerated !== false ? <AiBadge /> : undefined}>
          <p className="summary-text">{data.summary}</p>
        </Card>
      )}
      <Group titleKey="memory.decisions" n={decisions.length}>
        <ul className="items">
          {decisions.map((d) => (
            <DecisionItem key={d.id} decision={d} />
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
        <ol className="timeline">
          {timeline.map((e, i) => (
            <li key={e.id ?? i} className="timeline-item">
              <span className="timeline-date">{fmt.date(e.at ?? e.date ?? null)}</span>
              <div>
                <Badge>{tm(`entity.${e.type ?? e.kind ?? 'meeting'}`, e.type ?? e.kind ?? '')}</Badge> <span>{e.title ?? e.text}</span>
                <SourceLink source={e.meetingId ? { meetingId: e.meetingId, meetingTitle: e.meetingTitle ?? null, segmentIds: [], startMs: e.startMs ?? null, endMs: null, quote: null } : null} compact />
              </div>
            </li>
          ))}
        </ol>
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
