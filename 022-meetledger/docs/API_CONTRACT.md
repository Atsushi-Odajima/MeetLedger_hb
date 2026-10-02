# MeetLedger HTTP API contract (v1)

All JSON. Auth = session cookie `ml_sid` (+ header `x-csrf-token` from `GET /api/me` on non-GET) or `Authorization: Bearer <api token>` (MCP / integrations; read/write scopes).
Errors: `{ "error": { "code": string, "message": string, "details"?: any } }` with 400/401/403/404/409/413/415/429.
Tenant routes are under `/api/w/:workspaceId/...`. 404 is returned for anything the caller cannot see (never 403 leaking existence).
DTO types: `packages/shared/src/api.ts`. Dates: ISO-8601 strings; date-only fields `YYYY-MM-DD`.
Owner column = module directory under `apps/server/src/modules/` responsible for the route.

## core (implemented)
| Method | Path | Notes |
|---|---|---|
| GET | /api/setup/status | `{needsSetup, allowSignup, sampleAvailable}` |
| POST | /api/setup | first run only `{email,name,password,orgName,workspaceName}` |
| POST | /api/auth/login, /api/auth/logout, /api/auth/signup (if enabled), /api/auth/change-password | |
| POST | /api/auth/accept-invite | `{token, name?, password?}` |
| GET/PATCH | /api/me | MeDto (includes csrfToken) / `{name,timezone,locale}` |
| POST | /api/orgs/:orgId/invitations | admin; `{email, role, workspaceId}` → `{inviteUrl}` (shown to admin; not emailed) |
| GET | /api/orgs/:orgId/members | |
| POST | /api/orgs/:orgId/workspaces | org admin |
| GET | /api/w/:ws | `{id,orgId,name,role,isSample,settings,processing}` |
| PATCH | /api/w/:ws ; /api/w/:ws/settings | admin; settings = WorkspaceSettings partial |
| GET | /api/w/:ws/members ; PUT/DELETE /api/w/:ws/members/:userId | |
| GET | /api/w/:ws/meetings?from&to&status&type&projectId&seriesId&personId&q&limit&before&order | `{items: MeetingDto[], nextCursor}` |
| POST | /api/w/:ws/meetings | create (participants `[{personId}|{name,email}]`, accessUserIds, privacy fields) |
| GET/PATCH | /api/w/:ws/meetings/:id | detail incl. participants, accessUsers, consents, privacy decisions; PATCH requires `version` (409 on stale) |
| PUT | /api/w/:ws/meetings/:id/participants ; /access | |
| POST | /api/w/:ws/meetings/:id/consent | `{kind, state, method, details}` |
| POST | /api/w/:ws/meetings/:id/start `{capture}` ; /end `{expectMedia}` | start with recording requires consent_state notified/confirmed (409 `consent_required`) |
| GET/PUT | /api/w/:ws/meetings/:id/notes | PUT `{body, baseVersion}` → 409 `{serverBody, serverVersion}` on conflict |
| GET/POST | /api/w/:ws/people ; GET/PATCH/DELETE /api/w/:ws/people/:id ; POST /people/:id/notes | |
| GET/POST | /api/w/:ws/projects ; GET/PATCH /projects/:id | |
| GET/POST | /api/w/:ws/series ; GET /series/:id | |

## audio (capture, pipeline, transcripts)
| POST | /api/w/:ws/meetings/:id/media | multipart `file` (audio/video), validated (size, magic bytes, MIME). → `{assetId, jobId, created}` and enqueues `audio.process` |
| GET | /api/w/:ws/meetings/:id/media | assets list (no storage keys) with short-lived signed `url` |
| GET | /api/files/:assetId?u&exp&sig | streams decrypted media; signature bound to user + expiry (403 when expired/invalid) |
| POST | /api/w/:ws/meetings/:id/process `{rerun?}` | (re)queue processing of the latest original media; idempotent |
| GET | /api/w/:ws/meetings/:id/processing | job states for the meeting |
| POST | /api/w/:ws/meetings/:id/transcript/import | JSON `{format: 'srt'|'vtt'|'txt'|'json', content, language?}` |
| POST | /api/w/:ws/meetings/:id/transcript/local | desktop local transcription result `{provider, model, language, segments:[{startMs,endMs,text,speaker?,confidence?}]}` (audio never uploaded) |
| GET | /api/w/:ws/meetings/:id/transcript | TranscriptDto (current) or null; `?version=` |
| GET | /api/w/:ws/meetings/:id/transcript/versions | |
| PATCH | /api/w/:ws/segments/:segmentId | `{text?, speakerId?, expectedRevision}` (409 if stale); keeps revision history |
| GET | /api/w/:ws/segments/:segmentId/revisions | |
| PATCH | /api/w/:ws/meetings/:id/speakers/:speakerId | `{personId?, displayName?}` (manual mapping only; no voice identification) |
| Jobs | `audio.process` → on success enqueue `ai.extract` (if AI allowed) and `index.meeting` | |

## ledger (AI extraction, ledgers, review, ask, coach)
| POST | /api/w/:ws/meetings/:id/extract `{rerun?}` | enqueue `ai.extract` (policy-checked) |
| GET | /api/w/:ws/meetings/:id/summary | SummaryDto or null (aiGenerated label) |
| GET | /api/w/:ws/meetings/:id/ledger | `{decisions, actions, commitments, questions, contradictions}` for the meeting |
| GET/POST | /api/w/:ws/decisions?view=current|all|candidates|superseded&projectId&seriesId&personId&meetingId | POST = manual (confirmed) |
| GET/PATCH | /api/w/:ws/decisions/:id ; GET /decisions/:id/history ; POST /decisions/:id/supersede `{text}|{newDecisionId}` | |
| GET/POST | /api/w/:ws/actions?status&assignee=me&overdue=1&meetingId&projectId | |
| PATCH | /api/w/:ws/actions/:id | status/assignee/due/description |
| GET/POST | /api/w/:ws/commitments?direction=mine|theirs|all&status ; PATCH /commitments/:id | |
| GET/POST | /api/w/:ws/questions?status ; PATCH /questions/:id | |
| GET | /api/w/:ws/review?meetingId | Review Inbox: candidates (all four types) + flags (assigneeInferred, dueInferred, missingOwner) + unmapped speakers + unlinked participants + open contradictions |
| POST | /api/w/:ws/review/:type/:id/accept `{edits?, confirmInferred?}` ; /reject ; PATCH /review/:type/:id | type = decision|action|commitment|question. Accepting inferred assignee/due requires `confirmInferred:true` or explicit edits |
| GET | /api/w/:ws/contradictions?status=open ; POST /contradictions/:id/resolve `{resolution:'change'|'not_change'|'dismiss'}` | change ⇒ new decision confirmed + old superseded (kept) |
| POST | /api/w/:ws/meetings/:id/ask `{question}` | AskResponseDto with timestamp citations |
| GET | /api/w/:ws/meetings/:id/coach | factual metrics only |

## followup (follow-up, notifications, brief, memory, timeline, dashboard, agenda, templates)
| POST | /api/w/:ws/meetings/:id/followups `{kind}` ; GET same | FollowupDraftDto (only confirmed items; never invents promises) |
| PATCH | /api/w/:ws/followups/:id ; POST /followups/:id/approve ; /discard ; /mark-sent | sending to external systems goes through external-writes (connectors) |
| GET | /api/notifications?unread=1 ; POST /api/notifications/:id/read ; POST /api/notifications/read-all | user-level across workspaces |
| GET/PUT | /api/w/:ws/notification-prefs | quiet hours, timezone, email, max/hour, brief lead |
| GET | /api/w/:ws/meetings/:id/brief | Pre-meeting brief (firstMeeting flag) |
| GET | /api/w/:ws/meetings/:id/agenda ; POST /agenda/suggest ; POST /agenda (manual) ; PATCH /api/w/:ws/agenda/:itemId | |
| GET | /api/w/:ws/people/:id/timeline | |
| GET | /api/w/:ws/projects/:id/memory ; /api/w/:ws/series/:id/memory ; /api/w/:ws/memory?topic= | Meeting Memory |
| POST | /api/w/:ws/series/:id/meetings `{scheduledStart, title?}` | next meeting in series |
| GET | /api/w/:ws/dashboard | Today/Upcoming/NeedsReview/MyActions/MyCommitments/WaitingOnOthers/Overdue/DecisionsChanged/OpenQuestions |
| GET/POST | /api/w/:ws/templates | built-in + custom |
| Jobs | `followup.tick` (system scheduler) | |

## search (FTS, semantic/RAG, AI privacy)
| GET | /api/w/:ws/search?q&types&from&to&projectId&personId&limit | ACL applied in SQL before ranking; each hit has citation |
| POST | /api/w/:ws/ask `{question, projectId?, personId?, from?, to?}` | cross-meeting RAG; only AI-enabled meetings; "unknown" when insufficient |
| GET | /api/w/:ws/ai/privacy-preview?meetingId | what would be sent where (provider, local/cloud, fields, sizes) |
| Jobs | `index.meeting`, `index.person` | |

## data (export/import/retention/delete/backup/sample)
| DELETE | /api/w/:ws/meetings/:id | full delete: DB rows, storage objects, search/AI index, caches → deletion_requests record |
| POST | /api/w/:ws/meetings/:id/delete-audio ; /delete-transcript ; /delete-ai-index | |
| GET | /api/w/:ws/meetings/:id/export?format=md|html|txt|srt|vtt|json | |
| GET | /api/w/:ws/decisions/export?format=csv|json ; /api/w/:ws/actions/export?format=csv ; /commitments/export?format=csv | |
| GET | /api/w/:ws/projects/:id/book?format=md|html | |
| POST | /api/w/:ws/export/full → `{jobId}` ; GET /api/w/:ws/export/full/:jobId → `{status, url?}` | all data JSON (+ optional media) |
| POST | /api/w/:ws/import/full | restore a full export into an EMPTY workspace |
| POST | /api/sample-workspace | creates the separate fictional Sample organization for the caller |
| GET | /api/w/:ws/deletion-requests | |
| Jobs | `retention.sweep`, `export.full` | CLI: backup / restore |

## connectors (calendar, webhooks, external writes, API tokens) and MCP
| GET | /api/w/:ws/connectors | |
| POST | /api/w/:ws/connectors/ics `{url?|content?}` → preview ; POST /connectors/:id/import `{eventIds}` | |
| GET | /api/w/:ws/connectors/:provider/start (google_calendar|microsoft_calendar) → `{authorizeUrl}` ; GET /api/connectors/oauth/callback | minimal read-only scopes |
| POST | /api/w/:ws/connectors/:id/sync → preview of events (no write) ; DELETE /connectors/:id | |
| GET/POST/DELETE | /api/w/:ws/webhooks | HMAC signed deliveries |
| GET/POST | /api/w/:ws/external-writes ; POST /external-writes/:id/approve ; /reject | every external write = preview + explicit approval |
| GET/POST/DELETE | /api/w/:ws/api-tokens | MCP / integration tokens (shown once) |
| * | /mcp | MCP Streamable HTTP endpoint (Bearer token). Write tools require a confirmation step |
