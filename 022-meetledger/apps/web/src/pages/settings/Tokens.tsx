import { useState, type FormEvent } from 'react';
import { Alert, Async, Badge, Button, Card, Checkbox, EmptyState, SelectField, TextField } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useWs } from '../../state/workspace';
import { useToast } from '../../state/toast';
import { api, listOf } from '../../lib/api';
import { copyText, useApi } from '../../lib/hooks';
import type { ApiTokenDto } from '../../lib/types';

function CopyBlock({ text, label }: { text: string; label: string }) {
  const { t } = useI18n();
  const toast = useToast();
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="small-title">{label}</span>
        <Button size="sm" variant="ghost" icon="copy" onClick={() => copyText(text).then((ok) => ok && toast.success(t('common.copied')))}>
          {t('common.copy')}
        </Button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

export function TokensSettings() {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const { a, wsId, can } = useWs();
  const state = useApi<unknown>(a('/api-tokens'));
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState('90');
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const origin = window.location.origin;
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ token: string } & Partial<ApiTokenDto>>(a('/api-tokens'), {
        name: name.trim(),
        scopes: write ? ['read', 'write'] : ['read'],
        ...(days ? { expiresInDays: Number(days) } : {}),
      });
      setCreated(r.token);
      setName('');
      state.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (tk: ApiTokenDto) => {
    if (!window.confirm(t('tokens.revokeConfirm', { name: tk.name }))) return;
    try {
      await api.del(a(`/api-tokens/${tk.id}`));
      state.reload();
    } catch (err) {
      toast.error(err);
    }
  };
  const token = created ?? '<YOUR_TOKEN>';
  const desktopJson = JSON.stringify(
    { mcpServers: { meetledger: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
  return (
    <div className="stack">
      <Card title={t('tokens.title')}>
        <p className="field-hint">{t('tokens.intro')}</p>
        {created && (
          <Alert tone="success" title={t('tokens.createdOnce')}>
            <div className="copy-row">
              <code className="code-inline">{created}</code>
              <Button size="sm" icon="copy" onClick={() => copyText(created).then((ok) => ok && toast.success(t('common.copied')))}>
                {t('common.copy')}
              </Button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
              {t('tokens.hide')}
            </Button>
          </Alert>
        )}
        {can('member') && (
          <form className="stack" onSubmit={create}>
            <div className="grid-2">
              <TextField label={t('tokens.name')} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder={t('tokens.namePlaceholder')} />
              <SelectField
                label={t('tokens.expires')}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                options={[
                  { value: '30', label: t('tokens.days', { n: 30 }) },
                  { value: '90', label: t('tokens.days', { n: 90 }) },
                  { value: '365', label: t('tokens.days', { n: 365 }) },
                  { value: '', label: t('tokens.never') },
                ]}
              />
            </div>
            <Checkbox label={t('tokens.write')} hint={t('tokens.writeHint')} checked={write} onChange={(e) => setWrite(e.target.checked)} />
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()} icon="key">
              {t('tokens.create')}
            </Button>
          </form>
        )}
        <Async state={state}>
          {(d) => {
            const items = listOf<ApiTokenDto>(d, 'tokens').filter((x) => !x.revokedAt);
            return items.length ? (
              <ul className="items">
                {items.map((tk) => (
                  <li key={tk.id} className="item">
                    <div className="item-main">
                      <span className="item-title">
                        {tk.name} {tk.prefix && <code className="code-inline">{tk.prefix}…</code>}
                      </span>
                      <span className="item-meta">
                        {tk.scopes.map((s) => (
                          <Badge key={s}>{s}</Badge>
                        ))}
                        {tk.createdAt && <span>{t('tokens.createdAt', { time: fmt.date(tk.createdAt) })}</span>}
                        <span>{tk.lastUsedAt ? t('tokens.lastUsed', { time: fmt.relative(tk.lastUsedAt) }) : t('tokens.neverUsed')}</span>
                        {tk.expiresAt && <span>{t('tokens.expiresAt', { time: fmt.date(tk.expiresAt) })}</span>}
                      </span>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => revoke(tk)}>
                      {t('tokens.revoke')}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon="key" title={t('tokens.empty')} />
            );
          }}
        </Async>
      </Card>
      <Card title={t('mcp.title')}>
        <div className="stack">
          <p>{t('mcp.intro')}</p>
          <CopyBlock label={t('mcp.endpoint')} text={`${origin}/mcp`} />
          <CopyBlock label={t('mcp.claudeCode')} text={`claude mcp add --transport http meetledger ${origin}/mcp --header "Authorization: Bearer ${token}"`} />
          <CopyBlock label={t('mcp.desktopConfig')} text={desktopJson} />
          <ul className="notice-list">
            <li>{t('mcp.note.workspace', { ws: wsId })}</li>
            <li>{t('mcp.note.scopes')}</li>
            <li>{t('mcp.note.confirm')}</li>
            <li>{t('mcp.note.secret')}</li>
          </ul>
        </div>
      </Card>
    </div>
  );
}
