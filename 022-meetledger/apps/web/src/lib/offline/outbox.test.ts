import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createApiClient } from '../api';
import { closeDb } from './idb';
import {
  actionOpId,
  getCachedServerNotes,
  getOp,
  listOps,
  notesOpId,
  onNotesSaved,
  queueActionStatus,
  queueNotes,
  replayOutbox,
  resolveActionConflict,
  resolveNotesConflict,
  setOutboxUser,
  type ActionStatusOp,
  type NotesOp,
} from './outbox';

const WS = 'ws1';
const M = 'm1';

interface ServerState {
  online: boolean;
  notes: { body: string; version: number };
  action: { id: string; status: string; updatedAt: string };
  puts: { body: string; baseVersion: number }[];
  patches: { status: string }[];
  /** Hook run while a PUT is "in flight" (simulates typing during the request). */
  duringPut?: () => Promise<void>;
}

function setup(state: ServerState) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (!state.online) throw new TypeError('Failed to fetch');
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const res = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url === '/api/me') return res(200, { csrfToken: 'csrf' });
    if (url === `/api/w/${WS}/meetings/${M}/notes` && method === 'GET') return res(200, { mine: state.notes, others: [] });
    if (url === `/api/w/${WS}/meetings/${M}/notes` && method === 'PUT') {
      state.puts.push(body);
      if (state.duringPut) await state.duringPut();
      if (body.baseVersion !== state.notes.version)
        return res(409, { error: { code: 'conflict', message: 'Notes were changed on another device', details: { serverBody: state.notes.body, serverVersion: state.notes.version } } });
      state.notes = { body: body.body, version: state.notes.version + 1 };
      return res(200, { version: state.notes.version, updatedAt: '2026-10-02T00:00:00.000Z' });
    }
    if (url === `/api/w/${WS}/actions/${state.action.id}` && method === 'GET') return res(200, state.action);
    if (url === `/api/w/${WS}/actions/${state.action.id}` && method === 'PATCH') {
      state.patches.push(body);
      state.action = { ...state.action, status: body.status, updatedAt: new Date().toISOString() };
      return res(200, state.action);
    }
    return res(404, { error: { code: 'not_found', message: 'Not found' } });
  });
  const client = createApiClient({ fetch: fetchImpl as unknown as typeof fetch });
  client.setCsrf('csrf');
  return { client, fetchImpl };
}

function freshState(): ServerState {
  return {
    online: true,
    notes: { body: '', version: 0 },
    action: { id: 'a1', status: 'confirmed', updatedAt: '2026-10-01T00:00:00.000Z' },
    puts: [],
    patches: [],
  };
}

beforeEach(async () => {
  await closeDb();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  setOutboxUser('u1');
});

describe('offline queue — notes', () => {
  it('keeps edits queued while offline and coalesces them on the original base version', async () => {
    const state = freshState();
    state.online = false;
    const { client } = setup(state);
    await queueNotes({ wsId: WS, meetingId: M, body: 'a', baseVersion: 0 });
    await queueNotes({ wsId: WS, meetingId: M, body: 'ab', baseVersion: 7 /* ignored: base is kept */ });
    const r = await replayOutbox(client);
    expect(r.offline).toBe(true);
    const ops = await listOps();
    expect(ops).toHaveLength(1);
    const op = ops[0] as NotesOp;
    expect(op.body).toBe('ab');
    expect(op.baseVersion).toBe(0);
    expect(op.status).toBe('pending');
  });

  it('replays when back online, clears the op and caches the server copy', async () => {
    const state = freshState();
    const { client } = setup(state);
    const saved = vi.fn();
    const off = onNotesSaved(saved);
    await queueNotes({ wsId: WS, meetingId: M, body: 'hello', baseVersion: 0 });
    const r = await replayOutbox(client);
    off();
    expect(r).toMatchObject({ sent: 1, conflicts: 0, offline: false, remaining: 0 });
    expect(state.notes).toEqual({ body: 'hello', version: 1 });
    expect(await listOps()).toHaveLength(0);
    expect(await getCachedServerNotes(WS, M)).toMatchObject({ body: 'hello', version: 1 });
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ version: 1, body: 'hello', stillPending: false }));
  });

  it('never overwrites newer server notes: a stale base becomes a conflict with the server copy', async () => {
    const state = freshState();
    state.notes = { body: 'written on laptop', version: 3 };
    const { client } = setup(state);
    await queueNotes({ wsId: WS, meetingId: M, body: 'written offline on phone', baseVersion: 2 });
    const r = await replayOutbox(client);
    expect(r.conflicts).toBe(1);
    expect(state.notes).toEqual({ body: 'written on laptop', version: 3 }); // untouched
    const op = (await getOp<NotesOp>(notesOpId(WS, M)))!;
    expect(op.status).toBe('conflict');
    expect(op.body).toBe('written offline on phone'); // local text preserved
    expect(op.conflict).toEqual({ serverBody: 'written on laptop', serverVersion: 3 });
    // A conflicted op is not retried automatically.
    await replayOutbox(client);
    expect(state.puts).toHaveLength(1);
  });

  it('resolving with "merge" re-bases on the server version and saves both texts', async () => {
    const state = freshState();
    state.notes = { body: 'server', version: 3 };
    const { client } = setup(state);
    await queueNotes({ wsId: WS, meetingId: M, body: 'mine', baseVersion: 1 });
    await replayOutbox(client);
    const res = await resolveNotesConflict(notesOpId(WS, M), { choice: 'merge', body: 'mine\n---\nserver' });
    expect(res).toEqual({ body: 'mine\n---\nserver', baseVersion: 3, queued: true });
    await replayOutbox(client);
    expect(state.notes).toEqual({ body: 'mine\n---\nserver', version: 4 });
    expect(await listOps()).toHaveLength(0);
  });

  it('resolving with "server" drops the local op without writing', async () => {
    const state = freshState();
    state.notes = { body: 'server', version: 3 };
    const { client } = setup(state);
    await queueNotes({ wsId: WS, meetingId: M, body: 'mine', baseVersion: 1 });
    await replayOutbox(client);
    const res = await resolveNotesConflict(notesOpId(WS, M), { choice: 'server' });
    expect(res).toEqual({ body: 'server', baseVersion: 3, queued: false });
    expect(await listOps()).toHaveLength(0);
    expect(state.puts).toHaveLength(1);
  });

  it('keeps text typed while a save is in flight (re-queued on top of the new version)', async () => {
    const state = freshState();
    const { client } = setup(state);
    state.duringPut = async () => {
      state.duringPut = undefined;
      await queueNotes({ wsId: WS, meetingId: M, body: 'first + more', baseVersion: 0 });
    };
    await queueNotes({ wsId: WS, meetingId: M, body: 'first', baseVersion: 0 });
    await replayOutbox(client);
    // the second run (triggered automatically) saves the newer text with baseVersion 1
    expect(state.notes).toEqual({ body: 'first + more', version: 2 });
    expect(state.puts.map((p) => p.baseVersion)).toEqual([0, 1]);
    expect(await listOps()).toHaveLength(0);
  });

  it('only replays the signed-in user’s edits on a shared device', async () => {
    const state = freshState();
    const { client } = setup(state);
    setOutboxUser('someone-else');
    await queueNotes({ wsId: WS, meetingId: M, body: 'not mine', baseVersion: 0 });
    setOutboxUser('u1');
    expect(await listOps()).toHaveLength(0);
    await replayOutbox(client);
    expect(state.puts).toHaveLength(0);
  });
});

describe('offline queue — action status', () => {
  it('applies the change when the server still has the status we saw', async () => {
    const state = freshState();
    const { client } = setup(state);
    await queueActionStatus({ wsId: WS, actionId: 'a1', status: 'done', prevStatus: 'confirmed', baseUpdatedAt: state.action.updatedAt });
    const r = await replayOutbox(client);
    expect(r.sent).toBe(1);
    expect(state.patches).toEqual([{ status: 'done' }]);
    expect(await listOps()).toHaveLength(0);
  });

  it('does not overwrite a status changed elsewhere; the user decides', async () => {
    const state = freshState();
    const { client } = setup(state);
    await queueActionStatus({ wsId: WS, actionId: 'a1', status: 'done', prevStatus: 'confirmed', baseUpdatedAt: state.action.updatedAt });
    state.action = { id: 'a1', status: 'cancelled', updatedAt: '2026-10-02T08:00:00.000Z' }; // changed by a teammate
    const r = await replayOutbox(client);
    expect(r.conflicts).toBe(1);
    expect(state.patches).toHaveLength(0);
    const op = (await getOp<ActionStatusOp>(actionOpId(WS, 'a1')))!;
    expect(op.status).toBe('conflict');
    expect(op.conflict).toEqual({ serverStatus: 'cancelled', serverUpdatedAt: '2026-10-02T08:00:00.000Z' });

    await resolveActionConflict(op.id, 'mine');
    await replayOutbox(client);
    expect(state.patches).toEqual([{ status: 'done' }]);
  });

  it('drops the op when the net change is cancelled while offline', async () => {
    await queueActionStatus({ wsId: WS, actionId: 'a1', status: 'done', prevStatus: 'confirmed', baseUpdatedAt: null });
    await queueActionStatus({ wsId: WS, actionId: 'a1', status: 'confirmed', prevStatus: 'done', baseUpdatedAt: null });
    expect(await listOps()).toHaveLength(0);
  });

  it('treats an already-applied status as done without writing', async () => {
    const state = freshState();
    const { client } = setup(state);
    await queueActionStatus({ wsId: WS, actionId: 'a1', status: 'done', prevStatus: 'confirmed', baseUpdatedAt: null });
    state.action = { ...state.action, status: 'done' };
    await replayOutbox(client);
    expect(state.patches).toHaveLength(0);
    expect(await listOps()).toHaveLength(0);
  });
});
