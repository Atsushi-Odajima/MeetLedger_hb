import { useState } from 'react';
import { Alert, Async, Badge, Button, Card, EmptyState, Tabs } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useToast } from '../../state/toast';
import { api, listOf } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import type { ExternalWriteDto } from '../../lib/types';

interface PreviewShape {
  subject?: string | null;
  text?: string;
  payload?: unknown;
  warnings?: string[];
  connectorName?: string | null;
}

function Payload({ v }: { v: unknown }) {
  const { t, tm } = useI18n();
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return <pre className="payload">{v}</pre>;
  const p = v as PreviewShape;
  if (typeof p.text === 'string' || p.subject) {
    return (
      <div className="stack">
        {p.warnings && p.warnings.length > 0 && (
          <Alert tone="warn">
            <ul className="notice-list">
              {p.warnings.map((w) => (
                <li key={w}>{tm(`writeWarning.${w}`, w)}</li>
              ))}
            </ul>
          </Alert>
        )}
        {p.subject && (
          <p>
            <strong>{t('followup.subject')}:</strong> {p.subject}
          </p>
        )}
        <pre className="payload payload-text">{p.text}</pre>
        {p.payload !== undefined && (
          <details className="preview-details">
            <summary>{t('approvals.rawPayload')}</summary>
            <pre className="payload">{JSON.stringify(p.payload, null, 2)}</pre>
          </details>
        )}
      </div>
    );
  }
  return <pre className="payload">{JSON.stringify(v, null, 2)}</pre>;
}

/** Every write to an external system (Slack, email, CRM, calendar…) is previewed here and needs explicit approval. */
export function ApprovalsSettings() {
  const { t, fmt, tm } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const [tab, setTab] = useState<'pending' | 'all'>('pending');
  const state = useApi<unknown>(a('/external-writes'));
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (w: ExternalWriteDto, action: 'approve' | 'reject') => {
    setBusy(`${w.id}:${action}`);
    try {
      await api.post(a(`/external-writes/${w.id}/${action}`));
      toast.success(action === 'approve' ? t('approvals.approved') : t('approvals.rejected'));
      state.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="stack">
      <Alert tone="info" title={t('approvals.title')}>
        {t('approvals.intro')}
      </Alert>
      <Tabs<'pending' | 'all'>
        label={t('settings.approvals')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'pending', label: t('approvals.pending') },
          { id: 'all', label: t('common.all') },
        ]}
      />
      <Async state={state}>
        {(d) => {
          const items = listOf<ExternalWriteDto>(d, 'externalWrites', 'writes').filter((w) => tab === 'all' || w.status === 'pending' || w.status === 'pending_approval');
          return items.length ? (
            <div className="stack">
              {items.map((w) => (
                <Card
                  key={w.id}
                  title={w.summary ?? `${(w.preview as PreviewShape | undefined)?.connectorName ?? tm(`connectorProvider.${w.provider ?? ''}`, w.provider ?? '')}${w.target ? ` → ${w.target}` : ''}`}
                  actions={<Badge tone={w.status === 'approved' || w.status === 'done' ? 'success' : w.status === 'rejected' ? 'neutral' : 'warn'}>{tm(`writeStatus.${w.status}`, w.status)}</Badge>}
                  footer={
                    w.createdAt ? (
                      <span className="muted">
                        {fmt.dateTime(w.createdAt)}
                        {w.executedAt && ` · ${t('approvals.executedAt', { time: fmt.dateTime(w.executedAt) })}`}
                      </span>
                    ) : undefined
                  }
                >
                  <p className="small-title">{t('approvals.preview')}</p>
                  <Payload v={w.preview ?? w.payload} />
                  {can('member') && (w.status === 'pending' || w.status === 'pending_approval') && (
                    <div className="button-row">
                      <Button variant="primary" icon="send" onClick={() => act(w, 'approve')} loading={busy === `${w.id}:approve`}>
                        {t('approvals.approve')}
                      </Button>
                      <Button variant="ghost" onClick={() => act(w, 'reject')} loading={busy === `${w.id}:reject`}>
                        {t('approvals.reject')}
                      </Button>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState icon="check" title={t('approvals.empty')} />
          );
        }}
      </Async>
    </div>
  );
}
