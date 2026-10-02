import { Navigate, Route, Routes } from 'react-router-dom';
import { PageHeader, TabNav } from '../../components/ui';
import { useI18n, type MsgKey } from '../../i18n';
import { useWs } from '../../state/workspace';
import { PrivacySettings } from './Privacy';
import { MembersSettings, InvitationsSettings } from './Members';
import { ConnectorsSettings } from './Connectors';
import { ApprovalsSettings } from './Approvals';
import { TokensSettings } from './Tokens';
import { DataSettings } from './Data';
import { AccountSettings } from './Account';
import { AboutSettings } from './About';

const SECTIONS = ['privacy', 'members', 'invitations', 'connectors', 'approvals', 'tokens', 'data', 'account', 'about'] as const;

export function SettingsPage() {
  const { t } = useI18n();
  const { p, ws } = useWs();
  return (
    <>
      <PageHeader title={t('nav.settings')} subtitle={ws?.name} />
      <div className="settings-layout">
        <TabNav label={t('nav.settings')} items={SECTIONS.map((s) => ({ to: p(`/settings/${s}`), label: t(`settings.${s}` as MsgKey) }))} />
        <div className="settings-content">
          <Routes>
            <Route index element={<Navigate to="privacy" replace />} />
            <Route path="privacy" element={<PrivacySettings />} />
            <Route path="members" element={<MembersSettings />} />
            <Route path="invitations" element={<InvitationsSettings />} />
            <Route path="connectors" element={<ConnectorsSettings />} />
            <Route path="approvals" element={<ApprovalsSettings />} />
            <Route path="tokens" element={<TokensSettings />} />
            <Route path="data" element={<DataSettings />} />
            <Route path="account" element={<AccountSettings />} />
            <Route path="about" element={<AboutSettings />} />
            <Route path="*" element={<Navigate to="privacy" replace />} />
          </Routes>
        </div>
      </div>
    </>
  );
}
