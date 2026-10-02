import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ActionDto, CommitmentDto, DecisionDto, MeetingDto, QuestionDto } from '@meetledger/shared';
import { AiBadge, Alert, Async, Badge, Card } from '../../components/ui';
import { ActionItem, CommitmentItem, DecisionItem, MeetingRow, QuestionItem } from '../../components/ledger';
import { useI18n, type MsgKey } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useApi } from '../../lib/hooks';
import { listOf } from '../../lib/api';
import { useMeeting } from './context';

interface BriefDto {
  firstMeeting?: boolean;
  aiGenerated?: boolean;
  summary?: string | null;
  participants?: { personId?: string | null; name: string; organization?: string | null; roleTitle?: string | null; lastMeetingAt?: string | null; notes?: string | null; firstMeeting?: boolean }[];
  previousMeetings?: MeetingDto[];
  lastMeeting?: (MeetingDto & { summary?: string | null }) | null;
  openActions?: ActionDto[];
  openCommitments?: CommitmentDto[];
  commitments?: { mine?: CommitmentDto[]; theirs?: CommitmentDto[] } | CommitmentDto[];
  openQuestions?: QuestionDto[];
  recentDecisions?: DecisionDto[];
  decisions?: DecisionDto[];
  suggestedAgenda?: (string | { title: string })[];
  agenda?: (string | { title: string })[];
  [k: string]: unknown;
}

function Block({ titleKey, n, children }: { titleKey: MsgKey; n: number; children: ReactNode }) {
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

export function BriefTab() {
  const { t, fmt } = useI18n();
  const { p } = useWs();
  const { meeting, ma } = useMeeting();
  const state = useApi<BriefDto>(ma('/brief'));
  return (
    <div className="stack">
      <Card title={t('brief.participants')}>
        {meeting.participants?.length ? (
          <ul className="chips">
            {meeting.participants.map((pt) => (
              <li key={pt.id} className="chip">
                {pt.personId ? <Link to={p(`/people/${pt.personId}`)}>{pt.displayName}</Link> : pt.displayName}
                {pt.role === 'organizer' && <Badge tone="info">{t('participant.organizer')}</Badge>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('brief.noParticipants')}</p>
        )}
      </Card>
      <Async state={state}>
        {(b) => {
          const commitments = Array.isArray(b.commitments) ? b.commitments : [...(b.commitments?.mine ?? []), ...(b.commitments?.theirs ?? [])];
          const openCommitments = b.openCommitments ?? commitments;
          const decisions = b.recentDecisions ?? b.decisions ?? [];
          const agenda = (b.suggestedAgenda ?? b.agenda ?? []).map((x) => (typeof x === 'string' ? x : x.title));
          const prev = listOf<MeetingDto>(b.previousMeetings);
          return (
            <>
              {b.firstMeeting && (
                <Alert tone="info" title={t('brief.firstMeeting')}>
                  {t('brief.firstMeetingBody')}
                </Alert>
              )}
              {b.summary && (
                <Card title={t('brief.summary')} actions={b.aiGenerated !== false ? <AiBadge /> : undefined}>
                  <p className="summary-text">{b.summary}</p>
                </Card>
              )}
              {b.participants && b.participants.length > 0 && (
                <Card title={t('brief.people')}>
                  <ul className="items">
                    {b.participants.map((x, i) => (
                      <li key={x.personId ?? i} className="item">
                        <div className="item-main">
                          <span className="item-title">
                            {x.personId ? <Link to={p(`/people/${x.personId}`)}>{x.name}</Link> : x.name}
                            {x.firstMeeting && <Badge tone="info">{t('brief.firstTime')}</Badge>}
                          </span>
                          <span className="item-meta">
                            {[x.organization, x.roleTitle].filter(Boolean).join(' · ')}
                            {x.lastMeetingAt && ` · ${t('people.lastMeeting')}: ${fmt.date(x.lastMeetingAt)}`}
                          </span>
                          {x.notes && <p className="muted">{x.notes}</p>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {b.lastMeeting && (
                <Card title={t('brief.lastMeeting')}>
                  <ul className="rows">
                    <MeetingRow m={b.lastMeeting} />
                  </ul>
                  {b.lastMeeting.summary && <p className="summary-text">{b.lastMeeting.summary}</p>}
                </Card>
              )}
              <Block titleKey="brief.openActions" n={(b.openActions ?? []).length}>
                <ul className="items">
                  {(b.openActions ?? []).map((x) => (
                    <ActionItem key={x.id} action={x} />
                  ))}
                </ul>
              </Block>
              <Block titleKey="brief.openCommitments" n={openCommitments.length}>
                <ul className="items">
                  {openCommitments.map((x) => (
                    <CommitmentItem key={x.id} c={x} />
                  ))}
                </ul>
              </Block>
              <Block titleKey="brief.openQuestions" n={(b.openQuestions ?? []).length}>
                <ul className="items">
                  {(b.openQuestions ?? []).map((x) => (
                    <QuestionItem key={x.id} q={x} />
                  ))}
                </ul>
              </Block>
              <Block titleKey="brief.decisions" n={decisions.length}>
                <ul className="items">
                  {decisions.map((x) => (
                    <DecisionItem key={x.id} decision={x} />
                  ))}
                </ul>
              </Block>
              <Block titleKey="brief.previousMeetings" n={prev.length}>
                <ul className="rows">
                  {prev.map((m) => (
                    <MeetingRow key={m.id} m={m} />
                  ))}
                </ul>
              </Block>
              {agenda.length > 0 && (
                <Card title={t('brief.suggestedAgenda')} candidate>
                  <ol className="plain-list">
                    {agenda.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ol>
                  <Link to={p(`/meetings/${meeting.id}/agenda`)}>{t('brief.toAgenda')}</Link>
                </Card>
              )}
            </>
          );
        }}
      </Async>
    </div>
  );
}
