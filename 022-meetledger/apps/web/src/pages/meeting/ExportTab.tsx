import { Card } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useI18n, type MsgKey } from '../../i18n';
import { useMeeting } from './context';

const FORMATS = ['md', 'html', 'txt', 'srt', 'vtt', 'json'] as const;

export function ExportTab() {
  const { t } = useI18n();
  const { ma } = useMeeting();
  return (
    <Card title={t('export.meetingTitle')}>
      <p className="field-hint">{t('export.meetingHint')}</p>
      <ul className="export-list">
        {FORMATS.map((f) => (
          <li key={f}>
            <a className="btn btn-secondary btn-md" href={ma(`/export?format=${f}`)} download>
              <Icon name="download" />
              <span>{t(`export.format.${f}` as MsgKey)}</span>
            </a>
          </li>
        ))}
      </ul>
      <p className="field-hint">{t('export.privacyNote')}</p>
    </Card>
  );
}
