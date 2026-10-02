# RETENTION & DELETE — データ種別ごとの保存場所・保持期間・削除動作

MeetLedger は「音声 / 動画」「文字起こし」「AI索引」「成果物（Artifacts）」を**別々の保持期間**で管理します。
削除はすべて記録（`deletion_requests`）され、DB・ストレージ・検索索引・AI索引・キャッシュ・バックアップの扱いを明示します。

実装: `apps/server/src/modules/data/`（`deletion.ts`, `retention.ts`）。運用は [OPERATIONS.md](OPERATIONS.md) §5。

---

## 1. データ種別一覧

| データ種別 | 保存場所 | 保持期間の設定 | 自動削除 |
|---|---|---|---|
| 音声 / 動画（原本・正規化音声） | ストレージ `org/<org>/meeting/<meeting>/...`（AES-256-GCM暗号化）＋ `media_assets` 行 | Meetingごと: `never` / `until_processed`（既定）/ `7d` / `30d` / `custom`(日数)。Workspace既定値あり | `media_assets.retention_until` 到達時（音声パイプラインが算出。処理直後削除の設定は処理完了時に即削除） |
| 取込ファイル（SRT/VTT/TXT原本） | ストレージ＋`media_assets`（kind=`transcript_file`） | 文字起こしと同じ | `retention.transcriptDays` |
| 文字起こし | `transcripts`, `transcript_segments`, `segment_revisions`（DB） | Workspace設定 `retention.transcriptDays`（既定: 無期限） | 作成から N 日経過した版を削除 |
| 話者マッピング | `meeting_speakers` | Meetingと同じ | Meeting削除時（台帳の担当者参照のため文字起こし削除では残す） |
| 全文検索索引 | `search_docs`（DB） | 元データと連動 | 元データ削除時に同時削除 |
| AI索引（ベクトル） | `ai_chunks`（DB） | Workspace設定 `retention.aiIndexDays`（既定: 無期限） | 作成から N 日経過したチャンクを削除。AI OFF の Meeting は作られない |
| 要約（AI生成） | `summaries` | Workspace設定 `retention.artifactDays`（既定: 無期限） | 作成から N 日 |
| フォローアップ下書き | `followup_drafts` | `retention.artifactDays` | 最終更新から N 日 |
| ブリーフ（キャッシュ） | `brief_snapshots` | `retention.artifactDays` | 生成から N 日。関連Meeting削除時にも破棄 |
| Workspace Export ファイル | ストレージ `org/<org>/exports/<job>.json`（暗号化）＋ `jobs.result` | `retention.artifactDays` と **7日** の短い方 | 期限で削除し、ダウンロードは「expired」 |
| 台帳（決定事項・アクション・約束・質問・矛盾候補） | `decisions` ほか（DB） | 無期限（ユーザーが管理） | Meeting削除時に、そのMeeting由来の項目を削除 |
| 台帳の変更履歴 | `ledger_events` | 台帳項目と同じ | 項目削除時に削除 |
| メモ | `meeting_notes` | Meetingと同じ | Meeting削除時 |
| 人物 | `people`, `person_notes` | 無期限 | 人物削除（管理者）で匿名化＋メモ削除＋索引削除 |
| 通知 | `notifications` | — | 参照先Meeting/項目の削除時に削除 |
| 外部送信メタデータ | `external_calls`（送信先・目的・バイト数のみ、内容なし） | 無期限（監査用） | 削除しない |
| 監査ログ | `audit_events`（メタデータのみ、内容なし） | 無期限（監査用） | 削除しない |
| 削除記録 | `deletion_requests`（対象ID・日付ラベル・手順結果のみ、タイトル等の内容なし） | 無期限（説明責任のため） | 削除しない |
| セッション / 招待 / MCP確認 | `sessions`, `invitations`, `mcp_confirmations` | 有効期限 | 期限切れを毎時削除 |
| バックアップ | 運用者が管理する保管先 | 運用者のローテーション設定（例: 日7・週4・月12） | ローテーションで古い世代を削除 |

Workspace の保持設定は `PATCH /api/w/:ws/settings` の `retention: { transcriptDays, aiIndexDays, artifactDays }`（`null` = 無期限）。

---

## 2. 削除リクエストの種類

| 操作 | API | 権限 | 記録 scope |
|---|---|---|---|
| Meetingの完全削除 | `DELETE /api/w/:ws/meetings/:id` | 書き込み権限＋（作成者 または 管理者） | `meeting` |
| 音声のみ削除 | `POST /api/w/:ws/meetings/:id/delete-audio` | 同上 | `meeting_audio` |
| 文字起こしのみ削除 | `POST /api/w/:ws/meetings/:id/delete-transcript` | 同上 | `meeting_transcript` |
| AI索引のみ削除 | `POST /api/w/:ws/meetings/:id/delete-ai-index` `{disableAi?}` | 同上 | `meeting_ai_index` |
| 保持期間による自動削除 | `retention.sweep`（毎時） | システム | 上記 scope ＋ `steps.trigger = "retention"` |
| 削除記録の確認 | `GET /api/w/:ws/deletion-requests` | 管理者は全件、他は自分の依頼のみ | — |

- 非公開Meetingは作成者以外には存在自体が見えません（管理者でも 404）。他人の非公開Meetingを削除する必要がある場合は、作成者本人が行うか、運用者がDB操作で対応します。
- 削除の順序は「依頼を記録 → ストレージのオブジェクト削除 → DB・索引・キャッシュを1トランザクションで削除 → 記録を completed に更新」。
  途中で失敗した場合は記録が `failed` になり、同じ操作を再実行すれば続きから完了します（削除は冪等）。

### 削除記録（deletion_requests.steps）の例

```json
{
  "db":           { "status": "deleted", "transcripts": 1, "segments": 42, "mediaAssets": 1, "ledgerItems": 5, "summaries": 1, "followups": 0, "notes": 1, "ledgerEvents": 3 },
  "storage":      { "status": "deleted", "objects": 2 },
  "search_index": { "status": "deleted", "rows": 50 },
  "ai_index":     { "status": "deleted", "rows": 38 },
  "caches":       { "status": "deleted", "briefSnapshots": 1, "notifications": 2, "cancelledJobs": 0 },
  "backups":      "retained until backup rotation (see docs)"
}
```

---

## 3. 操作ごとの扱い（DB / ストレージ / 検索索引 / AI索引 / キャッシュ / バックアップ）

### 3.1 Meetingの完全削除
| 対象 | 扱い |
|---|---|
| DB | `meetings` 行を削除。参加者・同意記録・メモ・アジェンダ・文字起こし（全版）・話者・要約・台帳項目・矛盾候補・フォローアップ下書き・ブリーフは連鎖削除。台帳の変更履歴（`ledger_events`）も削除。他Meetingの決定から当該決定への参照（supersede）は NULL になる |
| ストレージ | `media_assets` の全オブジェクト＋ `org/<org>/meeting/<id>/` 配下の残存ファイルを削除 |
| 全文検索索引 | Meeting・セグメント・台帳・要約・メモに対応する `search_docs` を削除 |
| AI索引 | 同じく `ai_chunks` を削除 |
| キャッシュ | 当該Meetingのブリーフ、当該Meeting/項目を参照する他Meetingのブリーフ、関連通知を削除。未実行の処理ジョブ（文字起こし・抽出・索引）をキャンセル。参加者の人物索引は再構築 |
| 残るもの | `audit_events`（「削除した」というメタデータ）、`external_calls`（過去の外部送信メタデータ）、`deletion_requests`（日付ラベルのみ） |
| バックアップ | 書き換えません。**バックアップのローテーションで古い世代が消えるまで残ります**（§5） |

### 3.2 音声のみ削除
| 対象 | 扱い |
|---|---|
| ストレージ | 原本音声/動画・正規化音声のオブジェクトを削除 |
| DB | `media_assets` 行は `deleted_at` を設定したメタデータ（サイズ・ハッシュ・長さ）のみ残す。未実行の `audio.process` ジョブはキャンセル |
| 文字起こし・索引 | 残る（派生データ。不要なら文字起こし削除を併用） |
| バックアップ | ローテーションまで残る |

### 3.3 文字起こしのみ削除
| 対象 | 扱い |
|---|---|
| DB | 文字起こし全版・セグメント・編集履歴を削除。**台帳項目は本文を保持**し、出典の引用（`source_quote`）は削除、出典表示は「missing（削除済み）」になる。話者マッピングは残す |
| ストレージ | 取込ファイル（SRT/VTT/TXT原本）を削除 |
| 全文検索索引 / AI索引 | セグメント分を削除し、Meetingを再索引 |
| キャッシュ | 当該Meetingのブリーフを破棄、未実行のAI抽出ジョブをキャンセル |
| 要約 | 成果物として残る（`artifactDays` または Meeting削除で消える） |

### 3.4 AI索引のみ削除
| 対象 | 扱い |
|---|---|
| AI索引 | 当該Meetingの `ai_chunks` を削除 |
| 全文検索索引 / DB本体 | 残る |
| 再生成 | Meetingの内容が更新されると再作成されます。再作成させない場合は `{"disableAi": true}`（MeetingをAI OFFにする） |

### 3.5 保持期間による自動削除
上記 3.2〜3.4 と同じ処理を、期限到達分に対してシステムが実行します（`requested_by = NULL`, `steps.trigger = "retention"`）。
成果物（要約・下書き・ブリーフ・Exportファイル）の削除は件数を監査ログに記録します。

---

## 4. Export / Import と削除の関係
- Workspace Export ファイルは暗号化して保存し、署名付きURL（既定5分・発行ユーザー限定）でのみダウンロードできます。7日（または `artifactDays`）で自動削除されます。
- **ダウンロード済みのExportファイルは利用者の管理下**にあり、MeetLedger からは削除できません。削除要請に対応する場合は、配布先にも削除を依頼してください。

---

## 5. バックアップの扱い（重要）
- 削除操作はバックアップファイルを書き換えません。削除したデータは**バックアップの保管期間が過ぎた時点で完全に消えます**。
  例: 日次7世代＋週次4世代＋月次12世代の運用では、最長約12か月間はバックアップに残ります。
- バックアップは暗号化して保管し、アクセスを運用担当者に限定してください（DBテーブル部分は平文のため）。
- **古いバックアップから復元すると、その後に削除したデータが復活します。** 復元後は、復元時点以降の削除記録
  （`GET /api/w/:ws/deletion-requests` を定期的に保存しておく、または監査ログの `meeting.deleted` 等）をもとに同じ削除を再実行してください。
- 利用規約・プライバシーポリシーには「削除後もバックアップに最大◯日保持され、その後消去されます」と保管期間を明記することを推奨します。

---

## 6. Sample Workspace
- Sample Workspace は利用者ごとに作られる**別組織**（`organizations.is_sample = true`）で、架空データのみを含みます。
- テナント分離（RLS）により本番Workspaceの会議一覧・検索・AI回答には一切表示されません。
- 不要になった場合は組織ごと削除できます（運用者がDBで `DELETE FROM organizations WHERE id = '<sample org id>' AND is_sample;`。関連データは連鎖削除）。
