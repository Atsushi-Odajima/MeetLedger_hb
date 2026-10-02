// Canonical enums shared by server, web, desktop and MCP.

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };
export function roleAtLeast(role: Role | null | undefined, min: Role): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[min];
}

export const MEETING_STATUSES = ['scheduled', 'live', 'processing', 'ready', 'needs_review', 'archived'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const MEETING_TYPES = ['sales', 'client', 'internal', 'one_on_one', 'project', 'interview', 'workshop', 'other'] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

export const VISIBILITIES = ['private', 'workspace', 'selected'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const MEETING_SOURCES = ['manual', 'calendar', 'upload', 'transcript_import', 'browser_capture', 'desktop_capture', 'mcp', 'sample'] as const;
export type MeetingSource = (typeof MEETING_SOURCES)[number];

/** Consent workflow state. The app supports notification/consent; it never guarantees legal compliance. */
export const CONSENT_STATES = ['not_recording', 'pending', 'notified', 'confirmed', 'declined'] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

export const AUDIO_RETENTIONS = ['never', 'until_processed', '7d', '30d', 'custom'] as const;
export type AudioRetention = (typeof AUDIO_RETENTIONS)[number];

/** Where audio is transcribed. 'local' = on this server/desktop, never sent to an external transcription API. */
export const TRANSCRIPTION_MODES = ['local', 'cloud', 'none'] as const;
export type TranscriptionMode = (typeof TRANSCRIPTION_MODES)[number];

export const REVIEW_STATES = ['candidate', 'confirmed', 'rejected'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const DECISION_STATUSES = ['active', 'superseded', 'revoked'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** 'overdue' is derived (due_date < today and still open); it is returned by the API but never stored. */
export const ACTION_STATUSES = ['candidate', 'confirmed', 'in_progress', 'done', 'cancelled', 'rejected'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export const ACTION_OPEN_STATUSES: ActionStatus[] = ['confirmed', 'in_progress'];

export const COMMITMENT_STATUSES = ['candidate', 'open', 'done', 'cancelled', 'rejected'] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export const QUESTION_STATUSES = ['candidate', 'open', 'answered', 'dropped', 'rejected'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const CONTRADICTION_STATUSES = ['open', 'confirmed_change', 'not_change', 'dismissed'] as const;
export type ContradictionStatus = (typeof CONTRADICTION_STATUSES)[number];

export const FOLLOWUP_KINDS = ['thank_you_email', 'internal_recap', 'client_recap', 'slack_update'] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];

export const FOLLOWUP_STATUSES = ['draft', 'approved', 'sent', 'discarded'] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

export const NOTIFICATION_KINDS = [
  'upcoming_brief',
  'needs_review',
  'action_t1',
  'action_due',
  'commitment_due',
  'overdue_digest',
  'next_meeting',
  'contradiction',
  'digest',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const LEDGER_ENTITY_TYPES = ['decision', 'action', 'commitment', 'question'] as const;
export type LedgerEntityType = (typeof LEDGER_ENTITY_TYPES)[number];

export const SEARCH_ENTITY_TYPES = ['segment', 'summary', 'decision', 'action', 'commitment', 'question', 'person', 'note', 'meeting'] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

export const AI_PROVIDERS = ['local-rules', 'ollama', 'openai', 'anthropic'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];
export const LOCAL_AI_PROVIDERS: AiProviderId[] = ['local-rules', 'ollama'];

export const TRANSCRIPTION_PROVIDERS = ['local-sherpa', 'fixture', 'openai', 'deepgram'] as const;
export type TranscriptionProviderId = (typeof TRANSCRIPTION_PROVIDERS)[number];
export const LOCAL_TRANSCRIPTION_PROVIDERS: TranscriptionProviderId[] = ['local-sherpa', 'fixture'];

export const EMBEDDING_PROVIDERS = ['local-hash', 'openai', 'ollama'] as const;
export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDERS)[number];

export const EXTERNAL_CALL_KINDS = ['transcription', 'ai', 'embedding', 'connector', 'email', 'webhook'] as const;
export type ExternalCallKind = (typeof EXTERNAL_CALL_KINDS)[number];

export const CONNECTOR_PROVIDERS = ['google_calendar', 'microsoft_calendar', 'ics', 'webhook', 'slack', 'gmail', 'outlook_mail', 'hubspot', 'salesforce', 'teams'] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export const MAX_INAUDIBLE_CONFIDENCE = 0.35;
export const INAUDIBLE_TOKEN = '[inaudible]';
