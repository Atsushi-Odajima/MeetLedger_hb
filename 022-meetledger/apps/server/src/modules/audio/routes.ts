import { LOCAL_TRANSCRIPTION_PROVIDERS, toTsvectorLiteral } from '@meetledger/shared';
import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { Deps, WsCtx } from '../../context';
import { one, rows, withSystem, type Db } from '../../db/pool';
import { audit } from '../../lib/audit';
import { sha256 } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound, tooLarge, unsupported } from '../../lib/errors';
import { body, iso, parse, query, wsIdParams, zUuid } from '../../lib/http';
import { wsSettings } from '../../privacy/policy';
import { MIC_SUGGESTION, REMOTE_SUGGESTION } from '../../providers/diarization';
import { loadMeeting, requireAuth, workspaceCtx } from '../../rbac/access';
import { mediaKey } from '../../storage/types';
import { parseTranscriptImport } from './importers';
import { ffprobe } from './media';
import { cleanText } from './normalize';
import { chooseTranscriptionProvider, enqueueAudioProcess } from './pipeline';
import { isPlayable, retentionUntil } from './retention';
import { canonicalMime, extOf, validateUpload } from './sniff';
import { signFileUrl, verifyFileSignature } from './signedUrl';
import { afterTranscriptWritten, listTranscriptVersions, loadSegment, loadTranscriptDto, prepareTranscript, segmentDto, speakerDto, writeTranscriptVersion } from './transcripts';

const segParams = z.object({ workspaceId: zUuid, segmentId: zUuid });
const speakerParams = z.object({ workspaceId: zUuid, id: zUuid, speakerId: zUuid });

const MIC_LABELS = new Set(['mic', 'ch0', 'microphone', 'local', 'me']);
const REMOTE_LABELS = new Set(['system', 'ch1', 'remote', 'loopback']);

async function enqueueIndex(deps: Deps, db: Db, orgId: string, meetingId: string) {
  await deps.jobs.enqueue(db, { orgId, type: 'index.meeting', key: `index:${meetingId}:${Date.now()}`, payload: { meetingId } });
}

async function workspaceSettings(db: Db, workspaceId: string) {
  const w = await one<{ settings: unknown }>(db, 'SELECT settings FROM workspaces WHERE id=$1', [workspaceId]);
  return wsSettings(w?.settings);
}

function mediaDto(deps: Deps, ctx: WsCtx, m: any, a: any) {
  const playable = isPlayable(m, a);
  const signed = playable ? signFileUrl(deps.config, deps.clock, a.id, ctx.userId) : null;
  return {
    id: a.id,
    kind: a.kind,
    mime: a.mime,
    originalName: a.original_name,
    sizeBytes: Number(a.size_bytes),
    durationMs: a.duration_ms,
    channels: a.channels,
    createdAt: iso(a.created_at),
    retentionUntil: iso(a.retention_until),
    deletedAt: iso(a.deleted_at),
    playable,
    url: signed?.url ?? null,
    urlExpiresAt: signed?.expiresAt ?? null,
  };
}

export default async function audioRoutes(app: FastifyInstance, deps: Deps) {
  // ------------------------------------------------------------------ upload
  app.post('/api/w/:workspaceId/meetings/:id/media', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    await ctx.tx((db) => loadMeeting(db, ctx, id, 'write'));
    if (!req.isMultipart()) throw unsupported('multipart/form-data の file フィールドで送信してください');

    const tmpRoot = resolve(deps.config.TMP_DIR);
    await mkdir(tmpRoot, { recursive: true });
    const work = await mkdtemp(join(tmpRoot, 'upload-'));
    let storedKey: string | null = null;
    try {
      let part: Awaited<ReturnType<typeof req.file>>;
      try {
        part = await req.file();
      } catch (e: any) {
        if (e?.code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge(`ファイルが大きすぎます（上限 ${deps.config.MAX_UPLOAD_MB}MB）`);
        throw unsupported('multipart/form-data の file フィールドで送信してください');
      }
      if (!part || part.fieldname !== 'file') throw badRequest('file フィールドが必要です');
      const dest = join(work, 'upload');
      const hash = createHash('sha256');
      let size = 0;
      let head = Buffer.alloc(0);
      const tap = new Transform({
        transform(chunk: Buffer, _e, cb) {
          size += chunk.length;
          hash.update(chunk);
          if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(part.file, tap, createWriteStream(dest));
      } catch (e: any) {
        if (e?.code === 'FST_REQ_FILE_TOO_LARGE' || part.file.truncated) throw tooLarge(`ファイルが大きすぎます（上限 ${deps.config.MAX_UPLOAD_MB}MB）`);
        throw e;
      }
      if (part.file.truncated) throw tooLarge(`ファイルが大きすぎます（上限 ${deps.config.MAX_UPLOAD_MB}MB）`);
      if (size === 0) throw badRequest('空のファイルです');
      const v = validateUpload(head, part.filename, part.mimetype);
      if (!v.ok) throw unsupported(v.reason);
      let probe;
      try {
        probe = await ffprobe(deps.config, dest);
      } catch {
        throw unsupported('音声/動画ファイルとして読み取れません');
      }
      if (!probe.hasAudio) throw unsupported('音声トラックがありません');
      const sha = hash.digest('hex');
      const ext = extOf(part.filename);
      const mime = canonicalMime(v.container, ext, probe.hasVideo);
      const kind = probe.hasVideo ? 'original_video' : 'original_audio';
      const originalName = String(part.filename ?? '').slice(0, 200) || null;

      // Same file re-sent for the same meeting: reuse the asset (=> same job key => no duplicate processing).
      const dup = await ctx.tx((db) =>
        one<{ id: string }>(
          db,
          `SELECT id FROM media_assets WHERE meeting_id=$1 AND sha256=$2 AND deleted_at IS NULL AND kind IN ('original_audio','original_video') ORDER BY created_at LIMIT 1`,
          [id, sha],
        ),
      );
      const assetId = dup?.id ?? randomUUID();
      if (!dup) {
        storedKey = mediaKey(ctx.orgId, id, 'original', assetId);
        await deps.storage.putFile(storedKey, dest);
      }
      const res = await ctx.tx(async (db) => {
        const m: any = await loadMeeting(db, ctx, id, 'write');
        if (!dup) {
          await db.query(
            `INSERT INTO media_assets(id, org_id, meeting_id, kind, storage_key, mime, original_name, size_bytes, sha256, duration_ms, channels, encrypted, retention_until, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13)`,
            [assetId, ctx.orgId, id, kind, storedKey, mime, originalName, size, sha, probe.durationMs, probe.channels || null, retentionUntil(m, deps.clock.now()), ctx.userId],
          );
        }
        const choice = chooseTranscriptionProvider(deps, m, await workspaceSettings(db, workspaceId));
        const job = await enqueueAudioProcess(deps, db, ctx.orgId, id, assetId, choice.providerId);
        if (choice.providerId) await db.query(`UPDATE meetings SET status='processing', updated_at=now() WHERE id=$1 AND status <> 'archived'`, [id]);
        await audit(db, {
          orgId: ctx.orgId,
          workspaceId,
          userId: ctx.userId,
          action: 'media.uploaded',
          entityType: 'meeting',
          entityId: id,
          meta: { assetId, created: !dup, sizeBytes: size, mime, durationMs: probe.durationMs, provider: choice.providerId },
          ip: req.ip,
        });
        return {
          assetId,
          jobId: job.id,
          created: !dup,
          jobStatus: job.status,
          transcription: { allowed: !!choice.providerId, provider: choice.providerId, isLocal: choice.decision.isLocal, reason: choice.decision.reason },
        };
      });
      storedKey = null;
      return res;
    } finally {
      if (storedKey) await deps.storage.delete(storedKey).catch(() => undefined);
      await rm(work, { recursive: true, force: true });
    }
  });

  app.get('/api/w/:workspaceId/meetings/:id/media', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const m: any = await loadMeeting(db, ctx, id);
      const assets = await rows(
        db,
        `SELECT id, kind, mime, original_name, size_bytes, duration_ms, channels, retention_until, created_at, deleted_at
           FROM media_assets WHERE meeting_id=$1 AND kind IN ('original_audio','original_video') ORDER BY created_at DESC`,
        [id],
      );
      return { items: assets.map((a) => mediaDto(deps, ctx, m, a)), audioRetention: m.audio_retention };
    });
  });

  // ------------------------------------------------------------------ signed media download / playback
  app.get('/api/files/:assetId', async (req, reply) => {
    const auth = requireAuth(req);
    const p = z.object({ assetId: zUuid }).safeParse(req.params);
    if (!p.success) throw notFound('File not found');
    const q = z.object({ u: z.string().max(64), exp: z.coerce.number().int(), sig: z.string().max(128) }).safeParse(req.query ?? {});
    if (!q.success) throw forbidden('Invalid or expired link');
    const { assetId } = p.data;
    const check = verifyFileSignature(deps.config, deps.clock, assetId, q.data.u, q.data.exp, q.data.sig);
    if (check !== 'ok') throw forbidden(check === 'expired' ? 'Link expired' : 'Invalid or expired link');
    if (q.data.u !== auth.user.id) throw forbidden('Invalid or expired link');
    // Resolve the asset's workspace (auth lookup, ids only), then re-check membership + meeting ACL in tenant context.
    const loc = await withSystem(deps.pool, (db) =>
      one<{ workspace_id: string; meeting_id: string }>(db, 'SELECT m.workspace_id, a.meeting_id FROM media_assets a JOIN meetings m ON m.id = a.meeting_id WHERE a.id=$1', [assetId]),
    );
    if (!loc) throw notFound('File not found');
    const ctx = await workspaceCtx(deps, req, loc.workspace_id);
    const asset = await ctx.tx(async (db) => {
      const m: any = await loadMeeting(db, ctx, loc.meeting_id, 'read');
      const a = await one<any>(db, 'SELECT id, storage_key, mime, deleted_at, kind FROM media_assets WHERE id=$1 AND meeting_id=$2', [assetId, m.id]);
      if (!a || !isPlayable(m, a)) return null;
      await audit(db, { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId, action: 'media.accessed', entityType: 'media_asset', entityId: assetId, ip: req.ip });
      return a;
    });
    if (!asset) throw notFound('File not found');
    const stream = await deps.storage.getStream(asset.storage_key);
    reply
      .header('content-type', asset.mime)
      .header('cache-control', 'private, no-store')
      .header('content-disposition', 'inline')
      .header('accept-ranges', 'none')
      .header('x-content-type-options', 'nosniff');
    return reply.send(stream);
  });

  // ------------------------------------------------------------------ processing
  app.post('/api/w/:workspaceId/meetings/:id/process', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ rerun: z.boolean().default(false) }));
    return ctx.tx(async (db) => {
      const m: any = await loadMeeting(db, ctx, id, 'write');
      const a = await one<{ id: string }>(
        db,
        `SELECT id FROM media_assets WHERE meeting_id=$1 AND deleted_at IS NULL AND kind IN ('original_audio','original_video') ORDER BY created_at DESC LIMIT 1`,
        [id],
      );
      if (!a) throw conflict('処理できる元音声がありません（保持期間により削除済みの可能性）', { code: 'no_media' });
      const choice = chooseTranscriptionProvider(deps, m, await workspaceSettings(db, workspaceId));
      if (!choice.providerId) throw conflict(choice.decision.reason, { code: 'transcription_not_allowed' });
      const job = await enqueueAudioProcess(deps, db, ctx.orgId, id, a.id, choice.providerId, b.rerun);
      if (job.status === 'queued') await db.query(`UPDATE meetings SET status='processing', updated_at=now() WHERE id=$1 AND status <> 'archived'`, [id]);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'audio.process_requested', entityType: 'meeting', entityId: id, meta: { assetId: a.id, rerun: b.rerun, provider: choice.providerId } });
      return { jobId: job.id, status: job.status, created: job.created, assetId: a.id, provider: choice.providerId };
    });
  });

  app.get('/api/w/:workspaceId/meetings/:id/processing', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const m: any = await loadMeeting(db, ctx, id);
      const jobs = await rows(
        db,
        `SELECT id, type, status, attempts, max_attempts, last_error, created_at, updated_at, finished_at, payload->>'assetId' AS asset_id, payload->>'provider' AS provider
           FROM jobs WHERE org_id=$2 AND payload->>'meetingId' = $1 AND type IN ('audio.process','ai.extract') ORDER BY created_at DESC LIMIT 50`,
        [id, ctx.orgId],
      );
      const t = await one<any>(db, 'SELECT id, version, provider, is_local, created_at FROM transcripts WHERE meeting_id=$1 AND is_current ORDER BY version DESC LIMIT 1', [id]);
      const choice = chooseTranscriptionProvider(deps, m, await workspaceSettings(db, workspaceId));
      return {
        meetingId: id,
        meetingStatus: m.status,
        transcriptionMode: m.transcription_mode,
        transcription: { allowed: !!choice.providerId, provider: choice.providerId, isLocal: choice.decision.isLocal, reason: choice.decision.reason },
        jobs: jobs.map((j) => ({
          id: j.id,
          type: j.type,
          status: j.status,
          attempts: j.attempts,
          maxAttempts: j.max_attempts,
          error: j.status === 'succeeded' ? null : j.last_error,
          assetId: j.asset_id,
          provider: j.provider,
          createdAt: iso(j.created_at),
          updatedAt: iso(j.updated_at),
          finishedAt: iso(j.finished_at),
        })),
        transcript: t ? { id: t.id, version: t.version, provider: t.provider, isLocal: t.is_local, createdAt: iso(t.created_at) } : null,
      };
    });
  });

  // ------------------------------------------------------------------ transcripts
  app.post('/api/w/:workspaceId/meetings/:id/transcript/import', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(
      req,
      z.object({ format: z.enum(['srt', 'vtt', 'txt', 'json']), content: z.string().min(1).max(4_500_000), language: z.enum(['ja', 'en', 'auto']).nullable().optional() }),
    );
    const raw = parseTranscriptImport(b.format, b.content);
    const prepared = prepareTranscript(raw, { source: 'import', labelMode: 'verbatim' });
    return ctx.tx(async (db) => {
      const m: any = await loadMeeting(db, ctx, id, 'write');
      const w = await writeTranscriptVersion(db, {
        orgId: ctx.orgId,
        meetingId: id,
        provider: 'import',
        isLocal: true,
        language: b.language && b.language !== 'auto' ? b.language : (m.language ?? null),
        inputHash: sha256(`import:${b.format}\n${b.content}`),
        qualityFlags: { source: 'import', format: b.format },
        ...prepared,
      });
      if (w.created) await afterTranscriptWritten(deps, db, id, w.transcriptId);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'transcript.imported', entityType: 'meeting', entityId: id, meta: { format: b.format, segmentCount: prepared.segments.length, created: w.created } });
      return { ...w, segmentCount: prepared.segments.length };
    });
  });

  app.post('/api/w/:workspaceId/meetings/:id/transcript/local', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(
      req,
      z.object({
        provider: z.enum(LOCAL_TRANSCRIPTION_PROVIDERS as unknown as ['local-sherpa', 'fixture']),
        model: z.string().trim().min(1).max(200),
        language: z.string().max(16).nullable().optional(),
        durationMs: z.number().int().min(0).max(48 * 3600_000).optional(),
        segments: z
          .array(
            z.object({
              startMs: z.number().int().min(0),
              endMs: z.number().int().min(0),
              text: z.string().max(10_000),
              speaker: z.string().max(100).nullable().optional(),
              confidence: z.number().min(0).max(1).nullable().optional(),
            }),
          )
          .min(1)
          .max(20_000),
      }),
    );
    const labels = new Set(b.segments.map((s) => (s.speaker ?? '').trim().toLowerCase()).filter(Boolean));
    const channelMode = labels.size > 0 && [...labels].every((l) => MIC_LABELS.has(l) || REMOTE_LABELS.has(l));
    const prepared = prepareTranscript(b.segments, {
      durationMs: b.durationMs ?? null,
      source: channelMode ? 'channel' : labels.size ? 'diarization' : 'none',
      suggestionFor: (pl) => {
        const l = (pl ?? '').trim().toLowerCase();
        return MIC_LABELS.has(l) ? MIC_SUGGESTION : REMOTE_LABELS.has(l) && channelMode ? REMOTE_SUGGESTION : null;
      },
    });
    return ctx.tx(async (db) => {
      const m: any = await loadMeeting(db, ctx, id, 'write');
      if (m.transcription_mode === 'none') throw conflict('このMeetingは文字起こしOFFです', { code: 'transcription_disabled' });
      const w = await writeTranscriptVersion(db, {
        orgId: ctx.orgId,
        meetingId: id,
        provider: b.provider,
        isLocal: true,
        language: b.language && b.language !== 'auto' ? b.language : null,
        inputHash: sha256(`local:${JSON.stringify({ model: b.model, language: b.language ?? null, segments: b.segments })}`),
        qualityFlags: { source: 'desktop_local', model: b.model, diarization: channelMode ? 'channel' : labels.size ? 'provider' : 'none', durationMs: b.durationMs ?? null },
        ...prepared,
      });
      if (w.created) await afterTranscriptWritten(deps, db, id, w.transcriptId);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'transcript.local_submitted', entityType: 'meeting', entityId: id, meta: { provider: b.provider, segmentCount: prepared.segments.length, created: w.created } });
      return { ...w, segmentCount: prepared.segments.length };
    });
  });

  app.get('/api/w/:workspaceId/meetings/:id/transcript', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    const q = query(req, z.object({ version: z.coerce.number().int().min(1).optional() }));
    return ctx.tx(async (db) => {
      await loadMeeting(db, ctx, id);
      return loadTranscriptDto(db, id, q.version);
    });
  });

  app.get('/api/w/:workspaceId/meetings/:id/transcript/versions', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      await loadMeeting(db, ctx, id);
      return { items: await listTranscriptVersions(db, id) };
    });
  });

  // ------------------------------------------------------------------ segment editing (optimistic concurrency + history)
  app.patch('/api/w/:workspaceId/segments/:segmentId', async (req) => {
    const { workspaceId, segmentId } = parse(segParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ text: z.string().max(10_000).optional(), speakerId: zUuid.optional(), expectedRevision: z.number().int().min(1) }));
    if (b.text === undefined && b.speakerId === undefined) throw badRequest('text or speakerId is required');
    return ctx.tx(async (db) => {
      const seg = await one<any>(db, 'SELECT * FROM transcript_segments WHERE id=$1 FOR UPDATE', [segmentId]);
      if (!seg) throw notFound('Segment not found');
      await loadMeeting(db, ctx, seg.meeting_id, 'write');
      if (seg.revision !== b.expectedRevision) throw conflict('このセグメントは他の場所で編集されました', { server: segmentDto(await loadSegment(db, segmentId)) });
      let text = seg.text as string;
      let flags = (seg.flags ?? []) as string[];
      if (b.text !== undefined) {
        const c = cleanText(b.text);
        text = c.text;
        // A human edit replaces machine quality flags; inaudible stays flagged while "[inaudible]" remains in the text.
        flags = flags.filter((f) => f !== 'low_confidence' && f !== 'inaudible');
        if (c.inaudible || c.partial) flags.push('inaudible');
        if (!flags.includes('edited')) flags.push('edited');
      }
      let speakerId = seg.speaker_id as string | null;
      let speakerLabel = seg.speaker_label as string;
      if (b.speakerId !== undefined) {
        const sp = await one<{ id: string; label: string }>(db, 'SELECT id, label FROM meeting_speakers WHERE id=$1 AND meeting_id=$2', [b.speakerId, seg.meeting_id]);
        if (!sp) throw badRequest('Unknown speakerId for this meeting');
        speakerId = sp.id;
        speakerLabel = sp.label;
      }
      const now = deps.clock.now();
      const upd = await one<any>(
        db,
        `UPDATE transcript_segments SET text=$3, speaker_id=$4, speaker_label=$5, flags=$6, revision=revision+1, edited_by=$7, edited_at=$8, tsv=$9::tsvector
          WHERE id=$1 AND revision=$2 RETURNING revision`,
        [segmentId, b.expectedRevision, text, speakerId, speakerLabel, flags, ctx.userId, now, toTsvectorLiteral(text)],
      );
      if (!upd) throw conflict('このセグメントは他の場所で編集されました');
      await db.query(
        `INSERT INTO segment_revisions(org_id, segment_id, revision, old_text, new_text, old_speaker_label, new_speaker_label, edited_by, edited_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [ctx.orgId, segmentId, upd.revision, seg.text, text, seg.speaker_label, speakerLabel, ctx.userId, now],
      );
      await enqueueIndex(deps, db, ctx.orgId, seg.meeting_id);
      await audit(db, {
        orgId: ctx.orgId,
        workspaceId,
        userId: ctx.userId,
        action: 'segment.edited',
        entityType: 'segment',
        entityId: segmentId,
        meta: { revision: upd.revision, textChanged: text !== seg.text, speakerChanged: speakerLabel !== seg.speaker_label },
      });
      return segmentDto(await loadSegment(db, segmentId));
    });
  });

  app.get('/api/w/:workspaceId/segments/:segmentId/revisions', async (req) => {
    const { workspaceId, segmentId } = parse(segParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      const seg = await one<any>(db, 'SELECT id, meeting_id, revision FROM transcript_segments WHERE id=$1', [segmentId]);
      if (!seg) throw notFound('Segment not found');
      await loadMeeting(db, ctx, seg.meeting_id);
      const list = await rows(
        db,
        `SELECT r.revision, r.old_text, r.new_text, r.old_speaker_label, r.new_speaker_label, r.edited_by, r.edited_at, u.name AS edited_by_name
           FROM segment_revisions r LEFT JOIN users u ON u.id = r.edited_by WHERE r.segment_id=$1 ORDER BY r.revision DESC`,
        [segmentId],
      );
      return {
        segmentId,
        currentRevision: seg.revision,
        items: list.map((r) => ({
          revision: r.revision,
          oldText: r.old_text,
          newText: r.new_text,
          oldSpeakerLabel: r.old_speaker_label,
          newSpeakerLabel: r.new_speaker_label,
          editedBy: r.edited_by,
          editedByName: r.edited_by_name,
          editedAt: iso(r.edited_at),
        })),
      };
    });
  });

  // ------------------------------------------------------------------ speaker mapping (manual only; no voice identification)
  app.patch('/api/w/:workspaceId/meetings/:id/speakers/:speakerId', async (req) => {
    const { workspaceId, id, speakerId } = parse(speakerParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId, 'member');
    const b = body(req, z.object({ personId: zUuid.nullable().optional(), displayName: z.string().trim().min(1).max(100).nullable().optional() }));
    if (b.personId === undefined && b.displayName === undefined) throw badRequest('personId or displayName is required');
    return ctx.tx(async (db) => {
      await loadMeeting(db, ctx, id, 'write');
      const sp = await one<any>(db, 'SELECT * FROM meeting_speakers WHERE id=$1 AND meeting_id=$2 FOR UPDATE', [speakerId, id]);
      if (!sp) throw notFound('Speaker not found');
      if (b.personId) {
        const person = await one(db, 'SELECT id FROM people WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [b.personId, workspaceId]);
        if (!person) throw badRequest('Unknown personId');
      }
      const personId = b.personId === undefined ? sp.person_id : b.personId;
      const displayName = b.displayName === undefined ? sp.display_name : b.displayName;
      await db.query('UPDATE meeting_speakers SET person_id=$2, display_name=$3, updated_by=$4, updated_at=$5 WHERE id=$1', [speakerId, personId, displayName, ctx.userId, deps.clock.now()]);
      await enqueueIndex(deps, db, ctx.orgId, id);
      await audit(db, { orgId: ctx.orgId, workspaceId, userId: ctx.userId, action: 'speaker.mapped', entityType: 'meeting_speaker', entityId: speakerId, meta: { meetingId: id, personId, hasDisplayName: !!displayName } });
      const r = await one<any>(db, 'SELECT ms.*, p.name AS person_name FROM meeting_speakers ms LEFT JOIN people p ON p.id = ms.person_id AND p.deleted_at IS NULL WHERE ms.id=$1', [speakerId]);
      return speakerDto(r);
    });
  });

  // List of a meeting's speakers (for the mapping UI).
  app.get('/api/w/:workspaceId/meetings/:id/speakers', async (req) => {
    const { workspaceId, id } = parse(wsIdParams, req.params);
    const ctx = await workspaceCtx(deps, req, workspaceId);
    return ctx.tx(async (db) => {
      await loadMeeting(db, ctx, id);
      const list = await rows(db, 'SELECT ms.*, p.name AS person_name FROM meeting_speakers ms LEFT JOIN people p ON p.id = ms.person_id AND p.deleted_at IS NULL WHERE ms.meeting_id=$1 ORDER BY ms.label', [id]);
      return { items: list.map(speakerDto) };
    });
  });
}
