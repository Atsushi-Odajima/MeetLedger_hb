import { Alert, Button } from './ui';
import { useI18n } from '../i18n';

export type QuickFilter = 'period' | 'project' | 'person';

/** Element ids of the filter fields a quick-filter button focuses (Search and Ask pages). */
export const FILTER_FIELD_ID: Record<QuickFilter, string> = { period: 'flt-from', project: 'flt-project', person: 'flt-person' };

/** Opens the surrounding <details> filter panel and focuses the requested field. */
export function focusFilter(kind: QuickFilter) {
  const el = document.getElementById(FILTER_FIELD_ID[kind]) as HTMLInputElement | HTMLSelectElement | null;
  if (!el) return;
  const details = el.closest('details');
  if (details) details.open = true;
  el.focus();
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/**
 * Calm notice when the server searched only the newest meetings (time budget): says from which date on meetings were
 * searched and offers quick filters (period / project / person) to reach older ones.
 */
export function TruncatedNotice({ truncated, searchedFrom, hint, onQuick = focusFilter }: { truncated?: boolean; searchedFrom?: string | null; hint?: string | null; onQuick?(k: QuickFilter): void }) {
  const { t, fmt, lang } = useI18n();
  if (!truncated) return null;
  return (
    <Alert tone="info" title={t('search.truncatedTitle')}>
      <div className="stack-sm" data-testid="search-truncated">
        {searchedFrom && <p>{t('search.searchedFrom', { date: fmt.date(searchedFrom) })}</p>}
        <p>{lang === 'ja' && hint ? hint : t('search.truncatedBody')}</p>
        <div className="button-row">
          <Button size="sm" icon="calendar" onClick={() => onQuick('period')}>
            {t('search.quick.period')}
          </Button>
          <Button size="sm" icon="folder" onClick={() => onQuick('project')}>
            {t('search.quick.project')}
          </Button>
          <Button size="sm" icon="users" onClick={() => onQuick('person')}>
            {t('search.quick.person')}
          </Button>
        </div>
      </div>
    </Alert>
  );
}
