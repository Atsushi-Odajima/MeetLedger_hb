import type { Deps } from '../../context';
import type { Db } from '../../db/pool';

// Audio retention semantics (meetings.audio_retention):
//   never           : original kept only while processing; deleted as soon as processing ends (success OR final
//                     failure) and never playable/downloadable, not even before processing finishes.
//                     Safety net: retention_until = upload + 1 day (if the job never runs, retention.sweep deletes it).
//   until_processed : deleted right after a successful transcription. If processing keeps failing it is kept for
//                     re-processing, with a safety net retention_until = upload + 7 days (retention.sweep deletes it).
//   7d / 30d        : retention_until = upload + 7 / 30 days.
//   custom          : retention_until = upload + audio_retention_days.

export const UNTIL_PROCESSED_SAFETY_DAYS = 7;
export const NEVER_SAFETY_HOURS = 24;
const DAY = 86_400_000;

export function retentionUntil(m: { audio_retention: string; audio_retention_days?: number | null }, now: Date): Date | null {
  switch (m.audio_retention) {
    case 'never':
      return new Date(now.getTime() + NEVER_SAFETY_HOURS * 3_600_000);
    case 'until_processed':
      return new Date(now.getTime() + UNTIL_PROCESSED_SAFETY_DAYS * DAY);
    case '7d':
      return new Date(now.getTime() + 7 * DAY);
    case '30d':
      return new Date(now.getTime() + 30 * DAY);
    case 'custom':
      return new Date(now.getTime() + Math.max(1, m.audio_retention_days ?? 30) * DAY);
    default:
      return null;
  }
}

/** Whether an asset may be played back / downloaded under the meeting's current retention setting. */
export function isPlayable(m: { audio_retention: string }, asset: { deleted_at: Date | string | null }): boolean {
  return !asset.deleted_at && m.audio_retention !== 'never';
}

/**
 * Deletes the stored object and marks the asset row deleted (row kept as metadata: sha256/size/duration, no content).
 * Exported for the data module (retention.sweep / delete-audio). Must run in the asset's tenant transaction.
 */
export async function deleteMediaAsset(deps: Pick<Deps, 'storage' | 'clock'>, db: Db, asset: { id: string; storage_key: string }): Promise<void> {
  await deps.storage.delete(asset.storage_key);
  await db.query('UPDATE media_assets SET deleted_at = coalesce(deleted_at, $2) WHERE id = $1', [asset.id, deps.clock.now()]);
}
