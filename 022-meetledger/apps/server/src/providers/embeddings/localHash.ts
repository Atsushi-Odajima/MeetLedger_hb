import { tokenize } from '@meetledger/shared';
import { splitScripts } from '../../modules/search/text';
import type { EmbeddingProvider } from './types';

export const LOCAL_HASH_DIMS = 384;
export const LOCAL_HASH_MODEL = 'local-hash-384';

const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆ヶ]/u;

function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic feature hashing ("hashing trick") of lexical features into `dims` buckets, L2-normalized.
 * Features: shared tokenize() tokens (CJK bigrams, Latin/digit words) with sublinear tf, plus CJK character unigrams
 * (lower weight). This is a LEXICAL similarity signal, not a semantic language model: synonyms without shared
 * characters (e.g. 価格 / 値段) are NOT close.
 */
export function hashEmbed(text: string, dims = LOCAL_HASH_DIMS): number[] {
  const v = new Float64Array(dims);
  const tf = new Map<string, number>();
  const bump = (k: string, w: number) => tf.set(k, (tf.get(k) ?? 0) + w);
  for (const tok of tokenize(splitScripts(text), 4000)) {
    bump(`t:${tok.t}`, 1);
    if (!tok.single && CJK_CHAR_RE.test(tok.t)) for (const ch of Array.from(tok.t)) bump(`u:${ch}`, 0.5);
    else if (tok.single) bump(`u:${tok.t}`, 0.5);
  }
  for (const [feat, count] of tf) {
    const h = fnv1a(feat, 0x811c9dc5);
    const sign = fnv1a(feat, 0x9747b28c) & 1 ? 1 : -1;
    v[h % dims] += sign * (1 + Math.log(count));
  }
  let n = 0;
  for (let i = 0; i < dims; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  const out = new Array<number>(dims);
  for (let i = 0; i < dims; i++) out[i] = n > 0 ? v[i] / n : 0;
  return out;
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'local-hash';
  readonly isLocal = true;
  readonly model = LOCAL_HASH_MODEL;
  readonly dims = LOCAL_HASH_DIMS;
  readonly description = 'lexical hashing embedding (no external call)';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashEmbed(t, this.dims));
  }
}
