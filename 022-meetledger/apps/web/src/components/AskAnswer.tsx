import { Link } from 'react-router-dom';
import { msToClock, type AskResponseDto, type CitationDto } from '@meetledger/shared';
import { AiBadge, Alert, Badge } from './ui';
import { Icon } from './Icon';
import { useI18n } from '../i18n';
import { useWs } from '../state/workspace';

export function CitationList({ citations }: { citations: CitationDto[] }) {
  const { t, fmt, tm } = useI18n();
  const { p } = useWs();
  if (!citations.length) return null;
  return (
    <ol className="citations" aria-label={t('ask.citations')}>
      {citations.map((c, i) => {
        const to = c.meetingId ? p(`/meetings/${c.meetingId}/transcript${typeof c.startMs === 'number' ? `?t=${c.startMs}` : ''}`) : null;
        return (
          <li key={c.id ?? i} className="citation">
            <span className="citation-n" aria-hidden="true">
              [{i + 1}]
            </span>
            <div>
              {to ? (
                <Link to={to} className="source-link">
                  <Icon name="link" size={14} />
                  <span>{c.meetingTitle ?? t('source.open')}</span>
                  {c.meetingDate && <span className="muted">{fmt.date(c.meetingDate)}</span>}
                  {typeof c.startMs === 'number' && <span className="timestamp">{msToClock(c.startMs)}</span>}
                </Link>
              ) : (
                <span className="muted">{tm(`entity.${c.entityType}`, c.entityType)}</span>
              )}
              <Badge>{tm(`entity.${c.entityType}`, c.entityType)}</Badge>
              <p className="citation-snippet">{c.snippet}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function AskAnswer({ res }: { res: AskResponseDto }) {
  const { t } = useI18n();
  return (
    <div className="ask-answer" aria-live="polite">
      <div className="badges">
        {res.aiGenerated && <AiBadge />}
        {res.provider && <Badge tone="neutral">{res.provider}</Badge>}
      </div>
      {res.insufficient ? (
        <Alert tone="info" title={t('ask.unknown')}>
          {t('ask.unknownBody')}
        </Alert>
      ) : (
        <div className="answer-text">{res.answer}</div>
      )}
      {res.excludedMeetings > 0 && <p className="field-hint">{t('ask.excluded', { n: res.excludedMeetings })}</p>}
      <CitationList citations={res.citations ?? []} />
      {!res.insufficient && <p className="field-hint">{t('ask.verify')}</p>}
    </div>
  );
}
