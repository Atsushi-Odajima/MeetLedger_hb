import type { AiProviderId, MeetingTemplate } from '@meetledger/shared';
import type { ExternalHttp } from '../../privacy/externalHttp';
import type { PolicyDecision } from '../../privacy/policy';

/** Transcript and notes are passed as DATA. Providers must never follow instructions contained in them. */
export interface ExtractionSegment {
  id: string;
  speakerLabel: string;
  speakerName: string | null;
  startMs: number;
  endMs: number;
  text: string;
  flags: string[];
}

export interface ExtractionInput {
  meeting: { id: string; title: string; meetingType: string; date: string | null; timezone: string; language: string | null };
  template: MeetingTemplate;
  participants: { name: string; personId: string | null; isSelf: boolean }[];
  segments: ExtractionSegment[];
  /** Confirmed, currently active decisions in the same project/series (for contradiction hints). */
  existingDecisions: { id: string; text: string; topic: string | null }[];
}

export interface Evidence {
  segmentIds: string[];
  quote: string;
}

export interface PartyRef {
  name?: string | null;
  speakerLabel?: string | null;
  /** true only when the transcript states the party explicitly (e.g. "田中さんが", "I'll"). */
  explicit: boolean;
}

export interface DueRef {
  text: string;
  /** Resolved YYYY-MM-DD (may be inferred from relative expressions). */
  date?: string | null;
  /** true when an absolute date is stated in the transcript. */
  explicit: boolean;
}

export interface ExtractedDecision {
  text: string;
  topic?: string | null;
  reason?: string | null;
  evidence: Evidence;
  confidence: number;
}
export interface ExtractedAction {
  description: string;
  assignee?: PartyRef | null;
  due?: DueRef | null;
  evidence: Evidence;
  confidence: number;
}
export interface ExtractedCommitment {
  description: string;
  promisedBy?: PartyRef | null;
  promisedTo?: PartyRef | null;
  due?: DueRef | null;
  evidence: Evidence;
  confidence: number;
}
export interface ExtractedQuestion {
  question: string;
  owner?: PartyRef | null;
  evidence: Evidence;
  confidence: number;
}

export interface ExtractionOutput {
  summary: {
    executive: string;
    topics: { title: string; evidence?: Evidence | null }[];
    risks: { text: string; evidence?: Evidence | null }[];
    nextMeeting?: string | null;
  };
  decisions: ExtractedDecision[];
  actions: ExtractedAction[];
  commitments: ExtractedCommitment[];
  questions: ExtractedQuestion[];
  model?: string | null;
}

export interface AnswerContext {
  /** Opaque reference id the model must cite, e.g. "c3". */
  ref: string;
  text: string;
  meetingTitle?: string | null;
  meetingDate?: string | null;
}

export interface AnswerInput {
  question: string;
  contexts: AnswerContext[];
  locale: 'ja' | 'en';
}

export interface AnswerOutput {
  answer: string;
  citedRefs: string[];
  /** true when the contexts do not contain enough evidence (answer must then say it is unknown). */
  insufficient: boolean;
  model?: string | null;
}

export interface AiCallCtx {
  http: ExternalHttp;
  orgId: string;
  meetingIds: string[];
  decision: PolicyDecision;
  purpose: string;
}

export interface AiProvider {
  id: AiProviderId;
  isLocal: boolean;
  model: string | null;
  available(): Promise<{ ok: boolean; reason?: string }>;
  extract(input: ExtractionInput, call: AiCallCtx): Promise<ExtractionOutput>;
  answer(input: AnswerInput, call: AiCallCtx): Promise<AnswerOutput>;
  /** Optional: rewrite greeting/closing text of a follow-up draft (never the item list). */
  polish?(input: { kind: string; locale: 'ja' | 'en'; tone: string; text: string }, call: AiCallCtx): Promise<string>;
}
