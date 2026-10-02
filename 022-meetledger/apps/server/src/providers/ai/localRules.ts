// 'local-rules': deterministic JA/EN rule-based extractor. Never touches the network.
// It only ever quotes sentences that exist in the input, so every item is grounded by construction.
// Limits (documented in docs/AI_EXTRACTION.md): no coreference, no cross-sentence reasoning, keyword based.
import type {
  AiProvider,
  AnswerInput,
  AnswerOutput,
  Evidence,
  ExtractedAction,
  ExtractedCommitment,
  ExtractedDecision,
  ExtractedQuestion,
  ExtractionInput,
  ExtractionOutput,
  ExtractionSegment,
  PartyRef,
} from './types';
import { findDue } from './dueDate';
import { FIRST_PERSON_RE, NAME_HONORIFIC, cleanSentence, isEnglishNameCandidate, isInaudibleSegment, splitSentences, stripInaudible, truncate } from './text';

export const LOCAL_RULES_MODEL = 'rules-v1';

// ---------------------------------------------------------------- classification patterns
const UNDECIDED_RE =
  /未定|要確認|確認が必要|確認する必要|決まっていない|決まってない|決まっていません|決めていない|決まらず|合意に至らず|わからない|分からない|わかりません|分かりません|不明です|\bTBD\b|\bTBC\b|to be (?:confirmed|determined|decided)|not (?:yet )?decided|haven't decided|have not decided|not sure|unclear|open question/i;
const QUESTION_END_RE = /([?？]\s*$)|((ですか|ますか|でしょうか|ませんか|のか|かな)[。.]?\s*$)/;
const REQUEST_QUESTION_RE = /お願いできますか|お願いできませんか|してもらえますか|してもらえませんか|していただけますか|していただけませんか|頂けますか|いただけますか|\bcan you\b|\bcould you\b|\bwould you\b/i;
const PROPOSAL_RE = /ましょうか|しませんか/;
const TRIVIAL_QUESTION_RE = /^(よろしいですか|いいですか|大丈夫ですか|聞こえますか|見えますか|始めましょうか|はじめましょうか|ありますか|他にありますか|ほかにありますか|any questions|can you hear me|ok)[?？。.]?$/i;

const COMMIT_JA_RE =
  /(お送り|送付|ご共有|共有|ご連絡|連絡|ご報告|報告|ご提出|提出|ご回答|回答|ご返信|返信|お返事|ご用意|用意|ご案内|案内|お知らせ|お届け|お持ち)(?:いたし|致し|し|させていただき|させて頂き)ます|送ります|届けます|持っていきます|折り返します/;
const COMMIT_EN_RE =
  /\b(?:I'll|I will|I'm going to|I am going to|we'll|we will|we're going to|we are going to)\s+(?:also\s+)?(?:send|share|email|e-mail|forward|get back|follow up|provide|deliver|circulate|submit|reply|send over)\b/i;

const DECISION_JA_RE =
  /決定|決まりました|決まりです|決まりね|に決め(?:ました|ましょう)|決めました|にしましょう|ことにします|ことにしました|ことになりました|で行きましょう|でいきましょう|で進めましょう|で進めます|合意|承認|にします|にしました|に変更します|に変更しましょう|に変更となりました|に変更になりました|で確定|確定しました/;
const DECISION_EN_RE = /\bwe(?: have|'ve)? decided\b|\blet'?s go with\b|\bagreed\b|\bwe(?:'ll| will) go with\b|\bdecision is\b|\bdecided to\b|\bit's decided\b|\bfinali[sz]ed\b/i;

const ACTION_JA_RE =
  /してください|して下さい|をお願いします|お願いします|お願いいたします|しておいて|しておきます|対応します|やります|やっておきます|作成します|修正します|準備します|確認します|調整します|検討します|まとめます|進めます|手配します|更新します|作ります|直します|必要があります|必要です|しないといけません|しなければなりません|TODO|ToDo|宿題|アクションアイテム/;
const ACTION_EN_RE =
  /\b(?:action item|todo|to-do|please|need to|needs to|have to|has to|will (?:prepare|create|update|review|check|fix|draft|schedule|set up|look into|investigate|write)|I'll (?:prepare|create|update|review|check|fix|draft|schedule|set up|look into|investigate|write|handle|take care))\b/i;
const GREETING_RE = /よろしくお願い|ありがとうございました|お疲れさまでした|お疲れ様でした/;

const RISK_RE = /リスク|懸念|心配|遅れ|遅延|間に合わ|ボトルネック|ブロッカー|課題|問題があ|\brisk\b|\bconcern|\bblocker|\bdelay|\bslip/i;
const NEXT_MEETING_RE = /次回|次の(?:打ち合わせ|会議|ミーティング|定例|MTG)|\bnext (?:meeting|call|sync|session)\b/i;

// ---------------------------------------------------------------- topic extraction
const TOPIC_STOP = new Set(['我々', '私', '私たち', '弊社', '当社', '御社', '貴社', 'こちら', 'それ', 'これ', 'あれ', '今回', '本日', '今日', '方針', 'we', 'it', 'this', 'that']);
const DECISION_VERB_TAIL =
  '(?:決定|決ま|に決め|決めま|にしましょう|ことにし|ことになり|で行き|でいき|で進め|合意|承認|にします|にしました|に変更|で確定|確定し|と(?:します|しました|する))';

/** "公開日は10月にします" → "公開日". null when no clear topic. */
export function extractTopic(sentence: string): string | null {
  const s = cleanSentence(sentence.normalize('NFKC'));
  const clauses = s.split(/[、,，]/);
  for (const clause of clauses) {
    const m = clause.match(new RegExp(`^(.{1,24}?)(?:については|について|の件は|の件|は|も)(?=.*${DECISION_VERB_TAIL})`));
    if (m) {
      const t = m[1].replace(/^(では|じゃあ|それでは|なので|結論として|最終的に)/, '').trim();
      if (t && !TOPIC_STOP.has(t.toLowerCase()) && !/[?？]/.test(t)) return truncate(t, 60);
    }
  }
  const en = s.match(/\b(?:the|our)\s+([a-z][a-z0-9 \-]{1,30}?)\s+(?:is|will be|to be|should be|stays|remains)\b/i) ?? s.match(/\bfor the\s+([a-z][a-z0-9 \-]{1,30}?)\b/i);
  if (en && !TOPIC_STOP.has(en[1].toLowerCase())) return en[1].trim();
  return null;
}

// ---------------------------------------------------------------- parties
function speakerParty(seg: ExtractionSegment, explicit: boolean): PartyRef {
  return { speakerLabel: seg.speakerLabel, name: seg.speakerName, explicit };
}

/** Explicit assignee of a task sentence, or null. Never guesses. */
export function findAssignee(sentence: string, seg: ExtractionSegment): PartyRef | null {
  const s = sentence.normalize('NFKC');
  const subj = s.match(new RegExp(`${NAME_HONORIFIC}(?:が|の方で|のほうで|で対応)`));
  if (subj) return { name: subj[1], speakerLabel: null, explicit: true };
  const voc = s.match(new RegExp(`^(?:では|じゃあ|それでは)?[、,]?\\s*${NAME_HONORIFIC}[、,]`));
  if (voc && /ください|下さい|お願い|頼みます|もらえ|いただけ|頂け/.test(s)) return { name: voc[1], speakerLabel: null, explicit: true };
  if (FIRST_PERSON_RE.test(s) && !/(?:してください|して下さい|\bplease\b|\bcan you\b|\bcould you\b)/i.test(s)) return speakerParty(seg, true);
  const en = s.match(/\b([A-Z][a-z]{1,20})\s+(?:will|is going to|is to|has to|needs to)\b/) ?? s.match(/^([A-Z][a-z]{1,20}),\s+(?:please|can you|could you)\b/);
  if (en && isEnglishNameCandidate(en[1])) return { name: en[1], speakerLabel: null, explicit: true };
  return null;
}

/** Promiser: an explicit named subject, otherwise the speaker (commitments are first-person by definition). */
function findPromiser(sentence: string, seg: ExtractionSegment): PartyRef {
  const s = sentence.normalize('NFKC');
  const subj = s.match(new RegExp(`${NAME_HONORIFIC}(?:が|の方で|のほうで|から)`));
  if (subj) return { name: subj[1], speakerLabel: null, explicit: true };
  const en = s.match(/\b([A-Z][a-z]{1,20})\s+(?:will|is going to)\b/);
  if (en && isEnglishNameCandidate(en[1])) return { name: en[1], speakerLabel: null, explicit: true };
  return speakerParty(seg, true);
}

function findPromisee(sentence: string): PartyRef | null {
  const s = sentence.normalize('NFKC');
  const m = s.match(new RegExp(`${NAME_HONORIFIC}(?:に|へ|宛)`));
  if (m) return { name: m[1], speakerLabel: null, explicit: true };
  const g = s.match(/(御社|貴社|先方|皆さん|皆様|みなさん|お客様)(?:に|へ)/);
  if (g) return { name: g[1], speakerLabel: null, explicit: true };
  const en = s.match(/\b(?:send|share|email|forward|deliver|provide)\b[^.]*?\bto\s+([A-Z][a-z]{1,20})\b/);
  if (en && isEnglishNameCandidate(en[1])) return { name: en[1], speakerLabel: null, explicit: true };
  return null;
}

// ---------------------------------------------------------------- classification
export type SentenceKind = 'decision' | 'action' | 'commitment' | 'question' | null;

export function classifySentence(sentence: string): SentenceKind {
  const s = stripInaudible(sentence.normalize('NFKC'));
  if (s.length < 4) return null;
  if (UNDECIDED_RE.test(s)) return 'question';
  const isQ = QUESTION_END_RE.test(s);
  if (isQ) {
    if (REQUEST_QUESTION_RE.test(s)) return 'action';
    if (PROPOSAL_RE.test(s) && !/[?？]\s*$/.test(s)) return null;
    if (TRIVIAL_QUESTION_RE.test(s.trim()) || s.length < 6) return null;
    return 'question';
  }
  if (/ません(?!か)/.test(s) && !/決定|ことにし/.test(s)) {
    // negated statements ("送りません") are neither promises nor tasks; decisions may still be negative ("延期しないことにします").
    if (!DECISION_JA_RE.test(s)) return null;
  }
  if (COMMIT_JA_RE.test(s) || COMMIT_EN_RE.test(s)) return 'commitment';
  if (DECISION_JA_RE.test(s) || DECISION_EN_RE.test(s)) {
    if (/\bnot agreed\b|\bdisagree/i.test(s)) return 'question';
    return 'decision';
  }
  if (GREETING_RE.test(s) && !/(してください|対応|作成|確認|送)/.test(s)) return null;
  if (ACTION_JA_RE.test(s) || ACTION_EN_RE.test(s)) return 'action';
  return null;
}

// ---------------------------------------------------------------- extraction
export function extractWithRules(input: ExtractionInput): ExtractionOutput {
  const rules = input.template.extractionRules;
  const base = input.meeting.date;
  const decisions: ExtractedDecision[] = [];
  const actions: ExtractedAction[] = [];
  const commitments: ExtractedCommitment[] = [];
  const questions: ExtractedQuestion[] = [];
  const topics: { title: string; evidence: Evidence }[] = [];
  const risks: { text: string; evidence: Evidence }[] = [];
  let nextMeeting: string | null = null;
  const seenTopics = new Set<string>();
  const addTopic = (title: string, ev: Evidence) => {
    const k = title.normalize('NFKC').toLowerCase();
    if (seenTopics.has(k) || topics.length >= 10) return;
    seenTopics.add(k);
    topics.push({ title, evidence: ev });
  };

  for (const seg of input.segments) {
    if (isInaudibleSegment(seg)) continue;
    for (const sentence of splitSentences(seg.text)) {
      const ev: Evidence = { segmentIds: [seg.id], quote: truncate(sentence, 480) };
      const text = truncate(cleanSentence(sentence), 1000);
      if (!stripInaudible(text)) continue;
      const kind = classifySentence(sentence);
      if (kind === 'decision' && rules.decisions) {
        const topic = extractTopic(sentence);
        decisions.push({ text, topic, reason: null, evidence: ev, confidence: 0.6 });
        if (topic) addTopic(topic, ev);
      } else if (kind === 'action' && rules.actions) {
        const due = findDue(sentence, base);
        actions.push({
          description: text,
          assignee: findAssignee(sentence, seg),
          due: due ? { text: due.text, date: due.date, explicit: due.explicit } : null,
          evidence: ev,
          confidence: 0.5,
        });
      } else if (kind === 'commitment' && (rules.commitments || rules.actions)) {
        const due = findDue(sentence, base);
        const item = {
          description: text,
          promisedBy: findPromiser(sentence, seg),
          promisedTo: findPromisee(sentence),
          due: due ? { text: due.text, date: due.date, explicit: due.explicit } : null,
          evidence: ev,
          confidence: 0.55,
        };
        if (rules.commitments) commitments.push(item);
        else actions.push({ description: item.description, assignee: item.promisedBy, due: item.due, evidence: ev, confidence: 0.5 });
      } else if (kind === 'question' && rules.questions) {
        questions.push({ question: text, owner: null, evidence: ev, confidence: 0.5 });
      }
      if (rules.risks && RISK_RE.test(sentence) && risks.length < 10) risks.push({ text, evidence: ev });
      if (!nextMeeting && NEXT_MEETING_RE.test(sentence)) nextMeeting = text;
      const about = sentence.normalize('NFKC').match(/([一-龥ァ-ヶー々A-Za-z0-9]{2,20})(?:について|の件)/);
      if (about && !TOPIC_STOP.has(about[1])) addTopic(about[1], ev);
      const aboutEn = sentence.match(/\b(?:about|regarding)\s+(?:the\s+)?([a-z][a-z0-9 \-]{2,30}?)(?:[.,?!]|$)/i);
      if (aboutEn) addTopic(aboutEn[1].trim(), ev);
    }
  }

  // Executive summary = counts + verbatim quotes of the first items (built only from transcript content).
  const en = input.meeting.language === 'en';
  const quote = (s: string) => (en ? `"${truncate(s, 120)}"` : `「${truncate(s, 120)}」`);
  const lines: string[] = [];
  if (decisions.length) lines.push((en ? 'Decision candidates: ' : '決定事項の候補: ') + decisions.slice(0, 3).map((d) => quote(d.text)).join(en ? ', ' : '、'));
  if (actions.length) lines.push((en ? 'Action candidates: ' : 'アクションの候補: ') + actions.slice(0, 3).map((a) => quote(a.description)).join(en ? ', ' : '、'));
  if (commitments.length) lines.push((en ? 'Commitment candidates: ' : '約束の候補: ') + commitments.slice(0, 3).map((c) => quote(c.description)).join(en ? ', ' : '、'));
  if (questions.length) lines.push((en ? 'Open question candidates: ' : '未解決の質問の候補: ') + questions.slice(0, 3).map((q) => quote(q.question)).join(en ? ', ' : '、'));
  if (!lines.length) lines.push(en ? 'No decisions, actions or commitments were detected by the local rules.' : 'ローカルルールでは決定事項・アクション・約束は検出されませんでした。');

  return {
    summary: { executive: lines.join('\n'), topics, risks, nextMeeting },
    decisions,
    actions,
    commitments,
    questions,
    model: LOCAL_RULES_MODEL,
  };
}

// ---------------------------------------------------------------- extractive answering
const QUESTION_WORDS = new Set(['何', '誰', '何時', '如何', '何処', 'what', 'who', 'when', 'where', 'why', 'how', 'which', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'we', 'i', 'you', 'it', 'about', 'there']);

/** Content keywords of a question: Kanji/Katakana runs (as bigrams, single chars kept) and latin words (minus stop words). */
export function questionKeywords(q: string): { strong: string[]; weak: string[] } {
  const s = q.normalize('NFKC').toLowerCase();
  const strong: string[] = [];
  const weak: string[] = [];
  for (const m of s.matchAll(/([一-龥々ァ-ヶー]+)|([a-z0-9][a-z0-9_\-]*)/gu)) {
    const run = m[1] ?? m[2];
    if (QUESTION_WORDS.has(run)) continue;
    if (m[2]) {
      if (run.length >= 2) strong.push(run);
      continue;
    }
    const chars = Array.from(run);
    if (chars.length === 1) weak.push(run);
    else for (let i = 0; i < chars.length - 1; i++) strong.push(chars[i] + chars[i + 1]);
  }
  return { strong: [...new Set(strong)], weak: [...new Set(weak)] };
}

export function relevance(q: { strong: string[]; weak: string[] }, text: string): number {
  const t = text.normalize('NFKC').toLowerCase();
  const total = q.strong.length + q.weak.length * 0.5;
  if (!total) return 0;
  let strongHits = 0;
  let score = 0;
  for (const k of q.strong) if (t.includes(k)) {
    strongHits++;
    score += 1;
  }
  for (const k of q.weak) if (t.includes(k)) score += 0.5;
  if (!strongHits) return 0;
  return score / total;
}

export function answerExtractive(input: AnswerInput): AnswerOutput {
  const kw = questionKeywords(input.question);
  const scored = input.contexts
    .map((c, i) => ({ c, i, s: relevance(kw, stripInaudible(c.text)) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, 3);
  if (!scored.length) {
    return { answer: input.locale === 'en' ? 'The record does not say.' : '記録からは分かりません', citedRefs: [], insufficient: true, model: LOCAL_RULES_MODEL };
  }
  const ordered = scored.sort((a, b) => a.i - b.i);
  const head = input.locale === 'en' ? 'The record contains the following statements:' : '記録では次のように発言されています:';
  const body = ordered.map((x) => (input.locale === 'en' ? `- "${truncate(x.c.text, 200)}"` : `- 「${truncate(x.c.text, 200)}」`));
  return { answer: [head, ...body].join('\n'), citedRefs: ordered.map((x) => x.c.ref), insufficient: false, model: LOCAL_RULES_MODEL };
}

export class LocalRulesProvider implements AiProvider {
  readonly id = 'local-rules' as const;
  readonly isLocal = true;
  readonly model = LOCAL_RULES_MODEL;
  async available() {
    return { ok: true };
  }
  async extract(input: ExtractionInput): Promise<ExtractionOutput> {
    return extractWithRules(input);
  }
  async answer(input: AnswerInput): Promise<AnswerOutput> {
    return answerExtractive(input);
  }
}
