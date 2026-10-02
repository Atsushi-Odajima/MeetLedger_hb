import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { ActionDto, CommitmentDto, ContradictionDto, DecisionDto, QuestionDto } from '@meetledger/shared';
import { Alert, Async, Badge, Button, Card, Dialog, SelectField, TextField } from '../../components/ui';
import { ActionItem, CommitmentItem, DecisionItem, QuestionItem, usePeople } from '../../components/ledger';
import { useI18n } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useToast } from '../../state/toast';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import type { LedgerBundle } from '../../lib/types';
import { useMeeting } from './context';

type AddKind = 'decision' | 'action' | 'question';

function AddDialog({ kind, onClose, onAdded }: { kind: AddKind | null; onClose(): void; onAdded(): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { a } = useWs();
  const { meeting } = useMeeting();
  const { people } = usePeople();
  const [text, setText] = useState('');
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  if (!kind) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (kind === 'decision') await api.post(a('/decisions'), { text, meetingId: meeting.id, projectId: meeting.projectId });
      else if (kind === 'action')
        await api.post(a('/actions'), { description: text, meetingId: meeting.id, projectId: meeting.projectId, assigneePersonId: assignee || null, dueDate: due || null });
      else await api.post(a('/questions'), { question: text, meetingId: meeting.id, projectId: meeting.projectId });
      toast.success(t('ledger.added'));
      setText('');
      setAssignee('');
      setDue('');
      onAdded();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={t(`ledger.add.${kind}`)}>
      <form className="stack" onSubmit={submit}>
        <TextField label={t(`ledger.field.${kind}`)} value={text} onChange={(e) => setText(e.target.value)} required maxLength={2000} />
        {kind === 'action' && (
          <div className="grid-2">
            <SelectField
              label={t('action.assignee')}
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              options={[{ value: '', label: t('action.noAssignee') }, ...people.map((p) => ({ value: p.id, label: p.name }))]}
            />
            <TextField label={t('action.due')} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </div>
        )}
        <p className="field-hint">{t('ledger.manualNote')}</p>
        <div className="form-actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!text.trim()}>
            {t('common.add')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function MeetingLedgerTab() {
  const { t } = useI18n();
  const { p } = useWs();
  const { meeting, ma } = useMeeting();
  const state = useApi<LedgerBundle>(ma('/ledger'));
  const [adding, setAdding] = useState<AddKind | null>(null);
  return (
    <>
      <Async state={state}>
        {(l) => {
          const decisions = (l.decisions ?? []) as DecisionDto[];
          const actions = (l.actions ?? []) as ActionDto[];
          const commitments = (l.commitments ?? []) as CommitmentDto[];
          const questions = (l.questions ?? []) as QuestionDto[];
          const contradictions = ((l.contradictions ?? []) as ContradictionDto[]).filter((c) => c.status === 'open');
          const candidates =
            decisions.filter((d) => d.reviewState === 'candidate').length +
            actions.filter((x) => x.status === 'candidate').length +
            commitments.filter((x) => x.status === 'candidate').length +
            questions.filter((x) => x.status === 'candidate').length;
          return (
            <div className="stack">
              {(candidates > 0 || contradictions.length > 0) && (
                <Alert tone="info" title={t('ledger.candidatesWaiting', { n: candidates + contradictions.length })}>
                  <p>{t('ledger.candidatesHint')}</p>
                  <Link className="btn btn-sm btn-primary" to={p(`/review?meetingId=${meeting.id}`)}>
                    {t('review.goReview')}
                  </Link>
                </Alert>
              )}
              <Card
                title={
                  <>
                    {t('ledger.decisions')} <Badge>{decisions.length}</Badge>
                  </>
                }
                actions={meeting.canEdit && <Button size="sm" icon="plus" onClick={() => setAdding('decision')}>{t('common.add')}</Button>}
              >
                {decisions.length ? (
                  <ul className="items">
                    {decisions.map((d) => (
                      <DecisionItem key={d.id} decision={d} />
                    ))}
                  </ul>
                ) : (
                  <p className="muted calm">{t('ledger.noDecisions')}</p>
                )}
              </Card>
              <Card
                title={
                  <>
                    {t('ledger.actions')} <Badge>{actions.length}</Badge>
                  </>
                }
                actions={meeting.canEdit && <Button size="sm" icon="plus" onClick={() => setAdding('action')}>{t('common.add')}</Button>}
              >
                {actions.length ? (
                  <ul className="items">
                    {actions.map((x) => (
                      <ActionItem key={x.id} action={x} />
                    ))}
                  </ul>
                ) : (
                  <p className="muted calm">{t('ledger.noActions')}</p>
                )}
              </Card>
              <Card
                title={
                  <>
                    {t('ledger.commitments')} <Badge>{commitments.length}</Badge>
                  </>
                }
              >
                {commitments.length ? (
                  <ul className="items">
                    {commitments.map((x) => (
                      <CommitmentItem key={x.id} c={x} />
                    ))}
                  </ul>
                ) : (
                  <p className="muted calm">{t('ledger.noCommitments')}</p>
                )}
              </Card>
              <Card
                title={
                  <>
                    {t('ledger.questions')} <Badge>{questions.length}</Badge>
                  </>
                }
                actions={meeting.canEdit && <Button size="sm" icon="plus" onClick={() => setAdding('question')}>{t('common.add')}</Button>}
              >
                {questions.length ? (
                  <ul className="items">
                    {questions.map((x) => (
                      <QuestionItem key={x.id} q={x} />
                    ))}
                  </ul>
                ) : (
                  <p className="muted calm">{t('ledger.noQuestions')}</p>
                )}
              </Card>
            </div>
          );
        }}
      </Async>
      <AddDialog kind={adding} onClose={() => setAdding(null)} onAdded={state.reload} />
    </>
  );
}
