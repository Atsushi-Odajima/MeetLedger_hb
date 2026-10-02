# DATA_MODEL — MeetLedger (#022)

PostgreSQL 16。マイグレーション: `apps/server/src/db/migrations/*.sql`（起動時に自動適用、`schema_migrations` で管理）。
**テナント分離**: `org_id` を持つ全テーブルに `ENABLE` + `FORCE ROW LEVEL SECURITY` と `tenant_isolation` ポリシー
（`app_is_system() OR org_id = app_org_id()`）。グローバル表（`organizations`, `users`, `org_members`, `sessions`）はアプリ層で制御。

## 概念と関係
```
Organization ─┬─ Workspace ─┬─ Meeting ─┬─ Participant ── Person
              │             │           ├─ ConsentRecord / MeetingNote / AgendaItem
              │             │           ├─ MediaAsset (original audio/video, 暗号化)       [retention_until]
              │             │           ├─ Transcript (version, is_current) ─ TranscriptSegment (tsv) ─ SegmentRevision
              │             │           ├─ MeetingSpeaker (Speaker 1/2 → person は人間が割当)
              │             │           ├─ Summary (version, AI生成)
              │             │           ├─ Decision ⇄ (supersedes / superseded_by) Decision
              │             │           ├─ Action (→ linked Decision)   Commitment (promised_by → promised_to)
              │             │           ├─ OpenQuestion   ContradictionCandidate (existing ⇄ new Decision)
              │             │           ├─ FollowupDraft  BriefSnapshot
              │             │           └─ SearchDoc / AiChunk (vector, ACL metadata)  ExternalCall (metadata only)
              │             ├─ Project/Client ── Meeting   Series(recurring) ── Meeting
              │             ├─ Person ── PersonNote        Template (custom)
              │             ├─ ConnectorAccount ── ExternalWriteRequest   Webhook ── deliveries
              │             └─ ApiToken (MCP)  Invitation
              └─ Org members (role)            Notifications / UserPrefs / EmailOutbox / AuditEvent / DeletionRequest / Jobs
```

## 主要な状態
| エンティティ | 状態 |
|---|---|
| Meeting.status | scheduled → live → processing → needs_review → ready / archived |
| Meeting.visibility | private（作成者のみ）/ workspace / selected（meeting_access） |
| Meeting.consent_state | not_recording / pending / notified / confirmed / declined |
| Meeting.audio_retention | never / until_processed / 7d / 30d / custom(+days) |
| Meeting.transcription_mode / ai_enabled / is_confidential | local・cloud・none / bool / bool（Confidential は AI OFF・local・private を強制） |
| Decision | review_state: candidate → confirmed / rejected、status: active → superseded（削除しない）/ revoked |
| Action.status | candidate → confirmed → in_progress → done / cancelled / rejected（overdue は派生値） |
| Commitment.status | candidate → open → done / cancelled / rejected |
| OpenQuestion.status | candidate → open → answered / dropped / rejected |
| ContradictionCandidate.status | open → confirmed_change / not_change / dismissed |
| FollowupDraft.status | draft → approved → sent / discarded（送信は人間） |
| ExternalWriteRequest.status | pending_approval → approved → executed / rejected / failed |
| Job.status | queued → running → succeeded / failed(再試行) / dead |

## 根拠（Source）の持ち方
Ledger 各表は `source_segment_ids uuid[]`, `source_start_ms`, `source_end_ms`, `source_quote`, `source_transcript_id`,
`source_revisions jsonb`（抽出時の segment revision）を持つ。表示時に現在の segment と比較して `ok / edited / missing` を算出
（Transcript 編集後も ID と引用は保持 = 必須テスト#29）。

## 検索
- `transcript_segments.tsv` / `search_docs.tsv` / `ai_chunks.tsv`: アプリ側 bigram tokenizer（packages/shared/src/textIndex.ts）で生成した tsvector（GIN）。
- `ai_chunks.embedding real[]`: AI ON かつ非 Confidential の Meeting のみ。ACL は検索時に meetings と結合して SQL で適用。

## テーブル定義（自動生成: scripts/gen-data-model.sh, migrations: 001_init.sql, 010_audio_indexes.sql, 021_ledger_perf_indexes.sql, 022_ledger_review_order.sql, 030_followup_drafts_notifications.sql, 031_followup_perf_indexes.sql, 040_search_index_meta.sql, 041_search_perf.sql, 060_connectors_core.sql）

### actions

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| meeting_id | uuid | YES |  |
| project_id | uuid | YES |  |
| series_id | uuid | YES |  |
| description | text | NO |  |
| assignee_person_id | uuid | YES |  |
| assignee_user_id | uuid | YES |  |
| assignee_speaker_id | uuid | YES |  |
| assignee_text | text | YES |  |
| assignee_inferred | boolean | NO | false |
| due_date | date | YES |  |
| due_text | text | YES |  |
| due_inferred | boolean | NO | false |
| status | text | NO | 'candidate'::text |
| linked_decision_id | uuid | YES |  |
| external_sync_state | text | NO | 'none'::text |
| external_ref | text | YES |  |
| source_segment_ids | ARRAY | NO | '{}'::uuid[] |
| source_start_ms | integer | YES |  |
| source_end_ms | integer | YES |  |
| source_quote | text | YES |  |
| source_transcript_id | uuid | YES |  |
| source_revisions | jsonb | NO | '{}'::jsonb |
| confidence | real | YES |  |
| extracted_by | text | NO | 'user'::text |
| ai_provider | text | YES |  |
| created_by | uuid | YES |  |
| confirmed_by | uuid | YES |  |
| confirmed_at | timestamp with time zone | YES |  |
| completed_at | timestamp with time zone | YES |  |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |

### agenda_items

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| meeting_id | uuid | NO |  |
| text | text | NO |  |
| source_type | text | NO | 'manual'::text |
| source_id | uuid | YES |  |
| status | text | NO | 'candidate'::text |
| position | integer | NO | 0 |
| created_at | timestamp with time zone | NO | now() |

### ai_chunks

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| meeting_id | uuid | YES |  |
| entity_type | text | NO |  |
| entity_id | uuid | NO |  |
| chunk_index | integer | NO | 0 |
| text | text | NO |  |
| start_ms | integer | YES |  |
| end_ms | integer | YES |  |
| embedding | ARRAY | NO |  |
| embedding_model | text | NO |  |
| tsv | tsvector | YES |  |
| created_at | timestamp with time zone | NO | now() |
| person_ids | ARRAY | NO | '{}'::uuid[] |
| meta | jsonb | NO | '{}'::jsonb |
| content_hash | text | YES |  |

### api_tokens

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| user_id | uuid | NO |  |
| name | text | NO |  |
| token_hash | text | NO |  |
| scopes | ARRAY | NO | '{read}'::text[] |
| created_at | timestamp with time zone | NO | now() |
| last_used_at | timestamp with time zone | YES |  |
| expires_at | timestamp with time zone | YES |  |
| revoked_at | timestamp with time zone | YES |  |

### audit_events

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | YES |  |
| user_id | uuid | YES |  |
| action | text | NO |  |
| entity_type | text | YES |  |
| entity_id | uuid | YES |  |
| meta | jsonb | NO | '{}'::jsonb |
| ip | text | YES |  |
| created_at | timestamp with time zone | NO | now() |

### brief_snapshots

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| meeting_id | uuid | NO |  |
| user_id | uuid | NO |  |
| content | jsonb | NO |  |
| generated_at | timestamp with time zone | NO | now() |

### commitments

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| meeting_id | uuid | YES |  |
| project_id | uuid | YES |  |
| series_id | uuid | YES |  |
| description | text | NO |  |
| promised_by_person_id | uuid | YES |  |
| promised_by_user_id | uuid | YES |  |
| promised_by_speaker_id | uuid | YES |  |
| promised_by_text | text | YES |  |
| promised_to_person_id | uuid | YES |  |
| promised_to_user_id | uuid | YES |  |
| promised_to_text | text | YES |  |
| due_date | date | YES |  |
| due_text | text | YES |  |
| due_inferred | boolean | NO | false |
| status | text | NO | 'candidate'::text |
| source_segment_ids | ARRAY | NO | '{}'::uuid[] |
| source_start_ms | integer | YES |  |
| source_end_ms | integer | YES |  |
| source_quote | text | YES |  |
| source_transcript_id | uuid | YES |  |
| source_revisions | jsonb | NO | '{}'::jsonb |
| confidence | real | YES |  |
| extracted_by | text | NO | 'user'::text |
| ai_provider | text | YES |  |
| created_by | uuid | YES |  |
| confirmed_by | uuid | YES |  |
| confirmed_at | timestamp with time zone | YES |  |
| completed_at | timestamp with time zone | YES |  |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |

### connector_accounts

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| user_id | uuid | NO |  |
| provider | text | NO |  |
| display_name | text | YES |  |
| status | text | NO | 'active'::text |
| scopes | ARRAY | NO | '{}'::text[] |
| secret_ciphertext | text | YES |  |
| config | jsonb | NO | '{}'::jsonb |
| expires_at | timestamp with time zone | YES |  |
| last_sync_at | timestamp with time zone | YES |  |
| last_error | text | YES |  |
| created_at | timestamp with time zone | NO | now() |

### connector_events

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| connector_id | uuid | NO |  |
| event_key | text | NO |  |
| series_key | text | YES |  |
| recurrence | text | YES |  |
| title | text | NO |  |
| starts_at | timestamp with time zone | NO |  |
| ends_at | timestamp with time zone | YES |  |
| all_day | boolean | NO | false |
| start_date | date | YES |  |
| end_date | date | YES |  |
| timezone | text | YES |  |
| organizer | jsonb | YES |  |
| attendees | jsonb | NO | '[]'::jsonb |
| flags | ARRAY | NO | '{}'::text[] |
| fetched_at | timestamp with time zone | NO | now() |

### connector_oauth_states

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| user_id | uuid | NO |  |
| provider | text | NO |  |
| state_hash | text | NO |  |
| verifier_ciphertext | text | NO |  |
| redirect_uri | text | NO |  |
| scopes | ARRAY | NO | '{}'::text[] |
| expires_at | timestamp with time zone | NO |  |
| used_at | timestamp with time zone | YES |  |
| created_at | timestamp with time zone | NO | now() |

### consent_records

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| meeting_id | uuid | NO |  |
| kind | text | NO |  |
| state | text | NO |  |
| method | text | NO | 'in_app'::text |
| details | jsonb | NO | '{}'::jsonb |
| recorded_by | uuid | YES |  |
| created_at | timestamp with time zone | NO | now() |

### contradiction_candidates

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| meeting_id | uuid | YES |  |
| existing_decision_id | uuid | NO |  |
| new_decision_id | uuid | NO |  |
| reason | text | NO |  |
| status | text | NO | 'open'::text |
| resolved_by | uuid | YES |  |
| resolved_at | timestamp with time zone | YES |  |
| created_at | timestamp with time zone | NO | now() |

### decisions

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| meeting_id | uuid | YES |  |
| project_id | uuid | YES |  |
| series_id | uuid | YES |  |
| text | text | NO |  |
| topic | text | YES |  |
| topic_key | text | YES |  |
| decided_at | timestamp with time zone | YES |  |
| owner_person_id | uuid | YES |  |
| reason | text | YES |  |
| participant_person_ids | ARRAY | NO | '{}'::uuid[] |
| review_state | text | NO | 'candidate'::text |
| status | text | NO | 'active'::text |
| supersedes_decision_id | uuid | YES |  |
| superseded_by_decision_id | uuid | YES |  |
| source_segment_ids | ARRAY | NO | '{}'::uuid[] |
| source_start_ms | integer | YES |  |
| source_end_ms | integer | YES |  |
| source_quote | text | YES |  |
| source_transcript_id | uuid | YES |  |
| source_revisions | jsonb | NO | '{}'::jsonb |
| confidence | real | YES |  |
| extracted_by | text | NO | 'user'::text |
| ai_provider | text | YES |  |
| created_by | uuid | YES |  |
| confirmed_by | uuid | YES |  |
| confirmed_at | timestamp with time zone | YES |  |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |

### deletion_requests

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | YES |  |
| scope | text | NO |  |
| target_id | uuid | NO |  |
| target_label | text | YES |  |
| requested_by | uuid | YES |  |
| status | text | NO | 'pending'::text |
| steps | jsonb | NO | '{}'::jsonb |
| created_at | timestamp with time zone | NO | now() |
| completed_at | timestamp with time zone | YES |  |

### email_outbox

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| to_address | text | NO |  |
| subject | text | NO |  |
| body | text | NO |  |
| status | text | NO | 'queued'::text |
| dedupe_key | text | YES |  |
| error | text | YES |  |
| created_at | timestamp with time zone | NO | now() |
| sent_at | timestamp with time zone | YES |  |

### external_calls

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| meeting_id | uuid | YES |  |
| kind | text | NO |  |
| provider | text | NO |  |
| host | text | NO |  |
| purpose | text | NO |  |
| bytes_sent | bigint | NO | 0 |
| status | text | NO |  |
| created_at | timestamp with time zone | NO | now() |

### external_write_requests

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| connector_id | uuid | YES |  |
| provider | text | NO |  |
| kind | text | NO |  |
| target | text | YES |  |
| preview | jsonb | NO |  |
| payload_hash | text | NO |  |
| status | text | NO | 'pending_approval'::text |
| requested_by | uuid | YES |  |
| approved_by | uuid | YES |  |
| approved_at | timestamp with time zone | YES |  |
| executed_at | timestamp with time zone | YES |  |
| result | jsonb | YES |  |
| created_at | timestamp with time zone | NO | now() |

### followup_drafts

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| meeting_id | uuid | NO |  |
| kind | text | NO |  |
| subject | text | YES |  |
| body | text | NO |  |
| referenced_items | jsonb | NO | '[]'::jsonb |
| status | text | NO | 'draft'::text |
| generated_by | text | NO | 'template'::text |
| external_write_id | uuid | YES |  |
| created_by | uuid | YES |  |
| approved_by | uuid | YES |  |
| approved_at | timestamp with time zone | YES |  |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| workspace_id | uuid | YES |  |
| locale | text | NO | 'ja'::text |
| tone | text | YES |  |
| edited | boolean | NO | false |
| edited_by | uuid | YES |  |
| edited_at | timestamp with time zone | YES |  |
| version | integer | NO | 1 |
| sent_by | uuid | YES |  |
| sent_at | timestamp with time zone | YES |  |
| discarded_at | timestamp with time zone | YES |  |
| meta | jsonb | NO | '{}'::jsonb |

### invitations

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | YES |  |
| email | text | NO |  |
| role | text | NO |  |
| token_hash | text | NO |  |
| invited_by | uuid | YES |  |
| expires_at | timestamp with time zone | NO |  |
| accepted_at | timestamp with time zone | YES |  |
| created_at | timestamp with time zone | NO | now() |

### jobs

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | YES |  |
| type | text | NO |  |
| idempotency_key | text | NO |  |
| payload | jsonb | NO | '{}'::jsonb |
| status | text | NO | 'queued'::text |
| attempts | integer | NO | 0 |
| max_attempts | integer | NO | 3 |
| run_after | timestamp with time zone | NO | now() |
| locked_by | text | YES |  |
| locked_until | timestamp with time zone | YES |  |
| last_error | text | YES |  |
| result | jsonb | YES |  |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| finished_at | timestamp with time zone | YES |  |

### ledger_events

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| entity_type | text | NO |  |
| entity_id | uuid | NO |  |
| event | text | NO |  |
| by_user_id | uuid | YES |  |
| diff | jsonb | NO | '{}'::jsonb |
| created_at | timestamp with time zone | NO | now() |

### mcp_confirmations

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| user_id | uuid | NO |  |
| tool | text | NO |  |
| args_hash | text | NO |  |
| preview | jsonb | NO |  |
| expires_at | timestamp with time zone | NO |  |
| used_at | timestamp with time zone | YES |  |
| created_at | timestamp with time zone | NO | now() |

### media_assets

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| meeting_id | uuid | NO |  |
| kind | text | NO |  |
| storage_key | text | NO |  |
| mime | text | NO |  |
| original_name | text | YES |  |
| size_bytes | bigint | NO | 0 |
| sha256 | text | NO |  |
| duration_ms | integer | YES |  |
| channels | integer | YES |  |
| encrypted | boolean | NO | true |
| retention_until | timestamp with time zone | YES |  |
| created_by | uuid | YES |  |
| created_at | timestamp with time zone | NO | now() |
| deleted_at | timestamp with time zone | YES |  |

### meeting_access

| column | type | null | default |
|---|---|---|---|
| meeting_id | uuid | NO |  |
| org_id | uuid | NO |  |
| user_id | uuid | NO |  |

### meeting_notes

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| meeting_id | uuid | NO |  |
| author_user_id | uuid | NO |  |
| body | text | NO | ''::text |
| version | integer | NO | 1 |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |

### meeting_speakers

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| meeting_id | uuid | NO |  |
| label | text | NO |  |
| person_id | uuid | YES |  |
| display_name | text | YES |  |
| source | text | NO | 'diarization'::text |
| suggestion | text | YES |  |
| updated_by | uuid | YES |  |
| updated_at | timestamp with time zone | NO | now() |

### meetings

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| title | text | NO |  |
| scheduled_start | timestamp with time zone | YES |  |
| scheduled_end | timestamp with time zone | YES |  |
| started_at | timestamp with time zone | YES |  |
| ended_at | timestamp with time zone | YES |  |
| source | text | NO | 'manual'::text |
| calendar_event_id | text | YES |  |
| calendar_connection_id | uuid | YES |  |
| organizer_person_id | uuid | YES |  |
| meeting_type | text | NO | 'other'::text |
| project_id | uuid | YES |  |
| series_id | uuid | YES |  |
| template_key | text | YES |  |
| visibility | text | NO | 'workspace'::text |
| consent_state | text | NO | 'not_recording'::text |
| audio_retention | text | NO | 'until_processed'::text |
| audio_retention_days | integer | YES |  |
| transcription_mode | text | NO | 'local'::text |
| ai_enabled | boolean | NO | true |
| is_confidential | boolean | NO | false |
| status | text | NO | 'scheduled'::text |
| language | text | YES |  |
| created_by | uuid | NO |  |
| version | integer | NO | 1 |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| deleted_at | timestamp with time zone | YES |  |

### notifications

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | YES |  |
| user_id | uuid | NO |  |
| kind | text | NO |  |
| entity_type | text | YES |  |
| entity_id | uuid | YES |  |
| dedupe_key | text | NO |  |
| title | text | NO |  |
| body | text | NO | ''::text |
| link | text | YES |  |
| scheduled_for | timestamp with time zone | NO | now() |
| status | text | NO | 'pending'::text |
| delivered_at | timestamp with time zone | YES |  |
| read_at | timestamp with time zone | YES |  |
| created_at | timestamp with time zone | NO | now() |
| digest_id | uuid | YES |  |

### open_questions

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| meeting_id | uuid | YES |  |
| project_id | uuid | YES |  |
| series_id | uuid | YES |  |
| question | text | NO |  |
| owner_person_id | uuid | YES |  |
| due_date | date | YES |  |
| status | text | NO | 'candidate'::text |
| answer_text | text | YES |  |
| answered_in_meeting_id | uuid | YES |  |
| source_segment_ids | ARRAY | NO | '{}'::uuid[] |
| source_start_ms | integer | YES |  |
| source_end_ms | integer | YES |  |
| source_quote | text | YES |  |
| source_transcript_id | uuid | YES |  |
| source_revisions | jsonb | NO | '{}'::jsonb |
| confidence | real | YES |  |
| extracted_by | text | NO | 'user'::text |
| ai_provider | text | YES |  |
| created_by | uuid | YES |  |
| confirmed_by | uuid | YES |  |
| confirmed_at | timestamp with time zone | YES |  |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |

### org_members

| column | type | null | default |
|---|---|---|---|
| org_id | uuid | NO |  |
| user_id | uuid | NO |  |
| role | text | NO |  |
| created_at | timestamp with time zone | NO | now() |

### organizations

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| name | text | NO |  |
| is_sample | boolean | NO | false |
| settings | jsonb | NO | '{}'::jsonb |
| created_at | timestamp with time zone | NO | now() |

### participants

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| meeting_id | uuid | NO |  |
| person_id | uuid | YES |  |
| user_id | uuid | YES |  |
| display_name | text | NO |  |
| email | text | YES |  |
| role | text | NO | 'attendee'::text |
| created_at | timestamp with time zone | NO | now() |

### people

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| name | text | NO |  |
| organization | text | YES |  |
| role_title | text | YES |  |
| email | text | YES |  |
| notes | text | YES |  |
| tags | ARRAY | NO | '{}'::text[] |
| user_id | uuid | YES |  |
| created_by | uuid | YES |  |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |
| deleted_at | timestamp with time zone | YES |  |

### person_notes

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| person_id | uuid | NO |  |
| body | text | NO |  |
| author_user_id | uuid | YES |  |
| created_at | timestamp with time zone | NO | now() |

### projects

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| name | text | NO |  |
| kind | text | NO | 'project'::text |
| client_name | text | YES |  |
| description | text | YES |  |
| status | text | NO | 'active'::text |
| created_by | uuid | YES |  |
| created_at | timestamp with time zone | NO | now() |
| updated_at | timestamp with time zone | NO | now() |

### schema_migrations

| column | type | null | default |
|---|---|---|---|
| name | text | NO |  |
| applied_at | timestamp with time zone | NO | now() |

### search_docs

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| meeting_id | uuid | YES |  |
| entity_type | text | NO |  |
| entity_id | uuid | NO |  |
| title | text | YES |  |
| body | text | NO |  |
| tsv | tsvector | NO |  |
| occurred_at | timestamp with time zone | YES |  |
| updated_at | timestamp with time zone | NO | now() |
| person_ids | ARRAY | NO | '{}'::uuid[] |
| meta | jsonb | NO | '{}'::jsonb |

### search_person_refs

| column | type | null | default |
|---|---|---|---|
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| person_id | uuid | NO |  |
| meeting_id | uuid | NO |  |

### segment_revisions

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| segment_id | uuid | NO |  |
| revision | integer | NO |  |
| old_text | text | YES |  |
| new_text | text | YES |  |
| old_speaker_label | text | YES |  |
| new_speaker_label | text | YES |  |
| edited_by | uuid | YES |  |
| edited_at | timestamp with time zone | NO | now() |

### series

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| title | text | NO |  |
| cadence | text | YES |  |
| project_id | uuid | YES |  |
| meeting_type | text | NO | 'other'::text |
| template_key | text | YES |  |
| default_visibility | text | NO | 'workspace'::text |
| calendar_recurring_id | text | YES |  |
| created_by | uuid | YES |  |
| created_at | timestamp with time zone | NO | now() |

### sessions

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| user_id | uuid | NO |  |
| token_hash | text | NO |  |
| csrf_token | text | NO |  |
| ip | text | YES |  |
| user_agent | text | YES |  |
| created_at | timestamp with time zone | NO | now() |
| last_seen_at | timestamp with time zone | NO | now() |
| expires_at | timestamp with time zone | NO |  |

### summaries

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| meeting_id | uuid | NO |  |
| transcript_id | uuid | YES |  |
| version | integer | NO |  |
| provider | text | NO |  |
| model | text | YES |  |
| sections | jsonb | NO |  |
| is_current | boolean | NO | true |
| created_at | timestamp with time zone | NO | now() |

### templates

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| key | text | NO |  |
| name | text | NO |  |
| meeting_type | text | NO |  |
| definition | jsonb | NO |  |
| created_at | timestamp with time zone | NO | now() |

### transcript_segments

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| transcript_id | uuid | NO |  |
| meeting_id | uuid | NO |  |
| seq | integer | NO |  |
| start_ms | integer | NO |  |
| end_ms | integer | NO |  |
| speaker_id | uuid | YES |  |
| speaker_label | text | NO | 'Speaker 1'::text |
| text | text | NO |  |
| confidence | real | YES |  |
| flags | ARRAY | NO | '{}'::text[] |
| revision | integer | NO | 1 |
| edited_by | uuid | YES |  |
| edited_at | timestamp with time zone | YES |  |
| tsv | tsvector | YES |  |

### transcripts

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| meeting_id | uuid | NO |  |
| version | integer | NO |  |
| provider | text | NO |  |
| is_local | boolean | NO |  |
| language | text | YES |  |
| input_hash | text | NO |  |
| media_asset_id | uuid | YES |  |
| job_id | uuid | YES |  |
| is_current | boolean | NO | true |
| quality_flags | jsonb | NO | '{}'::jsonb |
| created_at | timestamp with time zone | NO | now() |

### user_prefs

| column | type | null | default |
|---|---|---|---|
| user_id | uuid | NO |  |
| org_id | uuid | NO |  |
| timezone | text | NO | 'Asia/Tokyo'::text |
| quiet_start_min | integer | NO | 1320 |
| quiet_end_min | integer | NO | 480 |
| email_enabled | boolean | NO | false |
| max_per_hour | integer | NO | 6 |
| brief_lead_min | integer | NO | 60 |
| updated_at | timestamp with time zone | NO | now() |
| timezone_set | boolean | NO | false |

### users

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| email | text | NO |  |
| name | text | NO |  |
| password_hash | text | YES |  |
| locale | text | NO | 'ja'::text |
| timezone | text | NO | 'Asia/Tokyo'::text |
| disabled_at | timestamp with time zone | YES |  |
| last_login_at | timestamp with time zone | YES |  |
| created_at | timestamp with time zone | NO | now() |

### webhook_deliveries

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| webhook_id | uuid | NO |  |
| event | text | NO |  |
| payload | jsonb | NO |  |
| dedupe_key | text | NO |  |
| status | text | NO | 'pending'::text |
| attempts | integer | NO | 0 |
| last_status | text | YES |  |
| created_at | timestamp with time zone | NO | now() |
| delivered_at | timestamp with time zone | YES |  |

### webhooks

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| workspace_id | uuid | NO |  |
| url | text | NO |  |
| secret_ciphertext | text | NO |  |
| events | ARRAY | NO | '{}'::text[] |
| active | boolean | NO | true |
| created_by | uuid | YES |  |
| created_at | timestamp with time zone | NO | now() |

### workspace_members

| column | type | null | default |
|---|---|---|---|
| workspace_id | uuid | NO |  |
| org_id | uuid | NO |  |
| user_id | uuid | NO |  |
| role | text | NO |  |
| created_at | timestamp with time zone | NO | now() |

### workspaces

| column | type | null | default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| org_id | uuid | NO |  |
| name | text | NO |  |
| settings | jsonb | NO | '{}'::jsonb |
| is_sample | boolean | NO | false |
| created_at | timestamp with time zone | NO | now() |
| deleted_at | timestamp with time zone | YES |  |
