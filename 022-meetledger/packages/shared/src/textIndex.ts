// Locale-independent tokenizer for Japanese + English full-text search.
// CJK runs are split into overlapping bigrams (like pg_bigm); Latin/digit runs become lower-cased words.
// We build PostgreSQL tsvector / tsquery *literals* ourselves so no PostgreSQL text-search parser,
// dictionary or OS locale is involved (works identically on every install).

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー々〆ヶ';
// Second alternative excludes CJK so that "ProofFlowは10月" splits into proofflow / は... / 10 / 月.
const RUN_RE = new RegExp(`([${CJK}]+)|((?:(?![${CJK}])[\\p{L}\\p{N}_])+)`, 'gu');
const CJK_ONLY_RE = new RegExp(`^[${CJK}]+$`, 'u');

export const MAX_INDEX_TOKENS = 20000;
const MAX_POSITIONS_PER_LEXEME = 256;
const MAX_POSITION = 16383;

export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

export interface Token {
  t: string;
  /** true when this token is a single CJK character (only possible for 1-char runs or 1-char queries). */
  single?: boolean;
}

/** Tokenize text for indexing. Positions are the array index + 1. */
export function tokenize(text: string, limit = MAX_INDEX_TOKENS): Token[] {
  const out: Token[] = [];
  const norm = normalizeText(text);
  for (const m of norm.matchAll(RUN_RE)) {
    if (m[1]) {
      const chars = Array.from(m[1]);
      if (chars.length === 1) out.push({ t: chars[0], single: true });
      else for (let i = 0; i < chars.length - 1; i++) out.push({ t: chars[i] + chars[i + 1] });
    } else if (m[2]) {
      out.push({ t: m[2] });
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

function esc(lexeme: string): string {
  return lexeme.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

/** Build a tsvector literal (cast with ::tsvector). */
export function toTsvectorLiteral(text: string): string {
  const tokens = tokenize(text);
  const map = new Map<string, number[]>();
  tokens.forEach((tok, i) => {
    const pos = Math.min(i + 1, MAX_POSITION);
    const arr = map.get(tok.t);
    if (!arr) map.set(tok.t, [pos]);
    else if (arr.length < MAX_POSITIONS_PER_LEXEME && arr[arr.length - 1] !== pos) arr.push(pos);
  });
  return Array.from(map, ([t, ps]) => `'${esc(t)}':${ps.join(',')}`).join(' ');
}

/**
 * Build a tsquery literal (cast with ::tsquery). Whitespace separated terms are AND-ed;
 * tokens inside a term must be adjacent (phrase, `<->`). A single CJK char becomes a prefix match.
 * Returns null when the query has no searchable tokens.
 */
export function toTsqueryLiteral(query: string, mode: 'and' | 'or' = 'and'): string | null {
  const terms = query.split(/[\s　]+/).filter(Boolean);
  const parts: string[] = [];
  for (const term of terms) {
    const toks = tokenize(term, 64);
    if (!toks.length) continue;
    const lex = toks.map((tok) => {
      const single = tok.single || (Array.from(tok.t).length === 1 && CJK_ONLY_RE.test(tok.t));
      return single ? `'${esc(tok.t)}':*` : `'${esc(tok.t)}'`;
    });
    parts.push(lex.length === 1 ? lex[0] : `(${lex.join(' <-> ')})`);
  }
  if (!parts.length) return null;
  return parts.join(mode === 'and' ? ' & ' : ' | ');
}

/** Token set used for lexical similarity (e.g. decision topic matching, local-hash embeddings). */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text, 2000).map((t) => t.t));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
