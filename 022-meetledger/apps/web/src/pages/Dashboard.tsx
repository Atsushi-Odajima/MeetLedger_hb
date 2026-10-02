import type { ReactNode } from 'react';
import type { ActionDto, CommitmentDto, DecisionDto, MeetingDto, Paged, QuestionDto } from '@meetledger/shared';
import { Card, CachedNotice, EmptyState, LinkButton, Loading, PageHeader, ErrorView } from '../components/ui';
import { ActionItem, AnyLedgerItem, CommitmentItem, DecisionItem, MeetingRow, QuestionItem } from '../components/ledger';
import { useI18n, type MsgKey } from '../i18n';
import { useSession } from '../state/session';
import { useWs } from '../state/workspace';
import { useApi } from '../lib/hooks';
import { ApiError, listOf, qs } from '../lib/api';
import { flattenGrouped, type DashboardDto, type DecisionChangeDto } from '../lib/types';
import { DecisionChangeItem } from '../components/ledger';

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Section shows at most this many rows; the rest is one click away ("すべて見る"). */
const TOP = 10;

/** "1000+" when the server capped the count. */
export function formatCount(n: number, cap?: number): string {
  return typeof cap === 'number' && n >= cap ? `${cap}+` : String(n);
}

function Section({
  id,
  titleKey,
  hintKey,
  hint,
  count,
  cap,
  children,
  empty,
  action,
}: {
  id: string;
  titleKey: MsgKey;
  hintKey?: MsgKey;
  hint?: ReactNode;
  count?: number;
  cap?: number;
  children: ReactNode;
  empty: boolean;
  action?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Card
      id={id}
      title={
        <>
          {t(titleKey)}
          {typeof count === 'number' && count > 0 && <span className="count-pill">{formatCount(count, cap)}</span>}
        </>
      }
      actions={action}
      className="dash-card"
    >
      {hintKey && !empty && <p className="field-hint">{t(hintKey)}</p>}
      {empty ? <p className="muted calm">{t(`${titleKey}.empty` as MsgKey)}</p> : children}
      {hint && !empty && <p className="field-hint">{hint}</p>}
    </Card>
  );
}

export function DashboardPage() {
  const { t, fmt } = useI18n();
  const { me } = useSession();
  const { a, p, can } = useWs();
  const dash = useApi<DashboardDto>(a('/dashboard'));
  // Fallback while the dashboard endpoint is unavailable: compose from the meetings list.
  const fallback = !!dash.error && (dash.error instanceof ApiError ? dash.error.status === 404 : false);
  const upcomingFb = useApi<Paged<MeetingDto>>(fallback ? a(`/meetings${qs({ from: startOfToday(), order: 'asc', limit: 30 })}`) : null);
  const reviewFb = useApi<Paged<MeetingDto>>(fallback ? a(`/meetings${qs({ status: 'needs_review', limit: 10 })}`) : null);

  let d: DashboardDto | undefined = dash.data;
  if (fallback) {
    const all = listOf<MeetingDto>(upcomingFb.data);
    const todayKey = new Date().toDateString();
    d = {
      today: all.filter((m) => m.scheduledStart && new Date(m.scheduledStart).toDateString() === todayKey),
      upcoming: all.filter((m) => !m.scheduledStart || new Date(m.scheduledStart).toDateString() !== todayKey),
      needsReview: listOf<MeetingDto>(reviewFb.data),
    };
  }

  const header = (
    <PageHeader
      title={t('dash.greeting', { name: me?.user.name ?? '' })}
      subtitle={fmt.date(new Date().toISOString())}
      actions={
        can('member') ? (
          <>
            <LinkButton to={p('/meetings/new')} variant="primary" icon="plus">
              {t('meeting.new')}
            </LinkButton>
            <LinkButton to={p('/review')} icon="inbox">
              {t('nav.review')}
            </LinkButton>
          </>
        ) : undefined
      }
    />
  );

  if (!d) {
    return (
      <>
        {header}
        {dash.error && !fallback ? <ErrorView error={dash.error} onRetry={dash.reload} /> : <Loading />}
      </>
    );
  }

  const today = d.today ?? [];
  const upcoming = d.upcoming ?? [];
  const needsReview = d.needsReview ?? [];
  const myActions = (d.myActions ?? []) as ActionDto[];
  const myCommitments = (d.myCommitments ?? []) as CommitmentDto[];
  const waiting = flattenGrouped(d.waitingOnOthers);
  const overdue = flattenGrouped(d.overdue);
  const changed = d.decisionsChanged ?? [];
  const questions = (d.openQuestions ?? []) as QuestionDto[];
  const c = d.counts ?? {};
  const cap = d.countCap;
  const n = (k: keyof NonNullable<DashboardDto['counts']>, fallback: number) => (typeof c[k] === 'number' ? (c[k] as number) : fallback);
  const seeAll = (to: string) => (
    <LinkButton size="sm" to={p(to)}>
      {t('common.seeAll')}
    </LinkButton>
  );
  const windowHint = d.windowDays ? t('dash.windowHint', { n: d.windowDays }) : undefined;

  return (
    <>
      {header}
      <CachedNotice at={dash.cachedAt} />
      {fallback && <p className="field-hint">{t('dash.fallback')}</p>}
      <div className="dash-grid">
        <Section id="dash-today" titleKey="dash.today" count={n('today', today.length)} cap={cap} empty={!today.length} action={seeAll('/meetings')}>
          <ul className="rows">
            {today.map((m) => (
              <MeetingRow key={m.id} m={m} showDate={false} />
            ))}
          </ul>
        </Section>
        <Section
          id="dash-review"
          titleKey="dash.needsReview"
          hintKey="dash.needsReview.hint"
          hint={windowHint}
          count={n('needsReview', needsReview.length)}
          cap={cap}
          empty={!needsReview.length}
          action={
            <LinkButton size="sm" to={p('/review')}>
              {t('common.open')}
            </LinkButton>
          }
        >
          <ul className="rows">
            {needsReview.map((m) => (
              <MeetingRow key={m.id} m={m} />
            ))}
          </ul>
        </Section>
        <Section
          id="dash-actions"
          titleKey="dash.myActions"
          count={n('myActions', myActions.length)}
          cap={cap}
          empty={!myActions.length}
          action={seeAll('/ledger?tab=actions&assignee=me')}
        >
          <ul className="items">
            {myActions.slice(0, TOP).map((x) => (
              <ActionItem key={x.id} action={x} showSource={false} />
            ))}
          </ul>
        </Section>
        <Section id="dash-upcoming" titleKey="dash.upcoming" count={n('upcoming', upcoming.length)} cap={cap} empty={!upcoming.length} action={seeAll('/meetings')}>
          <ul className="rows">
            {upcoming.slice(0, TOP).map((m) => (
              <MeetingRow key={m.id} m={m} />
            ))}
          </ul>
        </Section>
        <Section
          id="dash-commitments"
          titleKey="dash.myCommitments"
          count={n('myCommitments', myCommitments.length)}
          cap={cap}
          empty={!myCommitments.length}
          action={seeAll('/ledger?tab=commitments&direction=mine')}
        >
          <ul className="items">
            {myCommitments.slice(0, TOP).map((c) => (
              <CommitmentItem key={c.id} c={c} />
            ))}
          </ul>
        </Section>
        <Section
          id="dash-waiting"
          titleKey="dash.waiting"
          hint={windowHint}
          count={n('waitingOnOthers', waiting.length)}
          cap={cap}
          empty={!waiting.length}
          action={seeAll('/ledger?tab=commitments&direction=theirs')}
        >
          <ul className="items">
            {waiting.slice(0, TOP).map((x) => (
              <AnyLedgerItem key={(x as { id: string }).id} item={x as unknown as Record<string, unknown>} />
            ))}
          </ul>
        </Section>
        <Section
          id="dash-overdue"
          titleKey="dash.overdue"
          hintKey="dash.overdue.hint"
          count={n('overdue', overdue.length)}
          cap={cap}
          empty={!overdue.length}
          action={seeAll('/ledger?tab=actions&assignee=me&overdue=1')}
        >
          <ul className="items">
            {overdue.slice(0, TOP).map((x) => (
              <AnyLedgerItem key={(x as { id: string }).id} item={x as unknown as Record<string, unknown>} />
            ))}
          </ul>
        </Section>
        <Section
          id="dash-changed"
          titleKey="dash.decisionsChanged"
          count={n('decisionsChanged', changed.length)}
          cap={cap}
          empty={!changed.length}
          action={seeAll('/ledger?tab=decisions&view=all')}
        >
          <ul className="items">
            {changed
              .slice(0, TOP)
              .map((x, i) =>
                'previous' in x ? <DecisionChangeItem key={x.previous.id ?? i} change={x as DecisionChangeDto} /> : <DecisionItem key={x.id} decision={x as DecisionDto} />,
              )}
          </ul>
        </Section>
        <Section
          id="dash-questions"
          titleKey="dash.openQuestions"
          hint={windowHint}
          count={n('openQuestions', questions.length)}
          cap={cap}
          empty={!questions.length}
          action={seeAll('/ledger?tab=questions')}
        >
          <ul className="items">
            {questions.slice(0, TOP).map((q) => (
              <QuestionItem key={q.id} q={q} />
            ))}
          </ul>
        </Section>
      </div>
      {!today.length && !upcoming.length && !needsReview.length && can('member') && (
        <EmptyState
          icon="calendar"
          title={t('dash.firstRun.title')}
          body={t('dash.firstRun.body')}
          action={
            <LinkButton to={p('/meetings/new')} variant="primary" icon="plus">
              {t('meeting.new')}
            </LinkButton>
          }
        />
      )}
    </>
  );
}
