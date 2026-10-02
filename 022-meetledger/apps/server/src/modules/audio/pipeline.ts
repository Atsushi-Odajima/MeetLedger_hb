import { wavPcmSha256, parseWavHeader } from '@meetledger/local-asr';
import { closeSync, openSync, readSync, fstatSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Deps } from '../../context';
import { one, type Db } from '../../db/pool';
import type { JobRow } from '../../jobs/queue';
import { audit } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import { safeErrorMessage } from '../../lib/logger';
import { decideTranscription, wsSettings, type PolicyDecision, type WorkspaceSettings } from '../../privacy/policy';
import { tenantTx } from '../../rbac/access';
import { MIC_SUGGESTION, REMOTE_SUGGESTION, channelSpeakers, classifyByChannel, micSuggestionForClusters } from '../../providers/diarization';
import type { TranscriptionResult } from '../../providers/transcription/types';
import { ffprobe, normalizeAudio } from './media';
import { deleteMediaAsset } from './retention';
import { afterTranscriptWritten, prepareTranscript, writeTranscriptVersion, type PreparedTranscript, type SpeakerSource } from './transcripts';

export const AUDIO_PROCESS_JOB = 'audio.process';

/** Local provider used for transcription_mode='local'. Env LOCAL_TRANSCRIPTION_PROVIDER=fixture selects the fixture provider. */
export function localProviderId(deps: Pick<Deps, 'config'>): 'local-sherpa' | 'fixture' {
  const v = (deps.config as Record<string, unknown>).LOCAL_TRANSCRIPTION_PROVIDER ?? process.env.LOCAL_TRANSCRIPTION_PROVIDER;
  return v === 'fixture' ? 'fixture' : 'local-sherpa';
}

export interface ProviderChoice {
  /** null => no transcription (mode 'none' or blocked by policy). */
  providerId: string | null;
  decision: PolicyDecision;
}

/** local -> local provider; cloud -> decideTranscription(); none -> no transcription. */
export function chooseTranscriptionProvider(deps: Pick<Deps, 'config'>, m: { transcription_mode: string; ai_enabled: boolean; is_confidential: boolean }, s: WorkspaceSettings): ProviderChoice {
  const d = decideTranscription(m, s, deps.config);
  if (m.transcription_mode === 'local') {
    const id = localProviderId(deps);
    return { providerId: id, decision: { ...d, provider: id } };
  }
  if (!d.allowed) return { providerId: null, decision: d };
  return { providerId: d.provider, decision: d };
}

export function audioJobKey(assetId: string, providerId: string | null) {
  return `audio:${assetId}:${providerId ?? 'none'}`;
}

/** Enqueues (or, with rerun, re-queues a finished) audio.process job. Same asset + provider => same job. */
export async function enqueueAudioProcess(deps: Deps, db: Db, orgId: string, meetingId: string, assetId: string, providerId: string | null, rerun = false) {
  const key = audioJobKey(assetId, providerId);
  if (rerun) {
    const r = await deps.jobs.rerun(db, key);
    if (r) return { ...r, key };
  }
  const j = await deps.jobs.enqueue(db, { orgId, type: AUDIO_PROCESS_JOB, key, payload: { meetingId, assetId, provider: providerId } });
  return { ...j, key };
}

async function setStatus(deps: Deps, orgId: string, meetingId: string, status: 'processing' | 'needs_review', onlyFrom?: string[]) {
  await tenantTx(deps, orgId, (db) =>
    db.query(`UPDATE meetings SET status=$2, updated_at=now() WHERE id=$1 AND status <> 'archived' ${onlyFrom ? 'AND status = ANY($3)' : ''}`, onlyFrom ? [meetingId, status, onlyFrom] : [meetingId, status]),
  );
}

function wavDurationMs(path: string): number | null {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const h = parseWavHeader(buf.subarray(0, n), fstatSync(fd).size);
    return Math.round((h.dataLength / (h.channels * (h.bitsPerSample / 8)) / h.sampleRate) * 1000);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Builds stored segments + speakers from a provider result (provider diarization, channel separation, or none). */
export function buildTranscript(result: TranscriptionResult, stereoPath: string | null, durationMs: number | null): PreparedTranscript & { speakerMode: string } {
  const raw = result.segments.map((s) => ({ ...s }));
  if (result.diarization !== 'provider' && stereoPath && raw.length) {
    // No provider diarization: separate by capture channel (ch0 = mic, ch1 = system audio).
    const sides = classifyByChannel(stereoPath, raw);
    const labels = channelSpeakers(sides);
    raw.forEach((s, i) => (s.speaker = labels[i]));
    const p = prepareTranscript(raw, {
      durationMs,
      source: 'channel',
      suggestionFor: (pl) => (pl === 'ch0' ? MIC_SUGGESTION : pl === 'ch1' ? REMOTE_SUGGESTION : null),
    });
    return { ...p, speakerMode: 'channel' };
  }
  const source: SpeakerSource = result.diarization === 'provider' ? 'diarization' : 'none';
  if (result.diarization !== 'provider') raw.forEach((s) => (s.speaker = null));
  const p = prepareTranscript(raw, { durationMs, source });
  if (source === 'diarization' && stereoPath && p.segments.length) {
    const sides = classifyByChannel(stereoPath, p.segments);
    const sugg = micSuggestionForClusters(
      p.segments.map((s) => s.speakerLabel),
      p.segments,
      sides,
    );
    for (const sp of p.speakers) sp.suggestion = sugg.get(sp.label) ?? sp.suggestion ?? null;
  }
  return { ...p, speakerMode: source === 'diarization' ? 'provider' : 'none' };
}

function isPermanent(e: unknown): boolean {
  if ((e as any)?.permanent === true) return true;
  return e instanceof AppError && e.status < 500;
}

/** Applies retention after processing ended. never: always delete; until_processed: delete on success only. */
async function finalizeRetention(deps: Deps, orgId: string, assetId: string, success: boolean) {
  await tenantTx(deps, orgId, async (db) => {
    const a = await one<any>(
      db,
      `SELECT a.id, a.storage_key, a.deleted_at, m.audio_retention FROM media_assets a JOIN meetings m ON m.id = a.meeting_id WHERE a.id=$1 FOR UPDATE OF a`,
      [assetId],
    );
    if (!a || a.deleted_at) return;
    if (a.audio_retention === 'never' || (success && a.audio_retention === 'until_processed')) {
      await deleteMediaAsset(deps, db, a);
      await audit(db, { orgId, action: 'media.deleted_by_retention', entityType: 'media_asset', entityId: assetId, meta: { retention: a.audio_retention, success } });
    }
  });
}

/**
 * Job `audio.process`: decrypt -> ffprobe -> normalize (16 kHz mono [+ stereo]) -> transcribe -> align / flag /
 * speaker labels -> idempotent transcript version -> ai.extract (if allowed) + index.meeting -> retention.
 * Temp files are always removed. Never logs or stores transcript text outside the transcript tables.
 */
export async function processAudioJob(deps: Deps, job: JobRow): Promise<unknown> {
  const orgId = job.org_id;
  const meetingId = String(job.payload?.meetingId ?? '');
  const assetId = String(job.payload?.assetId ?? '');
  if (!orgId || !meetingId || !assetId) throw Object.assign(new Error('invalid audio.process payload'), { permanent: true });

  const loaded = await tenantTx(deps, orgId, async (db) => {
    const m = await one<any>(db, 'SELECT * FROM meetings WHERE id=$1 AND deleted_at IS NULL', [meetingId]);
    const a = await one<any>(db, 'SELECT * FROM media_assets WHERE id=$1 AND meeting_id=$2', [assetId, meetingId]);
    const ws = m ? await one<{ settings: unknown }>(db, 'SELECT settings FROM workspaces WHERE id=$1', [m.workspace_id]) : null;
    return { m, a, s: wsSettings(ws?.settings) };
  });
  const { m, a, s } = loaded;
  if (!m || !a || a.deleted_at) return { skipped: 'asset_missing' };

  const choice = chooseTranscriptionProvider(deps, m, s);
  if (!choice.providerId) {
    await finalizeRetention(deps, orgId, assetId, false);
    await setStatus(deps, orgId, meetingId, 'needs_review', ['processing']);
    await tenantTx(deps, orgId, (db) =>
      audit(db, { orgId, workspaceId: m.workspace_id, action: 'audio.transcription_skipped', entityType: 'meeting', entityId: meetingId, meta: { mode: m.transcription_mode, provider: choice.decision.provider } }),
    );
    return { skipped: 'transcription_not_allowed', reason: choice.decision.reason };
  }

  const tmpRoot = resolve(deps.config.TMP_DIR);
  await mkdir(tmpRoot, { recursive: true });
  const work = await mkdtemp(join(tmpRoot, 'audio-'));
  try {
    await setStatus(deps, orgId, meetingId, 'processing');
    const src = join(work, 'original');
    await deps.storage.getToFile(a.storage_key, src);
    const probe = await ffprobe(deps.config, src);
    if (!probe.hasAudio) throw Object.assign(new Error('media has no audio stream'), { permanent: true });
    const mono = join(work, 'mono.wav');
    const stereo = probe.channels >= 2 ? join(work, 'stereo.wav') : null;
    await normalizeAudio(deps.config, src, mono, stereo);
    await rm(src, { force: true }); // decrypted original no longer needed on disk
    const durationMs = wavDurationMs(mono) ?? probe.durationMs;
    const inputHash = wavPcmSha256(mono);
    const providerId = choice.providerId;

    // Idempotency before any (possibly external) call: same normalized input + same provider => existing transcript.
    const existing = await tenantTx(deps, orgId, (db) =>
      one<{ id: string; version: number }>(db, 'SELECT id, version FROM transcripts WHERE meeting_id=$1 AND input_hash=$2 AND provider=$3', [meetingId, inputHash, providerId]),
    );
    let out: { transcriptId: string; version: number; created: boolean; segmentCount?: number; aiJobId?: string | null };
    if (existing) {
      out = { transcriptId: existing.id, version: existing.version, created: false };
    } else {
      const provider = deps.providers.transcription(providerId);
      const language = m.language && m.language !== 'auto' ? m.language : s.transcription.language;
      const result = await provider.transcribe(
        { audioPath: mono, stereoPath: stereo, durationMs: durationMs ?? 0, language: language === 'ja' || language === 'en' ? language : 'auto', workDir: work },
        { http: deps.http, orgId, meetingId, decision: choice.decision },
      );
      const prepared = buildTranscript(result, stereo, durationMs);
      out = await tenantTx(deps, orgId, async (db) => {
        const w = await writeTranscriptVersion(db, {
          orgId,
          meetingId,
          provider: result.provider,
          isLocal: result.isLocal,
          language: result.language ?? null,
          inputHash,
          mediaAssetId: assetId,
          jobId: job.id,
          segments: prepared.segments,
          speakers: prepared.speakers,
          qualityFlags: {
            source: 'audio',
            model: result.model ?? null,
            diarization: prepared.speakerMode,
            durationMs,
            channels: probe.channels,
            ...(result.notes?.length ? { notes: result.notes } : {}),
          },
        });
        let aiJobId: string | null = null;
        if (w.created) aiJobId = (await afterTranscriptWritten(deps, db, meetingId, w.transcriptId)).aiJobId;
        await audit(db, {
          orgId,
          workspaceId: m.workspace_id,
          action: 'audio.transcribed',
          entityType: 'meeting',
          entityId: meetingId,
          meta: { transcriptId: w.transcriptId, version: w.version, provider: result.provider, isLocal: result.isLocal, segmentCount: prepared.segments.length, created: w.created },
        });
        return { ...w, segmentCount: prepared.segments.length, aiJobId };
      });
    }
    if (!out.created) await setStatus(deps, orgId, meetingId, 'needs_review', ['processing']);
    await finalizeRetention(deps, orgId, assetId, true);
    deps.log.info({ jobId: job.id, meetingId, transcriptId: out.transcriptId, created: out.created, segmentCount: out.segmentCount }, 'audio processed');
    return { ...out, provider: providerId };
  } catch (e) {
    const final = isPermanent(e) || job.attempts >= job.max_attempts;
    if (final) {
      await finalizeRetention(deps, orgId, assetId, false).catch(() => undefined);
      await setStatus(deps, orgId, meetingId, 'needs_review', ['processing']).catch(() => undefined);
      await tenantTx(deps, orgId, (db) =>
        audit(db, { orgId, workspaceId: m.workspace_id, action: 'audio.process_failed', entityType: 'meeting', entityId: meetingId, meta: { assetId, error: safeErrorMessage(e).slice(0, 200) } }),
      ).catch(() => undefined);
      if ((e as any)?.permanent !== true && e instanceof Error) Object.assign(e, { permanent: true });
    }
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
