import type { MeetingDto, ParticipantDto, PersonDto } from '@meetledger/shared';
import { iso } from '../../lib/http';

export function meetingDto(m: any, participants?: any[]): MeetingDto {
  return {
    id: m.id,
    workspaceId: m.workspace_id,
    title: m.title,
    scheduledStart: iso(m.scheduled_start),
    scheduledEnd: iso(m.scheduled_end),
    startedAt: iso(m.started_at),
    endedAt: iso(m.ended_at),
    source: m.source,
    calendarEventId: m.calendar_event_id,
    meetingType: m.meeting_type,
    projectId: m.project_id,
    seriesId: m.series_id,
    templateKey: m.template_key,
    visibility: m.visibility,
    consentState: m.consent_state,
    audioRetention: m.audio_retention,
    audioRetentionDays: m.audio_retention_days,
    transcriptionMode: m.transcription_mode,
    aiEnabled: m.ai_enabled,
    isConfidential: m.is_confidential,
    status: m.status,
    createdBy: m.created_by,
    organizerPersonId: m.organizer_person_id,
    version: m.version,
    participants: participants?.map(participantDto),
    createdAt: iso(m.created_at)!,
    updatedAt: iso(m.updated_at)!,
  };
}

export function participantDto(p: any): ParticipantDto {
  return { id: p.id, personId: p.person_id, displayName: p.display_name, email: p.email, role: p.role, userId: p.user_id };
}

export function personDto(p: any): PersonDto {
  return {
    id: p.id,
    name: p.name,
    organization: p.organization,
    roleTitle: p.role_title,
    email: p.email,
    notes: p.notes,
    tags: p.tags ?? [],
    userId: p.user_id,
    lastMeetingAt: p.last_meeting_at !== undefined ? iso(p.last_meeting_at) : undefined,
    nextMeetingAt: p.next_meeting_at !== undefined ? iso(p.next_meeting_at) : undefined,
    openCommitments: p.open_commitments !== undefined ? Number(p.open_commitments) : undefined,
  };
}
