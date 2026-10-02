// Web-side shapes for API responses that are not (yet) in @meetledger/shared/api.ts.
// Fields beyond the documented contract are optional: server modules are implemented in parallel and the UI must
// degrade gracefully when something is missing.
import type {
  ActionDto,
  AiProviderId,
  AudioRetention,
  CommitmentDto,
  ContradictionDto,
  DecisionDto,
  EmbeddingProviderId,
  MeetingDto,
  MeetingType,
  QuestionDto,
  Role,
  TranscriptionMode,
  Visibility,
} from '@meetledger/shared';

export interface PolicyDecisionDto {
  allowed: boolean;
  provider: string;
  isLocal: boolean;
  reason: string;
}

export interface WorkspaceSettingsDto {
  defaults: {
    visibility: Visibility;
    audioRetention: AudioRetention;
    audioRetentionDays: number | null;
    transcriptionMode: TranscriptionMode;
    aiEnabled: boolean;
  };
  transcription: { cloudAllowed: boolean; language: 'ja' | 'en' | 'auto' };
  ai: { provider: AiProviderId; cloudAllowed: boolean; embeddings: EmbeddingProviderId };
  retention: { transcriptDays: number | null; aiIndexDays: number | null; artifactDays: number | null };
}

export interface ProcessingDto {
  transcription: PolicyDecisionDto;
  ai: PolicyDecisionDto;
  installation: {
    cloudTranscriptionProvider: string;
    aiProvider: string;
    embeddingProvider: string;
    emailDriver: string;
    storageDriver: string;
  };
}

export interface WorkspaceInfo {
  id: string;
  orgId: string;
  name: string;
  role: Role;
  isSample: boolean;
  settings: WorkspaceSettingsDto;
  processing: ProcessingDto;
}

export interface ConsentRecordDto {
  id: string;
  kind: string;
  state: string;
  method: string;
  details: Record<string, unknown>;
  recorded_by?: string;
  created_at?: string;
  createdAt?: string;
}

export interface MeetingDetailDto extends MeetingDto {
  accessUsers: { id: string; name: string; email: string }[];
  consents: ConsentRecordDto[];
  privacy: { transcription: PolicyDecisionDto; ai: PolicyDecisionDto };
  canEdit: boolean;
  participantCount?: number;
  language?: string | null;
}

export interface MeetingListItem extends MeetingDto {
  participantCount?: number;
}

export interface NotesDto {
  mine: { body: string; version: number; updatedAt: string | null };
  others: { body: string; version: number; updated_at?: string; updatedAt?: string; author: string }[];
}

export interface ProjectDto {
  id: string;
  workspaceId: string;
  name: string;
  kind: 'project' | 'client';
  clientName: string | null;
  description: string | null;
  status: 'active' | 'archived';
  meetingCount?: number;
  createdAt: string;
}

export interface SeriesDto {
  id: string;
  workspaceId: string;
  title: string;
  cadence: string | null;
  projectId: string | null;
  meetingType: MeetingType;
  templateKey: string | null;
  defaultVisibility: Visibility;
  lastMeetingAt: string | null;
  meetingCount?: number;
  createdAt: string;
}

export interface MemberDto {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface MediaAssetDto {
  id: string;
  kind?: string;
  mime?: string;
  originalName?: string | null;
  playable?: boolean;
  urlExpiresAt?: string | null;
  retentionUntil?: string | null;
  mimeType?: string;
  mime_type?: string;
  sizeBytes?: number;
  durationMs?: number | null;
  url?: string | null;
  status?: string;
  createdAt?: string;
  filename?: string | null;
}

export interface JobDto {
  id?: string;
  type: string;
  status: string;
  error?: string | null;
  progress?: number | null;
  updatedAt?: string;
  createdAt?: string;
}

export interface LedgerBundle {
  decisions: DecisionDto[];
  actions: ActionDto[];
  commitments: CommitmentDto[];
  questions: QuestionDto[];
  contradictions: ContradictionDto[];
}

/** Lighter item shapes used by dashboard / memory / brief (followup module). */
export interface SourceInfo {
  meetingId: string | null;
  meetingTitle?: string | null;
  meetingDate?: string | null;
  startMs?: number | null;
}
export interface DecisionChangeDto {
  changedAt: string | null;
  previous: { id: string; text: string; source: SourceInfo };
  current: { id: string; text: string; source: SourceInfo } | null;
}
type Grouped<T> = T[] | { actions?: T[]; commitments?: T[] };

export interface DashboardDto {
  today?: MeetingDto[];
  upcoming?: MeetingDto[];
  needsReview?: (MeetingDto & { candidates?: number; candidateCount?: number })[];
  myActions?: ActionDto[];
  myCommitments?: CommitmentDto[];
  waitingOnOthers?: Grouped<ActionDto | CommitmentDto>;
  overdue?: Grouped<ActionDto | CommitmentDto>;
  decisionsChanged?: (DecisionDto | DecisionChangeDto)[];
  openQuestions?: QuestionDto[];
  counts?: Record<string, number>;
}

/** Flattens `T[] | {actions, commitments}` into one list. */
export function flattenGrouped<T>(g: Grouped<T> | undefined | null): T[] {
  if (!g) return [];
  if (Array.isArray(g)) return g;
  return [...(g.commitments ?? []), ...(g.actions ?? [])];
}

export interface NotificationDto {
  id: string;
  kind: string;
  orgName?: string | null;
  items?: { id: string; kind: string; title: string; link?: string | null }[];
  title: string;
  body?: string | null;
  link?: string | null;
  workspaceId?: string | null;
  meetingId?: string | null;
  readAt?: string | null;
  createdAt: string;
}

export interface NotificationPrefsDto {
  timezone?: string | null;
  timezoneSource?: 'notification_settings' | 'profile';
  quietStart?: string | null;
  quietEnd?: string | null;
  emailEnabled?: boolean;
  maxPerHour?: number | null;
  briefLeadMin?: number | null;
  emailDriver?: string;
}

export interface FollowupListItem {
  id: string;
  meetingId: string;
  kind: string;
  subject: string | null;
  body: string;
  status: string;
  generatedBy: string;
  createdAt: string;
  version?: number;
  edited?: boolean;
  warnings?: (string | { message?: string; code?: string })[];
  approvedAt?: string | null;
  sentAt?: string | null;
}

export interface SearchHit {
  id?: string;
  entityType: string;
  entityId: string;
  meetingId: string | null;
  meetingTitle?: string | null;
  meetingDate?: string | null;
  startMs?: number | null;
  endMs?: number | null;
  snippet: string;
  title?: string | null;
  score?: number;
  speaker?: string | null;
  aiGenerated?: boolean;
  occurredAt?: string | null;
  citation?: { meetingTitle?: string | null; meetingDate?: string | null; startMs?: number | null; endMs?: number | null; snippet?: string } | null;
}

export interface ConnectorDto {
  id: string;
  provider: string;
  status?: string;
  name?: string | null;
  displayName?: string | null;
  lastSyncAt?: string | null;
  createdAt?: string;
  config?: Record<string, unknown>;
}

export interface CalendarEventPreview {
  id: string;
  title: string;
  start?: string | null;
  end?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  attendees?: (string | { name?: string; email?: string })[];
  location?: string | null;
  alreadyImported?: boolean;
}

export interface ExternalWriteDto {
  id: string;
  provider?: string;
  target?: string;
  kind?: string;
  action?: string;
  status: string;
  preview?: unknown;
  payload?: unknown;
  summary?: string | null;
  createdAt?: string;
  requestedBy?: string | null;
}

export interface ApiTokenDto {
  id: string;
  name: string;
  scopes: string[];
  createdAt?: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  prefix?: string | null;
}

export interface WebhookDto {
  id: string;
  url: string;
  events?: string[];
  active?: boolean;
  createdAt?: string;
  secret?: string;
}

export interface DeletionRequestDto {
  id: string;
  scope?: string;
  targetLabel?: string | null;
  trigger?: 'user' | 'retention' | string;
  requestedBy?: { id: string; name: string | null } | null;
  kind?: string;
  entityType?: string;
  entityId?: string;
  status: string;
  createdAt?: string;
  completedAt?: string | null;
  details?: unknown;
}

export interface AgendaItemDto {
  id: string;
  text?: string;
  sourceType?: string;
  sourceId?: string | null;
  title?: string;
  notes?: string | null;
  status?: string;
  source?: string;
  position?: number;
  durationMin?: number | null;
  reviewState?: string;
}

export interface SegmentRevisionDto {
  revision: number;
  text?: string;
  newText?: string;
  oldText?: string;
  newSpeakerLabel?: string | null;
  oldSpeakerLabel?: string | null;
  editedAt?: string;
  speakerId?: string | null;
  editedBy?: string | null;
  editedByName?: string | null;
  createdAt?: string;
}

export interface TemplateDto {
  key: string;
  name: string;
  meetingType: MeetingType;
  custom?: boolean;
}
