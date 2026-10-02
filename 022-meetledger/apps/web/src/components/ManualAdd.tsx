import { useState, type FormEvent } from 'react';
import { Button, Dialog, SelectField, TextField } from './ui';
import { usePeople } from './ledger';
import { useI18n } from '../i18n';
import { useWs } from '../state/workspace';
import { useSession } from '../state/session';
import { useToast } from '../state/toast';
import { api } from '../lib/api';

export type ManualKind = 'decision' | 'action' | 'commitment' | 'question';

const ME = '__me__';

/**
 * Manual ledger entry (human-created items are confirmed immediately — they are not AI candidates).
 * Commitments: who promised (me / a person / unknown), to whom, and a due date.
 */
export function ManualAddDialog({
  kind,
  meeting,
  onClose,
  onAdded,
}: {
  kind: ManualKind | null;
  meeting?: { id: string; projectId?: string | null } | null;
  onClose(): void;
  onAdded(): void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { a } = useWs();
  const { me } = useSession();
  const { people } = usePeople();
  const [text, setText] = useState('');
  const [assignee, setAssignee] = useState('');
  const [by, setBy] = useState(ME);
  const [to, setTo] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  if (!kind) return null;
  const ctx = meeting ? { meetingId: meeting.id } : {};
  const party = (v: string, k: 'promisedBy' | 'promisedTo') =>
    v === ME && me ? { [`${k}UserId`]: me.user.id } : v ? { [`${k}PersonId`]: v } : {};
  const reset = () => {
    setText('');
    setAssignee('');
    setBy(ME);
    setTo('');
    setDue('');
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (kind === 'decision') await api.post(a('/decisions'), { text: text.trim(), ...ctx, ...(meeting?.projectId ? { projectId: meeting.projectId } : {}) });
      else if (kind === 'action')
        await api.post(a('/actions'), { description: text.trim(), ...ctx, ...(meeting?.projectId ? { projectId: meeting.projectId } : {}), assigneePersonId: assignee || null, dueDate: due || null });
      else if (kind === 'commitment')
        await api.post(a('/commitments'), {
          description: text.trim(),
          ...ctx,
          ...(meeting?.projectId ? { projectId: meeting.projectId } : {}),
          ...party(by, 'promisedBy'),
          ...party(to, 'promisedTo'),
          dueDate: due || null,
        });
      else await api.post(a('/questions'), { question: text.trim(), ...ctx, ...(meeting?.projectId ? { projectId: meeting.projectId } : {}), ...(due ? { dueDate: due } : {}) });
      toast.success(t('ledger.added'));
      reset();
      onAdded();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const partyOptions = (allowUnknown: boolean) => [
    ...(allowUnknown ? [{ value: '', label: t('commitment.unknown') }] : []),
    ...(me ? [{ value: ME, label: t('ledger.me', { name: me.user.name }) }] : []),
    ...people.filter((p) => !me || p.userId !== me.user.id).map((p) => ({ value: p.id, label: p.organization ? `${p.name}（${p.organization}）` : p.name })),
  ];
  return (
    <Dialog open onClose={onClose} title={t(`ledger.add.${kind}`)}>
      <form className="stack" onSubmit={submit}>
        <TextField label={t(`ledger.field.${kind}`)} value={text} onChange={(e) => setText(e.target.value)} required maxLength={2000} autoFocus />
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
        {kind === 'commitment' && (
          <>
            <div className="grid-2">
              <SelectField label={t('commitment.promisedBy')} value={by} onChange={(e) => setBy(e.target.value)} options={partyOptions(true)} />
              <SelectField label={t('commitment.promisedTo')} value={to} onChange={(e) => setTo(e.target.value)} options={partyOptions(true)} />
            </div>
            <TextField label={t('action.due')} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </>
        )}
        {kind === 'question' && <TextField label={t('question.dueOptional')} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}
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
