import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ACTION_STATUSES, COMMITMENT_STATUSES, QUESTION_STATUSES, type ActionDto, type CommitmentDto, type DecisionDto, type QuestionDto } from '@meetledger/shared';
import { Async, Button, Checkbox, Dialog, EmptyState, PageHeader, SelectField, TabPanel, Tabs, TextArea } from '../components/ui';
import { Icon } from '../components/Icon';
import { ActionItem, CommitmentItem, DecisionItem, QuestionItem } from '../components/ledger';
import { useI18n, type MsgKey } from '../i18n';
import { useWs } from '../state/workspace';
import { useToast } from '../state/toast';
import { api, listOf, qs } from '../lib/api';
import { useApi } from '../lib/hooks';

type LedgerTab = 'decisions' | 'actions' | 'commitments' | 'questions';

function ExportLink({ href, label }: { href: string; label: string }) {
  return (
    <a className="btn btn-sm btn-ghost" href={href} download>
      <Icon name="download" size={16} />
      <span>{label}</span>
    </a>
  );
}

function Decisions() {
  const { t } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const [view, setView] = useState<'current' | 'all' | 'candidates' | 'superseded'>('current');
  const state = useApi<unknown>(a(`/decisions${qs({ view })}`));
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
        {(d) => {
          const items = listOf<DecisionDto>(d, 'decisions');
          return items.length ? (
            <ul className="items items-card">
              {items.map((x) => (
                <DecisionItem
                  key={x.id}
                  decision={x}
                  actions={
                    can('member') && x.status === 'active' && x.reviewState === 'confirmed' ? (
                      <Button size="sm" icon="edit" onClick={() => setSupersede(x)}>
                        {t('decision.supersede')}
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </ul>
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
  const [overdue, setOverdue] = useState(false);
  const state = useApi<unknown>(a(`/actions${qs({ status, assignee: mine ? 'me' : undefined, overdue: overdue ? 1 : undefined })}`));
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
        {(d) => {
          const items = listOf<ActionDto>(d, 'actions');
          return items.length ? (
            <ul className="items items-card">
              {items.map((x) => (
                <ActionItem key={x.id} action={x} />
              ))}
            </ul>
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
  const [direction, setDirection] = useState<'all' | 'mine' | 'theirs'>('all');
  const [status, setStatus] = useState('open');
  const state = useApi<unknown>(a(`/commitments${qs({ direction, status })}`));
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
        <div className="filters-end">
          <ExportLink href={a('/commitments/export?format=csv')} label="CSV" />
        </div>
      </div>
      <Async state={state}>
        {(d) => {
          const items = listOf<CommitmentDto>(d, 'commitments');
          return items.length ? (
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
          ) : (
            <EmptyState icon="users" title={t('ledger.noCommitments')} />
          );
        }}
      </Async>
    </>
  );
}

function Questions() {
  const { t } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const [status, setStatus] = useState('open');
  const state = useApi<unknown>(a(`/questions${qs({ status })}`));
  const [answering, setAnswering] = useState<QuestionDto | null>(null);
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
      </div>
      <Async state={state}>
        {(d) => {
          const items = listOf<QuestionDto>(d, 'questions');
          return items.length ? (
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
