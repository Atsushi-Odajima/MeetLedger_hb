import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ACTION_STATUSES, COMMITMENT_STATUSES, QUESTION_STATUSES, type ActionDto, type CommitmentDto, type DecisionDto, type QuestionDto } from '@meetledger/shared';
import { Async, Button, Checkbox, Dialog, EmptyState, LoadMore, PageHeader, SelectField, TabPanel, Tabs, TextArea } from '../components/ui';
import { Icon } from '../components/Icon';
import { ActionItem, CommitmentItem, DecisionItem, QuestionItem, RevokeDecisionButton } from '../components/ledger';
import { ManualAddDialog, type ManualKind } from '../components/ManualAdd';
import { useI18n, type MsgKey } from '../i18n';
import { useWs } from '../state/workspace';
import { useToast } from '../state/toast';
import { api, qs } from '../lib/api';
import { usePaged, type PagedState } from '../lib/hooks';

type LedgerTab = 'decisions' | 'actions' | 'commitments' | 'questions';

function ExportLink({ href, label }: { href: string; label: string }) {
  return (
    <a className="btn btn-sm btn-ghost" href={href} download>
      <Icon name="download" size={16} />
      <span>{label}</span>
    </a>
  );
}

function More({ state }: { state: PagedState<unknown> }) {
  return <LoadMore shown={state.items?.length ?? 0} total={state.total} hasMore={state.hasMore} loading={state.loadingMore} error={state.moreError} onMore={state.loadMore} />;
}

function Decisions() {
  const { t } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const [params] = useSearchParams();
  const initialView = params.get('view');
  const [view, setView] = useState<'current' | 'all' | 'candidates' | 'superseded'>(
    initialView === 'all' || initialView === 'candidates' || initialView === 'superseded' ? initialView : 'current',
  );
  const state = usePaged<DecisionDto>(a(`/decisions${qs({ view })}`), 'decisions');
  const [supersede, setSupersede] = useState<DecisionDto | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!supersede) return;
    setBusy(true);
    try {
      await api.post(a(`/decisions/${supersede.id}/supersede`), { text });
      toast.success(t('decision.superseded'));
      setSupersede(null);
      setText('');
      state.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="filters">
        <SelectField
          label={t('ledger.view')}
          value={view}
          onChange={(e) => setView(e.target.value as typeof view)}
          options={(['current', 'all', 'candidates', 'superseded'] as const).map((v) => ({ value: v, label: t(`decisionView.${v}` as MsgKey) }))}
        />
        <div className="filters-end">
          <ExportLink href={a('/decisions/export?format=csv')} label="CSV" />
          <ExportLink href={a('/decisions/export?format=json')} label="JSON" />
        </div>
      </div>
      <Async state={state}>
        {() => {
          const items = state.items ?? [];
          return items.length ? (
            <>
              <ul className="items items-card">
                {items.map((x) => (
                  <DecisionItem
                    key={x.id}
                    decision={x}
                    actions={
                      can('member') && x.reviewState === 'confirmed' && (x.status === 'active' || x.status === 'revoked') ? (
                        <div className="button-row">
                          {x.status === 'active' && (
                            <Button size="sm" icon="edit" onClick={() => setSupersede(x)}>
                              {t('decision.supersede')}
                            </Button>
                          )}
                          <RevokeDecisionButton decision={x} onChanged={() => state.reload()} />
                        </div>
                      ) : undefined
                    }
                  />
                ))}
              </ul>
              <More state={state} />
            </>
          ) : (
            <EmptyState icon="book" title={t('ledger.noDecisions')} />
          );
        }}
      </Async>
      <Dialog
        open={!!supersede}
        onClose={() => setSupersede(null)}
        title={t('decision.supersedeTitle')}
        footer={
          <>
            <Button onClick={() => setSupersede(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={submit} loading={busy} disabled={!text.trim()}>
              {t('decision.supersede')}
            </Button>
          </>
        }
      >
        <p className="muted">{supersede?.text}</p>
        <TextArea label={t('decision.newText')} value={text} onChange={(e) => setText(e.target.value)} rows={3} />
        <p className="field-hint">{t('decision.supersedeHint')}</p>
      </Dialog>
    </>
  );
}

function Actions() {
  const { t } = useI18n();
  const { a } = useWs();
  const [params] = useSearchParams();
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(params.get('assignee') === 'me');
  const [overdue, setOverdue] = useState(params.get('overdue') === '1');
  const state = usePaged<ActionDto>(a(`/actions${qs({ status, assignee: mine ? 'me' : undefined, overdue: overdue ? 1 : undefined })}`), 'actions');
  return (
    <>
      <div className="filters">
        <SelectField
          label={t('action.status')}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[{ value: '', label: t('common.all') }, ...ACTION_STATUSES.map((s) => ({ value: s, label: t(`actionStatus.${s}` as MsgKey) }))]}
        />
        <Checkbox label={t('ledger.mineOnly')} checked={mine} onChange={(e) => setMine(e.target.checked)} />
        <Checkbox label={t('ledger.overdueOnly')} checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />
        <div className="filters-end">
          <ExportLink href={a('/actions/export?format=csv')} label="CSV" />
        </div>
      </div>
      <Async state={state}>
        {() => {
          const items = state.items ?? [];
          return items.length ? (
            <>
              <ul className="items items-card">
                {items.map((x) => (
                  <ActionItem key={x.id} action={x} />
                ))}
              </ul>
              <More state={state} />
            </>
          ) : (
            <EmptyState icon="check" title={t('ledger.noActions')} />
          );
        }}
      </Async>
    </>
  );
}

function Commitments() {
  const { t } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const [params] = useSearchParams();
  const initialDir = params.get('direction');
  const [direction, setDirection] = useState<'all' | 'mine' | 'theirs'>(initialDir === 'mine' || initialDir === 'theirs' ? initialDir : 'all');
  const [status, setStatus] = useState('open');
  const [overdueOnly, setOverdueOnly] = useState(params.get('overdue') === '1');
  const [adding, setAdding] = useState<ManualKind | null>(null);
  const state = usePaged<CommitmentDto>(a(`/commitments${qs({ direction, status, overdue: overdueOnly ? 1 : undefined })}`), 'commitments');
  const update = async (c: CommitmentDto, s: string) => {
    try {
      await api.patch(a(`/commitments/${c.id}`), { status: s });
      toast.announce(t('common.saved'));
      state.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <>
      <div className="filters">
        <SelectField
          label={t('commitment.direction')}
          value={direction}
          onChange={(e) => setDirection(e.target.value as typeof direction)}
          options={(['all', 'mine', 'theirs'] as const).map((v) => ({ value: v, label: t(`commitment.filter.${v}` as MsgKey) }))}
        />
        <SelectField
          label={t('action.status')}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[{ value: '', label: t('common.all') }, ...COMMITMENT_STATUSES.map((s) => ({ value: s, label: t(`commitmentStatus.${s}` as MsgKey) }))]}
        />
        <Checkbox label={t('ledger.overdueOnly')} checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
        <div className="filters-end">
          {can('member') && (
            <Button size="sm" icon="plus" onClick={() => setAdding('commitment')}>
              {t('ledger.addBtn.commitment')}
            </Button>
          )}
          <ExportLink href={a('/commitments/export?format=csv')} label="CSV" />
        </div>
      </div>
      <Async state={state}>
        {() => {
          const items = state.items ?? [];
          return items.length ? (
            <>
              <ul className="items items-card">
                {items.map((x) => (
                  <CommitmentItem
                    key={x.id}
                    c={x}
                    actions={
                      can('member') && x.status === 'open' ? (
                        <div className="button-row">
                          <Button size="sm" icon="check" onClick={() => update(x, 'done')}>
                            {t('commitment.markDone')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => update(x, 'cancelled')}>
                            {t('commitment.cancel')}
                          </Button>
                        </div>
                      ) : undefined
                    }
                  />
                ))}
              </ul>
              <More state={state} />
            </>
          ) : (
            <EmptyState icon="users" title={t('ledger.noCommitments')} />
          );
        }}
      </Async>
      <ManualAddDialog kind={adding} onClose={() => setAdding(null)} onAdded={state.reload} />
    </>
  );
}

function Questions() {
  const { t } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const [status, setStatus] = useState('open');
  const state = usePaged<QuestionDto>(a(`/questions${qs({ status })}`), 'questions');
  const [answering, setAnswering] = useState<QuestionDto | null>(null);
  const [adding, setAdding] = useState<ManualKind | null>(null);
  const [answer, setAnswer] = useState('');
  const update = async (q: QuestionDto, body: Record<string, unknown>) => {
    try {
      await api.patch(a(`/questions/${q.id}`), body);
      toast.announce(t('common.saved'));
      state.reload();
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    }
  };
  return (
    <>
      <div className="filters">
        <SelectField
          label={t('action.status')}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[{ value: '', label: t('common.all') }, ...QUESTION_STATUSES.map((s) => ({ value: s, label: t(`questionStatus.${s}` as MsgKey) }))]}
        />
        {can('member') && (
          <div className="filters-end">
            <Button size="sm" icon="plus" onClick={() => setAdding('question')}>
              {t('ledger.addBtn.question')}
            </Button>
          </div>
        )}
      </div>
      <Async state={state}>
        {() => {
          const items = state.items ?? [];
          return items.length ? (
            <>
              <ul className="items items-card">
                {items.map((x) => (
                  <QuestionItem
                    key={x.id}
                    q={x}
                    actions={
                      can('member') && x.status === 'open' ? (
                        <div className="button-row">
                          <Button size="sm" onClick={() => setAnswering(x)}>
                            {t('question.answerIt')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => update(x, { status: 'dropped' })}>
                            {t('question.drop')}
                          </Button>
                        </div>
                      ) : undefined
                    }
                  />
                ))}
              </ul>
              <More state={state} />
            </>
          ) : (
            <EmptyState icon="info" title={t('ledger.noQuestions')} />
          );
        }}
      </Async>
      <Dialog
        open={!!answering}
        onClose={() => setAnswering(null)}
        title={t('question.answerIt')}
        footer={
          <>
            <Button onClick={() => setAnswering(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={!answer.trim()}
              onClick={async () => {
                if (answering && (await update(answering, { status: 'answered', answerText: answer }))) {
                  setAnswering(null);
                  setAnswer('');
                }
              }}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <p className="muted">{answering?.question}</p>
        <TextArea label={t('question.answer')} value={answer} onChange={(e) => setAnswer(e.target.value)} rows={3} />
      </Dialog>
      <ManualAddDialog kind={adding} onClose={() => setAdding(null)} onAdded={state.reload} />
    </>
  );
}

export function LedgerPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as LedgerTab) || 'decisions';
  const setTab = (id: LedgerTab) => {
    params.set('tab', id);
    setParams(params, { replace: true });
  };
  return (
    <>
      <PageHeader title={t('nav.ledger')} subtitle={t('ledger.subtitle')} />
      <Tabs<LedgerTab>
        label={t('nav.ledger')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'decisions', label: t('ledger.decisions') },
          { id: 'actions', label: t('ledger.actions') },
          { id: 'commitments', label: t('ledger.commitments') },
          { id: 'questions', label: t('ledger.questions') },
        ]}
      />
      <TabPanel id={tab}>
        {tab === 'decisions' && <Decisions />}
        {tab === 'actions' && <Actions />}
        {tab === 'commitments' && <Commitments />}
        {tab === 'questions' && <Questions />}
      </TabPanel>
    </>
  );
}
