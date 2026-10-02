# Decision Ledger（決定事項台帳）

「いつ・どの会議で・何が決まり、いま有効な決定はどれか」を、根拠（発言範囲）付きで残す台帳です。
**古い決定は削除せず、Supersede（置き換え）リンクで履歴として残し、「現在有効な決定」を表示します。**

実装: `apps/server/src/modules/ledger/{routes,service,queries,contradictions}.ts` / テーブル: `decisions`, `contradiction_candidates`, `ledger_events`

## 1. 状態

| 列 | 値 | 意味 |
|---|---|---|
| `review_state` | `candidate` | AI 抽出直後。現在有効な決定には含まれない |
| | `confirmed` | 人が確認した（Review Inbox の accept、手動作成、矛盾解決の change） |
| | `rejected` | 人が却下（行は残り、再抽出でも作り直さない） |
| `status` | `active` | 有効 |
| | `superseded` | 新しい決定に置き換えられた（`superseded_by_decision_id`） |
| | `revoked` | 取り消し（PATCH `status:'revoked'`） |

**現在有効な決定** = `review_state='confirmed' AND status='active'`。AI が単独で confirmed にすることはありません。

## 2. 根拠（SourceRef）

各決定は `source_segment_ids`、`source_start_ms/end_ms`、`source_quote`、`source_transcript_id`、`source_revisions`（セグメントid→抽出時の revision）を持ちます。
API では `source: { meetingId, meetingTitle, meetingDate, segmentIds, startMs, endMs, quote, status }` を返します。

- `status: 'ok'` — 根拠セグメントが現行 Transcript に存在し、抽出時から変更されていない
- `status: 'edited'` — 抽出後にセグメント本文が修正された（**ids と quote は抽出時のまま保持**。画面で「元の発言から修正あり」と表示）
- `status: 'missing'` — セグメントが削除された、または Transcript が再作成され現行版でなくなった

メモ由来の決定は `segmentIds: []`、quote のみ。手動作成時に `meetingId + segmentIds` を渡すと現行 Transcript から根拠を作ります。

## 3. API

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/w/:ws/decisions?view=current\|all\|candidates\|superseded&projectId&seriesId&personId&meetingId&topic&limit&cursor` | `current`=有効な決定（既定）、`all`=却下以外、`candidates`、`superseded`。`{items, nextCursor, total}`（ページングは [COMMITMENT_LEDGER.md](COMMITMENT_LEDGER.md) 参照） |
| POST | `/api/w/:ws/decisions` | 手動作成（即 confirmed）。`{text, topic?, reason?, meetingId?, projectId?, seriesId?, ownerPersonId?, decidedAt?, participantPersonIds?, segmentIds?, supersedesDecisionId?}` |
| GET/PATCH | `/api/w/:ws/decisions/:id` | PATCH: `text/topic/reason/ownerPersonId/projectId/seriesId/participantPersonIds`、`status: 'revoked'\|'active'`（変更は ledger_events に差分で記録） |
| GET | `/api/w/:ws/decisions/:id/history` | `{chain: [古い→新しい], current, events}`（Supersede チェーン＋全イベント） |
| POST | `/api/w/:ws/decisions/:id/supersede` | `{text, topic?, reason?}`（新しい決定を作成）または `{newDecisionId}`（既存の決定/候補を新しい方として確定）。旧決定は `superseded` として残る |
| GET | `/api/w/:ws/contradictions?status=open\|…\|all&meetingId` | 矛盾候補（両方の決定が見える場合のみ） |
| POST | `/api/w/:ws/contradictions/:id/resolve` | `{resolution: 'change'\|'not_change'\|'dismiss'}` |
| GET | `/api/w/:ws/meetings/:id/ledger` | その Meeting の決定・アクション・約束・質問・矛盾 |

Review Inbox（accept/reject/edit）は [COMMITMENT_LEDGER.md](COMMITMENT_LEDGER.md#review-inbox) を参照。

## 4. Supersede（置き換え）

- 置き換えられるのは `confirmed` かつ `active` の決定だけ。旧決定 → `status='superseded'`, `superseded_by_decision_id=新`。新決定 → `supersedes_decision_id=旧`, `confirmed`, `active`。トピックが未設定なら旧決定のトピックを引き継ぎます。
- 行は削除しません。`ledger_events` に `superseded` / `supersedes` を記録し、履歴 API でチェーンをたどれます。
- 同じ2件の間に未解決の矛盾候補があれば `confirmed_change` として閉じます。

## 5. 矛盾候補（Contradiction candidates）

AI 抽出（および手動作成）で新しい決定ができると、**同じ Project または Series（どちらも無ければ Workspace 全体）**の「現在有効な決定」と比較します。

1. 対応付け: `topic_key`（トピックの正規化キー。例「公開日」）が同じ、または本文のトークン Jaccard 類似度 ≥ 0.3
2. 食い違い: 日付・数値・金額などの値（`10月`、`5万円`、`Q3`、`Oct 15` …）の集合が異なる。値が無い場合は、同じトピックで「値の部分」（「デザインは**A案**にします」）が異なる
3. 値が同じなら言い換えとみなし、矛盾にしません

候補は `contradiction_candidates(status='open')` として保存され、Review Inbox と `/contradictions` に表示されます。**自動で置き換えることはありません。**

規模（1 Workspace に 50万件の決定）でも検出は有界です: 比較対象は「同じトピックの最新200件（範囲内）」と「範囲内の最新300件」だけで、
新しい決定1件につき**最新の競合3件まで**、1回の抽出で最大100件の矛盾候補を作ります（人が見るべきなのは最新の有効な決定との食い違いのため）。

| resolution | 結果 |
|---|---|
| `change` | 新しい決定を confirmed（候補なら確定）にし、既存の決定を superseded（リンク付き、削除しない）。`status='confirmed_change'` |
| `not_change` | 変更ではない（別の事柄など）。両方そのまま。`status='not_change'` |
| `dismiss` | 誤検出として閉じる。`status='dismissed'` |

決定候補を却下すると、その候補が起点の未解決の矛盾は `dismissed` になります。

## 6. アクセス制御

- すべての一覧・取得・更新は `itemVisibleSql` による Meeting ACL を SQL で適用します（private Meeting は作成者のみ、admin も見えない）。見えないものは 404。
- 矛盾候補は「既存」と「新」の両方の決定が見えるユーザーにだけ表示されます（見えない Meeting の決定内容を漏らさない）。
- 更新は member 以上。viewer は閲覧のみ。

## 7. 監査（ledger_events）

`extracted`（AI、by_user_id なし）、`created`、`edited`（差分）、`accepted`、`rejected`、`status_changed`、`superseded`、`supersedes`、矛盾の `detected` / `resolved` / `dismissed`。
人が編集した AI 候補は再抽出で置き換えられません。
