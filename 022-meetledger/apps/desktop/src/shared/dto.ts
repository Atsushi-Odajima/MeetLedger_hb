// Minimal server DTO subsets the recorder page needs (main maps full server DTOs to these).

export interface MeetingSummaryDto {
  id: string;
  workspaceId: string;
  title: string;
  status: string;
  consentState: string;
  transcriptionMode: string;
  isConfidential: boolean;
  aiEnabled: boolean;
  scheduledStart: string | null;
  startedAt: string | null;
  language: string | null;
}

export interface MeSummaryDto {
  userName: string;
  workspaces: { id: string; name: string; role: string; isSample: boolean }[];
}
