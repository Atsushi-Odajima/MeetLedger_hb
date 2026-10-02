# Follow-up 下書きと通知エンジン

担当モジュール: `apps/server/src/modules/followup/`（`drafts.ts`, `engine.ts`, `notificationRoutes.ts`）、
`apps/server/src/modules/notifications/email.ts`。マイグレーション: `030_followup_drafts_notifications.sql`。

## 1. Follow-up 下書き

### 原則
- **下書きのみ**。MeetLedger は Follow-up を自動送信しません。`approve`（人が承認）→ 人が自分のメール/Slack で送る → `mark-sent` で記録。
  外部システムへの書き込みが必要な場合は connectors モジュールの external-writes（プレビュー + 明示承認）を通します。
- **Meeting に無い約束を追加しない**。本文の項目リストは、その会議の次の行だけから**決定的なテンプレート**で組み立てます:
  - 決定: `review_state='confirmed' AND status='active'`
  - Action: `status IN ('confirmed','in_progress')`
  - 約束: `status='open'`
  - 質問: `status='open'`

  候補（candidate）・却下・完了済みは含めません。候補が残っている場合は `warnings: ['candidates_excluded:N']`。
- `referencedItems` に使用した全項目 `{type, id}` を記録します（本文との対応を監査可能）。
- 言語はユーザーの locale（`ja`/`en`、リクエストで上書き可）、文体はテンプレートの `followupStyle.tone`（formal / neutral / casual）。

### 種類
| kind | 宛先 | 内容 |
|---|---|---|
| `thank_you_email` | 社外 | お礼 + 確認事項 |
| `client_recap` | 社外 | 決定 / 次のアクション / 約束 / 確認中の事項 |
| `internal_recap` | 社内 | 上記 + 決定の理由（reason） |
| `slack_update` | 社内 | 箇条書き（件名なし） |

社外向け（`thank_you_email`, `client_recap`）には社内限定情報を含めません: 決定の理由、会議メモ（private notes）、人物メモ、文字起こしの引用。
（社内向けにもメモ・文字起こしは含めません。本文は Ledger 項目と定型文だけです。）

### AI polish（任意）
`POST …/followups {kind, polish: true}` のとき、`decideAi` が許可し、かつ Provider が `polish` を実装している場合に限り、
**挨拶文と結びの文だけ**を Provider に渡して言い換えます（項目リストは AI に渡さず、変更もしません）。
外部 Provider の場合は `deps.http`（GuardedHttp）経由で AI OFF / Confidential を再確認し、`external_calls` にメタデータのみ記録されます。

結果は `validatePolish` で検証し、次のいずれかに当たると**却下して定型文を使います**（`polish.rejected[{part, reason}]`）:
- 元の文と Ledger に無い数字（算用数字・漢数字+単位）が増えた（`number_added`）
- 日付・期限表現（来週、明日、曜日、期限、締切、today, next week, 月名 …）が増えた（`date_added`）
- 約束・確約表現（お送り, 送付, 提出, ご連絡, 対応します, までに, 見積, 必ず, will, send, provide, promise …）が増えた（`promise_added`）
- 箇条書き・リンク・メールアドレスの追加、改行構造の変更、過度な長文化
例: 「来週までに見積をお送りします」を付け足した出力は却下されます（テスト #11）。
1か所でも採用されると `generatedBy: 'ai'`（UI は「AI生成」ラベル）。AI OFF の会議では Provider を呼びません（`polish.skipped: 'ai_off'`）。

### API
| | |
|---|---|
| `POST /api/w/:ws/meetings/:id/followups` | `{kind, locale?, polish?}`。未編集の同種 draft があればその場で再生成、編集済み draft は上書きせず新規作成 |
| `GET  /api/w/:ws/meetings/:id/followups` | discard 以外の一覧 |
| `PATCH /api/w/:ws/followups/:id` | `{subject?, body?, version}`。人の編集は自由（`edited: true` を記録）。`version` 不一致は 409。承認済みを編集すると draft に戻る |
| `POST /api/w/:ws/followups/:id/approve` | draft → approved。作成後に参照項目が未確定へ戻っていたら 409 `stale_items`（`{acknowledgeStale: true}` で承認可） |
| `POST /api/w/:ws/followups/:id/discard` | sent 以外 → discarded |
| `POST /api/w/:ws/followups/:id/mark-sent` | approved → sent（`{channel}`）。未承認は 409 `approval_required`。送信は行わない |

レスポンス（`FollowupDraftDto` 拡張）: `edited, version, locale, tone, warnings, polish, aiGenerated, approvedAt, sentAt`。

## 2. 通知エンジン（job `followup.tick`）

スケジューラ（`modules/scheduler.ts`）が `SCHEDULER_INTERVAL_SEC`（既定300秒）ごとに org 無しのシステムジョブを投入します。
ハンドラ `runFollowupTick(deps)` は system context で組織一覧（サンプル組織を除く）を取得し、組織ごとに `tenantTx` 内で
**生成 → 配信** を行います。1組織の失敗は他の組織に影響しません（ID のみログ）。何度実行しても重複しません。

### 生成ルール
| kind | 受信者 | タイミング | dedupe_key |
|---|---|---|---|
| `needs_review` | 会議の作成者 | status=needs_review または候補あり（終了14日以内）→ T+0 | `needs_review:{meetingId}` |
| `action_t1` | Action 担当ユーザー | 確定の翌日（〜翌々日まで）。期限当日/期限切れのものは除外 | `action_t1:{actionId}` |
| `action_due` | Action 担当ユーザー | 期限日の朝（ユーザーTZの quiet 終了時刻、既定 08:00） | `action_due:{actionId}:{due}` |
| `commitment_due` | 約束した本人（promised_by） | 期限日の朝 | `commitment_due:{id}:{due}` |
| `overdue_digest` | 本人 | 期限切れの自分の Action/約束を **1通にまとめて**（期限が新しい順に10件 + 総数。1000件で打ち切り「1000件以上」）、ユーザーTZの ISO 週ごとに最大1回。作成はユーザーの朝（quiet 終了から3時間以内） | `overdue_digest:{orgId}:{YYYY-Www}` |
| `upcoming_brief` | 作成者 + 参加者（ユーザー紐づけ）で会議を閲覧できる人 | 開始の `brief_lead_min` 分前（0 で無効） | `upcoming_brief:{meetingId}:{start}` |
| `next_meeting` | 会議の作成者 | シリーズの会議が終了（3日以内）し、次回が未登録 | `next_meeting:{meetingId}` |
| `digest` | 本人 | storm control で溢れた分をまとめたもの | `digest:{最初の統合元id}` |

- 受信者はワークスペースのメンバーであり、かつ元の会議を閲覧できる必要があります（`meetingVisibleSql` を受信者で評価）。
  他人の Private 会議の項目について通知されることはありません。
- **重複防止**: `notifications UNIQUE(user_id, dedupe_key)` + `ON CONFLICT DO NOTHING`（unnest による一括 INSERT）。期限が変更された場合はキーが変わるので再通知されます。
- **有界な処理量（§40規模）**: 候補はすべて索引の範囲検索（期限日±1日、直近4日の確定、直近の会議、24時間以内の会議）。期限切れ項目を1件ずつ走査せず、
  週次まとめが未作成のユーザーだけ上位10件+件数を取得します。性能DB（Action/約束 各50万件）で 1 tick ≈ 0.1 秒（週初回のまとめ作成時 ≈ 0.4 秒）。

### Quiet hours / タイムゾーン
- `user_prefs`（ユーザー×組織）: `quiet_start_min`（既定 22:00）、`quiet_end_min`（既定 08:00）、`timezone`、`email_enabled`、`max_per_hour`（既定6）、`brief_lead_min`（既定60）。
- タイムゾーン: 通知設定で明示した値（`timezone_set=true`）を優先し、未設定ならプロフィール（`users.timezone`）。
- quiet hours 中に発生した通知は `scheduled_for` を quiet 終了時刻へずらし、それまで `pending`（受信箱に出ない）。
- 会議前リマインドが quiet でずれて開始時刻を過ぎる場合は `suppressed`（配信しない）。保留中に開始時刻を過ぎたものも `suppressed`。

### Storm control
配信時、ユーザーごとに直近1時間の配信数（digest 含む）を数え、残り枠 `allowance = max_per_hour - 配信済み` を計算:
- 保留件数 ≤ 枠: すべて個別に配信
- 保留件数 > 枠: 優先度順（会議前 > 期限当日 > 要確認 > T+1 > 次回 > 期限切れまとめ）に `枠-1` 件を個別配信し、残りを **1件の `digest`** に統合（統合元は `digested`, `digest_id`）
- 枠 0: 保留のまま（1時間の窓が空いた時点で配信/統合）

→ どの1時間をとっても配信数は `max_per_hour` を超えません（テスト #21）。

### 文言ポリシー（罪悪感を煽らない）
- 事実と次にできることだけを書く: 「期限が過ぎています（3件）」「状況が変わった項目は、完了・期限変更・取り消しで整理できます。」
- 使わない: 「遅れ」「遅延」「至急」「催促」「まだ〜していません」、感嘆符による圧力、他人との比較、ランキング。
- 期限切れは週1回のまとめのみ（毎日責めない）。
- 文言は `engine.ts` の `TEXT` に固定（ja/en、ユーザーの locale）。通知本文に文字起こしや AI 出力は含めません（Ledger 項目の記述・会議名のみ）。

### メール
- `email_enabled=true` のユーザーにだけ、配信された通知（digest 含む、統合元は除く）のコピーを送ります。dedupeKey `notification:{id}` で二重送信しません。
- メール送信は配信状態のコミット後に、1通ずつ別トランザクションで行います。
- ドライバ（`createEmailAdapter(config)`）:
  - `EMAIL_DRIVER=outbox`（既定）: `email_outbox` に `held` で保存するだけ（外部送信なし）
  - `EMAIL_DRIVER=smtp`: `SmtpEmail`（nodemailer、`SMTP_URL` 必須）。outbox に `queued` → `sent` / `failed` を記録し、`external_calls` に
    host・バイト数・結果のみ記録（本文・資格情報は記録しない）
- `app.ts` は `opts.email ?? createEmailAdapter(config)` を使うため、`EMAIL_DRIVER=smtp` と `SMTP_URL` を設定すれば SMTP で送信されます
  （コード変更は不要）。CLI（`cli/main.ts`）は常に `OutboxEmail` です。各ユーザーの「通知の設定 → メールでも受け取る」（`email_enabled`）は既定 OFF です。

### 通知 API（ユーザー単位・全組織横断）
| | |
|---|---|
| `GET /api/notifications?unread=1&limit&before` | 自分宛て（`user_id`）かつ現在メンバーである組織/ワークスペースの配信済み通知。`digest` には統合元 `items` を添付。`unreadCount` |
| `POST /api/notifications/:id/read` | 既読（digest は統合元も既読）。他人の通知は 404 |
| `POST /api/notifications/read-all` | |
| `GET/PUT /api/w/:ws/notification-prefs` | `{timezone|null, quietStart:"HH:MM"|quietStartMin, quietEnd|quietEndMin, emailEnabled, maxPerHour(1-60), briefLeadMin(0-1440)}`。`timezone:null` でプロフィールTZへ戻す |

受信箱は system context で `user_id` と `org_members` / `workspace_members` によりフィルタします（API トークンはトークンの組織に限定）。
リンク（`link`）は Web 側のパス（例 `/w/{ws}/meetings/{id}/brief`）です。

## 既知の制限
- 期限切れまとめは「ユーザー×組織」単位で週1回です（複数組織に所属する場合は組織ごと）。
- サンプル組織（`is_sample`）は通知対象外です。
- quiet hours の計算は分単位で、夏時間の切替直後は最大1時間ずれる可能性があります。
- SMTP の実サーバーへの送信は未検証です（テストは nodemailer のローカル JSON トランスポートを使用し、ネットワークに出ません）。
