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

function Section({ id, titleKey, hintKey, count, children, empty, action }: { id: string; titleKey: MsgKey; hintKey?: MsgKey; count?: number; children: ReactNode; empty: boolean; action?: ReactNode }) {
  const { t } = useI18n();
  return (
    <Card
      id={id}
      title={
        <>
          {t(titleKey)}
          {typeof count === 'number' && count > 0 && <span className="count-pill">{count}</span>}
        </>
      }
      actions={action}
      className="dash-card"
    >
      {hintKey && !empty && <p className="field-hint">{t(hintKey)}</p>}
      {empty ? <p className="muted calm">{t(`${titleKey}.empty` as MsgKey)}</p> : children}
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

  return (
    <>
      {header}
      <CachedNotice at={dash.cachedAt} />
      {fallback && <p className="field-hint">{t('dash.fallback')}</p>}
      <div className="dash-grid">
        <Section id="dash-today" titleKey="dash.today" count={today.length} empty={!today.length}>
          <ul className="rows">
            {today.map((m) => (
              <MeetingRow key={m.id} m={m} showDate={false} />
            ))}
          </ul>
        </Section>
        <Section id="dash-review" titleKey="dash.needsReview" hintKey="dash.needsReview.hint" count={needsReview.length} empty={!needsReview.length} action={<LinkButton size="sm" to={p('/review')}>{t('common.open')}</LinkButton>}>
          <ul className="rows">
            {needsReview.map((m) => (
              <MeetingRow key={m.id} m={m} />
            ))}
          </ul>
        </Section>
        <Section id="dash-actions" titleKey="dash.myActions" count={myActions.length} empty={!myActions.length} action={<LinkButton size="sm" to={p('/ledger?tab=actions&assignee=me')}>{t('common.seeAll')}</LinkButton>}>
          <ul className="items">
            {myActions.slice(0, 8).map((x) => (
              <ActionItem key={x.id} action={x} showSource={false} />
            ))}
          </ul>
        </Section>
        <Section id="dash-upcoming" titleKey="dash.upcoming" count={upcoming.length} empty={!upcoming.length} action={<LinkButton size="sm" to={p('/meetings')}>{t('common.seeAll')}</LinkButton>}>
          <ul className="rows">
            {upcoming.slice(0, 8).map((m) => (
              <MeetingRow key={m.id} m={m} />
            ))}
          </ul>
        </Section>
        <Section id="dash-commitments" titleKey="dash.myCommitments" count={myCommitments.length} empty={!myCommitments.length}>
          <ul className="items">
            {myCommitments.slice(0, 6).map((c) => (
              <CommitmentItem key={c.id} c={c} />
            ))}
          </ul>
        </Section>
        <Section id="dash-waiting" titleKey="dash.waiting" count={waiting.length} empty={!waiting.length}>
          <ul className="items">
            {waiting.slice(0, 8).map((x) => (
              <AnyLedgerItem key={(x as { id: string }).id} item={x as unknown as Record<string, unknown>} />
            ))}
          </ul>
        </Section>
        <Section id="dash-overdue" titleKey="dash.overdue" hintKey="dash.overdue.hint" count={overdue.length} empty={!overdue.length}>
          <ul className="items">
            {overdue.slice(0, 8).map((x) => (
              <AnyLedgerItem key={(x as { id: string }).id} item={x as unknown as Record<string, unknown>} />
            ))}
          </ul>
        </Section>
        <Section id="dash-changed" titleKey="dash.decisionsChanged" count={changed.length} empty={!changed.length}>
          <ul className="items">
            {changed.slice(0, 5).map((x, i) =>
              'previous' in x ? <DecisionChangeItem key={x.previous.id ?? i} change={x as DecisionChangeDto} /> : <DecisionItem key={x.id} decision={x as DecisionDto} />,
            )}
          </ul>
        </Section>
        <Section id="dash-questions" titleKey="dash.openQuestions" count={questions.length} empty={!questions.length}>
          <ul className="items">
            {questions.slice(0, 6).map((q) => (
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
