import { createContext, useContext } from 'react';
import type { MeetingDetailDto } from '../../lib/types';

export interface MeetingCtx {
  meeting: MeetingDetailDto;
  setMeeting(m: MeetingDetailDto): void;
  reload(): void;
  /** API path under this meeting. */
  ma(path?: string): string;
  /** App route under this meeting. */
  mp(path?: string): string;
}

export const MeetingContext = createContext<MeetingCtx | null>(null);

export function useMeeting(): MeetingCtx {
  const v = useContext(MeetingContext);
  if (!v) throw new Error('useMeeting outside MeetingContext');
  return v;
}

/** Recording / upload requires that participants were notified (server enforces the same rule). */
export function consentOk(m: Pick<MeetingDetailDto, 'consentState'>): boolean {
  return m.consentState === 'notified' || m.consentState === 'confirmed';
}
