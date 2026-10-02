// Text helpers for the search module. All full-text work uses the shared JA/EN tokenizer
// (packages/shared/src/textIndex.ts) and passes tsvector / tsquery LITERALS to PostgreSQL ($n::tsvector / $n::tsquery).
//
// Script boundary fix: the shared RUN_RE consumes "ProofFlowは10月公開予定" as ONE token because its
// Latin/digit alternative ([\p{L}\p{N}_]+) also matches CJK letters once a run starts with a Latin letter or digit.
// We insert a space at every CJK <-> non-CJK boundary before tokenizing, so mixed text such as "10月公開" is indexed as
// '10' '月公' '公開' (and queried as a phrase). For pure-CJK or pure-Latin text the output is identical to the shared one.
import { normalizeText, tokenize, toTsqueryLiteral, toTsvectorLiteral, tokenSet } from '@meetledger/shared';

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー々〆ヶ';
const WORD = '[\\p{L}\\p{N}_]';
const BOUNDARY_RE = new RegExp(`(?<=[${CJK}])(?=${WORD})(?![${CJK}])|(?<=${WORD})(?<![${CJK}])(?=[${CJK}])`, 'gu');
const HAS_CJK_RE = new RegExp(`[${CJK}]`, 'u');
const KANJI_KATA_RE = /[\p{Script=Han}\p{Script=Katakana}ー々ヶ]+/gu;

export function splitScripts(text: string): string {
  return text.replace(BOUNDARY_RE, ' ');
}

/** tsvector literal for indexing (cast with ::tsvector). */
export function indexTsv(text: string): string {
  return toTsvectorLiteral(splitScripts(text));
}

function esc(lexeme: string): string {
  return lexeme.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

function termPhrase(term: string): string | null {
  const toks = tokenize(splitScripts(term), 64);
  if (!toks.length) return null;
  const lex = toks.map((tok) => (tok.single ? `'${esc(tok.t)}':*` : `'${esc(tok.t)}'`));
  let p = lex.length === 1 ? lex[0] : `(${lex.join(' <-> ')})`;
  // Also accept tsvectors written with the unsplit shared tokenizer by other modules (before our re-index ran).
  const legacy = toTsqueryLiteral(term);
  if (legacy && legacy !== p && legacy !== lex[0]) p = `(${p} | ${legacy})`;
  return p;
}

/**
 * User query -> tsquery literal. Whitespace separated terms are AND-ed; each term is a phrase of its tokens
 * (so "10月公開" must appear contiguously). Returns null when nothing searchable remains.
 */
export function queryTsq(q: string, mode: 'and' | 'or' = 'and'): string | null {
  const parts = q
    .split(/[\s　]+/)
    .filter(Boolean)
    .slice(0, 16)
    .map(termPhrase)
    .filter((x): x is string => !!x);
  if (!parts.length) return null;
  return parts.join(mode === 'and' ? ' & ' : ' | ');
}

/** OR query over keywords (each keyword is a phrase). */
export function keywordsTsq(keywords: string[]): string | null {
  const parts = keywords.slice(0, 24).map(termPhrase).filter((x): x is string => !!x);
  return parts.length ? parts.join(' | ') : null;
}

/** Normalized form used for substring matching (NFKC, lower case, no whitespace). */
export function norm(text: string): string {
  return normalizeText(text).replace(/[\s　]+/g, '');
}

export function lexicalTokens(text: string): Set<string> {
  return tokenSet(splitScripts(text));
}

// ------------------------------------------------------------------ keyword extraction (ask)

const STOP_KEYWORDS = new Set(
  [
    '何', '誰', '全部', '全て', '内容', '会議', '会議室', 'ミーティング', '記録', '件', '今後', '状況', '一覧', '関連', 'データ', '情報', '表示', '全体',
    'ワークスペース', '全員', '全社', 'すべて',
    'what', 'who', 'when', 'where', 'which', 'how', 'why', 'did', 'does', 'do', 'we', 'i', 'you', 'they', 'the', 'a', 'an', 'and', 'or', 'of', 'to',
    'in', 'on', 'for', 'about', 'with', 'is', 'are', 'was', 'were', 'be', 'all', 'any', 'our', 'my', 'me', 'us', 'it', 'that', 'this', 'there', 'have',
    'has', 'had', 'tell', 'show', 'list', 'please', 'meeting', 'meetings', 'everything', 'anything', 'so', 'far', 'from', 'by', 'at',
  ].map((s) => s.normalize('NFKC').toLowerCase()),
);

/**
 * Content keywords of a (already scope-stripped) question:
 * - Latin / digit words (>= 2 chars, not stop words)
 * - Kanji / Katakana sequences (>= 2 chars). Long kanji compounds also contribute their 2-char parts.
 * Hiragana (particles, okurigana) never become keywords.
 */
export function extractKeywords(text: string): string[] {
  const out: string[] = [];
  const push = (k: string) => {
    if (k && !STOP_KEYWORDS.has(k) && !out.includes(k)) out.push(k);
  };
  const n = normalizeText(splitScripts(text));
  for (const piece of n.split(/[^\p{L}\p{N}_ー々〆ヶ]+/u)) {
    if (!piece) continue;
    if (!HAS_CJK_RE.test(piece)) {
      if (Array.from(piece).length >= 2) push(piece);
      continue;
    }
    for (const run of piece.match(KANJI_KATA_RE) ?? []) {
      const chars = Array.from(run);
      if (chars.length < 2) continue;
      push(run);
      const isKatakana = /^[\p{Script=Katakana}ー]+$/u.test(run);
      if (!isKatakana && chars.length >= 4) for (let i = 0; i + 1 < chars.length; i += 2) push(chars[i] + chars[i + 1]);
    }
  }
  return out.slice(0, 16);
}

/** Terms used for snippet highlighting of a user query. */
export function highlightTerms(q: string): string[] {
  const terms = new Set<string>();
  for (const term of q.split(/[\s　]+/).filter(Boolean)) {
    const t = normalizeText(term).trim();
    if (t) terms.add(t);
    for (const piece of normalizeText(splitScripts(term)).split(/\s+/)) if (piece && Array.from(piece).length >= 1) terms.add(piece);
  }
  return [...terms].filter((t) => /[\p{L}\p{N}]/u.test(t)).sort((a, b) => b.length - a.length);
}

// ------------------------------------------------------------------ snippets

export const HL_START = '[[';
export const HL_END = ']]';

/**
 * Builds a snippet around the first match. Matching happens on the NFKC/lower-cased text, but the snippet shows
 * the ORIGINAL characters. Returns the marked snippet ([[...]] around matches) and the plain snippet.
 */
export function makeSnippet(text: string, terms: string[], max = 160): { snippet: string; plain: string } {
  const src = text.replace(/\s+/g, ' ').trim();
  let normStr = '';
  const map: number[] = [];
  for (let i = 0; i < src.length; ) {
    const cp = src.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const n = ch.normalize('NFKC').toLowerCase();
    for (let k = 0; k < n.length; k++) map.push(i);
    normStr += n;
    i += ch.length;
  }
  map.push(src.length);
  const ranges: [number, number][] = [];
  for (const t of terms) {
    if (!t) continue;
    let from = 0;
    for (let guard = 0; guard < 50; guard++) {
      const at = normStr.indexOf(t, from);
      if (at < 0) break;
      const s = map[at];
      const e = map[at + t.length] ?? src.length;
      if (!ranges.some(([a, b]) => s < b && e > a)) ranges.push([s, e]);
      from = at + t.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const first = ranges[0]?.[0] ?? 0;
  let start = Math.max(0, first - Math.floor(max / 3));
  let end = Math.min(src.length, start + max);
  if (end - start < max) start = Math.max(0, end - max);
  // do not cut surrogate pairs
  if (start > 0 && /[\uDC00-\uDFFF]/.test(src[start])) start--;
  if (end < src.length && /[\uDC00-\uDFFF]/.test(src[end])) end++;
  const pre = start > 0 ? '…' : '';
  const post = end < src.length ? '…' : '';
  let marked = '';
  let pos = start;
  for (const [a, b] of ranges) {
    if (b <= start || a >= end) continue;
    const s = Math.max(a, start);
    const e = Math.min(b, end);
    marked += src.slice(pos, s) + HL_START + src.slice(s, e) + HL_END;
    pos = e;
  }
  marked += src.slice(pos, end);
  return { snippet: pre + marked + post, plain: pre + src.slice(start, end) + post };
}
