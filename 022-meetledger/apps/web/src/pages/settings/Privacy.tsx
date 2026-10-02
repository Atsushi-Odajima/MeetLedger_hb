import { useEffect, useState, type ReactNode } from 'react';
import { AI_PROVIDERS, AUDIO_RETENTIONS, EMBEDDING_PROVIDERS, type AiProviderId, type AudioRetention, type EmbeddingProviderId, type TranscriptionMode, type Visibility } from '@meetledger/shared';
import { Alert, Badge, Button, Card, ErrorView, Loading, RadioGroup, SelectField, TextField, Toggle } from '../../components/ui';
import { useI18n, type MsgKey } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useToast } from '../../state/toast';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import type { PolicyDecisionDto, ProcessingDto, WorkspaceSettingsDto } from '../../lib/types';

function Where({ local, children }: { local: boolean; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <span className="where">
      <Badge tone={local ? 'success' : 'warn'} icon={local ? 'shield' : 'globe'}>
        {local ? t('where.local') : t('where.external')}
      </Badge>{' '}
      {children}
    </span>
  );
}

function decisionText(d: PolicyDecisionDto, t: (k: MsgKey, v?: Record<string, string | number>) => string) {
  if (!d.allowed) return t('where.off', { reason: d.reason });
  return d.reason;
}

/** Recursively renders the privacy-preview payload as readable rows (no raw JSON for normal users). */
function PreviewValue({ v }: { v: unknown }): ReactNode {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? '✓' : '—';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v))
    return (
      <ul className="plain-list">
        {v.map((x, i) => (
          <li key={i}>
            <PreviewValue v={x} />
          </li>
        ))}
      </ul>
    );
  return (
    <dl className="kv kv-nested">
      {Object.entries(v as Record<string, unknown>).map(([k, x]) => (
        <div className="kv-row" key={k}>
          <dt>{k}</dt>
          <dd>
            <PreviewValue v={x} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

interface PreviewSummaryShape {
  meetings?: { visible?: number; aiEligible?: number; aiOff?: number; confidential?: number; cloudTranscription?: number };
  notSent?: string[];
  ask?: { fields?: string[]; maxContexts?: number; maxContextChars?: number };
}

function PreviewSummary({ data }: { data: unknown }) {
  const { t } = useI18n();
  const d = (data ?? {}) as PreviewSummaryShape;
  if (!d.meetings && !d.notSent) return null;
  const m = d.meetings ?? {};
  const stats: [MsgKey, number | undefined][] = [
    ['where.stat.visible', m.visible],
    ['where.stat.aiEligible', m.aiEligible],
    ['where.stat.aiOff', m.aiOff],
    ['where.stat.confidential', m.confidential],
    ['where.stat.cloudTranscription', m.cloudTranscription],
  ];
  return (
    <div className="stack where-summary">
      {d.meetings && (
        <div className="stat-grid">
          {stats
            .filter(([, v]) => typeof v === 'number')
            .map(([k, v]) => (
              <div className="stat" key={k}>
                <span className="stat-value">{v}</span>
                <span className="stat-label">{t(k)}</span>
              </div>
            ))}
        </div>
      )}
      {d.ask?.fields && d.ask.fields.length > 0 && (
        <div>
          <h3 className="small-title">{t('where.askFields', { n: d.ask.maxContexts ?? '-', chars: d.ask.maxContextChars ?? '-' })}</h3>
          <ul className="chips">
            {d.ask.fields.map((f) => (
              <li key={f} className="chip">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.notSent && d.notSent.length > 0 && (
        <div>
          <h3 className="small-title">{t('where.notSent')}</h3>
          <ul className="notice-list">
            {d.notSent.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function WherePanel({ processing, settings }: { processing: ProcessingDto; settings: WorkspaceSettingsDto }) {
  const { t } = useI18n();
  const { a } = useWs();
  const preview = useApi<unknown>(a('/ai/privacy-preview'));
  const inst = processing.installation;
  const embedLocal = settings.ai.embeddings !== 'openai' || !settings.ai.cloudAllowed;
  const rows: { data: string; where: ReactNode; note?: string }[] = [
    {
      data: t('where.audio'),
      where: <Where local={processing.transcription.isLocal}>{processing.transcription.allowed ? processing.transcription.provider : t('where.notProcessed')}</Where>,
      note: decisionText(processing.transcription, t),
    },
    {
      data: t('where.aiText'),
      where: <Where local={processing.ai.isLocal}>{processing.ai.allowed ? processing.ai.provider : t('where.notProcessed')}</Where>,
      note: decisionText(processing.ai, t),
    },
    { data: t('where.embeddings'), where: <Where local={embedLocal}>{embedLocal && settings.ai.embeddings === 'openai' ? 'local-hash' : settings.ai.embeddings}</Where>, note: t('where.embeddingsNote') },
    { data: t('where.email'), where: <Where local={inst.emailDriver === 'outbox'}>{inst.emailDriver === 'outbox' ? t('where.emailOutbox') : 'SMTP'}</Where>, note: t('where.emailNote') },
    { data: t('where.storage'), where: <Where local={inst.storageDriver === 'local'}>{inst.storageDriver === 'local' ? t('where.storageLocal') : 'S3'}</Where>, note: t('where.storageNote') },
  ];
  return (
    <Card title={t('where.title')} id="where">
      <p className="field-hint">{t('where.intro')}</p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('where.colData')}</th>
              <th scope="col">{t('where.colWhere')}</th>
              <th scope="col">{t('where.colNote')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.data}>
                <th scope="row">{r.data}</th>
                <td>{r.where}</td>
                <td className="muted">{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="field-hint">{t('where.aiOffNote')}</p>
      <PreviewSummary data={preview.data} />
      <details className="preview-details">
        <summary>{t('where.previewTitle')}</summary>
        {preview.loading && !preview.data ? <Loading /> : preview.error ? <ErrorView error={preview.error} compact /> : <PreviewValue v={preview.data} />}
      </details>
      <p className="field-hint">
        {t('where.installation', { tr: inst.cloudTranscriptionProvider, ai: inst.aiProvider, emb: inst.embeddingProvider })}
      </p>
    </Card>
  );
}

const daysOrNull = (v: string) => (v === '' ? null : Math.max(1, Math.min(36500, Number(v))));

export function PrivacySettings() {
  const { t } = useI18n();
  const toast = useToast();
  const { ws, a, can, reload } = useWs();
  const [s, setS] = useState<WorkspaceSettingsDto | null>(ws?.settings ?? null);
  const [processing, setProcessing] = useState<ProcessingDto | null>(ws?.processing ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (ws) {
      setS(ws.settings);
      setProcessing(ws.processing);
    }
  }, [ws]);
  if (!s || !processing) return <Loading />;
  const admin = can('admin');
  const ro = !admin;
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.patch<{ settings: WorkspaceSettingsDto; processing: ProcessingDto }>(a('/settings'), s);
      setS(r.settings);
      setProcessing(r.processing);
      toast.success(t('common.saved'));
      reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const set = <K extends keyof WorkspaceSettingsDto>(k: K, v: Partial<WorkspaceSettingsDto[K]>) => setS({ ...s, [k]: { ...s[k], ...v } });
  return (
    <div className="stack">
      <WherePanel processing={processing} settings={s} />
      {ro && <Alert tone="info">{t('settings.adminOnly')}</Alert>}
      <Card title={t('privacySettings.defaults')}>
        <div className="stack">
          <RadioGroup<TranscriptionMode>
            legend={t('privacy.transcription')}
            value={s.defaults.transcriptionMode}
            onChange={(v) => set('defaults', { transcriptionMode: v })}
            options={(['local', 'cloud', 'none'] as const).map((m) => ({ value: m, label: t(`transcriptionMode.${m}` as MsgKey), hint: t(`transcriptionMode.${m}.hint` as MsgKey), disabled: ro || (m === 'cloud' && !s.transcription.cloudAllowed) }))}
          />
          <Toggle label={t('privacySettings.aiDefault')} hint={t('privacySettings.aiDefaultHint')} checked={s.defaults.aiEnabled} onChange={(v) => set('defaults', { aiEnabled: v })} disabled={ro} />
          <div className="grid-2">
            <SelectField
              label={t('meeting.visibility')}
              value={s.defaults.visibility}
              disabled={ro}
              onChange={(e) => set('defaults', { visibility: e.target.value as Visibility })}
              options={(['private', 'workspace', 'selected'] as const).map((v) => ({ value: v, label: t(`visibility.${v}` as MsgKey) }))}
            />
            <SelectField
              label={t('privacy.audioRetention')}
              value={s.defaults.audioRetention}
              disabled={ro}
              onChange={(e) => set('defaults', { audioRetention: e.target.value as AudioRetention, audioRetentionDays: e.target.value === 'custom' ? (s.defaults.audioRetentionDays ?? 90) : null })}
              options={AUDIO_RETENTIONS.map((r) => ({ value: r, label: t(`audioRetention.${r}` as MsgKey) }))}
            />
          </div>
          {s.defaults.audioRetention === 'custom' && (
            <TextField label={t('privacy.audioRetentionDays')} type="number" min={1} max={3650} disabled={ro} value={s.defaults.audioRetentionDays ?? ''} onChange={(e) => set('defaults', { audioRetentionDays: daysOrNull(e.target.value) })} />
          )}
        </div>
      </Card>
      <Card title={t('privacySettings.cloud')}>
        <div className="stack">
          <Alert tone="info">{t('privacySettings.cloudIntro')}</Alert>
          <Toggle
            label={t('privacySettings.cloudTranscription')}
            hint={processing.installation.cloudTranscriptionProvider === 'none' ? t('privacySettings.noCloudProvider') : t('privacySettings.cloudTranscriptionHint', { provider: processing.installation.cloudTranscriptionProvider })}
            checked={s.transcription.cloudAllowed}
            onChange={(v) => set('transcription', { cloudAllowed: v })}
            disabled={ro}
          />
          <SelectField
            label={t('privacySettings.language')}
            value={s.transcription.language}
            disabled={ro}
            onChange={(e) => set('transcription', { language: e.target.value as 'ja' | 'en' | 'auto' })}
            options={[
              { value: 'auto', label: t('language.auto') },
              { value: 'ja', label: t('language.ja') },
              { value: 'en', label: t('language.en') },
            ]}
          />
          <SelectField
            label={t('privacySettings.aiProvider')}
            value={s.ai.provider}
            disabled={ro}
            hint={t('privacySettings.aiProviderHint', { installed: processing.installation.aiProvider })}
            onChange={(e) => set('ai', { provider: e.target.value as AiProviderId })}
            options={AI_PROVIDERS.map((x) => ({ value: x, label: t(`aiProvider.${x}` as MsgKey) }))}
          />
          <Toggle label={t('privacySettings.cloudAi')} hint={t('privacySettings.cloudAiHint')} checked={s.ai.cloudAllowed} onChange={(v) => set('ai', { cloudAllowed: v })} disabled={ro} />
          <SelectField
            label={t('privacySettings.embeddings')}
            value={s.ai.embeddings}
            disabled={ro}
            onChange={(e) => set('ai', { embeddings: e.target.value as EmbeddingProviderId })}
            options={EMBEDDING_PROVIDERS.map((x) => ({ value: x, label: t(`embeddingProvider.${x}` as MsgKey) }))}
          />
        </div>
      </Card>
      <Card title={t('privacySettings.retention')}>
        <p className="field-hint">{t('privacySettings.retentionHint')}</p>
        <div className="grid-3">
          <TextField label={t('privacySettings.transcriptDays')} type="number" min={1} disabled={ro} value={s.retention.transcriptDays ?? ''} placeholder={t('privacySettings.forever')} onChange={(e) => set('retention', { transcriptDays: daysOrNull(e.target.value) })} />
          <TextField label={t('privacySettings.aiIndexDays')} type="number" min={1} disabled={ro} value={s.retention.aiIndexDays ?? ''} placeholder={t('privacySettings.forever')} onChange={(e) => set('retention', { aiIndexDays: daysOrNull(e.target.value) })} />
          <TextField label={t('privacySettings.artifactDays')} type="number" min={1} disabled={ro} value={s.retention.artifactDays ?? ''} placeholder={t('privacySettings.forever')} onChange={(e) => set('retention', { artifactDays: daysOrNull(e.target.value) })} />
        </div>
      </Card>
      {admin && (
        <div className="form-actions">
          <Button variant="primary" onClick={save} loading={busy}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </div>
  );
}
