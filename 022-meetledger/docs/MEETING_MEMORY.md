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
| `currentDecisions` | confirmed かつ active、かつ supersede されていない決定（最大8、新しい順） |
| `openActions` | confirmed / in_progress（最大10、期限順、`overdue` 付き） |
| `commitments.mine / theirs / others` | open の約束。`mine` = 自分が約束した（promised_by が自分のユーザー/自分に紐づくPerson）、`theirs` = 自分/社内宛て または 外部の人が約束したもの、`others` = その他（各最大10、期限順） |
| `openQuestions` | open（最大8） |
| `personNotes` | 参加者（自分以外）の人物メモ（直近3件）とプロフィールメモ。初回は空 |
| `recentChanges` | 直近30日の決定の変更（旧 → 新） |
| `agendaTemplate` | テンプレートの定型アジェンダ |
| `counts` / `more` | 各セクションの正確な総数（`decisions, actions, commitments, commitmentsMine/Theirs/Others, questions`）と、上限で省略した件数 |

関連範囲: 同じシリーズ / 同じProject / 前回会議 の項目 + 参加者（自分以外のPerson）に紐づく項目（担当・約束の当事者・決定のオーナー・質問のオーナー）。
現在の会議自身の項目は含めません。

## Memory

- `GET /api/w/:ws/projects/:id/memory` — Project の Current Decisions / Outstanding Commitments / Open Actions / Open Questions / Recent Changes（90日）
  + 直近10件/今後5件の会議 + `meetingCount`。
- `GET /api/w/:ws/series/:id/memory` — 同上（シリーズ）+ `previousMeeting` / `nextMeeting`。
- `GET /api/w/:ws/memory?topic=…&projectId=` — トピック検索（下記）。

各セクションは**上位20件**（`limit`）と、正確な総数 `counts.{currentDecisions,outstandingCommitments,openActions,openQuestions,recentChanges}`、
`more.{…}`（20件を超えるか）を返します。全件は ledger の一覧API（`/decisions?projectId=`, `/actions?projectId=` 等）で参照します。

Current Decisions は「confirmed かつ status=active、`superseded_by_decision_id` が空、かつ有効な後継決定から supersede されていない」もののみ。
supersede された決定は Current から除外され、Recent Changes に「旧 → 新」で残ります（履歴は消しません）。
Recent Changes の期間は supersede された時刻（旧決定の `updated_at`。ledger の supersede 処理が更新）で判定します。

### トピック（`?topic=`）
共有トークナイザ（CJK bigram / 英単語）で**トピックの全トークンを含む**項目を返します。§40規模で有界にするため、
各 Ledger テーブルの**新しい順 20,000 件**（`TOPIC_SCAN`）を ILIKE + トークン照合し、決定は `topic_key` の完全一致も全期間から加えます。
対象外になり得た場合は `scan.truncated: true`。古い項目まで探す場合は全文検索（search モジュール）を使います。
（RLS 下では `@@`/`ILIKE` が非 leakproof のためインデックス条件にならず、全件走査は 1 テーブル 0.5 秒以上かかるため。）

## Person timeline — `GET /api/w/:ws/people/:id/timeline?order=desc|asc&limit=&cursor=`

イベント種別: `meeting`（参加）, `decision`（オーナー、またはその人が参加した会議で `participant_person_ids` に含まれる）,
`commitment`（`role: promised_by|promised_to`）, `action`（担当）, `followup`（承認済み/送付済みのみ。件名とステータスのみで本文は返さない）,
`note`（人のメモ、`authoredBy: 'human'`）。すべて ACL 適用済みです。

- `limit` 既定100・最大200。順序は `(at, type, id)`（desc/asc）。`nextCursor`（`at|type|id`）を `cursor` に渡すと続きを取得
  （キーセット方式。同時刻の項目でも欠落・重複しない）。`at` はミリ秒精度。
- `stats`（`meetings, openActions, openCommitmentsBy, openCommitmentsTo`）は件数のみで、ページに依存しない総数です。

## Recurring meeting — `POST /api/w/:ws/series/:id/meetings`

`{ scheduledStart, scheduledEnd?, title?, copyParticipants?=true }` → core の `createMeeting` を再利用して次回を作成します。
前回（シリーズ内の直近の可視会議）の参加者・公開範囲（selected の場合はアクセス者も）を引き継ぎ、作成と同時に Agenda 候補を生成します（`agendaSuggested`）。
次回の Brief には前回の未完了 Action / 未解決の質問 / open の約束が `previousMeeting.via = 'series'` として表示されます。

## Dashboard — `GET /api/w/:ws/dashboard`

各セクションは**上位10件**（`limit`）+ `counts`（上限 `countCap`=1000。1000 は「1000以上」と表示）。

| セクション | 定義 |
|---|---|
| `today` / `upcoming` | ユーザーTZの今日 / 明日から7日間の可視会議（`counts.today/upcoming`） |
| `needsReview` | 直近90日（`windowDays`）に自分が作成 or 参加した可視会議のうち status=needs_review または候補がある（`candidates` 件数付き） |
| `myActions` / `myCommitments` | 自分担当の open Action / 自分が約束した open の約束のうち**期限切れでないもの**（期限順） |
| `overdue.actions` / `overdue.commitments` | 自分の期限切れ Action / 約束（期限が新しい順の上位10件 + `counts.overdueActions/overdueCommitments/overdue`）。事実のみで責める文言は付けない |
| `waitingOnOthers.commitments` / `.actions` | 直近90日の自分の会議で、自分/社内宛て（または外部の人）の約束 / 他の人が担当する Action |
| `decisionsChanged` | 直近7日の決定の変更（旧 → 新） |
| `openQuestions` | 直近90日の自分の会議の未解決の質問 + 自分がオーナーの質問 |

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

## 性能（spec §40: 5万会議・各Ledger 50万件・1000万セグメント）

計測（`scripts/perf/measure.ts`、ローカルPG16）: Brief p95 ≈ 0.1 s、Project/Series memory ≈ 0.05 s、Person timeline ≈ 0.03 s、
Dashboard ≈ 0.2 s、Topic memory ≈ 0.5 s。

- **RLS と索引**: RLS 下では leakproof な演算子（`=`, `<`, `= ANY`, `IS NULL`）しか索引条件になりません。スコープの OR 分岐はすべて
  索引付きの単純な等値（series_id / project_id / meeting_id = ANY / person_id）で、BitmapOr になります。配列演算子（`&&`, `@>`）は後段フィルタのみ。
  索引: `021_ledger_perf_indexes.sql`（ledger）+ `031_followup_perf_indexes.sql`（supersede 参照、変更履歴、series/project/person 分岐、通知）。
- **ACL**: 各項目の元会議を `LEFT JOIN LATERAL (… LIMIT 1) sm` で主キー参照し、その会議に `meetingVisibleSql` を適用します（`itemVisibleSql` と同じ意味）。
  OR 内の相関 EXISTS は全会議のハッシュ化（5万行 × RLS 判定）になるため避けています。
- **ORDER BY + LIMIT の罠**: 対象が少ないスコープで `(workspace_id, due_date)` 索引を順に走査して全件を読むことを防ぐため、
  スコープ付き一覧の並び順は索引に一致しない式（`coalesce(due_date, 'infinity')` 等）にしています。ダッシュボードの「自分の」一覧だけは
  ユーザー別の索引順をそのまま使います。
- **件数**: Brief / Memory は正確な件数、Dashboard は 1000 で打ち切り。

## 既知の制限

- Brief はリクエスト時に計算します（`brief_snapshots` は未使用）。各セクション上限で打ち切り、総数は `counts` で返します。
- トピック照合は語彙一致（意味検索ではない）で、各テーブルの新しい 20,000 件が対象です。表記ゆれ（例: 見積り/見積もり）は一致しないことがあります。
- 「社内/社外」の判定は Person がワークスペースのユーザーに紐づいているかで行います（未紐づけの社内メンバーは外部扱い）。
- Dashboard の Needs Review / Waiting on Others / Open Questions は直近90日の自分の会議（最大2000件）が対象です。
