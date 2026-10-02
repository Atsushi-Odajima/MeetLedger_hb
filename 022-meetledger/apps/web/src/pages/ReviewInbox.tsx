import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ActionDto, CommitmentDto, ContradictionDto, DecisionDto, LedgerEntityType, QuestionDto, SourceRef } from '@meetledger/shared';
import {
  AiBadge,
  Alert,
  Badge,
  Button,
  CandidateBadge,
  Card,
  CachedNotice,
  EmptyState,
  ErrorView,
  LoadMore,
  Loading,
  PageHeader,
  SelectField,
  Tabs,
  TextField,
  Checkbox,
} from '../components/ui';
import { DecisionItem, SourceLink, personName, usePeople } from '../components/ledger';
import { useI18n, type MsgKey } from '../i18n';
import { useWs } from '../state/workspace';
import { useToast } from '../state/toast';
import { api, ApiError, listOf, qs } from '../lib/api';
import { useApi, withCursor } from '../lib/hooks';

type AnyItem = DecisionDto | ActionDto | CommitmentDto | QuestionDto;
/** Union of the optional fields of all four candidate types (for reading without narrowing). */
interface LooseItem {
  text?: string;
  question?: string;
  description?: string;
  topic?: string | null;
  assigneePersonId?: string | null;
  assigneeUserId?: string | null;
  assigneeText?: string | null;
  assigneeInferred?: boolean;
  dueInferred?: boolean;
  dueDate?: string | null;
  dueText?: string | null;
  promisedByPersonId?: string | null;
  promisedByText?: string | null;
  promisedToPersonId?: string | null;
  promisedToText?: string | null;
  extractedBy?: string;
  confidence?: number | null;
  source?: SourceRef | null;
}
interface Flags {
  assigneeInferred?: boolean;
  dueInferred?: boolean;
  missingOwner?: boolean;
}
export interface ReviewCard {
  type: LedgerEntityType;
  item: AnyItem & { meetingTitle?: string | null };
  flags: Flags;
}

interface ReviewResponse {
  items?: { type: LedgerEntityType; item?: AnyItem; flags?: Flags }[];
  candidates?: unknown;
  decisions?: DecisionDto[];
  actions?: ActionDto[];
  commitments?: CommitmentDto[];
  questions?: QuestionDto[];
  contradictions?: ContradictionDto[];
  unmappedSpeakers?: { id: string; label: string; meetingId: string; meetingTitle?: string | null; suggestion?: string | null }[];
  unlinkedParticipants?: { id: string; displayName: string; email?: string | null; meetingId: string; meetingTitle?: string | null }[];
}

function deriveFlags(type: LedgerEntityType, item: AnyItem, given?: Flags): Flags {
  const f: Flags = { ...(given ?? {}) };
  const it = item as LooseItem;
  if (f.assigneeInferred === undefined && type === 'action') f.assigneeInferred = !!it.assigneeInferred;
  if (f.dueInferred === undefined) f.dueInferred = !!it.dueInferred;
  if (f.missingOwner === undefined && type === 'action') f.missingOwner = !it.assigneePersonId && !it.assigneeUserId && !it.assigneeText;
  return f;
}

/** Accepts the different shapes the review endpoint may return. */
export function normalizeReview(r: ReviewResponse | AnyItem[] | null | undefined): {
  cards: ReviewCard[];
  contradictions: ContradictionDto[];
  speakers: NonNullable<ReviewResponse['unmappedSpeakers']>;
  participants: NonNullable<ReviewResponse['unlinkedParticipants']>;
} {
  const cards: ReviewCard[] = [];
  const src = (
    r && !Array.isArray(r) && r.candidates && typeof r.candidates === 'object' && !Array.isArray(r.candidates) ? { ...r, ...(r.candidates as object) } : r
  ) as ReviewResponse | null;
  const fromItems = src && !Array.isArray(src) ? (src.items ?? (Array.isArray(src.candidates) ? (src.candidates as ReviewResponse['items']) : undefined)) : undefined;
  if (fromItems) {
    for (const x of fromItems) {
      const item = (x.item ?? (x as unknown as AnyItem)) as AnyItem;
      cards.push({ type: x.type, item, flags: deriveFlags(x.type, item, x.flags) });
    }
  } else if (src && !Array.isArray(src)) {
    const add = (type: LedgerEntityType, list?: AnyItem[]) =>
      (list ?? []).forEach((item) => cards.push({ type, item, flags: deriveFlags(type, item, (item as { flags?: Flags }).flags) }));
    add('decision', src.decisions);
    add('action', src.actions);
    add('commitment', src.commitments);
    add('question', src.questions);
  }
  const o = (src && !Array.isArray(src) ? src : {}) as ReviewResponse;
  return {
    cards,
    contradictions: (o.contradictions ?? []).filter((c) => !c.status || c.status === 'open'),
    speakers: o.unmappedSpeakers ?? [],
    participants: o.unlinkedParticipants ?? [],
  };
}

function textOf(c: ReviewCard): string {
  const it = c.item as LooseItem;
  return (c.type === 'decision' ? it.text : c.type === 'question' ? it.question : it.description) ?? '';
}

function CandidateCard({ card, onDone }: { card: ReviewCard; onDone(id: string, outcome: 'accepted' | 'rejected'): void }) {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const { people, byId } = usePeople();
  const it = card.item as LooseItem;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(textOf(card));
  const [assignee, setAssignee] = useState(it.assigneePersonId ?? '');
  const [due, setDue] = useState(it.dueDate ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const inferred = !!(card.flags.assigneeInferred || card.flags.dueInferred);
  const assigneeChanged = assignee !== (it.assigneePersonId ?? '');
  const dueChanged = due !== (it.dueDate ?? '');
  const explicitlyEdited = editing && (!card.flags.assigneeInferred || assigneeChanged) && (!card.flags.dueInferred || dueChanged);
  const needsConfirm = inferred && !explicitlyEdited;
  const canWrite = can('member');

  const accept = async () => {
    setBusy('accept');
    try {
      const edits: Record<string, unknown> = {};
      if (editing) {
        if (text !== textOf(card)) edits[card.type === 'decision' ? 'text' : card.type === 'question' ? 'question' : 'description'] = text;
        if (card.type === 'action' && assigneeChanged) edits.assigneePersonId = assignee || null;
        if ((card.type === 'action' || card.type === 'commitment') && dueChanged) edits.dueDate = due || null;
      }
      await api.post(a(`/review/${card.type}/${card.item.id}/accept`), {
        ...(Object.keys(edits).length ? { edits } : {}),
        ...(inferred && confirmed ? { confirmInferred: true } : {}),
      });
      toast.announce(t('review.accepted'));
      onDone(card.item.id, 'accepted');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const reject = async () => {
    setBusy('reject');
    try {
      await api.post(a(`/review/${card.type}/${card.item.id}/reject`));
      toast.announce(t('review.rejected'));
      onDone(card.item.id, 'rejected');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const assigneeName = personName(byId, it.assigneePersonId, it.assigneeText);
  return (
    <article className="card card-candidate review-card" aria-label={`${t(`entityType.${card.type}` as MsgKey)}: ${textOf(card)}`}>
      <header className="review-head">
        <CandidateBadge />
        {it.extractedBy === 'ai' && <AiBadge />}
        <Badge tone="primary">{t(`entityType.${card.type}` as MsgKey)}</Badge>
        {typeof it.confidence === 'number' && <span className="muted">{t('review.confidence', { pct: Math.round(it.confidence * 100) })}</span>}
      </header>
      {editing ? (
        <div className="stack">
          <TextField label={t(`ledger.field.${card.type === 'commitment' ? 'action' : card.type}` as MsgKey)} value={text} onChange={(e) => setText(e.target.value)} />
          {card.type === 'action' && (
            <div className="grid-2">
              <SelectField
                label={t('action.assignee')}
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                className={card.flags.assigneeInferred && !assigneeChanged ? 'inferred-field' : undefined}
                options={[
                  { value: '', label: it.assigneeText ? `${t('action.noAssignee')}（${it.assigneeText}）` : t('action.noAssignee') },
                  ...people.map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
              <TextField
                label={t('action.due')}
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
                className={card.flags.dueInferred && !dueChanged ? 'inferred-field' : undefined}
                hint={it.dueText ? t('review.dueText', { text: it.dueText }) : undefined}
              />
            </div>
          )}
          {card.type === 'commitment' && (
            <TextField
              label={t('action.due')}
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              className={card.flags.dueInferred && !dueChanged ? 'inferred-field' : undefined}
            />
          )}
        </div>
      ) : (
        <>
          <p className="review-text">{textOf(card)}</p>
          <dl className="review-fields">
            {card.type === 'action' && (
              <div className={card.flags.assigneeInferred ? 'inferred' : undefined}>
                <dt>{t('action.assignee')}</dt>
                <dd>
                  {assigneeName ?? t('action.noAssignee')}
                  {card.flags.assigneeInferred && <Badge tone="warn">{t('review.inferred')}</Badge>}
                </dd>
              </div>
            )}
            {(card.type === 'action' || card.type === 'commitment') && (
              <div className={card.flags.dueInferred ? 'inferred' : undefined}>
                <dt>{t('action.due')}</dt>
                <dd>
                  {it.dueDate ? fmt.date(it.dueDate) : (it.dueText ?? t('action.noDue'))}
                  {card.flags.dueInferred && <Badge tone="warn">{t('review.inferred')}</Badge>}
                </dd>
              </div>
            )}
            {card.type === 'commitment' && (
              <div>
                <dt>{t('commitment.who')}</dt>
                <dd>
                  {t('commitment.fromTo', {
                    by: personName(byId, it.promisedByPersonId, it.promisedByText) ?? t('commitment.unknown'),
                    to: personName(byId, it.promisedToPersonId, it.promisedToText) ?? t('commitment.unknown'),
                  })}
                </dd>
              </div>
            )}
            {card.type === 'decision' && it.topic && (
              <div>
                <dt>{t('decision.topic')}</dt>
                <dd>{it.topic}</dd>
              </div>
            )}
          </dl>
          {card.flags.missingOwner && <p className="field-hint">{t('review.missingOwner')}</p>}
        </>
      )}
      <SourceLink source={it.source} />
      {inferred && (
        <div className="inferred-confirm">
          <Checkbox
            label={t('review.confirmInferred')}
            hint={explicitlyEdited ? t('review.editedExplicitly') : t('review.confirmInferredHint')}
            checked={confirmed || explicitlyEdited}
            disabled={explicitlyEdited}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
        </div>
      )}
      {canWrite && (
        <footer className="review-actions">
          <Button variant="primary" icon="check" onClick={accept} loading={busy === 'accept'} disabled={needsConfirm && !confirmed}>
            {editing ? t('review.saveAndAccept') : t('review.accept')}
          </Button>
          <Button icon="edit" onClick={() => setEditing((e) => !e)} aria-pressed={editing}>
            {editing ? t('review.cancelEdit') : t('review.edit')}
          </Button>
          <Button variant="ghost" icon="x" onClick={reject} loading={busy === 'reject'}>
            {t('review.reject')}
          </Button>
        </footer>
      )}
    </article>
  );
}

function ContradictionCard({ c, onDone }: { c: ContradictionDto; onDone(id: string): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { a, can } = useWs();
  const [busy, setBusy] = useState<string | null>(null);
  const resolve = async (resolution: 'change' | 'not_change' | 'dismiss') => {
    setBusy(resolution);
    try {
      await api.post(a(`/contradictions/${c.id}/resolve`), { resolution });
      toast.announce(t(`review.contradiction.done.${resolution}` as MsgKey));
      onDone(c.id);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <article className="card card-candidate review-card contradiction" aria-label={t('review.isChange')}>
      <header className="review-head">
        <Badge tone="warn">{t('review.isChange')}</Badge>
      </header>
      <p className="field-hint">{c.reason}</p>
      <div className="conflict-grid">
        <div>
          <h3 className="small-title">{t('review.existingDecision')}</h3>
          <ul className="items">
            <DecisionItem decision={c.existingDecision} />
          </ul>
        </div>
        <div>
          <h3 className="small-title">{t('review.newDecision')}</h3>
          <ul className="items">
            <DecisionItem decision={c.newDecision} />
          </ul>
        </div>
      </div>
      {can('member') && (
        <footer className="review-actions">
          <Button variant="primary" onClick={() => resolve('change')} loading={busy === 'change'}>
            {t('review.yesChange')}
          </Button>
          <Button onClick={() => resolve('not_change')} loading={busy === 'not_change'}>
            {t('review.noChange')}
          </Button>
          <Button variant="ghost" onClick={() => resolve('dismiss')} loading={busy === 'dismiss'}>
            {t('review.dismiss')}
          </Button>
        </footer>
      )}
      <p className="field-hint">{t('review.changeHint')}</p>
    </article>
  );
}

type TabId = 'all' | LedgerEntityType | 'changes' | 'people';
type CountKey = LedgerEntityType | 'contradiction';

interface PagedReview extends ReviewResponse {
  counts?: Partial<Record<CountKey, number>>;
  total?: number;
  nextCursor?: string | null;
  groups?: { meetingId: string | null; meetingTitle: string | null; total?: number }[];
}

/** Appends a further page (more meetings) to the loaded inbox, de-duplicating by id. */
function mergePages(a: PagedReview, b: PagedReview): PagedReview {
  const uniq = <T,>(x: T[] = [], y: T[] = [], key: (v: T) => string = (v) => (v as { id?: string }).id ?? '') => {
    const seen = new Set(x.map(key));
    return [...x, ...y.filter((v) => !seen.has(key(v)))];
  };
  return {
    ...a,
    items: uniq(a.items, b.items, (v) => `${v.type}:${(v.item as { id?: string } | undefined)?.id ?? ''}`),
    contradictions: uniq(a.contradictions, b.contradictions),
    unmappedSpeakers: uniq(a.unmappedSpeakers, b.unmappedSpeakers),
    unlinkedParticipants: uniq(a.unlinkedParticipants, b.unlinkedParticipants),
    groups: [...(a.groups ?? []), ...(b.groups ?? [])],
    nextCursor: b.nextCursor ?? null,
  };
}

export function ReviewInboxPage() {
  const { t } = useI18n();
  const { a, p } = useWs();
  const [params, setParams] = useSearchParams();
  const meetingId = params.get('meetingId') ?? '';
  const path = a(`/review${qs({ meetingId })}`);
  const state = useApi<PagedReview>(path);
  const [more, setMore] = useState<PagedReview | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [tab, setTab] = useState<TabId>('all');
  const [done, setDone] = useState<Map<string, CountKey>>(new Map());
  useEffect(() => {
    setDone(new Map());
    setMore(null);
    setMoreError(null);
  }, [state.data]);
  const page = useMemo(() => (state.data && more ? mergePages(state.data, more) : state.data), [state.data, more]);
  const data = useMemo(() => normalizeReview(page), [page]);
  const cursor = (more ?? state.data)?.nextCursor ?? null;
  const loadMore = async () => {
    if (!cursor || !state.data) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const r = await api.get<PagedReview>(withCursor(path, cursor));
      setMore((cur) => (cur ? mergePages(cur, r) : { ...r, items: r.items ?? [] }));
    } catch (e) {
      setMoreError(e);
    } finally {
      setLoadingMore(false);
    }
  };
  const cards = data.cards.filter((c) => !done.has(c.item.id));
  const contradictions = data.contradictions.filter((c) => !done.has(c.id));
  const serverCounts = state.data?.counts;
  const doneOf = (k: CountKey) => [...done.values()].filter((v) => v === k).length;
  // Server totals cover the whole inbox (not just the loaded meetings); fall back to the loaded cards.
  const count = (k: CountKey) =>
    typeof serverCounts?.[k] === 'number'
      ? Math.max(0, (serverCounts[k] as number) - doneOf(k))
      : k === 'contradiction'
        ? contradictions.length
        : cards.filter((c) => c.type === k).length;
  const itemTotal = count('decision') + count('action') + count('commitment') + count('question');
  const shown = tab === 'all' ? cards : tab === 'changes' || tab === 'people' ? [] : cards.filter((c) => c.type === tab);
  const markDone = (id: string, type: CountKey) => setDone((s) => new Map(s).set(id, type));
  const total = itemTotal + count('contradiction');
  const notFound = state.error instanceof ApiError && state.error.status === 404 && !!meetingId;
  const clearFilter = () => {
    params.delete('meetingId');
    setParams(params);
  };

  return (
    <>
      <PageHeader title={t('nav.review')} subtitle={t('review.subtitle')} />
      {meetingId && (
        <p className="filter-chip">
          {t('review.filteredByMeeting')}{' '}
          <Button size="sm" variant="ghost" icon="x" onClick={clearFilter}>
            {t('common.clearFilter')}
          </Button>
        </p>
      )}
      {state.loading && !state.data ? (
        <Loading />
      ) : notFound ? (
        <EmptyState
          icon="inbox"
          title={t('review.meetingNotFound')}
          body={t('review.meetingNotFoundBody')}
          action={
            <Button variant="primary" onClick={clearFilter}>
              {t('review.showAll')}
            </Button>
          }
        />
      ) : state.error && !state.data ? (
        <ErrorView error={state.error} onRetry={state.reload} />
      ) : (
        <>
          <CachedNotice at={state.cachedAt} />
          <Tabs<TabId>
            label={t('nav.review')}
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'all', label: t('common.all'), count: itemTotal },
              { id: 'decision', label: t('entityType.decision'), count: count('decision') },
              { id: 'action', label: t('entityType.action'), count: count('action') },
              { id: 'commitment', label: t('entityType.commitment'), count: count('commitment') },
              { id: 'question', label: t('entityType.question'), count: count('question') },
              { id: 'changes', label: t('review.isChange'), count: count('contradiction') },
              { id: 'people', label: t('review.peopleTab'), count: data.speakers.length + data.participants.length },
            ]}
          />
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tab-panel">
            {!total && tab !== 'people' && <EmptyState icon="check" title={t('review.empty')} body={t('review.emptyBody')} />}
            {(tab === 'all' || tab === 'changes') && contradictions.map((c) => <ContradictionCard key={c.id} c={c} onDone={(id) => markDone(id, 'contradiction')} />)}
            <div className="review-list">
              {shown.map((c) => (
                <CandidateCard key={`${c.type}-${c.item.id}`} card={c} onDone={(id) => markDone(id, c.type)} />
              ))}
            </div>
            {tab !== 'people' && (cursor || (total > 0 && cards.length + contradictions.length < total)) && (
              <LoadMore shown={cards.length + contradictions.length} total={total} hasMore={!!cursor} loading={loadingMore} error={moreError} onMore={loadMore} />
            )}
            {tab === 'people' && (
              <Card title={t('review.peopleTab')}>
                <p className="field-hint">{t('review.peopleHint')}</p>
                {data.speakers.length + data.participants.length === 0 ? (
                  <p className="muted">{t('review.peopleEmpty')}</p>
                ) : (
                  <ul className="items">
                    {data.speakers.map((s) => (
                      <li key={s.id} className="item">
                        <div className="item-main">
                          <span className="item-title">{t('review.unmappedSpeaker', { label: s.label })}</span>
                          <span className="item-meta">{s.meetingTitle}</span>
                          {s.suggestion && <span className="field-hint">{t('transcript.suggestionBody', { name: s.suggestion })}</span>}
                        </div>
                        <Link className="btn btn-sm btn-secondary" to={p(`/meetings/${s.meetingId}/transcript`)}>
                          {t('review.mapSpeaker')}
                        </Link>
                      </li>
                    ))}
                    {data.participants.map((x) => (
                      <li key={x.id} className="item">
                        <div className="item-main">
                          <span className="item-title">{t('review.unlinkedParticipant', { name: x.displayName })}</span>
                          <span className="item-meta">{x.meetingTitle}</span>
                        </div>
                        <Link className="btn btn-sm btn-secondary" to={p(`/meetings/${x.meetingId}/settings`)}>
                          {t('review.linkPerson')}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
          <Alert tone="info">{t('review.footer')}</Alert>
        </>
      )}
    </>
  );
}
