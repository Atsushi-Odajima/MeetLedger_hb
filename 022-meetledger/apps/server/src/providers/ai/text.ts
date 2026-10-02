// Text helpers shared by the local rule extractor and the server-side validator of AI output.
import { INAUDIBLE_TOKEN, tokenSet } from '@meetledger/shared';

const INAUDIBLE_RE = /\[\s*inaudible\s*\]/gi;

/** Removes "[inaudible]" markers (they must never be "completed" by anybody). */
export function stripInaudible(s: string): string {
  return s.replace(INAUDIBLE_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** Normalized form for containment checks: NFKC, lower case, no whitespace / punctuation / symbols, no inaudible markers. */
export function norm(s: string): string {
  return stripInaudible(s.normalize('NFKC')).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** true when `needle` (normalized, non-empty) is contained in `hay` (normalized). */
export function containsNorm(hay: string, needle: string): boolean {
  const n = norm(needle);
  return n.length > 0 && norm(hay).includes(n);
}

/** Share of `part`'s tokens (CJK bigrams / latin words) that also occur in `whole`. 0 when `part` has no tokens. */
export function coverage(part: string, whole: string | Set<string>): number {
  const a = tokenSet(stripInaudible(part));
  if (!a.size) return 0;
  const b = typeof whole === 'string' ? tokenSet(stripInaudible(whole)) : whole;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / a.size;
}

/** A segment consisting only of inaudible markers / punctuation, or explicitly flagged, carries no usable content. */
export function isInaudibleSegment(s: { text: string; flags?: string[] | null }): boolean {
  if (s.flags?.some((f) => f === 'inaudible' || f === INAUDIBLE_TOKEN)) return true;
  return norm(s.text).length === 0;
}

/** Splits an utterance into sentences (JA 。！？ / EN . ! ? / newlines). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.match(/[^。！？!?．]+[。！？!?．]*/g) ?? [];
    for (const p of parts) {
      // English sentences separated by ". " followed by an upper-case letter.
      for (const q of p.split(/(?<=\.)\s+(?=[A-Z])/)) {
        const t = q.trim();
        if (t.length >= 2) out.push(t);
      }
    }
  }
  return out;
}

/** Removes leading conversational fillers and trailing punctuation for item text. */
export function cleanSentence(s: string): string {
  let t = s.trim();
  for (let i = 0; i < 4; i++) {
    const next = t.replace(/^(では|じゃあ|それでは|それじゃあ|なので|ということで|結論として|結論は|最終的に|はい|えー|えっと|あの|まず|あと|では、|OK|Ok|ok|So|so|Okay|okay|Alright|alright)[、,，\s]+/u, '');
    if (next === t) break;
    t = next;
  }
  return t.replace(/[。．.!！]+$/u, '').trim();
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------------------------------------------------------------- patterns

/** Explicit first-person subject markers (the speaker is the actor). */
export const FIRST_PERSON_RE =
  /(私|わたし|わたくし|僕|ぼく|俺|自分)(が|の方で|のほうで|から|で)|こちらで|こちらから|当方で|当方から|弊社で|弊社から|\bI'll\b|\bI will\b|\bI am going to\b|\bI'm going to\b|\bI can\b|\bwe'll\b|\bwe will\b|\bwe are going to\b|\bwe're going to\b/i;

/** Humble (謙譲) verb forms are first-person by grammar (お送りします / ご連絡いたします). */
export const HUMBLE_RE = /(お|ご)[一-龥ぁ-ん]{1,6}(いたします|致します|します|申し上げます)/;

/** Honorific name reference: 田中さん / 山田様 / Suzuki-san. Group 1 = name. */
export const NAME_HONORIFIC = '([一-龥々]{1,6}|[ァ-ヶー]{2,10}|[A-Za-z]{2,20})(?:さん|様|さま|氏|くん|君|部長|課長|先生)';

const EN_NAME_STOP = new Set([
  'I', 'We', 'You', 'They', 'He', 'She', 'It', 'This', 'That', 'The', 'Someone', 'Somebody', 'Everyone', 'Anyone', 'Nobody', 'There', 'Then', 'So', 'And', 'But', 'Also', 'Please', 'Let', 'Who',
]);
export function isEnglishNameCandidate(s: string): boolean {
  return !EN_NAME_STOP.has(s);
}
