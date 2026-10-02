import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FOLLOWUP_KINDS, findBuiltinTemplate, type FollowupKind } from '@meetledger/shared';
import { AiBadge, Alert, Async, Badge, Button, Card, EmptyState, SelectField, TextArea, TextField } from '../../components/ui';
import { useI18n, type MsgKey } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useToast } from '../../state/toast';
import { api, ApiError, listOf } from '../../lib/api';
import { copyText, useApi } from '../../lib/hooks';
import type { ConnectorDto, FollowupListItem } from '../../lib/types';
import { useMeeting } from './context';

type Channel = 'email' | 'slack' | 'chat' | 'other';

/** Requests an external send (Slack / webhook / CRM). Nothing is sent until approved on the approval page. */
function ExternalSend({ d }: { d: FollowupListItem }) {
  const { t, tm } = useI18n();
  const toast = useToast();
  const { a, p } = useWs();
  const navigate = useNavigate();
  const { meeting } = useMeeting();
  const connectors = useApi<unknown>(a('/connectors'));
  const writable = listOf<ConnectorDto>(connectors.data, 'connectors').filter((c) => c.kind === 'write' && c.status === 'active');
  const [connectorId, setConnectorId] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  if (!writable.length) return <p className="field-hint">{t('followup.noDestinations')} <Link to={p('/settings/connectors')}>{t('settings.connectors')}</Link></p>;
  const selected = writable.find((c) => c.id === connectorId) ?? writable[0];
  const request = async (acknowledgeConfidential = false) => {
    setBusy(true);
    try {
      await api.post(a('/external-writes'), {
        connectorId: selected.id,
        followupId: d.id,
        meetingId: meeting.id,
        to: to.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean).slice(0, 20),
        acknowledgeConfidential,
      });
      toast.success(t('followup.sendRequested'));
      navigate(p('/settings/approvals'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.details as { code?: string } | undefined)?.code === 'confidential_ack_required') {
        if (window.confirm(t('followup.confidentialConfirm'))) await request(true);
      } else toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inline-form">
      <SelectField
        label={t('followup.destination')}
        value={selected.id}
        onChange={(e) => setConnectorId(e.target.value)}
        options={writable.map((c) => ({ value: c.id, label: `${c.displayName ?? c.name ?? c.provider} (${tm(`connectorProvider.${c.provider}`, c.provider)})` }))}
      />
      {selected.provider !== 'slack' && selected.provider !== 'webhook' && <TextField label={t('followup.recipients')} value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" />}
      <Button icon="send" onClick={() => request()} loading={busy}>
        {t('followup.requestSend')}
      </Button>
    </div>
  );
}

function Draft({ d, onChange }: { d: FollowupListItem; onChange(): void }) {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const { a, p } = useWs();
  const { meeting } = useMeeting();
  const [subject, setSubject] = useState(d.subject ?? '');
  const [body, setBody] = useState(d.body);
  const [busy, setBusy] = useState<string | null>(null);
  const [stale, setStale] = useState<{ type: string; id: string }[] | null>(null);
  const [conflict, setConflict] = useState(false);
  const [channel, setChannel] = useState<Channel>('email');
  useEffect(() => {
    setSubject(d.subject ?? '');
    setBody(d.body);
    setConflict(false);
  }, [d]);
  const dirty = subject !== (d.subject ?? '') || body !== d.body;
  const editable = meeting.canEdit && (d.status === 'draft' || d.status === 'approved');
  const run = async (name: string, fn: () => Promise<unknown>, okMsg: MsgKey) => {
    setBusy(name);
    try {
      await fn();
      toast.success(t(okMsg));
      setStale(null);
      onChange();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const det = (e.details ?? {}) as { code?: string; staleItems?: { type: string; id: string }[] };
        if (det.code === 'stale_items') setStale(det.staleItems ?? []);
        else setConflict(true);
      } else toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const text = subject ? `${subject}\n\n${body}` : body;
  const warnings = (d.warnings ?? []).map((w) => (typeof w === 'string' ? w : (w.message ?? w.code ?? ''))).filter(Boolean);
  return (
    <Card
      title={t(`followupKind.${d.kind}` as MsgKey)}
      actions={
        <div className="badges">
          {d.generatedBy === 'ai' ? <AiBadge /> : <Badge>{t('followup.template')}</Badge>}
          {d.edited && <Badge>{t('followup.edited')}</Badge>}
          <Badge tone={d.status === 'approved' ? 'success' : d.status === 'sent' ? 'info' : 'neutral'}>{t(`followupStatus.${d.status}` as MsgKey)}</Badge>
        </div>
      }
      footer={<span className="muted">{fmt.dateTime(d.createdAt)}</span>}
    >
      <div className="stack">
        {warnings.length > 0 && (
          <Alert tone="warn" title={t('followup.warnings')}>
            <ul className="notice-list">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Alert>
        )}
        {conflict && (
          <Alert tone="warn" title={t('meetingSettings.conflict')}>
            <p>{t('followup.conflict')}</p>
            <Button size="sm" onClick={onChange}>
              {t('common.reload')}
            </Button>
          </Alert>
        )}
        <TextField label={t('followup.subject')} value={subject} onChange={(e) => setSubject(e.target.value)} readOnly={!editable} />
        <TextArea label={t('followup.body')} value={body} onChange={(e) => setBody(e.target.value)} rows={10} readOnly={!editable} />
        {d.status === 'approved' && dirty && <p className="field-hint">{t('followup.editResetsApproval')}</p>}
        {stale && (
          <Alert tone="warn" title={t('followup.staleTitle')}>
            <p>{t('followup.staleBody', { n: stale.length })}</p>
            <Button size="sm" onClick={() => run('approve', () => api.post(a(`/followups/${d.id}/approve`), { version: d.version, acknowledgeStale: true }), 'followup.approved')}>
              {t('followup.approveAnyway')}
            </Button>
          </Alert>
        )}
        <div className="button-row">
          {editable && dirty && (
            <Button variant="primary" loading={busy === 'save'} onClick={() => run('save', () => api.patch(a(`/followups/${d.id}`), { subject: subject || null, body, version: d.version ?? 0 }), 'common.saved')}>
              {t('common.save')}
            </Button>
          )}
          {editable && !dirty && d.status === 'draft' && (
            <Button variant="primary" icon="check" loading={busy === 'approve'} onClick={() => run('approve', () => api.post(a(`/followups/${d.id}/approve`), { version: d.version }), 'followup.approved')}>
              {t('followup.approve')}
            </Button>
          )}
          <Button icon="copy" onClick={() => copyText(text).then((ok) => (ok ? toast.success(t('common.copied')) : toast.error(t('common.copyFailed'))))}>
            {t('followup.copy')}
          </Button>
          {meeting.canEdit && d.status !== 'sent' && d.status !== 'discarded' && (
            <Button variant="ghost" icon="trash" loading={busy === 'discard'} onClick={() => run('discard', () => api.post(a(`/followups/${d.id}/discard`)), 'followup.discarded')}>
              {t('followup.discard')}
            </Button>
          )}
        </div>
        {meeting.canEdit && d.status === 'approved' && !dirty && (
          <div className="inline-form">
            <SelectField
              label={t('followup.sentVia')}
              value={channel}
              onChange={(e) => setChannel(e.target.value as Channel)}
              options={(['email', 'slack', 'chat', 'other'] as const).map((c) => ({ value: c, label: t(`followup.channel.${c}` as MsgKey) }))}
            />
            <Button icon="send" loading={busy === 'sent'} onClick={() => run('sent', () => api.post(a(`/followups/${d.id}/mark-sent`), { channel }), 'followup.markedSent')}>
              {t('followup.markSent')}
            </Button>
          </div>
        )}
        {d.status === 'approved' && meeting.canEdit && (
          <>
            <ExternalSend d={d} />
            <p className="field-hint">
              {t('followup.externalNote')} <Link to={p('/settings/approvals')}>{t('settings.approvals')}</Link>
            </p>
          </>
        )}
        {d.status === 'sent' && d.sentAt && <p className="field-hint">{t('followup.sentAt', { time: fmt.dateTime(d.sentAt) })}</p>}
      </div>
    </Card>
  );
}

export function FollowupTab() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const { meeting, ma } = useMeeting();
  const state = useApi<unknown>(ma('/followups'));
  const tpl = findBuiltinTemplate(meeting.templateKey);
  const [kind, setKind] = useState<FollowupKind>(tpl?.followupStyle.defaultKinds[0] ?? 'internal_recap');
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true);
    try {
      await api.post(ma('/followups'), { kind, locale: lang });
      toast.success(t('followup.generated'));
      state.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <Alert tone="info">{t('followup.intro')}</Alert>
      {meeting.canEdit && (
        <div className="inline-form">
          <SelectField
            label={t('followup.kind')}
            value={kind}
            onChange={(e) => setKind(e.target.value as FollowupKind)}
            options={FOLLOWUP_KINDS.map((k) => ({ value: k, label: t(`followupKind.${k}` as MsgKey) }))}
          />
          <Button variant="primary" icon="sparkle" onClick={generate} loading={busy}>
            {t('followup.generate')}
          </Button>
        </div>
      )}
      <Async state={state}>
        {(data) => {
          const drafts = listOf<FollowupListItem>(data, 'followups', 'drafts').filter((d) => d.status !== 'discarded');
          return drafts.length ? (
            <div className="stack">
              {drafts.map((d) => (
                <Draft key={d.id} d={d} onChange={state.reload} />
              ))}
            </div>
          ) : (
            <EmptyState icon="mail" title={t('followup.empty')} body={t('followup.emptyBody')} />
          );
        }}
      </Async>
    </div>
  );
}
