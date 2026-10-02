import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ActionDto, CommitmentDto, ContradictionDto, DecisionDto, QuestionDto } from '@meetledger/shared';
import { Alert, Async, Badge, Button, Card } from '../../components/ui';
import { ManualAddDialog, type ManualKind } from '../../components/ManualAdd';
import { ActionItem, CommitmentItem, DecisionItem, QuestionItem } from '../../components/ledger';
import { useI18n } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useApi } from '../../lib/hooks';
import type { LedgerBundle } from '../../lib/types';
import { useMeeting } from './context';

export function MeetingLedgerTab() {
  const { t } = useI18n();
  const { p } = useWs();
  const { meeting, ma } = useMeeting();
  const state = useApi<LedgerBundle>(ma('/ledger'));
  const [adding, setAdding] = useState<ManualKind | null>(null);
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
                actions={
                  meeting.canEdit && (
                    <Button size="sm" icon="plus" onClick={() => setAdding('decision')}>
                      {t('ledger.addBtn.decision')}
                    </Button>
                  )
                }
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
                actions={
                  meeting.canEdit && (
                    <Button size="sm" icon="plus" onClick={() => setAdding('action')}>
                      {t('ledger.addBtn.action')}
                    </Button>
                  )
                }
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
                actions={
                  meeting.canEdit && (
                    <Button size="sm" icon="plus" onClick={() => setAdding('commitment')}>
                      {t('ledger.addBtn.commitment')}
                    </Button>
                  )
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
                actions={
                  meeting.canEdit && (
                    <Button size="sm" icon="plus" onClick={() => setAdding('question')}>
                      {t('ledger.addBtn.question')}
                    </Button>
                  )
                }
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
      <ManualAddDialog kind={adding} meeting={meeting} onClose={() => setAdding(null)} onAdded={state.reload} />
    </>
  );
}
