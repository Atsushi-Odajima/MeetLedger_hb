// Contradiction candidates between a new decision and a confirmed, currently active decision.
// Match: same topic_key, or similar text (token Jaccard). Conflict: differing values (dates, numbers, prices) or,
// for the same topic, a differing "value part" ("公開日は[10月]にします" vs "公開日は[11月]に変更しましょう").
// Results are candidates for a human; nothing is superseded automatically.
import { jaccard, tokenSet } from '@meetledger/shared';
import { norm } from '../../providers/ai/text';

const VALUE_RE = new RegExp(
  [
    '(?:\\d{4}年)?\\d{1,2}月(?:\\d{1,2}日)?(?:上旬|中旬|下旬|末|中)?',
    '\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}',
    '\\d{1,2}/\\d{1,2}',
    '\\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?\\s+\\d{1,2}\\b',
    '\\b(?:january|february|march|april|june|july|august|september|october|november|december)\\b',
    'q[1-4]\\b',
    '第[1-4一二三四]四半期',
    '[$¥￥€]\\s?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:k|m|万|億|千)?',
    '\\d[\\d,]*(?:\\.\\d+)?\\s*(?:万|億|千|百)?\\s*(?:円|ドル|ユーロ|%|％|パーセント|人|名|件|社|日間|週間|か月|ヶ月|カ月|時間|分|個|本|台|k\\b|m\\b|usd\\b|jpy\\b)?',
  ].join('|'),
  'gi',
);

/** Values mentioned in a decision (normalized). */
export function valueSet(text: string): Set<string> {
  const t = text.normalize('NFKC').toLowerCase();
  const out = new Set<string>();
  for (const m of t.matchAll(VALUE_RE)) {
    const v = m[0].replace(/[\s,]/g, '');
    if (v) out.add(v);
  }
  return out;
}

const VERB_TAIL =
  /(?:に|で|と)?(?:することに(?:します|しました|なりました)|ことに(?:します|しました|なりました)|変更(?:します|しましょう|となりました|になりました)?|決定(?:です|しました|します)?|決まりました|決めました|決めましょう|にしましょう|しましょう|します|しました|行きましょう|いきましょう|進めましょう|進めます|合意(?:しました|します)?|承認(?:しました|します|されました)?|確定(?:です|しました)?)\s*[。.!！]*$/u;

/** "公開日は10月にします" (topic 公開日) -> "10月". */
export function valuePart(text: string, topic: string | null): string | null {
  if (!topic) return null;
  const t = text.normalize('NFKC');
  const tp = topic.normalize('NFKC');
  const i = t.indexOf(tp);
  if (i < 0) return null;
  let rest = t.slice(i + tp.length).replace(/^(?:については|について|の件は|の件|は|も|を)\s*/u, '');
  let prev = '';
  while (prev !== rest) {
    prev = rest;
    rest = rest.replace(VERB_TAIL, '').trim();
  }
  rest = rest.replace(/^(?:[、,]\s*)/, '').replace(/[にでと]$/u, '');
  return norm(rest) ? rest : null;
}

export interface DecisionLike {
  text: string;
  topic: string | null;
  topicKey: string | null;
}

const fmt = (s: Set<string>) => [...s].join('・');

/** Returns a human-readable reason when `next` likely changes/contradicts `existing`, otherwise null. */
export function contradictionReason(next: DecisionLike, existing: DecisionLike): string | null {
  if (norm(next.text) === norm(existing.text)) return null;
  const sameTopic = !!next.topicKey && next.topicKey === existing.topicKey;
  const sim = jaccard(tokenSet(next.text), tokenSet(existing.text));
  if (!sameTopic && sim < 0.3) return null;
  const label = existing.topic ?? next.topic;
  const head = label ? `「${label}」について既存の決定と異なる可能性があります` : '類似した既存の決定と異なる可能性があります';
  const va = valueSet(next.text);
  const vb = valueSet(existing.text);
  if (va.size && vb.size) {
    if ([...va].every((v) => vb.has(v)) && [...vb].every((v) => va.has(v))) return null;
    return `${head}（既存: ${fmt(vb)} / 新: ${fmt(va)}）`;
  }
  if (sameTopic) {
    const pa = valuePart(next.text, next.topic);
    const pb = valuePart(existing.text, existing.topic);
    if (pa && pb && norm(pa) !== norm(pb)) return `${head}（既存: ${pb} / 新: ${pa}）`;
  }
  return null;
}
