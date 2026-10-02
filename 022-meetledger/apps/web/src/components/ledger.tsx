import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ACTION_STATUSES,
  msToClock,
  type ActionDto,
  type ActionStatus,
  type CommitmentDto,
  type DecisionDto,
  type MeetingDto,
  type QuestionDto,
  type SourceRef,
} from '@meetledger/shared';
import { Badge, Button, CandidateBadge, AiBadge, Loading, ErrorView } from './ui';
import { Icon } from './Icon';
import { useI18n, type MsgKey } from '../i18n';
import { useWs } from '../state/workspace';
import { useToast } from '../state/toast';
import { api, listOf, NetworkError } from '../lib/api';
import { actionOpId, getOp, queueActionStatus, replayOutbox } from '../lib/offline/outbox';
import { useOutbox } from '../lib/hooks';
import type { PersonDto } from '@meetledger/shared';

// ------------------------------------------------------------------ people lookup (cached per workspace)
const peopleCache = new Map<string, Promise<PersonDto[]>>();
export function usePeople(): { people: PersonDto[]; byId: Map<string, PersonDto>; refresh(): void } {
  const { a, wsId } = useWs();
  const [people, setPeople] = useState<PersonDto[]>([]);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!peopleCache.has(wsId) || n > 0)
      peopleCache.set(
        wsId,
        api
          .get(a('/people?limit=500'))
          .then((r) => listOf<PersonDto>(r, 'people'))
          .catch(() => {
            peopleCache.delete(wsId);
            return [];
          }),
      );
    peopleCache.get(wsId)!.then((p) => alive && setPeople(p));
    return () => {
      alive = false;
    };
  }, [wsId, a, n]);
  return { people, byId: new Map(people.map((p) => [p.id, p])), refresh: () => setN((x) => x + 1) };
}

export function personName(byId: Map<string, PersonDto>, id: string | null | undefined, text?: string | null): string | null {
  if (id && byId.has(id)) return byId.get(id)!.name;
  return text ?? null;
}

// ------------------------------------------------------------------ meeting row
export function MeetingPrivacyBadges({ m }: { m: Pick<MeetingDto, 'aiEnabled' | 'isConfidential' | 'transcriptionMode' | 'visibility'> }) {
  const { t } = useI18n();
  return (
    <>
      {m.isConfidential && (
        <Badge tone="warn" icon="lock">
          {t('privacy.confidential')}
        </Badge>
      )}
      {!m.aiEnabled && <Badge tone="neutral">{t('privacy.aiOff')}</Badge>}
      {m.transcriptionMode === 'local' && <Badge tone="info">{t('privacy.local')}</Badge>}
      {m.transcriptionMode === 'cloud' && <Badge tone="neutral">{t('privacy.cloud')}</Badge>}
      {m.visibility === 'private' && (
        <Badge tone="neutral" icon="lock">
          {t('visibility.private')}
        </Badge>
      )}
    </>
  );
}

export function MeetingRow({ m, showDate = true }: { m: MeetingDto & { participantCount?: number }; showDate?: boolean }) {
  const { t, fmt } = useI18n();
  const { p } = useWs();
  const when = m.scheduledStart ?? m.startedAt ?? m.createdAt;
  return (
    <li className="row meeting-row">
      <div className="row-time" aria-hidden={!showDate}>
        {showDate ? (
          <>
            <span className="row-day">{fmt.dayLabel(when)}</span>
            <span className="row-hour">{m.scheduledStart ? fmt.time(m.scheduledStart) : ''}</span>
          </>
        ) : (
          <span className="row-hour">{m.scheduledStart ? fmt.time(m.scheduledStart) : '—'}</span>
        )}
      </div>
      <div className="row-main">
        <Link to={p(`/meetings/${m.id}`)} className="row-title">
          {m.title}
        </Link>
        <div className="row-meta">
          <Badge tone={m.status === 'needs_review' ? 'candidate' : m.status === 'live' ? 'danger' : 'neutral'}>{t(`meetingStatus.${m.status}` as MsgKey)}</Badge>
          <span>{t(`meetingType.${m.meetingType}` as MsgKey)}</span>
          {typeof m.participantCount === 'number' && <span>{t('meeting.participantsN', { n: m.participantCount })}</span>}
          <MeetingPrivacyBadges m={m} />
        </div>
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ source / citation
export function SourceLink({ source, compact }: { source: SourceRef | null | undefined; compact?: boolean }) {
  const { t, fmt } = useI18n();
  const { p } = useWs();
  if (!source || !source.meetingId) return null;
  const ts = typeof source.startMs === 'number' ? source.startMs : null;
  const to = p(`/meetings/${source.meetingId}/transcript${ts !== null ? `?t=${ts}` : ''}`);
  return (
    <div className="source">
      <Link to={to} className="source-link">
        <Icon name="link" size={14} />
        {source.meetingTitle && !compact ? <span>{source.meetingTitle}</span> : <span>{t('source.open')}</span>}
        {source.meetingDate && !compact && <span className="muted">{fmt.date(source.meetingDate)}</span>}
        {ts !== null && <span className="timestamp">{msToClock(ts)}</span>}
      </Link>
      {source.status === 'edited' && <Badge tone="warn">{t('source.edited')}</Badge>}
      {source.status === 'missing' && <Badge tone="danger">{t('source.missing')}</Badge>}
      {source.quote && !compact && <blockquote className="quote">「{source.quote}」</blockquote>}
    </div>
  );
}

// ------------------------------------------------------------------ action status (with offline queue)
export function useActionStatus() {
  const { wsId, a } = useWs();
  const toast = useToast();
  const { t } = useI18n();
  return async (action: ActionDto, status: ActionStatus): Promise<ActionDto | 'queued' | null> => {
    const queueIt = async () => {
      await queueActionStatus({
        wsId,
        actionId: action.id,
        status,
        prevStatus: action.status,
        baseUpdatedAt: action.updatedAt ?? null,
        meetingId: action.meetingId,
        label: action.description.slice(0, 80),
      });
      toast.info(t('sync.queued'));
      return 'queued' as const;
    };
    // An edit for this action is already waiting: keep order by queueing behind it.
    if (await getOp(actionOpId(wsId, action.id)).catch(() => undefined)) {
      const r = await queueIt();
      replayOutbox(api).catch(() => undefined);
      return r;
    }
    try {
      const updated = await api.patch<ActionDto>(a(`/actions/${action.id}`), { status });
      toast.announce(t('action.statusChanged', { status: t(`actionStatus.${status}` as MsgKey) }));
      return updated && typeof updated === 'object' && 'id' in updated ? updated : { ...action, status };
    } catch (e) {
      if (e instanceof NetworkError) return queueIt();
      toast.error(e);
      return null;
    }
  };
}

export function ActionItem({ action, onChange, showSource = true }: { action: ActionDto; onChange?: (a: ActionDto) => void; showSource?: boolean }) {
  const { t, fmt } = useI18n();
  const { wsId, can, p } = useWs();
  const { byId } = usePeople();
  const { ops } = useOutbox();
  const setStatus = useActionStatus();
  const [local, setLocal] = useState(action);
  useEffect(() => setLocal(action), [action]);
  const queued = ops.find((o) => o.kind === 'action.status' && o.actionId === action.id && o.wsId === wsId);
  const isCandidate = local.status === 'candidate';
  const assignee = personName(byId, local.assigneePersonId, local.assigneeText);
  const editable = can('member') && !isCandidate && local.status !== 'rejected';
  const change = async (s: ActionStatus) => {
    const prev = local;
    setLocal({ ...local, status: s });
    const r = await setStatus(prev, s);
    if (r === null) setLocal(prev);
    else if (r !== 'queued') {
      setLocal(r);
      onChange?.(r);
    }
  };
  const statuses = ACTION_STATUSES.filter((s) => s !== 'candidate' && s !== 'rejected');
  return (
    <li className={`item${isCandidate ? ' item-candidate' : ''}${local.status === 'done' ? ' item-done' : ''}`}>
      {editable && (
        <input
          type="checkbox"
          className="item-check"
          checked={local.status === 'done'}
          onChange={(e) => change(e.target.checked ? 'done' : 'confirmed')}
          aria-label={t('action.markDone', { title: local.description })}
        />
      )}
      <div className="item-main">
        <div className="item-title">
          {isCandidate && <CandidateBadge />}
          {local.extractedBy === 'ai' && isCandidate && <AiBadge />}
          <span>{local.description}</span>
        </div>
        <div className="item-meta">
          <span className={local.assigneeInferred ? 'inferred' : undefined}>
            {t('action.assignee')}: {assignee ?? t('action.noAssignee')}
            {local.assigneeInferred && <Badge tone="warn">{t('review.inferred')}</Badge>}
          </span>
          <span className={local.dueInferred ? 'inferred' : undefined}>
            {t('action.due')}: {local.dueDate ? fmt.date(local.dueDate) : (local.dueText ?? t('action.noDue'))}
            {local.dueInferred && <Badge tone="warn">{t('review.inferred')}</Badge>}
          </span>
          {local.overdue && local.status !== 'done' && <Badge tone="warn">{t('action.overdue')}</Badge>}
          {queued && (
            <Badge tone={queued.status === 'conflict' ? 'warn' : 'neutral'} icon="sync">
              {queued.status === 'conflict' ? t('sync.status.conflict') : t('sync.unsynced')}
            </Badge>
          )}
          {local.externalSyncState === 'pending_approval' && <Badge tone="info">{t('action.pendingApproval')}</Badge>}
        </div>
        {showSource && <SourceLink source={local.source} compact />}
      </div>
      <div className="item-side">
        {editable ? (
          <select className="input select select-sm" value={local.status} onChange={(e) => change(e.target.value as ActionStatus)} aria-label={t('action.status')}>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {t(`actionStatus.${s}` as MsgKey)}
              </option>
            ))}
          </select>
        ) : isCandidate ? (
          <Link to={p(`/review${local.meetingId ? `?meetingId=${local.meetingId}` : ''}`)} className="btn btn-sm btn-secondary">
            {t('review.goReview')}
          </Link>
        ) : (
          <Badge>{t(`actionStatus.${local.status}` as MsgKey)}</Badge>
        )}
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ decisions
export function DecisionHistory({ decisionId }: { decisionId: string }) {
  const { a } = useWs();
  const { t, fmt } = useI18n();
  const [state, setState] = useState<{ items?: DecisionDto[]; error?: unknown }>({});
  useEffect(() => {
    api
      .get(a(`/decisions/${decisionId}/history`))
      .then((r) => setState({ items: listOf<DecisionDto>(r, 'history', 'chain', 'decisions') }))
      .catch((error) => setState({ error }));
  }, [a, decisionId]);
  if (state.error) return <ErrorView error={state.error} compact />;
  if (!state.items) return <Loading />;
  if (!state.items.length) return <p className="muted">{t('decision.noHistory')}</p>;
  return (
    <ol className="history-chain" aria-label={t('decision.history')}>
      {state.items.map((d) => (
        <li key={d.id} className={`history-step${d.status === 'superseded' ? ' history-superseded' : ''}`}>
          <div className="history-dot" aria-hidden="true" />
          <div>
            <p className={d.status === 'superseded' ? 'strike' : undefined}>{d.text}</p>
            <p className="item-meta">
              <Badge tone={d.status === 'active' ? 'success' : 'neutral'}>{t(`decisionStatus.${d.status}` as MsgKey)}</Badge>
              <span>{fmt.date(d.decidedAt ?? d.createdAt)}</span>
              {d.reason && <span>{t('decision.reason')}: {d.reason}</span>}
            </p>
            <SourceLink source={d.source} />
          </div>
        </li>
      ))}
    </ol>
  );
}

export function DecisionItem({ decision, actions }: { decision: DecisionDto; actions?: ReactNode }) {
  const { t, fmt } = useI18n();
  const [showHistory, setShowHistory] = useState(false);
  const isCandidate = decision.reviewState === 'candidate';
  const hasChain = !!decision.supersedesDecisionId || !!decision.supersededByDecisionId;
  return (
    <li className={`item${isCandidate ? ' item-candidate' : ''}`}>
      <div className="item-main">
        <div className="item-title">
          {isCandidate && <CandidateBadge />}
          {isCandidate && decision.extractedBy === 'ai' && <AiBadge />}
          <span className={decision.status === 'superseded' ? 'strike' : undefined}>{decision.text}</span>
        </div>
        <div className="item-meta">
          <Badge tone={decision.status === 'active' ? 'success' : 'neutral'}>{t(`decisionStatus.${decision.status}` as MsgKey)}</Badge>
          {decision.topic && <span>#{decision.topic}</span>}
          <span>{fmt.date(decision.decidedAt ?? decision.createdAt)}</span>
          {decision.supersedesDecisionId && <Badge tone="info">{t('decision.changed')}</Badge>}
        </div>
        <SourceLink source={decision.source} compact />
        {(hasChain || decision.status === 'superseded') && (
          <Button size="sm" variant="ghost" icon="history" aria-expanded={showHistory} onClick={() => setShowHistory((s) => !s)}>
            {showHistory ? t('decision.hideHistory') : t('decision.showHistory')}
          </Button>
        )}
        {showHistory && <DecisionHistory decisionId={decision.id} />}
      </div>
      {actions && <div className="item-side">{actions}</div>}
    </li>
  );
}

// ------------------------------------------------------------------ commitments / questions
export function CommitmentItem({ c, actions }: { c: CommitmentDto; actions?: ReactNode }) {
  const { t, fmt } = useI18n();
  const { byId } = usePeople();
  const isCandidate = c.status === 'candidate';
  const by = personName(byId, c.promisedByPersonId, c.promisedByText) ?? t('commitment.unknown');
  const to = personName(byId, c.promisedToPersonId, c.promisedToText) ?? t('commitment.unknown');
  return (
    <li className={`item${isCandidate ? ' item-candidate' : ''}${c.status === 'done' ? ' item-done' : ''}`}>
      <div className="item-main">
        <div className="item-title">
          {isCandidate && <CandidateBadge />}
          {isCandidate && c.extractedBy === 'ai' && <AiBadge />}
          <span>{c.description}</span>
        </div>
        <div className="item-meta">
          <Badge tone={c.direction === 'mine' ? 'primary' : c.direction === 'theirs' ? 'info' : 'neutral'}>{t(`commitment.direction.${c.direction}` as MsgKey)}</Badge>
          <span>{t('commitment.fromTo', { by, to })}</span>
          <span className={c.dueInferred ? 'inferred' : undefined}>
            {t('action.due')}: {c.dueDate ? fmt.date(c.dueDate) : (c.dueText ?? t('action.noDue'))}
            {c.dueInferred && <Badge tone="warn">{t('review.inferred')}</Badge>}
          </span>
          {c.overdue && c.status === 'open' && <Badge tone="warn">{t('action.overdue')}</Badge>}
          {!isCandidate && <Badge>{t(`commitmentStatus.${c.status}` as MsgKey)}</Badge>}
        </div>
        <SourceLink source={c.source} compact />
      </div>
      {actions && <div className="item-side">{actions}</div>}
    </li>
  );
}

export function QuestionItem({ q, actions }: { q: QuestionDto; actions?: ReactNode }) {
  const { t, fmt } = useI18n();
  const isCandidate = q.status === 'candidate';
  return (
    <li className={`item${isCandidate ? ' item-candidate' : ''}`}>
      <div className="item-main">
        <div className="item-title">
          {isCandidate && <CandidateBadge />}
          {isCandidate && q.extractedBy === 'ai' && <AiBadge />}
          <span>{q.question}</span>
        </div>
        <div className="item-meta">
          {!isCandidate && <Badge tone={q.status === 'open' ? 'info' : 'neutral'}>{t(`questionStatus.${q.status}` as MsgKey)}</Badge>}
          {q.dueDate && (
            <span>
              {t('action.due')}: {fmt.date(q.dueDate)}
            </span>
          )}
          {q.answerText && (
            <span>
              {t('question.answer')}: {q.answerText}
            </span>
          )}
        </div>
        <SourceLink source={q.source} compact />
      </div>
      {actions && <div className="item-side">{actions}</div>}
    </li>
  );
}

/** Generic renderer for mixed ledger lists (dashboard "overdue" etc.). */
export function AnyLedgerItem({ item }: { item: Record<string, unknown> }) {
  if ('question' in item) return <QuestionItem q={item as unknown as QuestionDto} />;
  if ('promisedByText' in item || 'direction' in item) return <CommitmentItem c={item as unknown as CommitmentDto} />;
  if ('description' in item) return <ActionItem action={item as unknown as ActionDto} />;
  if ('text' in item) return <DecisionItem decision={item as unknown as DecisionDto} />;
  return null;
}
