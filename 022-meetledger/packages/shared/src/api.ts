// DTOs returned by the HTTP API (camelCase). Server maps DB rows -> these shapes.
import type {
  ActionStatus,
  AudioRetention,
  CommitmentStatus,
  ConsentState,
  ContradictionStatus,
  DecisionStatus,
  FollowupKind,
  FollowupStatus,
  MeetingSource,
  MeetingStatus,
  MeetingType,
  QuestionStatus,
  ReviewState,
  Role,
  TranscriptionMode,
  Visibility,
} from './enums';

export interface SourceRef {
  meetingId: string | null;
  meetingTitle?: string | null;
  meetingDate?: string | null;
  segmentIds: string[];
  startMs: number | null;
  endMs: number | null;
  quote: string | null;
  /** 'ok' | 'edited' (segment text changed after extraction) | 'missing' (segment deleted / transcript replaced) */
  status?: 'ok' | 'edited' | 'missing';
}

export interface MeDto {
  user: { id: string; email: string; name: string; locale: string; timezone: string };
  orgs: { id: string; name: string; role: Role; isSample: boolean }[];
  workspaces: { id: string; orgId: string; name: string; role: Role; isSample: boolean }[];
  csrfToken: string;
}

export interface MeetingDto {
  id: string;
  workspaceId: string;
  title: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  startedAt: string | null;
  endedAt: string | null;
  source: MeetingSource;
  calendarEventId: string | null;
  meetingType: MeetingType;
  projectId: string | null;
  seriesId: string | null;
  templateKey: string | null;
  visibility: Visibility;
  consentState: ConsentState;
  audioRetention: AudioRetention;
  audioRetentionDays: number | null;
  transcriptionMode: TranscriptionMode;
  aiEnabled: boolean;
  isConfidential: boolean;
  status: MeetingStatus;
  createdBy: string;
  organizerPersonId: string | null;
  version: number;
  participants?: ParticipantDto[];
  createdAt: string;
  updatedAt: string;
}

export interface ParticipantDto {
  id: string;
  personId: string | null;
  displayName: string;
  email: string | null;
  role: 'organizer' | 'attendee' | 'optional';
  userId: string | null;
}

export interface PersonDto {
  id: string;
  name: string;
  organization: string | null;
  roleTitle: string | null;
  email: string | null;
  notes: string | null;
  tags: string[];
  userId: string | null;
  lastMeetingAt?: string | null;
  nextMeetingAt?: string | null;
  openCommitments?: number;
}

export interface SegmentDto {
  id: string;
  seq: number;
  startMs: number;
  endMs: number;
  speakerId: string | null;
  speakerLabel: string;
  speakerName: string | null;
  text: string;
  confidence: number | null;
  flags: string[];
  revision: number;
}

export interface SpeakerDto {
  id: string;
  label: string;
  personId: string | null;
  displayName: string | null;
  source: 'diarization' | 'channel' | 'manual' | 'import' | 'none';
  suggestion?: string | null;
}

export interface TranscriptDto {
  id: string;
  meetingId: string;
  version: number;
  provider: string;
  language: string | null;
  isLocal: boolean;
  qualityFlags: Record<string, unknown>;
  createdAt: string;
  segments: SegmentDto[];
  speakers: SpeakerDto[];
}

export interface SummaryDto {
  id: string;
  meetingId: string;
  version: number;
  provider: string;
  model: string | null;
  aiGenerated: true;
  sections: {
    executive: string;
    topics: { title: string; source: SourceRef | null }[];
    risks: { text: string; source: SourceRef | null }[];
    nextMeeting: string | null;
  };
  createdAt: string;
}

interface LedgerBase {
  id: string;
  workspaceId: string;
  meetingId: string | null;
  projectId: string | null;
  source: SourceRef | null;
  confidence: number | null;
  extractedBy: 'ai' | 'user' | 'import';
  aiProvider: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionDto extends LedgerBase {
  text: string;
  topic: string | null;
  decidedAt: string | null;
  ownerPersonId: string | null;
  reason: string | null;
  reviewState: ReviewState;
  status: DecisionStatus;
  supersedesDecisionId: string | null;
  supersededByDecisionId: string | null;
  participants: string[];
}

export interface ActionDto extends LedgerBase {
  description: string;
  assigneePersonId: string | null;
  assigneeUserId: string | null;
  assigneeText: string | null;
  assigneeInferred: boolean;
  dueDate: string | null;
  dueText: string | null;
  dueInferred: boolean;
  status: ActionStatus;
  overdue: boolean;
  linkedDecisionId: string | null;
  externalSyncState: 'none' | 'pending_approval' | 'synced' | 'failed';
}

export interface CommitmentDto extends LedgerBase {
  description: string;
  promisedByPersonId: string | null;
  promisedByText: string | null;
  promisedToPersonId: string | null;
  promisedToText: string | null;
  /** 'mine' = promised by the current user, 'theirs' = promised to the current user / us, 'other' */
  direction: 'mine' | 'theirs' | 'other';
  dueDate: string | null;
  dueText: string | null;
  dueInferred: boolean;
  status: CommitmentStatus;
  overdue: boolean;
}

export interface QuestionDto extends LedgerBase {
  question: string;
  ownerPersonId: string | null;
  dueDate: string | null;
  status: QuestionStatus;
  answerText: string | null;
}

export interface ContradictionDto {
  id: string;
  existingDecision: DecisionDto;
  newDecision: DecisionDto;
  reason: string;
  status: ContradictionStatus;
  createdAt: string;
}

export interface FollowupDraftDto {
  id: string;
  meetingId: string;
  kind: FollowupKind;
  subject: string | null;
  body: string;
  status: FollowupStatus;
  generatedBy: 'template' | 'ai';
  referencedItems: { type: string; id: string }[];
  createdAt: string;
}

export interface CitationDto {
  id: string;
  entityType: string;
  entityId: string;
  meetingId: string | null;
  meetingTitle: string | null;
  meetingDate: string | null;
  startMs: number | null;
  endMs: number | null;
  snippet: string;
}

export interface AskResponseDto {
  answer: string;
  insufficient: boolean;
  citations: CitationDto[];
  provider: string;
  aiGenerated: boolean;
  excludedMeetings: number;
}

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}
