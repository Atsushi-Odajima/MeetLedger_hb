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

