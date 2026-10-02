import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ActionDto, CommitmentDto, DecisionDto, MeetingDto, QuestionDto } from '@meetledger/shared';
import { AiBadge, Alert, Async, Badge, Card } from '../../components/ui';
import { ActionItem, CommitmentItem, DecisionChangeItem, DecisionItem, MeetingRow, QuestionItem } from '../../components/ledger';
import type { DecisionChangeDto } from '../../lib/types';
import { useI18n, type MsgKey } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useApi } from '../../lib/hooks';
import { useMeeting } from './context';

interface BriefParticipant {
  personId?: string | null;
  name: string;
  organization?: string | null;
  roleTitle?: string | null;
  isMe?: boolean;
  isInternal?: boolean;
}
interface BriefDto {
  firstMeeting?: boolean;
  aiGenerated?: boolean;
  summary?: string | null;
  participants?: BriefParticipant[];
  agendaTemplate?: string[];
  previousMeeting?: (MeetingDto & { via?: 'series' | 'participants' | 'project' }) | null;
  currentDecisions?: DecisionDto[];
  openActions?: ActionDto[];
  commitments?: { mine?: CommitmentDto[]; theirs?: CommitmentDto[]; others?: CommitmentDto[] } | CommitmentDto[];
  openQuestions?: QuestionDto[];
  personNotes?: { personId: string; name: string; organization: string | null; roleTitle: string | null; profileNote: string | null; notes: { id: string; body: string; author: string | null; createdAt: string | null }[] }[];
  recentChanges?: DecisionChangeDto[];
  more?: { decisions?: number; actions?: number; commitments?: number; questions?: number };
  /** Exact totals (lists are capped). */
  counts?: Partial<Record<'decisions' | 'actions' | 'commitments' | 'commitmentsMine' | 'commitmentsTheirs' | 'commitmentsOthers' | 'questions', number>>;
}

function Block({ titleKey, n, children }: { titleKey: MsgKey; n: number; children: ReactNode }) {
  const { t } = useI18n();
  if (!n) return null;
  return (
    <Card
      id={titleKey.replace(/\./g, '-')}
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
          const c = b.commitments;
          const mine = Array.isArray(c) ? c.filter((x) => x.direction === 'mine') : (c?.mine ?? []);
          const theirs = Array.isArray(c) ? c.filter((x) => x.direction === 'theirs') : (c?.theirs ?? []);
          const otherCommitments = Array.isArray(c) ? c.filter((x) => x.direction !== 'mine' && x.direction !== 'theirs') : (c?.others ?? []);
          const decisions = b.currentDecisions ?? [];
          const changes = b.recentChanges ?? [];
          const others = (b.participants ?? []).filter((x) => !x.isMe);
          const more = (n?: number) => (n ? <p className="field-hint">{t('brief.more', { n })}</p> : null);
          const cnt = (k: keyof NonNullable<BriefDto['counts']>, shown: number) => Math.max(shown, b.counts?.[k] ?? 0);
          const commitmentMore = (k: 'commitmentsMine' | 'commitmentsTheirs' | 'commitmentsOthers', shown: number) => (b.counts?.[k] !== undefined ? more(Math.max(0, (b.counts[k] ?? 0) - shown)) : null);
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
              {b.previousMeeting && (
                <Card title={t('brief.lastMeeting')} actions={b.previousMeeting.via ? <Badge>{t(`brief.via.${b.previousMeeting.via}` as MsgKey)}</Badge> : undefined}>
                  <ul className="rows">
                    <MeetingRow m={b.previousMeeting} />
                  </ul>
                </Card>
              )}
              <Block titleKey="brief.openActions" n={cnt('actions', (b.openActions ?? []).length)}>
                <ul className="items">
                  {(b.openActions ?? []).map((x) => (
                    <ActionItem key={x.id} action={x} />
                  ))}
                </ul>
                {more(b.more?.actions)}
              </Block>
              <Block titleKey="brief.myCommitments" n={cnt('commitmentsMine', mine.length)}>
                <ul className="items">
                  {mine.map((x) => (
                    <CommitmentItem key={x.id} c={x} />
                  ))}
                </ul>
                {commitmentMore('commitmentsMine', mine.length)}
              </Block>
              <Block titleKey="brief.theirCommitments" n={cnt('commitmentsTheirs', theirs.length)}>
                <ul className="items">
                  {theirs.map((x) => (
                    <CommitmentItem key={x.id} c={x} />
                  ))}
                </ul>
                {b.counts?.commitmentsTheirs !== undefined ? commitmentMore('commitmentsTheirs', theirs.length) : more(b.more?.commitments)}
              </Block>
              <Block titleKey="brief.otherCommitments" n={cnt('commitmentsOthers', otherCommitments.length)}>
                <ul className="items">
                  {otherCommitments.map((x) => (
                    <CommitmentItem key={x.id} c={x} />
                  ))}
                </ul>
                {commitmentMore('commitmentsOthers', otherCommitments.length)}
              </Block>
              <Block titleKey="brief.openQuestions" n={cnt('questions', (b.openQuestions ?? []).length)}>
                <ul className="items">
                  {(b.openQuestions ?? []).map((x) => (
                    <QuestionItem key={x.id} q={x} />
                  ))}
                </ul>
                {more(b.more?.questions)}
              </Block>
              <Block titleKey="brief.decisions" n={cnt('decisions', decisions.length)}>
                <ul className="items">
                  {decisions.map((x) => (
                    <DecisionItem key={x.id} decision={x} />
                  ))}
                </ul>
                {more(b.more?.decisions)}
              </Block>
              <Block titleKey="brief.changes" n={changes.length}>
                <ul className="items">
                  {changes.map((x, i) => (
                    <DecisionChangeItem key={x.previous.id ?? i} change={x} />
                  ))}
                </ul>
              </Block>
              {(b.personNotes ?? []).length > 0 && (
                <Card title={t('brief.people')}>
                  <ul className="items">
                    {(b.personNotes ?? []).map((x) => (
                      <li key={x.personId} className="item">
                        <div className="item-main">
                          <span className="item-title">
                            <Link to={p(`/people/${x.personId}`)}>{x.name}</Link>
                          </span>
                          <span className="item-meta">{[x.organization, x.roleTitle].filter(Boolean).join(' · ')}</span>
                          {x.profileNote && <p className="pre muted">{x.profileNote}</p>}
                          {x.notes.map((n) => (
                            <p key={n.id} className="pre">
                              {n.body} <span className="muted">— {n.author ?? ''} {fmt.date(n.createdAt)}</span>
                            </p>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {others.length > 0 && !(b.personNotes ?? []).length && (
                <Card title={t('brief.people')}>
                  <ul className="chips">
                    {others.map((x, i) => (
                      <li key={x.personId ?? i} className="chip">
                        {x.personId ? <Link to={p(`/people/${x.personId}`)}>{x.name}</Link> : x.name}
                        {[x.organization, x.roleTitle].filter(Boolean).length > 0 && <span className="muted">{[x.organization, x.roleTitle].filter(Boolean).join(' · ')}</span>}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {(b.agendaTemplate ?? []).length > 0 && (
                <Card title={t('brief.suggestedAgenda')}>
                  <ol className="plain-list">
                    {(b.agendaTemplate ?? []).map((x, i) => (
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
