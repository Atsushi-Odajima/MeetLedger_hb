import { useEffect, useRef, useState } from 'react';
import { Alert, Async, Badge, Button, Card, Checkbox, EmptyState, ProgressBar } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useI18n } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useToast } from '../../state/toast';
import { api, listOf } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { uploadWithProgress } from '../../lib/upload';
import type { DeletionRequestDto } from '../../lib/types';

function FullExport() {
  const { t, tm } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const [includeMedia, setIncludeMedia] = useState(false);
  const [job, setJob] = useState<{ jobId: string; status: string; url?: string | null } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);
  const start = async () => {
    try {
      const r = await api.post<{ jobId: string }>(a('/export/full'), { includeMedia });
      setJob({ jobId: r.jobId, status: 'queued' });
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(async () => {
        try {
          const s = await api.get<{ status: string; url?: string | null }>(a(`/export/full/${r.jobId}`));
          setJob({ jobId: r.jobId, ...s });
          if (s.url || ['ready', 'failed', 'expired', 'done', 'completed'].includes(s.status)) {
            if (timer.current) clearInterval(timer.current);
          }
        } catch {
          /* keep polling */
        }
      }, 3000);
    } catch (e) {
      toast.error(e);
    }
  };
  if (!can('admin')) return null;
  return (
    <Card title={t('data.fullExport')}>
      <p className="field-hint">{t('data.fullExportHint')}</p>
      <Checkbox label={t('data.includeMedia')} hint={t('data.includeMediaHint')} checked={includeMedia} onChange={(e) => setIncludeMedia(e.target.checked)} />
      <Button icon="download" onClick={start} disabled={!!job && !job.url && !['failed', 'expired'].includes(job.status)}>
        {t('data.startExport')}
      </Button>
      {job && (
        <p aria-live="polite">
          {t('data.exportStatus')}: <Badge tone={job.status === 'ready' ? 'success' : job.status === 'failed' ? 'danger' : 'info'}>{tm(`exportStatus.${job.status}`, job.status)}</Badge>{' '}
          {job.url && (
            <a href={job.url} className="btn btn-sm btn-primary" download>
              <Icon name="download" size={16} />
              <span>{t('common.download')}</span>
            </a>
          )}
        </p>
      )}
    </Card>
  );
}

function FullImport() {
  const { t } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  if (!can('admin')) return null;
  const run = async () => {
    if (!file) return;
    setProgress(0);
    try {
      await uploadWithProgress(a('/import/full'), file, file.name, (l, total) => setProgress(total ? l / total : 0)).promise;
      toast.success(t('data.importDone'));
      setFile(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setProgress(null);
    }
  };
  return (
    <Card title={t('data.fullImport')}>
      <Alert tone="warn">{t('data.fullImportHint')}</Alert>
      <div className="field">
        <label htmlFor="import-file" className="field-label">
          {t('data.importFile')}
        </label>
        <input id="import-file" type="file" className="input" accept=".json,.zip,.tar,.gz,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <Checkbox label={t('data.importConfirm')} checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
      <Button onClick={run} disabled={!file || !confirm || progress !== null} icon="upload">
        {t('data.startImport')}
      </Button>
      {progress !== null && <ProgressBar value={progress * 100} label={t('upload.progressLabel')} />}
    </Card>
  );
}

function DeletionRequests() {
  const { t, fmt, tm } = useI18n();
  const { a } = useWs();
  const state = useApi<unknown>(a('/deletion-requests'));
  return (
    <Card title={t('data.deletions')}>
      <p className="field-hint">{t('data.deletionsHint')}</p>
      <Async state={state}>
        {(d) => {
          const items = listOf<DeletionRequestDto>(d, 'deletionRequests', 'requests');
          return items.length ? (
            <ul className="items">
              {items.map((x) => (
                <li key={x.id} className="item">
                  <div className="item-main">
                    <span className="item-title">
                      {tm(`deletionScope.${x.scope ?? x.kind ?? ''}`, x.scope ?? x.kind ?? x.entityType ?? '')}
                      {x.targetLabel && <span className="muted"> — {x.targetLabel}</span>}
                    </span>
                    <span className="item-meta">
                      <Badge tone={x.status === 'done' || x.status === 'completed' ? 'success' : 'neutral'}>{tm(`deletionStatus.${x.status}`, x.status)}</Badge>
                      {x.createdAt && <span>{fmt.dateTime(x.createdAt)}</span>}
                      {x.completedAt && <span>→ {fmt.dateTime(x.completedAt)}</span>}
                      {x.trigger && <span>{tm(`deletionTrigger.${x.trigger}`, x.trigger)}</span>}
                      {x.requestedBy?.name && <span>{x.requestedBy.name}</span>}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="trash" title={t('data.noDeletions')} />
          );
        }}
      </Async>
    </Card>
  );
}

export function DataSettings() {
  const { t } = useI18n();
  const { a } = useWs();
  const links: { href: string; label: string }[] = [
    { href: a('/decisions/export?format=csv'), label: t('data.decisionsCsv') },
    { href: a('/decisions/export?format=json'), label: t('data.decisionsJson') },
    { href: a('/actions/export?format=csv'), label: t('data.actionsCsv') },
    { href: a('/commitments/export?format=csv'), label: t('data.commitmentsCsv') },
  ];
  return (
    <div className="stack">
      <Card title={t('data.exports')}>
        <p className="field-hint">{t('data.exportsHint')}</p>
        <ul className="export-list">
          {links.map((l) => (
            <li key={l.href}>
              <a className="btn btn-secondary btn-md" href={l.href} download>
                <Icon name="download" />
                <span>{l.label}</span>
              </a>
            </li>
          ))}
        </ul>
      </Card>
      <FullExport />
      <FullImport />
      <DeletionRequests />
    </div>
  );
}
