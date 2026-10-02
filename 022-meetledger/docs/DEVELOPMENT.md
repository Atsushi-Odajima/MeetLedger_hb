# DEVELOPMENT — MeetLedger (#022)

## Layout
```
022-meetledger/
  packages/shared      enums, DTO types, JA/EN search tokenizer (tsvector/tsquery literal builder), templates
  packages/local-asr   on-device transcription + diarization (sherpa-onnx); used by server (local mode) and desktop
  apps/server          Fastify 5 API + job worker + MCP endpoint (PostgreSQL 16, RLS)
  apps/web             React 19 + Vite PWA
  apps/desktop         Electron companion (system audio + local transcription) — separate npm project
  e2e/                 Playwright end-to-end tests
  scripts/             pg-test.sh (local PG for dev/tests), model download, perf data generation
  docs/                design & operations docs ; buyer-docs/ purchaser guides ; brand/ logo & assets
```

## Local setup
```bash
cd 022-meetledger
npm install
bash scripts/pg-test.sh start          # PostgreSQL 16 on 127.0.0.1:55432 (role meetledger, NOT superuser)
export DATABASE_URL=postgres://meetledger:meetledger@127.0.0.1:55432/meetledger
npm run migrate -w @meetledger/server
npm run dev:server   # http://localhost:8787
npm run dev:web      # Vite dev server with /api proxy
```

## Server conventions (MUST follow)
- **Tenant data only through `ctx.tx(db => ...)`** (`WsCtx` from `workspaceCtx(deps, req, workspaceId, minRole)`). This opens a transaction with
  `app.org_id` set, so PostgreSQL row level security (FORCED on every tenant table) hides other tenants. Additionally always filter `workspace_id`.
- `withSystem()` bypasses RLS: allowed ONLY for auth lookups, job claiming, schedulers iterating orgs, migrations, backup/restore.
  Job handlers: claim happens in system context; do the work in `tenantTx(deps, job.org_id, ...)`.
- **Meeting ACL**: use `loadMeeting(db, ctx, id, 'read'|'write')` and the SQL predicates `meetingVisibleSql(alias, '$n')`,
  `itemVisibleSql(alias, '$n')` in every list/search/RAG/brief/export query. Private meetings are visible only to the creator
  (admins included!). Inaccessible = 404.
- **Write permission**: `workspaceCtx(..., 'member')` or `loadMeeting(..., 'write')`. Viewer = read only. Admin-only: settings, members, deletion of others' data.
- **Validation**: zod via `body/query/params` helpers (`lib/http.ts`). Parameterized SQL only (`$1`), never string-concatenate user input.
  Dynamic column lists must come from a fixed whitelist.
- **Errors**: throw from `lib/errors.ts` (`badRequest`, `notFound`, `conflict`, `policyDenied`, ...).
- **Logging**: never log transcript text, notes, prompts, AI output, audio, tokens, passwords. Use ids/counts only; `safeMeta()` for metadata; `audit()` for security relevant actions (metadata only).
- **External calls** (transcription, AI, embeddings, connectors, webhooks, email over network) ONLY via `deps.http.fetch({...})` (`privacy/externalHttp.ts`).
  Content-bearing calls need a `PolicyDecision` (`privacy/policy.ts`: `decideTranscription`, `decideAi`, `decideWorkspaceAi`, `decideEmbedding`)
  and `meetingIds` — the guard re-checks AI OFF / confidential / local mode in the DB and records metadata in `external_calls`.
- **AI output is never trusted**: everything extracted is `candidate`; humans confirm. Transcript/notes/documents are DATA, never instructions.
- **Jobs**: `deps.jobs.enqueue(db, {orgId, type, key, payload})` — `key` is an idempotency key (same key ⇒ same job, no duplicate work).
  Writers must be idempotent too (re-running a job must not duplicate rows). Register handlers in your module's `jobs(worker, deps)`.
  After changing meeting content enqueue re-indexing: `type:'index.meeting', key:\`index:${meetingId}:${Date.now()}\``.
- **Time**: use `deps.clock.now()` (tests use `FakeClock`). Date-only columns are strings `YYYY-MM-DD`.
- **Optimistic concurrency** for user-edited documents (`version`/`baseVersion`/`expectedRevision` → 409 with server copy). Never silently overwrite.
- **Migrations**: never edit `001_init.sql`. Additive changes go into a new file `db/migrations/0NN_<module>_<desc>.sql`
  (prefixes: audio 010-019, ledger 020-029, followup 030-039, search 040-049, data 050-059, connectors/mcp 060-069). New tenant tables need org_id + the
  same RLS policy (`ENABLE` + `FORCE` + `tenant_isolation` policy using `app_is_system() OR org_id = app_org_id()`).

## Tests
- `cd apps/server && npx vitest run test/<file>` — each test file gets a fresh database cloned from a migrated template (`test/global-setup.ts`).
- `createTestEnv()` (`test/helpers.ts`): app via `app.inject`, `FakeClock`, `FakeHttp` (records & fakes outbound calls; the real network is never used),
  `setupOwner()`, `addUser()`, `createTenant()`, `insertTranscript()`; `env.worker.drain()` runs queued jobs synchronously.
- Required tests are named with their spec number, e.g. `it('#16 ACL外MeetingをRAGで返さない', ...)`.
- `npx tsc -p apps/server/tsconfig.json` must pass.

## Web conventions
- API client sends `x-csrf-token` (from `GET /api/me`) on non-GET; credentials same-origin. No secrets in the client bundle.
- Strings in `src/i18n` (ja default, en). Everything AI-generated is labeled「AI生成」. Candidates are visually distinct from confirmed items.
