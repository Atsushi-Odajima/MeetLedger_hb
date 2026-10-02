import { useState, type FormEvent } from 'react';
import { ROLES, type Role } from '@meetledger/shared';
import { Alert, Async, Button, Card, SelectField, TextField } from '../../components/ui';
import { useI18n, type MsgKey } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useSession } from '../../state/session';
import { useToast } from '../../state/toast';
import { api, listOf } from '../../lib/api';
import { copyText, useApi } from '../../lib/hooks';
import type { MemberDto } from '../../lib/types';

export function MembersSettings() {
  const { t } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const { me } = useSession();
  const state = useApi<unknown>(a('/members'));
  const admin = can('admin');
  const setRole = async (m: MemberDto, role: Role) => {
    try {
      await api.put(a(`/members/${m.id}`), { role });
      toast.success(t('common.saved'));
      state.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const remove = async (m: MemberDto) => {
    if (!window.confirm(t('members.removeConfirm', { name: m.name }))) return;
    try {
      await api.del(a(`/members/${m.id}`));
      state.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Card title={t('settings.members')}>
      <p className="field-hint">{t('members.rolesHint')}</p>
      <Async state={state}>
        {(d) => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t('auth.name')}</th>
                  <th scope="col">{t('auth.email')}</th>
                  <th scope="col">{t('members.role')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {listOf<MemberDto>(d, 'members').map((m) => (
                  <tr key={m.id}>
                    <th scope="row">{m.name}</th>
                    <td>{m.email}</td>
                    <td>
                      {admin && m.id !== me?.user.id ? (
                        <select className="input select select-sm" value={m.role} onChange={(e) => setRole(m, e.target.value as Role)} aria-label={t('members.roleFor', { name: m.name })}>
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {t(`role.${r}` as MsgKey)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        t(`role.${m.role}` as MsgKey)
                      )}
                    </td>
                    <td>
                      {admin && m.id !== me?.user.id && (
                        <Button size="sm" variant="ghost" onClick={() => remove(m)}>
                          {t('members.remove')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </Card>
  );
}

export function InvitationsSettings() {
  const { t } = useI18n();
  const toast = useToast();
  const { ws, wsId, can } = useWs();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'viewer' | 'admin'>('member');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ inviteUrl: string; expiresInDays?: number } | null>(null);
  if (!can('admin')) return <Alert tone="info">{t('settings.adminOnly')}</Alert>;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ inviteUrl: string; expiresInDays?: number }>(`/api/orgs/${ws!.orgId}/invitations`, { email: email.trim(), role, workspaceId: wsId });
      setResult(r);
      setEmail('');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('settings.invitations')}>
      <form className="stack" onSubmit={submit}>
        <div className="grid-2">
          <TextField label={t('auth.email')} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <SelectField
            label={t('members.role')}
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
            options={(['admin', 'member', 'viewer'] as const).map((r) => ({ value: r, label: t(`role.${r}` as MsgKey) }))}
          />
        </div>
        <Button type="submit" variant="primary" loading={busy} disabled={!email.trim()}>
          {t('invite.create')}
        </Button>
      </form>
      {result && (
        <Alert tone="success" title={t('invite.created')}>
          <p>{t('invite.shareHint', { days: result.expiresInDays ?? 7 })}</p>
          <div className="copy-row">
            <code className="code-inline">{result.inviteUrl}</code>
            <Button size="sm" icon="copy" onClick={() => copyText(result.inviteUrl).then((ok) => ok && toast.success(t('common.copied')))}>
              {t('common.copy')}
            </Button>
          </div>
        </Alert>
      )}
      <p className="field-hint">{t('invite.noEmail')}</p>
    </Card>
  );
}
