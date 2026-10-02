# Action / Commitment / Open Question Ledger

会議から生まれる「やること」を3種類に分けて管理します。いずれも AI 抽出直後は **Candidate** で、人が Review Inbox で確認して初めて有効になります。

| 種類 | 何を表すか | 例 | 主な項目 | 状態 |
|---|---|---|---|---|
| **Action**（アクション） | チーム内のタスク。誰かが実行する作業 | 「見積もりを作成してください」「デモ環境の準備をお願いします」 | 担当（Person/User/表示名）、期限 | `candidate → confirmed → in_progress → done / cancelled`、`rejected` |
| **Commitment**（約束） | 相手に対して**誰かが口頭で約束したこと**。誰が・誰に | 「山田様に見積書を金曜日までにお送りします」「弊社から来週中に要件をご共有します」 | 約束した人（promisedBy）、約束した相手（promisedTo）、期限、方向 | `candidate → open → done / cancelled`、`rejected` |
| **Open Question**（未解決の質問） | 会議で答えが出なかった問い・未決事項 | 「納期はいつになりますか？」「予算の上限はまだ未定です」 | 担当、期限、回答 | `candidate → open → answered / dropped`、`rejected` |

実装: `apps/server/src/modules/ledger/**` / テーブル: `actions`, `commitments`, `open_questions`, `ledger_events`

## 1. 推測と捏造の扱い

- **言及がなければ null**: 担当者・期限が発言に無い場合は空のまま（「担当未定」として Review Inbox に `missingOwner` / `missingDue` フラグ）。AI が名前や日付を補うことはありません。
- **推測したら推測フラグ**: 相対表現（「来週金曜」「明日」「今週中」）から解決した期限は `dueInferred=true`。LLM が文脈から推測した担当は `assigneeInferred=true`。
- **推測値の確定には明示的な確認が必要**: 推測フラグが立った項目を accept するには `confirmInferred:true` を送るか、その値（`dueDate`、`assignee*`）を編集してください。そうでなければ 400 `confirm_inferred_required`。
- `[inaudible]`（聞き取れない部分）は補完しません。
- 担当の名前は、Meeting の参加者・話者マッピングと**一意に一致する場合だけ** Person に紐付けます（「田中」→参加者「田中 一郎」）。曖昧なら表示名のみ。

## 2. 話者マッピングと Commitment

- 「私が〜します」「お送りします」のような一人称の約束は、その発言の**話者ラベル**に紐付きます（`promisedBySpeakerId`）。話者ラベルが Person にマッピングされていれば（手動マッピングのみ、声による本人推定はしません）`promisedByPersonId` も入ります。
- 相手は「山田様に」「御社に」などの明示がある場合のみ（`promisedToPersonId` / `promisedToText`）。
- 方向（`direction`、閲覧ユーザー基準）:
  - `mine`: 自分（自分の User、または自分に紐付いた Person）が約束した
  - `theirs`: 自分に対して約束された、または社外の人（User に紐付かない Person）が約束した（＝相手待ち）
  - `other`: 上記以外（同僚どうしの約束など）
- **相手に勝手に催促や確認の連絡を送りません。** ledger モジュールは Commitment について外部へ何も送信しません（テスト #9 で外部呼び出し 0 件を確認）。フォローアップ文面の作成・送信は followup / connectors モジュールの責務で、API 契約上、外部への送信はプレビューと明示承認が前提です。

## 3. 期限と overdue

- `dueDate` は日付のみ（`YYYY-MM-DD`）。相対表現は**会議日（会議作成者のタイムゾーン）**を基準に解決します。
- `overdue` は保存せず、毎回 `deps.clock` と**閲覧ユーザーのタイムゾーン**の「今日」から導出します（Action: `confirmed/in_progress` で期限切れ、Commitment: `open` で期限切れ）。

## 4. API

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/w/:ws/actions?status&assignee=me&assigneePersonId&overdue=1&meetingId&projectId&limit&cursor` | `status=open` は confirmed+in_progress。`assignee=me` は自分の User または自分に紐付いた Person |
| POST | `/api/w/:ws/actions` | 手動作成（confirmed）`{description, meetingId?, assigneePersonId?, assigneeUserId?, assigneeText?, dueDate?, projectId?, linkedDecisionId?}` |
| GET/PATCH | `/api/w/:ws/actions/:id` | `status`（confirmed/in_progress/done/cancelled）、担当、期限、説明 |
| GET | `/api/w/:ws/commitments?direction=mine\|theirs\|all&status&overdue=1&meetingId&projectId&personId` | |
| POST, GET/PATCH | `/api/w/:ws/commitments`, `/commitments/:id` | `status`（open/done/cancelled）、promisedBy*/promisedTo*、期限 |
| GET | `/api/w/:ws/questions?status&meetingId&projectId` | |
| POST, GET/PATCH | `/api/w/:ws/questions`, `/questions/:id` | `status`（open/answered/dropped）、`answerText`、`answeredInMeetingId` |

Candidate の状態は PATCH では変更できません（409 `use_review`）。確定・却下は Review Inbox で行います。

**ページング（全一覧共通: decisions / actions / commitments / questions / contradictions）**: `limit`（既定50、最大200）と `cursor`（前ページの `nextCursor`、不透明な keyset カーソル）。
レスポンスは `{items, nextCursor, total}`。`total` は ACL 適用後の正確な件数で、**最初のページ（cursor なし）でのみ**計算します（2ページ目以降は `null`）。
並び順: Decision = 決定日の新しい順、Action / Commitment = 期限の近い順（期限なしは最後）、Question = 作成の新しい順。

## 5. Review Inbox {#review-inbox}

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/w/:ws/review?meetingId&type&limit&groupLimit&cursor` | 会議ごとにグループ化した候補。下記参照 |
| POST | `/api/w/:ws/review/:type/:id/accept` | `{edits?, confirmInferred?}` → decision: confirmed / action: confirmed / commitment: open / question: open |
| POST | `/api/w/:ws/review/:type/:id/reject` | `{reason?}` → rejected（行は残り、再抽出でも作り直さない） |
| PATCH | `/api/w/:ws/review/:type/:id` | 候補のまま編集（担当・期限を人が決めると推測フラグは消える） |
| GET | `/api/w/:ws/review/:type/:id/events` | その項目の ledger_events |

`type` = `decision | action | commitment | question`。`edits` は種類ごとのホワイトリスト（未知のキー、例えば `status` は 400）。

`GET /review` のレスポンス:
- `counts`（`decision/action/commitment/question/contradiction`）と `total` … **受信箱全体**（全ページ）の正確な件数（タブのバッジ用）
- `groups` … 1ページ分の会議（既定20件、`groupLimit` 最大50、会議日の新しい順）。各グループに会議別件数 `counts`、`total`、`itemsIncluded`（`items` に含めた件数。残りは `?meetingId=` で取得）
- `items` … そのページの会議の候補（`{type, item, flags}`、既定100件・最大300件）。`flags = {assigneeInferred, dueInferred, missingOwner, missingDue, sourceStatus}`
- `nextCursor` … 次の会議ページ。`meetingId` 指定時はその会議の候補をページング
- `contradictions` / `unmappedSpeakers` / `unlinkedParticipants` … そのページの会議分のみ（話者・参加者は `id` を持つ）
- `type` で種類を絞り込み（その種類の候補がある会議だけを返す）。見えない Meeting を `meetingId` に指定すると 404
すべての変更は `ledger_events`（誰が・何を・差分）に記録され、Meeting の再インデックス（`index.meeting`）を登録します。
権限: 閲覧は viewer 以上、accept/reject/edit は member 以上。見えない Meeting の項目は 404。

## 6. 再抽出（rerun）時の扱い

- 人が触っていない AI 候補だけを置き換えます。
- confirmed / rejected / 人が編集した候補と同じ文面・同じ引用の項目は作り直しません（重複しない）。
- 担当未定のアクションは、再抽出しても勝手に担当が付くことはありません（E2E-3）。
