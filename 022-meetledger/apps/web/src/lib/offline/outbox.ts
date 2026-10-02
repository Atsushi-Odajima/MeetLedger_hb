// Offline queue ("outbox") for edits made while offline or while the server is unreachable.
//
// Supported operations (kept deliberately small):
//   notes.put      manual meeting notes (PUT /notes with baseVersion → 409 {serverBody, serverVersion} on conflict)
//   action.status  status change of an Action (checked against the server state before it is applied)
//
// Rules:
//   * Operations are coalesced per target (one notes op per meeting, one status op per action). The ORIGINAL base
//     (baseVersion / prevStatus / baseUpdatedAt) is kept, so a later replay still detects changes made elsewhere.
//   * Replay never overwrites newer server data. A conflict is stored with the server copy and waits for the user
//     to choose (use server / keep mine / merge). Nothing is retried automatically after a conflict.
//   * Network failures stop the replay and leave everything pending.

import type { ActionStatus } from '@meetledger/shared';
import { ApiError, NetworkError, listOf, type ApiClient } from '../api';
import { idb } from './idb';

export type OpStatus = 'pending' | 'conflict' | 'failed';

interface OpBase {
  id: string;
  /** Owner of the queued edit: ops are only replayed / shown for the signed-in user who made them. */
  userId: string | null;
  wsId: string;
  createdAt: string;
  updatedAt: string;
  status: OpStatus;
  attempts: number;
  error?: string;
}

export interface NotesOp extends OpBase {
  kind: 'notes.put';
  meetingId: string;
  meetingTitle?: string;
  body: string;
  baseVersion: number;
  conflict?: { serverBody: string; serverVersion: number };
}

export interface ActionStatusOp extends OpBase {
  kind: 'action.status';
  actionId: string;
  meetingId?: string | null;
  label?: string;
  /** The Action status this op applies (op state is `status`). */
  targetStatus: ActionStatus;
  prevStatus: ActionStatus;
  baseUpdatedAt: string | null;
  conflict?: { serverStatus: string; serverUpdatedAt: string | null };
}

export type OutboxOp = NotesOp | ActionStatusOp;

export interface CachedNotes {
  body: string;
  version: number;
  updatedAt: string | null;
}

export const notesOpId = (wsId: string, meetingId: string) => `notes:${currentUserId ?? '-'}:${wsId}:${meetingId}`;
export const actionOpId = (wsId: string, actionId: string) => `action:${currentUserId ?? '-'}:${wsId}:${actionId}`;
const notesCacheKey = (wsId: string, meetingId: string) => `notes:${currentUserId ?? '-'}:${wsId}:${meetingId}`;

// ---------------------------------------------------------------- change notifications
type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribeOutbox(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
function notify() {
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* listener errors must not break the queue */
    }
  });
}

export interface NotesSavedEvent {
  wsId: string;
  meetingId: string;
  version: number;
  body: string;
  /** true when the editor has newer text than what was saved (op stays queued with the new baseVersion). */
  stillPending: boolean;
}
type NotesListener = (e: NotesSavedEvent) => void;
const notesListeners = new Set<NotesListener>();
export function onNotesSaved(l: NotesListener): () => void {
  notesListeners.add(l);
  return () => notesListeners.delete(l);
}

const now = () => new Date().toISOString();

let currentUserId: string | null = null;
/** Set by the session: ops are tagged with and filtered by the signed-in user (shared devices). */
export function setOutboxUser(userId: string | null) {
  currentUserId = userId;
  notify();
}
export const getOutboxUser = () => currentUserId;
const mine = (o: OutboxOp) => !o.userId || o.userId === currentUserId;

/** Logout: drop cached server copies (viewing data). Unsynced edits stay (tagged with their user) and sync on next login. */
export async function clearOfflineViewData(): Promise<void> {
  await idb.clear('kv').catch(() => undefined);
}

// ---------------------------------------------------------------- queue API
export async function listOps(): Promise<OutboxOp[]> {
  const all = (await idb.all<OutboxOp>('outbox')).filter(mine);
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getOp<T extends OutboxOp = OutboxOp>(id: string): Promise<T | undefined> {
  return idb.get<T>('outbox', id);
}

export async function discardOp(id: string): Promise<void> {
  await idb.delete('outbox', id);
  notify();
}

export async function queueNotes(input: { wsId: string; meetingId: string; body: string; baseVersion: number; meetingTitle?: string }): Promise<NotesOp> {
  const id = notesOpId(input.wsId, input.meetingId);
  const op = await idb.update<NotesOp>('outbox', id, (cur) => {
    const t = now();
    if (cur) {
      return {
        ...cur,
        body: input.body,
        meetingTitle: input.meetingTitle ?? cur.meetingTitle,
        updatedAt: t,
        // a conflict stays a conflict until the user resolves it; a failed op becomes pending again on a new edit
        status: cur.status === 'conflict' ? 'conflict' : 'pending',
        attempts: cur.status === 'failed' ? 0 : cur.attempts,
        error: cur.status === 'failed' ? undefined : cur.error,
      };
    }
    return {
      id,
      kind: 'notes.put',
      userId: currentUserId,
      wsId: input.wsId,
      meetingId: input.meetingId,
      meetingTitle: input.meetingTitle,
      body: input.body,
      baseVersion: input.baseVersion,
      createdAt: t,
      updatedAt: t,
      status: 'pending',
      attempts: 0,
    };
  });
  notify();
  return op!;
}

export async function queueActionStatus(input: {
  wsId: string;
  actionId: string;
  status: ActionStatus;
  prevStatus: ActionStatus;
  baseUpdatedAt: string | null;
  meetingId?: string | null;
  label?: string;
}): Promise<ActionStatusOp | undefined> {
  const id = actionOpId(input.wsId, input.actionId);
  const op = await idb.update<ActionStatusOp>('outbox', id, (cur) => {
    const t = now();
    if (cur) {
      // Net change cancelled (e.g. done -> back to confirmed while still offline): nothing to send.
      if (input.status === cur.prevStatus && cur.status !== 'conflict') return undefined;
      return {
        ...cur,
        targetStatus: input.status,
        label: input.label ?? cur.label,
        status: cur.status === 'conflict' ? 'conflict' : 'pending',
        attempts: 0,
        error: undefined,
        updatedAt: t,
      };
    }
    return {
      id,
      kind: 'action.status',
      userId: currentUserId,
      wsId: input.wsId,
      actionId: input.actionId,
      meetingId: input.meetingId ?? null,
      label: input.label,
      targetStatus: input.status,
      prevStatus: input.prevStatus,
      baseUpdatedAt: input.baseUpdatedAt,
      createdAt: t,
      updatedAt: t,
      status: 'pending',
      attempts: 0,
    };
  });
  notify();
  return op;
}

// ---------------------------------------------------------------- server copy cache (notes)
export function cacheServerNotes(wsId: string, meetingId: string, n: CachedNotes) {
  return idb.put<CachedNotes>('kv', n, notesCacheKey(wsId, meetingId)).catch(() => undefined);
}
export function getCachedServerNotes(wsId: string, meetingId: string): Promise<CachedNotes | undefined> {
  return idb.get<CachedNotes>('kv', notesCacheKey(wsId, meetingId)).catch(() => undefined);
}

// ---------------------------------------------------------------- conflict resolution
export type NotesResolution = { choice: 'server' } | { choice: 'mine' } | { choice: 'merge'; body: string };

/** Resolves a notes conflict. Returns the text the editor should show and whether something is still queued. */
export async function resolveNotesConflict(id: string, r: NotesResolution): Promise<{ body: string; baseVersion: number; queued: boolean } | undefined> {
  const op = await getOp<NotesOp>(id);
  if (!op || !op.conflict) return undefined;
  const { serverBody, serverVersion } = op.conflict;
  if (r.choice === 'server') {
    await idb.delete('outbox', id);
    await cacheServerNotes(op.wsId, op.meetingId, { body: serverBody, version: serverVersion, updatedAt: null });
    notify();
    return { body: serverBody, baseVersion: serverVersion, queued: false };
  }
  const body = r.choice === 'merge' ? r.body : op.body;
  // The user has seen the server copy: re-base onto it explicitly. If the server changes again, we get a new 409.
  await idb.put<NotesOp>('outbox', { ...op, body, baseVersion: serverVersion, conflict: undefined, status: 'pending', attempts: 0, error: undefined, updatedAt: now() });
  notify();
  return { body, baseVersion: serverVersion, queued: true };
}

export async function resolveActionConflict(id: string, choice: 'server' | 'mine'): Promise<void> {
  const op = await getOp<ActionStatusOp>(id);
  if (!op || !op.conflict) return;
  if (choice === 'server') await idb.delete('outbox', id);
  else
    await idb.put<ActionStatusOp>('outbox', {
      ...op,
      prevStatus: op.conflict.serverStatus as ActionStatus,
      baseUpdatedAt: op.conflict.serverUpdatedAt,
      conflict: undefined,
      status: 'pending',
      attempts: 0,
      updatedAt: now(),
    });
  notify();
}

// ---------------------------------------------------------------- replay
export interface ReplayResult {
  sent: number;
  conflicts: number;
  failed: number;
  remaining: number;
  offline: boolean;
}

let running: Promise<ReplayResult> | null = null;
let again = false;

/** Replays pending operations in order. Concurrent calls share one run (and trigger one more run afterwards). */
export function replayOutbox(client: ApiClient): Promise<ReplayResult> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let result: ReplayResult;
    do {
      again = false;
      result = await replayOnce(client);
    } while (again && !result.offline);
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
}

async function replayOnce(client: ApiClient): Promise<ReplayResult> {
  const res: ReplayResult = { sent: 0, conflicts: 0, failed: 0, remaining: 0, offline: false };
  const ops = (await listOps()).filter((o) => o.status === 'pending');
  for (const op of ops) {
    try {
      if (op.kind === 'notes.put') await sendNotes(client, op, res);
      else await sendActionStatus(client, op, res);
    } catch (e) {
      if (e instanceof NetworkError) {
        res.offline = true;
        break;
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof ApiError && e.status >= 500) {
        await idb.update<OutboxOp>('outbox', op.id, (cur) => (cur ? { ...cur, attempts: cur.attempts + 1, error: msg } : cur));
      } else {
        await idb.update<OutboxOp>('outbox', op.id, (cur) => (cur ? { ...cur, status: 'failed', attempts: cur.attempts + 1, error: msg } : cur));
        res.failed += 1;
      }
    }
  }
  res.remaining = (await listOps()).filter((o) => o.status === 'pending').length;
  notify();
  return res;
}

async function sendNotes(client: ApiClient, op: NotesOp, res: ReplayResult) {
  const path = `/api/w/${op.wsId}/meetings/${op.meetingId}/notes`;
  const sentBody = op.body;
  try {
    const saved = await client.put<{ version: number; updatedAt?: string }>(path, { body: sentBody, baseVersion: op.baseVersion });
    let stillPending = false;
    await idb.update<NotesOp>('outbox', op.id, (cur) => {
      if (!cur) return undefined;
      if (cur.body === sentBody && cur.status === 'pending') return undefined; // done
      // Edited again while the request was in flight: keep the newer text queued on top of the version we just wrote.
      stillPending = true;
      return { ...cur, baseVersion: saved.version, attempts: 0 };
    });
    await cacheServerNotes(op.wsId, op.meetingId, { body: sentBody, version: saved.version, updatedAt: saved.updatedAt ?? now() });
    res.sent += 1;
    if (stillPending) again = true; // newer text was typed meanwhile: send it in the next pass
    notesListeners.forEach((l) => l({ wsId: op.wsId, meetingId: op.meetingId, version: saved.version, body: sentBody, stillPending }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      let details = e.details as { serverBody?: string; serverVersion?: number } | undefined;
      if (typeof details?.serverVersion !== 'number') {
        const cur = await client.get<{ mine: { body: string; version: number } }>(path);
        details = { serverBody: cur.mine.body, serverVersion: cur.mine.version };
      }
      await idb.update<NotesOp>('outbox', op.id, (cur) =>
        cur ? { ...cur, status: 'conflict', conflict: { serverBody: details!.serverBody ?? '', serverVersion: details!.serverVersion ?? 0 }, error: undefined } : cur,
      );
      res.conflicts += 1;
      return;
    }
    throw e;
  }
}

interface ServerAction {
  id: string;
  status: string;
  updatedAt?: string | null;
}

async function fetchAction(client: ApiClient, op: ActionStatusOp): Promise<ServerAction | null> {
  try {
    return await client.get<ServerAction>(`/api/w/${op.wsId}/actions/${op.actionId}`);
  } catch (e) {
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) throw e;
  }
  // Fallback when there is no single-action endpoint: look the action up in the list views.
  const lists = [op.meetingId ? `/api/w/${op.wsId}/actions?meetingId=${op.meetingId}` : null, `/api/w/${op.wsId}/actions?assignee=me`];
  for (const p of lists) {
    if (!p) continue;
    try {
      const found = listOf<ServerAction>(await client.get(p), 'actions').find((a) => a.id === op.actionId);
      if (found) return found;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
  }
  return null;
}

async function sendActionStatus(client: ApiClient, op: ActionStatusOp, res: ReplayResult) {
  const target = op.targetStatus;
  const server = await fetchAction(client, op);
  if (server) {
    if (server.status === target) {
      await idb.delete('outbox', op.id); // already applied elsewhere
      res.sent += 1;
      return;
    }
    // Someone else changed the status after we went offline: never overwrite it silently.
    if (server.status !== op.prevStatus) {
      await idb.update<ActionStatusOp>('outbox', op.id, (cur) =>
        cur ? { ...cur, status: 'conflict', conflict: { serverStatus: server.status, serverUpdatedAt: server.updatedAt ?? null } } : cur,
      );
      res.conflicts += 1;
      return;
    }
  }
  try {
    await client.patch(`/api/w/${op.wsId}/actions/${op.actionId}`, { status: target });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const d = (e.details ?? {}) as { current?: ServerAction };
      await idb.update<ActionStatusOp>('outbox', op.id, (cur) =>
        cur ? { ...cur, status: 'conflict', conflict: { serverStatus: d.current?.status ?? 'unknown', serverUpdatedAt: d.current?.updatedAt ?? null } } : cur,
      );
      res.conflicts += 1;
      return;
    }
    throw e;
  }
  await idb.delete('outbox', op.id);
  res.sent += 1;
}
