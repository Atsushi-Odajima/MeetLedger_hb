import { msToClock } from '@meetledger/shared';
import { Alert, Async, Card } from '../../components/ui';
import { useI18n } from '../../i18n';
import { useApi } from '../../lib/hooks';
import { useMeeting } from './context';

interface SpeakerShare {
  speaker?: string;
  label?: string;
  name?: string;
  displayName?: string;
  talkMs?: number;
  ms?: number;
  share?: number;
  turns?: number;
}

const humanize = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Factual meeting metrics only (talk time, turns, counts). No evaluation or psychological analysis. */
export function CoachTab() {
  const { t, tm } = useI18n();
  const { ma } = useMeeting();
  const state = useApi<Record<string, unknown>>(ma('/coach'));
  return (
    <div className="stack">
      <Alert tone="info">{t('coach.intro')}</Alert>
      <Async state={state}>
        {(data) => {
          const metrics = (data && typeof data === 'object' && 'metrics' in data ? (data.metrics as Record<string, unknown>) : data) ?? {};
          const speakers = (Array.isArray(metrics.speakers) ? metrics.speakers : Array.isArray(metrics.talkTime) ? metrics.talkTime : []) as SpeakerShare[];
          const totalMs = speakers.reduce((n, s) => n + (s.talkMs ?? s.ms ?? 0), 0);
          const scalars = Object.entries(metrics).filter(([, v]) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean');
          return (
            <>
              {speakers.length > 0 && (
                <Card title={t('coach.talkTime')}>
                  <ul className="bars">
                    {speakers.map((s, i) => {
                      const ms = s.talkMs ?? s.ms ?? 0;
                      const share = typeof s.share === 'number' ? (s.share > 1 ? s.share / 100 : s.share) : totalMs ? ms / totalMs : 0;
                      const name = s.displayName ?? s.name ?? s.speaker ?? s.label ?? `#${i + 1}`;
                      return (
                        <li key={i} className="bar-row">
                          <span className="bar-label">{name}</span>
                          <span className="bar-track" role="img" aria-label={t('coach.shareAria', { name, pct: Math.round(share * 100) })}>
                            <span className="bar-fill" style={{ width: `${Math.round(share * 100)}%` }} />
                          </span>
                          <span className="bar-value">
                            {Math.round(share * 100)}% · {msToClock(ms)}
                            {typeof s.turns === 'number' && ` · ${t('coach.turns', { n: s.turns })}`}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}
              {scalars.length > 0 && (
                <Card title={t('coach.metrics')}>
                  <div className="stat-grid">
                    {scalars.map(([k, v]) => (
                      <div className="stat" key={k}>
                        <span className="stat-value">{typeof v === 'number' && /ms$/i.test(k) ? msToClock(v) : String(v)}</span>
                        <span className="stat-label">{tm(`coach.metric.${k}`, humanize(k))}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
              {!speakers.length && !scalars.length && <p className="muted">{t('coach.empty')}</p>}
            </>
          );
        }}
      </Async>
    </div>
  );
}
