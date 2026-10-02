// Server-side validation of AI extraction output. AI output is never trusted:
//  * evidence segment ids must exist in the input (unknown / other-meeting ids are dropped)
//  * the quote must match the cited segments' text (normalized substring or strong token overlap)
//  * evidence consisting only of inaudible segments is dropped ("聞き取れない部分を補完しない")
//  * item text not grounded in its evidence is replaced by the verified quote
//  * assignee / promiser / due are kept only when mentioned in the transcript; explicitness is re-derived server-side
//  * free-text summary sentences must be grounded in the transcript
//  * there is no status in the output: persistence always stores candidates
import { tokenSet } from '@meetledger/shared';
import type { DueRef, ExtractionInput, ExtractionOutput, ExtractionSegment, PartyRef } from '../../providers/ai/types';
import { findDue, isValidYmd } from '../../providers/ai/dueDate';
import { FIRST_PERSON_RE, HUMBLE_RE, containsNorm, coverage, isInaudibleSegment, norm, stripInaudible, truncate } from '../../providers/ai/text';

export interface VSource {
  segmentIds: string[];
  quote: string;
  startMs: number | null;
  endMs: number | null;
}
export interface VParty {
  name: string | null;
  speakerLabel: string | null;
  explicit: boolean;
}
export interface VDue {
  text: string;
  date: string | null;
  explicit: boolean;
}
export interface VDecision {
  text: string;
  topic: string | null;
  reason: string | null;
  source: VSource;
  confidence: number;
}
export interface VAction {
  description: string;
  assignee: VParty | null;
  due: VDue | null;
  source: VSource;
  confidence: number;
}
export interface VCommitment {
  description: string;
  promisedBy: VParty | null;
  promisedTo: VParty | null;
  due: VDue | null;
  source: VSource;
  confidence: number;
}
export interface VQuestion {
  question: string;
  owner: VParty | null;
  source: VSource;
  confidence: number;
}
export interface ValidatedExtraction {
  summary: { executive: string; topics: { title: string; source: VSource | null }[]; risks: { text: string; source: VSource | null }[]; nextMeeting: string | null };
  decisions: VDecision[];
  actions: VAction[];
  commitments: VCommitment[];
  questions: VQuestion[];
  stats: { received: number; kept: number; dropped: Record<string, number>; textReplaced: number; partiesDropped: number; duesDropped: number };
}

const MAX_ITEMS = 100;
const GROUNDED_TEXT = 0.3;
const GROUNDED_SUMMARY = 0.5;

export interface ValidateOptions {
  /** Executive summary produced by our own deterministic code (local-rules) — skip sentence grounding. */
  trustedSummary?: boolean;
}

export function validateExtraction(input: ExtractionInput, raw: ExtractionOutput | unknown, opts: ValidateOptions = {}): ValidatedExtraction {
  const out: any = raw && typeof raw === 'object' ? raw : {};
  const segMap = new Map<string, ExtractionSegment>(input.segments.map((s) => [s.id, s]));
  const audible = input.segments.filter((s) => !isInaudibleSegment(s));
  const corpus = audible.map((s) => stripInaudible(s.text)).join('\n');
  const corpusTokens = tokenSet(corpus);
  const labels = new Map<string, string | null>();
  for (const s of input.segments) if (!labels.has(s.speakerLabel)) labels.set(s.speakerLabel, s.speakerName);
  const knownNames = [...input.participants.map((p) => p.name), ...[...labels.values()].filter((x): x is string => !!x)];
  const rules = input.template.extractionRules;
  const base = input.meeting.date;
  const stats: ValidatedExtraction['stats'] = { received: 0, kept: 0, dropped: {}, textReplaced: 0, partiesDropped: 0, duesDropped: 0 };
  const drop = (reason: string) => (stats.dropped[reason] = (stats.dropped[reason] ?? 0) + 1);

  // ---------------------------------------------------------- evidence
  function checkEvidence(ev: any): VSource | null {
    if (!ev || typeof ev !== 'object' || !Array.isArray(ev.segmentIds)) return void drop('no_evidence'), null;
    const ids = [...new Set((ev.segmentIds as unknown[]).filter((x): x is string => typeof x === 'string'))].slice(0, 20);
    const segs = ids.map((id) => segMap.get(id)).filter((s): s is ExtractionSegment => !!s);
    if (!segs.length || segs.length !== ids.length) return void drop('unknown_segment'), null;
    const usable = segs.filter((s) => !isInaudibleSegment(s));
    if (!usable.length) return void drop('inaudible_only'), null;
    const cited = usable.map((s) => s.text).join('\n');
    let quote = typeof ev.quote === 'string' ? ev.quote.trim() : '';
    if (!norm(quote)) {
      quote = truncate(usable[0].text.trim(), 480);
    } else {
      const ok = norm(cited).includes(norm(quote)) || (tokenSet(stripInaudible(quote)).size >= 2 && coverage(quote, cited) >= 0.8);
      if (!ok) return void drop('quote_mismatch'), null;
    }
    // Narrow the range to the segments that actually contain the quote.
    const nq = norm(quote);
    const narrowed = usable.filter((s) => {
      const ns = norm(s.text);
      return ns && (nq.includes(ns) || ns.includes(nq) || coverage(s.text, quote) >= 0.5);
    });
    const used = narrowed.length ? narrowed : usable;
    const starts = used.map((s) => s.startMs).filter((n) => Number.isFinite(n));
    const ends = used.map((s) => s.endMs).filter((n) => Number.isFinite(n));
    return {
      segmentIds: used.map((s) => s.id),
      quote: truncate(quote, 500),
      startMs: starts.length ? Math.min(...starts) : null,
      endMs: ends.length ? Math.max(...ends) : null,
    };
  }

  const citedTextOf = (src: VSource) => [src.quote, ...src.segmentIds.map((id) => segMap.get(id)?.text ?? '')].join('\n');

  /** Item text must be grounded in its evidence, otherwise the verified quote is used instead. */
  function groundText(text: unknown, src: VSource, max: number): string {
    const t = typeof text === 'string' ? text.trim() : '';
    if (t && coverage(t, citedTextOf(src)) >= GROUNDED_TEXT) return truncate(t, max);
    stats.textReplaced++;
    return truncate(src.quote, max);
  }

  // ---------------------------------------------------------- parties / due
  function checkParty(p: PartyRef | null | undefined, src: VSource): VParty | null {
    if (!p || typeof p !== 'object') return null;
    const label = typeof p.speakerLabel === 'string' && labels.has(p.speakerLabel) ? p.speakerLabel : null;
    let name = typeof p.name === 'string' && norm(p.name) ? truncate(p.name.trim(), 100) : null;
    if (name) {
      const mentioned = containsNorm(corpus, name) || knownNames.some((k) => containsNorm(k, name!) || containsNorm(name!, k));
      if (!mentioned) name = null; // not mentioned anywhere -> never fabricated
    }
    if (!name && !label) {
      if (p.name || p.speakerLabel) stats.partiesDropped++;
      return null;
    }
    const cited = citedTextOf(src);
    const citedSegs = src.segmentIds.map((id) => segMap.get(id)).filter(Boolean) as ExtractionSegment[];
    let explicit = p.explicit === true;
    if (explicit) {
      const nameInEvidence = !!name && containsNorm(cited, name);
      const speakerFirstPerson = !!label && citedSegs.some((s) => s.speakerLabel === label) && (FIRST_PERSON_RE.test(cited) || HUMBLE_RE.test(cited));
      explicit = nameInEvidence || speakerFirstPerson;
    }
    return { name: name ?? (label ? labels.get(label) ?? null : null), speakerLabel: label, explicit };
  }

  function checkDue(d: DueRef | null | undefined, src: VSource): VDue | null {
    if (!d || typeof d !== 'object' || typeof d.text !== 'string') return null;
    const text = truncate(stripInaudible(d.text).trim(), 100);
    if (norm(text).length < 2 || !containsNorm(corpus, text)) {
      stats.duesDropped++;
      return null;
    }
    const inEvidence = containsNorm(citedTextOf(src), text);
    const parsed = findDue(text, base);
    if (parsed) return { text, date: parsed.date, explicit: parsed.explicit && inEvidence };
    const date = isValidYmd(d.date) ? d.date : null;
    return { text, date, explicit: false };
  }

  const conf = (c: unknown) => (typeof c === 'number' && Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5);
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  const dedupe = new Set<string>();
  const firstTime = (kind: string, text: string) => {
    const k = `${kind}:${norm(text)}`;
    if (dedupe.has(k)) return false;
    dedupe.add(k);
    return true;
  };

  // ---------------------------------------------------------- items
  const decisions: VDecision[] = [];
  for (const d of arr(out.decisions)) {
    stats.received++;
    if (!rules.decisions) {
      drop('kind_disabled');
      continue;
    }
    const src = checkEvidence(d?.evidence);
    if (!src) continue;
    const text = groundText(d?.text, src, 1000);
    if (!firstTime('d', text) || decisions.length >= MAX_ITEMS) {
      drop('duplicate_or_limit');
      continue;
    }
    let topic = typeof d?.topic === 'string' && d.topic.trim() ? truncate(d.topic.trim(), 100) : null;
    if (topic && !containsNorm(citedTextOf(src), topic) && coverage(topic, corpusTokens) < GROUNDED_SUMMARY) topic = null;
    let reason = typeof d?.reason === 'string' && d.reason.trim() ? truncate(d.reason.trim(), 1000) : null;
    if (reason && coverage(reason, corpusTokens) < GROUNDED_SUMMARY) reason = null;
    decisions.push({ text, topic, reason, source: src, confidence: conf(d?.confidence) });
  }

  const actions: VAction[] = [];
  for (const a of arr(out.actions)) {
    stats.received++;
    if (!rules.actions) {
      drop('kind_disabled');
      continue;
    }
    const src = checkEvidence(a?.evidence);
    if (!src) continue;
    const description = groundText(a?.description, src, 1000);
    if (!firstTime('a', description) || actions.length >= MAX_ITEMS) {
      drop('duplicate_or_limit');
      continue;
    }
    actions.push({ description, assignee: checkParty(a?.assignee, src), due: checkDue(a?.due, src), source: src, confidence: conf(a?.confidence) });
  }

  const commitments: VCommitment[] = [];
  for (const c of arr(out.commitments)) {
    stats.received++;
    if (!rules.commitments) {
      drop('kind_disabled');
      continue;
    }
    const src = checkEvidence(c?.evidence);
    if (!src) continue;
    const description = groundText(c?.description, src, 1000);
    if (!firstTime('c', description) || commitments.length >= MAX_ITEMS) {
      drop('duplicate_or_limit');
      continue;
    }
    commitments.push({
      description,
      promisedBy: checkParty(c?.promisedBy, src),
      promisedTo: checkParty(c?.promisedTo, src),
      due: checkDue(c?.due, src),
      source: src,
      confidence: conf(c?.confidence),
    });
  }

  const questions: VQuestion[] = [];
  for (const q of arr(out.questions)) {
    stats.received++;
    if (!rules.questions) {
      drop('kind_disabled');
      continue;
    }
    const src = checkEvidence(q?.evidence);
    if (!src) continue;
    const question = groundText(q?.question, src, 1000);
    if (!firstTime('q', question) || questions.length >= MAX_ITEMS) {
      drop('duplicate_or_limit');
      continue;
    }
    questions.push({ question, owner: checkParty(q?.owner, src), source: src, confidence: conf(q?.confidence) });
  }

  // ---------------------------------------------------------- summary
  const s: any = out.summary && typeof out.summary === 'object' ? out.summary : {};
  const groundedSentences = (text: unknown, max: number): string => {
    if (typeof text !== 'string') return '';
    if (opts.trustedSummary) return truncate(text.trim(), max);
    const kept = (text.match(/[^。！？!?\n]+[。！？!?]*/g) ?? []).map((x) => x.trim()).filter((x) => x && coverage(x, corpusTokens) >= GROUNDED_SUMMARY);
    return truncate(kept.join(/[。！？]/.test(text) ? '' : ' ').trim(), max);
  };
  const summaryEntry = (title: unknown, ev: unknown): { text: string; source: VSource | null } | null => {
    const t = typeof title === 'string' ? title.trim() : '';
    if (!t) return null;
    if (ev) {
      const src = checkEvidence(ev);
      if (!src) return null;
      if (coverage(t, citedTextOf(src)) < GROUNDED_TEXT && coverage(t, corpusTokens) < GROUNDED_SUMMARY) return void drop('ungrounded_summary'), null;
      return { text: truncate(t, 300), source: src };
    }
    if (coverage(t, corpusTokens) < GROUNDED_SUMMARY) return void drop('ungrounded_summary'), null;
    return { text: truncate(t, 300), source: null };
  };
  const topics = arr(s.topics)
    .slice(0, 30)
    .map((t) => summaryEntry(t?.title, t?.evidence))
    .filter((x): x is { text: string; source: VSource | null } => !!x)
    .map((x) => ({ title: x.text, source: x.source }));
  const risks = rules.risks
    ? arr(s.risks)
        .slice(0, 30)
        .map((t) => summaryEntry(t?.text, t?.evidence))
        .filter((x): x is { text: string; source: VSource | null } => !!x)
    : [];
  const nextMeeting = groundedSentences(s.nextMeeting, 300) || null;

  stats.kept = decisions.length + actions.length + commitments.length + questions.length;
  return {
    summary: { executive: groundedSentences(s.executive, 4000), topics, risks, nextMeeting },
    decisions,
    actions,
    commitments,
    questions,
    stats,
  };
}
