# Meeting Memory — Pre-meeting Brief / Memory / Person Timeline / Recurring / Dashboard / Agenda

担当モジュール: `apps/server/src/modules/followup/`（`brief.ts`, `memory.ts`, `dashboard.ts`, `agenda.ts`, `templates.ts`, `util.ts`）。
Ledger（decisions / actions / commitments / open_questions）は ledger モジュールが書き込み、本モジュールは **SQL で読むだけ** です。

## 共通原則

- **事実のみ**: 表示するのは確定済み（confirmed / open）の Ledger 行、Meeting、人が書いたメモだけ。AI生成テキストを Brief / Timeline に混ぜません。
  候補（`candidate`）・却下（`rejected`）は一切出しません。
- **ACL**: すべてのクエリが `meetingVisibleSql` / `itemVisibleSql` を通ります。Private Meeting は作成者のみ（管理者も不可）。
  他人の Private Meeting の項目は Brief / Dashboard / Timeline / Memory / Agenda のどこにも出ません（テスト `ACL: ...` で検証）。
  `meeting_id IS NULL`（Workspace レベル）の項目は全メンバーに見えます（core の定義どおり）。
- **出典**: すべての項目に `source: { meetingId, meetingTitle, meetingDate }` を付けます（どの会議で決まった/約束したか）。
- **人物を断定しない**: Person timeline は会議・決定・約束・Action・送付済みFollow-up・人のメモを時系列に並べるだけで、
  性格・心理・意図の推定や評価を返すフィールドは存在しません（`factsOnly: true`）。
- **1on1**: 1on1 は Private が既定（core / テンプレート）。シリーズの次回作成時も前回の公開範囲を引き継ぎます。HR評価・心理分析には使いません。
- **汎用PM化しない**: タスク管理機能（ガント・依存関係・工数等）は持ちません。Ledger の確認・引き継ぎに限定します。
- **時刻**: `deps.clock.now()` とユーザーのタイムゾーン（`users.timezone`）で「今日」「期限切れ」を判定します。

## Pre-meeting Brief — `GET /api/w/:ws/meetings/:id/brief`

| フィールド | 内容 |
|---|---|
| `firstMeeting` | 関連する過去の会議・項目が何も無いとき `true`。このとき参加者の基本情報（氏名/組織/役職）と定型アジェンダだけを返し、他は空（無理に生成しない） |
| `previousMeeting` | 同じシリーズの直前の会議 → 無ければ「自分以外の参加者を共有する」or「同じProject」の直近の可視会議。`via: series｜participants｜project` |
| `currentDecisions` | confirmed かつ active、かつ supersede されていない決定（最大8） |
| `openActions` | confirmed / in_progress（最大10、期限順、`overdue` 付き） |
| `commitments.mine / theirs / others` | open の約束。`mine` = 自分が約束した（promised_by が自分のユーザー/自分に紐づくPerson）、`theirs` = 自分/社内宛て または 外部の人が約束したもの、`others` = その他（各最大10） |
| `openQuestions` | open（最大8） |
| `personNotes` | 参加者（自分以外）の人物メモ（直近3件）とプロフィールメモ。初回は空 |
| `recentChanges` | 直近30日の決定の変更（旧 → 新） |
| `agendaTemplate` | テンプレートの定型アジェンダ |
| `more` | 上限で省略した件数 |

関連範囲: 同じシリーズ / 同じProject / 前回会議 の項目 + 参加者（自分以外のPerson）に紐づく項目（担当・約束の当事者・決定のオーナー/参加者・質問のオーナー）。
現在の会議自身の項目は含めません。

## Memory

- `GET /api/w/:ws/projects/:id/memory` — Project の Current Decisions / Outstanding Commitments / Open Actions / Open Questions / Recent Changes（90日）+ 直近/今後の会議。
- `GET /api/w/:ws/series/:id/memory` — 同上（シリーズ）+ `previousMeeting` / `nextMeeting`。
- `GET /api/w/:ws/memory?topic=…&projectId=` — トピック検索。ILIKE で候補を絞り込み、共有トークナイザ（CJK bigram / 英単語）で
  **トピックの全トークンを含む**項目だけを返します（決定は `topic` / `topic_key` も対象）。会議タイトルも同様に照合。

Current Decisions は「confirmed かつ status=active、`superseded_by_decision_id` が空、かつ有効な後継決定から supersede されていない」もののみ。
supersede された決定は Current から除外され、Recent Changes に「旧 → 新」で残ります（履歴は消しません）。

## Person timeline — `GET /api/w/:ws/people/:id/timeline?order=desc|asc&limit=`

イベント種別: `meeting`（参加）, `decision`（オーナー/参加者）, `commitment`（`role: promised_by|promised_to`）, `action`（担当）,
`followup`（承認済み/送付済みのみ。件名とステータスのみで本文は返さない）, `note`（人のメモ、`authoredBy: 'human'`）。
`stats` は件数のみ。すべて ACL 適用済みです。

## Recurring meeting — `POST /api/w/:ws/series/:id/meetings`

`{ scheduledStart, scheduledEnd?, title?, copyParticipants?=true }` → core の `createMeeting` を再利用して次回を作成します。
前回（シリーズ内の直近の可視会議）の参加者・公開範囲（selected の場合はアクセス者も）を引き継ぎ、作成と同時に Agenda 候補を生成します（`agendaSuggested`）。
次回の Brief には前回の未完了 Action / 未解決の質問 / open の約束が `previousMeeting.via = 'series'` として表示されます。

## Dashboard — `GET /api/w/:ws/dashboard`

| セクション | 定義 |
|---|---|
| `today` / `upcoming` | ユーザーTZの今日 / 明日から7日間の可視会議 |
| `needsReview` | 自分が作成 or 参加した可視会議のうち status=needs_review または候補がある（`candidates` 件数付き） |
| `myActions` / `myCommitments` | 自分担当の open Action / 自分が約束した open の約束 |
| `waitingOnOthers` | 自分/社内宛て（または外部の人の）約束 + 自分が関わる会議で他の人が担当する Action |
| `overdue` | 自分の期限切れ Action / 約束（事実のみ。責める文言は付けない） |
| `decisionsChanged` | 直近7日の決定の変更 |
| `openQuestions` | 自分がオーナー or 自分が関わる会議の未解決の質問 |

## Agenda

- `GET /api/w/:ws/meetings/:id/agenda` — 項目一覧。元の Ledger 行を閲覧者が見られない場合（他人の Private 会議由来）は表示しません。
- `POST /api/w/:ws/meetings/:id/agenda/suggest` — 前回会議 / シリーズの open Action・約束・質問を `candidate` として追加。
  `UNIQUE(meeting_id, source_type, source_id)` により**何度実行しても重複しません**。テンプレート項目は本文一致で重複防止。
- `POST /api/w/:ws/meetings/:id/agenda` `{text, position?}` — 手動項目（`accepted`）。
- `PATCH /api/w/:ws/agenda/:itemId` `{text?, status?: candidate|accepted|rejected|done, position?}`。

## Templates — `GET/POST /api/w/:ws/templates`

GET は shared の組み込みテンプレート（`builtIn: true`）+ `templates` テーブルのカスタム。
POST（admin のみ）`{key, name, meetingType, basedOn?, agenda?, summarySections?, extractionRules?, followupStyle?}`。
組み込みキーと同じキーは 409。`followupStyle.tone` は Follow-up 下書きの文体に使われます（`hints` はAIへの補助情報で、ポリシーを変えません）。

## 既知の制限

- Brief はリクエスト時に計算します（`brief_snapshots` は未使用）。大量の関連会議がある場合は各セクション上限で打ち切ります。
- トピック照合は語彙一致（意味検索ではない）。表記ゆれ（例: 見積り/見積もり）は一致しないことがあります。
- 「社内/社外」の判定は Person がワークスペースのユーザーに紐づいているかで行います（未紐づけの社内メンバーは外部扱い）。
