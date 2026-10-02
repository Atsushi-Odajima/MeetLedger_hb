# OPERATIONS — MeetLedger 運用ガイド

デプロイ方式（Docker / VM / 物理サーバー / PaaS）に依存しない運用手順です。コマンド例の `node dist/cli/index.js` は
ビルド済みサーバー（`apps/server/dist`）での実行方法です。開発環境では `npx tsx src/cli/index.ts`（`apps/server` で実行）でも同じです。

関連: [RETENTION_DELETE.md](RETENTION_DELETE.md)（データ種別ごとの保持と削除）、[API_CONTRACT.md](API_CONTRACT.md)。

---

## 1. 守るべき状態（ステートフルな要素）

| 要素 | 場所（環境変数） | 内容 | 失うと |
|---|---|---|---|
| PostgreSQL | `DATABASE_URL` | 会議・文字起こし・台帳・設定・ユーザー等の全テーブル | すべてのデータ |
| オブジェクトストレージ | `STORAGE_DIR`（local driver） | 音声/動画・取込ファイル・Export成果物（**AES-256-GCMで暗号化済み**） | 音声・添付 |
| **MASTER_KEY** | 環境変数（Secret管理） | ストレージ暗号化・コネクタトークン暗号化の鍵（HKDFで組織ごとに派生） | **暗号化済みデータが二度と復号できない** |
| SESSION_SECRET | 環境変数 | 署名付きURL・CSRF用HMAC鍵 | ログイン中セッション/発行済みURLの無効化のみ（データ損失なし） |
| TMP_DIR | `TMP_DIR` | 処理中の一時ファイル | 失っても問題なし（処理は再実行可能） |

> `.env` / Secret ストアそのものもバックアップ対象です（特に `MASTER_KEY`）。DB とストレージだけでは復元できません。

---

## 2. CLI コマンド

```
node dist/cli/index.js migrate                                   # 未適用マイグレーションの適用
node dist/cli/index.js backup  --out /backup/ml-YYYYMMDD.tar.gz  # バックアップ作成（--no-storage でDBのみ）
node dist/cli/index.js restore --in  /backup/ml-YYYYMMDD.tar.gz  # 空のDBへ復元（--force で既存データを置換）
node dist/cli/index.js seed-sample --email user@example.com      # 架空データのSample Workspaceを作成
node dist/cli/index.js create-owner --email ops@example.com --name "Ops"   # パスワードは MEETLEDGER_OWNER_PASSWORD で渡す
node dist/cli/index.js create-owner --email ops@example.com --reset-password # オーナーのパスワード再設定（全セッション失効）
node dist/cli/index.js retention-sweep                           # 保持期間スイープを1回実行
```

- 環境変数（`DATABASE_URL`, `MASTER_KEY`, `STORAGE_DIR`, `TMP_DIR` …）はサーバーと同じものを読みます。
- 出力は件数・ID・ファイル名のみで、会議内容は表示しません。終了コード: 0=成功 / 1=失敗 / 2=引数誤り。
- パスワードはシェル履歴に残らないよう `--password` ではなく `MEETLEDGER_OWNER_PASSWORD` 環境変数での指定を推奨します。

---

## 3. バックアップ

### 3.1 形式（`meetledger-backup/v1`, tar.gz）

```
manifest.json          形式, appVersion, createdAt, schemaMigrations, 各テーブル行数, MASTER_KEY指紋, 全ファイルのsha256
tables/NNN-<table>.jsonl   1行=1レコード（PostgreSQL to_jsonb）。外部キー依存順に並ぶ
storage/org/...            オブジェクトストレージのファイルを「暗号化されたまま」コピー
```

- DB は **1つの REPEATABLE READ トランザクション**で読み出すため、テーブル間の整合が取れたスナップショットになります。
- `sessions` は含めません（復元後は全員再ログイン）。それ以外のテーブル（ユーザー、組織、ジョブ、監査ログ等）はすべて含みます。
- ストレージは暗号化済みファイルをそのまま格納します。**復元先でも同じ `MASTER_KEY` が必要**です（manifest の `keyFingerprint` で照合。鍵そのものは含みません）。
- **注意: `tables/*.jsonl` は平文です**（文字起こし・メモ・パスワードハッシュ等を含む）。バックアップファイルは
  - 暗号化して保管する（例: `age -r <公開鍵> ml.tar.gz > ml.tar.gz.age`、または暗号化バケット／暗号化ボリューム）
  - 閲覧できる人を運用担当者に限定する
  - 本番と別の場所（別リージョン・別アカウント）にも保管する

### 3.2 スケジュール例

| 頻度 | 保管世代 | 例 |
|---|---|---|
| 毎日 | 7日分 | `15 3 * * *` |
| 毎週 | 4週分 | 日曜分を週次として保管 |
| 毎月 | 12か月分 | 1日分を月次として保管 |

```bash
# /etc/cron.d/meetledger-backup の例（アプリと同じ環境変数を読み込む）
15 3 * * * meetledger . /etc/meetledger/env && node /opt/meetledger/apps/server/dist/cli/index.js backup \
  --out /backup/ml-$(date +\%Y\%m\%d).tar.gz && age -r "$BACKUP_PUBKEY" /backup/ml-$(date +\%Y\%m\%d).tar.gz \
  > /backup/ml-$(date +\%Y\%m\%d).tar.gz.age && rm /backup/ml-$(date +\%Y\%m\%d).tar.gz
```

- **バックアップの保管期間は「削除したデータがバックアップから消えるまでの期間」**でもあります（[RETENTION_DELETE.md](RETENTION_DELETE.md) §5）。
  利用規約・プライバシーポリシーに記載する保管期間と一致させてください（上の例では最長約12か月）。
- バックアップ中もサービスは稼働できます。大量アップロード中は、DBスナップショット後に追加された音声がアーカイブに含まれないことがあります（次回バックアップで取得）。
- S3互換ストレージ等を使う構成では、`--no-storage` で DB のみを取得し、ストレージ側はバケットのバージョニング／レプリケーションで保護してください。

### 3.3 復元（restore）

```bash
# 1) アプリ（API・ワーカー）を停止
# 2) 新しい空のDB（または既存DB）に対して実行。MASTER_KEY は元環境と同じものを設定
node dist/cli/index.js restore --in /backup/ml-20261001.tar.gz
# 既存データを丸ごと置き換える場合のみ（全テーブルTRUNCATE、バックアップに無いストレージファイルも削除）
node dist/cli/index.js restore --in /backup/ml-20261001.tar.gz --force
# 3) アプリを起動 → /api/health 確認 → ログイン確認
```

restore が行う検証（どれかに失敗すると DB には一切書き込みません）:

1. manifest の形式チェック、**全ファイルの sha256 照合**（改ざん・欠損・余分なファイルを検出）
2. `MASTER_KEY` の指紋照合（不一致なら中止。鍵を失った場合のみ `--allow-key-mismatch` でDBのテキストデータだけ復元可能。音声・コネクタ秘密情報は読めません）
3. `migrate` 実行後、バックアップのスキーマが現在のアプリより新しくないことを確認（新しい場合はアプリを先に更新）
4. 復元先DBが空であること（ユーザー/組織が存在すれば `--force` なしでは中止）
5. 外部キー依存順に1トランザクションで投入し、テーブルごとの行数を manifest と照合 → ストレージ配置 → COMMIT

### 3.4 復元訓練（リストアドリル）— 四半期に1回以上推奨

1. 検証用の PostgreSQL と空の `STORAGE_DIR` を用意（本番と同じ `MASTER_KEY`）。
2. 最新バックアップを `restore` する（所要時間を記録 = RTO の実測値）。
3. 確認項目
   - `restore complete: N tables, M rows, K storage objects` が manifest と一致
   - 検証環境でアプリを起動し、オーナーでログインできる／会議一覧・決定事項・文字起こしが表示される
   - 音声を1件再生できる（= 暗号化オブジェクトが同じ鍵で復号できる）
   - バックアップの `createdAt` から本番の最新時刻までの差 = RPO の実測値
4. 結果（日時・バックアップ名・所要時間・問題点）を記録し、検証環境を破棄。

### 3.5 pg_dump を使う代替手順

CLI バックアップの代わりに PostgreSQL 標準ツールを使うこともできます。テーブルは **FORCE ROW LEVEL SECURITY** のため、
アプリ用ロールでは通常の `pg_dump` が失敗します。次のどちらかで実行してください（動作確認済み）。

```bash
# A) アプリ用ロールで、システムコンテキスト（app.system=on）を指定して取得
PGOPTIONS='-c app.system=on' pg_dump --enable-row-security -Fc -f ml.dump "$DATABASE_URL"
# B) スーパーユーザー（または BYPASSRLS ロール）で取得
pg_dump -Fc -f ml.dump -U postgres meetledger

# ストレージは別途アーカイブ（暗号化済みファイルをそのまま）
tar -C "$STORAGE_DIR" -czf ml-storage.tar.gz .

# 復元: 空のDBへ
pg_restore --no-owner -d "$DATABASE_URL" ml.dump
tar -C "$STORAGE_DIR" -xzf ml-storage.tar.gz
```

- pg_dump 方式では sha256 照合・鍵指紋照合・空DBチェックは行われません。手順書と訓練で補ってください。
- `sessions` も含まれるため、復元後に `DELETE FROM sessions;` を実行して全セッションを失効させることを推奨します。
- DB とストレージを別々に取得するため、取得タイミングのずれに注意してください（DB→ストレージの順で取得）。

---

## 4. 鍵管理（MASTER_KEY / SESSION_SECRET）

- `MASTER_KEY`: `openssl rand -base64 32`（32バイト）。**生成直後に鍵保管（キーエスクロー）を行う**こと。
  - 推奨: パスワードマネージャーの共有金庫＋オフライン保管（紙／暗号化USB）の2か所。保管者は2名以上。
  - 鍵とバックアップファイルは**別の場所**に保管する（同じ場所に置くと暗号化の意味が薄れます）。
  - `backup` 出力の `key fingerprint` を記録しておくと、どの鍵でどのバックアップを復元できるか確認できます。
  - 現行版は `MASTER_KEY` のローテーション（再暗号化）を提供していません。鍵を変更すると既存の音声・コネクタトークンは読めなくなります。
    漏えいが疑われる場合は、新環境へ Workspace Export→Import（音声込み）で移行し、旧鍵・旧データを破棄してください。
- `SESSION_SECRET`: 32文字以上のランダム値。変更すると発行済みの署名付きURL・ダウンロードリンクが無効になります（データ損失なし）。
- 本番では `NODE_ENV=production` で既定値の鍵を使うと起動しません。
- API キー（OpenAI / Anthropic / Deepgram / OAuth クライアント）は環境変数で渡し、ログ・バックアップの manifest には出力されません（DBにも保存しません）。

---

## 5. 保持期間スイープ（retention.sweep）

- `RUN_WORKER=true` のプロセスが1時間ごとに `retention.sweep` ジョブを登録・実行します（クラスタ全体で1時間に1回）。
- 手動実行: `node dist/cli/index.js retention-sweep`（結果は件数のJSON）。
- 処理内容（詳細は [RETENTION_DELETE.md](RETENTION_DELETE.md)）:
  - 音声/動画: `media_assets.retention_until` を過ぎたもの（Meetingごとの音声保持設定から算出）
  - 文字起こし: Workspace設定 `retention.transcriptDays` より古いもの
  - AI索引: `retention.aiIndexDays` より古い `ai_chunks`
  - 成果物: `retention.artifactDays` より古い要約・フォローアップ下書き・ブリーフキャッシュ／Workspace Export ファイル（最長7日）
  - 期限切れのセッション・招待・MCP確認
- 削除はすべて `deletion_requests`（`trigger: retention`）と監査ログ（件数のみ）に記録されます。
- ワーカーを止めている間は削除が遅れます。長期停止後は手動で1回実行してください。

---

## 6. 監視の基本

| 項目 | 確認方法 | 目安 |
|---|---|---|
| 死活 | `GET /api/health` → `{ok:true}`（DB接続も確認） | 1分間隔、2回連続失敗で通知 |
| ジョブ滞留 | `SELECT type, count(*) FROM jobs WHERE status='queued' AND run_after < now() - interval '15 minutes' GROUP BY type;` | 0 が正常 |
| 失敗ジョブ | `SELECT type, count(*) FROM jobs WHERE status='dead' AND updated_at > now() - interval '1 day' GROUP BY type;` | 増加時に調査（`last_error` は300文字に切り詰め済み・内容は含まない） |
| 保持スイープ | `SELECT finished_at, result FROM jobs WHERE type='retention.sweep' ORDER BY created_at DESC LIMIT 1;` | 2時間以上更新が無ければワーカー停止を疑う |
| ディスク | `STORAGE_DIR`, `TMP_DIR`, バックアップ置き場, PostgreSQL データ領域 | 使用率 80% で通知 |
| バックアップ | 最新バックアップファイルの日時・サイズ、restore 訓練の記録 | 26時間以上新しいファイルが無ければ通知 |
| ログ | pino JSON。認証ヘッダ・Cookie・本文・文字起こし等は自動で伏字 | エラーレベルの急増を監視 |

DB確認クエリはシステムコンテキストで実行してください（例: `SET app.system = 'on';` を実行してから。テーブルは RLS で保護されています）。

---

## 7. アップグレード

1. `backup` を取得（アップグレード前の世代として別保管）
2. 新バージョンを配置 → `node dist/cli/index.js migrate`（サーバー起動時にも自動適用）
3. アプリ起動 → `/api/health` → 主要画面の確認
4. 問題があれば旧バージョンに戻し、手順1のバックアップを `restore --force`

マイグレーションは追加のみ（既存SQLは書き換えない）方針です。新しいスキーマで作成したバックアップは古いアプリでは復元できません（restore が検出して中止します）。
