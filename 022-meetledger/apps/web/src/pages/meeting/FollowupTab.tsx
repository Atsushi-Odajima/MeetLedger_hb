import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FOLLOWUP_KINDS, findBuiltinTemplate, type FollowupKind } from '@meetledger/shared';
import { AiBadge, Alert, Async, Badge, Button, Card, EmptyState, SelectField, TextArea, TextField } from '../../components/ui';
import { useI18n, type MsgKey } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useToast } from '../../state/toast';
import { api, listOf } from '../../lib/api';
import { copyText, useApi } from '../../lib/hooks';
import type { FollowupListItem } from '../../lib/types';
import { useMeeting } from './context';

function Draft({ d, onChange }: { d: FollowupListItem; onChange(): void }) {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const { a, p } = useWs();
  const { meeting } = useMeeting();
  const [subject, setSubject] = useState(d.subject ?? '');
  const [body, setBody] = useState(d.body);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    setSubject(d.subject ?? '');
    setBody(d.body);
  }, [d]);
  const dirty = subject !== (d.subject ?? '') || body !== d.body;
  const editable = meeting.canEdit && d.status === 'draft';
  const act = async (name: string, fn: () => Promise<unknown>, okMsg: MsgKey) => {
    setBusy(name);
    try {
      await fn();
      toast.success(t(okMsg));
      onChange();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const text = subject ? `${subject}\n\n${body}` : body;
  return (
    <Card
      title={t(`followupKind.${d.kind}` as MsgKey)}
      actions={
        <div className="badges">
          {d.generatedBy === 'ai' ? <AiBadge /> : <Badge>{t('followup.template')}</Badge>}
          <Badge tone={d.status === 'approved' ? 'success' : d.status === 'sent' ? 'info' : 'neutral'}>{t(`followupStatus.${d.status}` as MsgKey)}</Badge>
        </div>
      }
      footer={<span className="muted">{fmt.dateTime(d.createdAt)}</span>}
    >
      <div className="stack">
        <TextField label={t('followup.subject')} value={subject} onChange={(e) => setSubject(e.target.value)} readOnly={!editable} />
        <TextArea label={t('followup.body')} value={body} onChange={(e) => setBody(e.target.value)} rows={10} readOnly={!editable} />
        <div className="button-row">
          {editable && dirty && (
            <Button variant="primary" loading={busy === 'save'} onClick={() => act('save', () => api.patch(a(`/followups/${d.id}`), { subject: subject || null, body }), 'common.saved')}>
              {t('common.save')}
            </Button>
          )}
          {editable && !dirty && (
            <Button variant="primary" icon="check" loading={busy === 'approve'} onClick={() => act('approve', () => api.post(a(`/followups/${d.id}/approve`)), 'followup.approved')}>
              {t('followup.approve')}
            </Button>
          )}
          <Button icon="copy" onClick={() => copyText(text).then((ok) => (ok ? toast.success(t('common.copied')) : toast.error(t('common.copyFailed'))))}>
            {t('followup.copy')}
          </Button>
          {meeting.canEdit && d.status === 'approved' && (
            <Button icon="send" loading={busy === 'sent'} onClick={() => act('sent', () => api.post(a(`/followups/${d.id}/mark-sent`)), 'followup.markedSent')}>
              {t('followup.markSent')}
            </Button>
          )}
          {meeting.canEdit && d.status !== 'sent' && d.status !== 'discarded' && (
            <Button variant="ghost" icon="trash" loading={busy === 'discard'} onClick={() => act('discard', () => api.post(a(`/followups/${d.id}/discard`)), 'followup.discarded')}>
              {t('followup.discard')}
            </Button>
          )}
        </div>
        {d.status === 'approved' && (
          <p className="field-hint">
            {t('followup.externalNote')} <Link to={p('/settings/approvals')}>{t('settings.approvals')}</Link>
          </p>
        )}
      </div>
    </Card>
  );
}

export function FollowupTab() {
  const { t } = useI18n();
  const toast = useToast();
  const { meeting, ma } = useMeeting();
  const state = useApi<unknown>(ma('/followups'));
  const tpl = findBuiltinTemplate(meeting.templateKey);
  const [kind, setKind] = useState<FollowupKind>(tpl?.followupStyle.defaultKinds[0] ?? 'internal_recap');
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true);
    try {
      await api.post(ma('/followups'), { kind });
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
