import { useState } from 'react';
import type { SummaryDto } from '@meetledger/shared';
import { AiBadge, Alert, Async, Badge, Button, Card, EmptyState } from '../../components/ui';
import { SourceLink } from '../../components/ledger';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useMeeting } from './context';

export function SummaryTab() {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const { meeting, ma } = useMeeting();
  const state = useApi<SummaryDto | null>(ma('/summary'));
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await api.post(ma('/extract'), { rerun: true });
      toast.success(t('processing.queued'));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Async state={state}>
      {(s) =>
        !s ? (
          <EmptyState
            icon="sparkle"
            title={t('summary.empty')}
            body={meeting.aiEnabled ? t('summary.emptyBody') : t('privacy.aiOff.hint')}
            action={
              meeting.aiEnabled && meeting.canEdit ? (
                <Button icon="sparkle" onClick={run} loading={busy}>
                  {t('processing.extract')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="stack">
            <Card
              title={t('summary.executive')}
              actions={
                <div className="badges">
                  <AiBadge />
                  <Badge>{s.model ? `${s.provider} · ${s.model}` : s.provider}</Badge>
                </div>
              }
            >
              <p className="summary-text">{s.sections.executive}</p>
              <p className="field-hint">
                {t('summary.generatedAt', { time: fmt.dateTime(s.createdAt), v: s.version })} · {t('summary.verify')}
              </p>
            </Card>
            {s.sections.topics?.length > 0 && (
              <Card title={t('summary.topics')}>
                <ul className="items">
                  {s.sections.topics.map((tp, i) => (
                    <li key={i} className="item">
                      <div className="item-main">
                        <span className="item-title">{tp.title}</span>
                        <SourceLink source={tp.source} compact />
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {s.sections.risks?.length > 0 && (
              <Card title={t('summary.risks')}>
                <ul className="items">
                  {s.sections.risks.map((r, i) => (
                    <li key={i} className="item">
                      <div className="item-main">
                        <span>{r.text}</span>
                        <SourceLink source={r.source} compact />
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {s.sections.nextMeeting && (
              <Card title={t('summary.nextMeeting')}>
                <p>{s.sections.nextMeeting}</p>
              </Card>
            )}
            <Alert tone="info">{t('summary.ledgerNote')}</Alert>
            {meeting.canEdit && meeting.aiEnabled && (
              <Button icon="sync" onClick={run} loading={busy}>
                {t('summary.regenerate')}
              </Button>
            )}
          </div>
        )
      }
    </Async>
  );
}
