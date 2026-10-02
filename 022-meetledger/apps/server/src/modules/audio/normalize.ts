import { INAUDIBLE_TOKEN, MAX_INAUDIBLE_CONFIDENCE } from '@meetledger/shared';

// Post-processing of provider output before it is stored:
//  - timestamps: clamped to [0, duration], end >= start, starts monotonic (non-decreasing)
//  - tiny fragments (< 500 ms) of the same speaker within 300 ms are merged into the previous segment
//  - unintelligible / empty text becomes EXACTLY "[inaudible]" (flag 'inaudible'); nothing is ever filled in
//  - confidence below MAX_INAUDIBLE_CONFIDENCE => flag 'low_confidence' (text kept verbatim for human review)

export interface InSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number | null;
  speaker?: string | null;
  flags?: string[];
}

export interface OutSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  flags: string[];
  /** Provider speaker label (normalized to "Speaker N" later). */
  speaker: string | null;
}

const INAUDIBLE_VARIANTS = /\[(?:inaudible|unintelligible|indiscernible|unclear|聞き取れず|聞き取り不能)\]|\((?:inaudible|unintelligible)\)/gi;
const CJK_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー。、！？]$/u;
const CJK_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー。、！？]/u;

export const MERGE_TINY_MS = 500;
export const MERGE_GAP_MS = 300;

/** Normalizes whitespace and inaudible markers. A text without any letter/digit becomes exactly "[inaudible]". */
export function cleanText(text: string | null | undefined): { text: string; inaudible: boolean; partial: boolean } {
  let t = String(text ?? '')
    .replace(/[\t\r\n ]+/g, ' ')
    .trim();
  t = t.replace(INAUDIBLE_VARIANTS, INAUDIBLE_TOKEN);
  const rest = t.split(INAUDIBLE_TOKEN).join('');
  if (!/[\p{L}\p{N}]/u.test(rest)) return { text: INAUDIBLE_TOKEN, inaudible: true, partial: false };
  return { text: t, inaudible: false, partial: t.includes(INAUDIBLE_TOKEN) };
}

export function joinText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return CJK_END.test(a) && CJK_START.test(b) ? a + b : `${a} ${b}`;
}

function clampConf(c: number | null | undefined): number | null {
  if (c === null || c === undefined || !Number.isFinite(c)) return null;
  return Math.max(0, Math.min(1, c));
}

function minConf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function flagsFor(inaudible: boolean, partial: boolean, conf: number | null, extra: string[] = []): string[] {
  const f = new Set(extra.filter((x) => x !== 'inaudible' && x !== 'low_confidence'));
  if (inaudible || partial) f.add('inaudible');
  if (conf !== null && conf < MAX_INAUDIBLE_CONFIDENCE) f.add('low_confidence');
  return [...f];
}

export function alignSegments(raw: InSegment[], durationMs?: number | null): OutSegment[] {
  const dur = durationMs && durationMs > 0 ? Math.round(durationMs) : null;
  const clamp = (v: number) => {
    const x = Number.isFinite(v) ? Math.round(v) : 0;
    return Math.max(0, dur !== null ? Math.min(dur, x) : x);
  };
  const prepared = raw
    .map((s, i) => ({ s, i, start: clamp(s.startMs), end: clamp(s.endMs) }))
    .map((x) => ({ ...x, end: Math.max(x.start, x.end) }))
    .sort((a, b) => a.start - b.start || a.i - b.i);

  const out: OutSegment[] = [];
  let lastStart = 0;
  for (const { s, start: st, end: en } of prepared) {
    const c = cleanText(s.text);
    const rawHasContent = /\S/.test(String(s.text ?? ''));
    // Zero-length fragments with no content carry nothing (artifacts); everything else is kept, incl. [inaudible].
    if (en - st < 50 && !rawHasContent && !(s.flags ?? []).includes('no_timestamp')) continue;
    const start = Math.max(st, lastStart);
    const end = Math.max(en, start);
    lastStart = start;
    const conf = clampConf(s.confidence);
    const seg: OutSegment = { startMs: start, endMs: end, text: c.text, confidence: conf, flags: flagsFor(c.inaudible, c.partial, conf, s.flags), speaker: s.speaker ?? null };
    const prev = out[out.length - 1];
    const timed = !seg.flags.includes('no_timestamp') && prev && !prev.flags.includes('no_timestamp');
    if (prev && timed && prev.speaker === seg.speaker && seg.startMs - prev.endMs <= MERGE_GAP_MS) {
      const prevInaudible = prev.text === INAUDIBLE_TOKEN;
      const curInaudible = seg.text === INAUDIBLE_TOKEN;
      const tiny = seg.endMs - seg.startMs < MERGE_TINY_MS;
      if ((prevInaudible && curInaudible) || (tiny && !prevInaudible && !curInaudible)) {
        prev.text = prevInaudible ? INAUDIBLE_TOKEN : joinText(prev.text, seg.text);
        prev.endMs = Math.max(prev.endMs, seg.endMs);
        prev.confidence = minConf(prev.confidence, seg.confidence);
        prev.flags = flagsFor(prev.text === INAUDIBLE_TOKEN, prev.text.includes(INAUDIBLE_TOKEN), prev.confidence, [...prev.flags, ...seg.flags]);
        continue;
      }
    }
    out.push(seg);
  }
  return out;
}

export function qualitySummary(segs: { text: string; flags: string[] }[]) {
  return {
    segmentCount: segs.length,
    inaudibleCount: segs.filter((s) => s.flags.includes('inaudible')).length,
    lowConfidenceCount: segs.filter((s) => s.flags.includes('low_confidence')).length,
  };
}
