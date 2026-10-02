# DECISIONS — 設計判断記録（ADR形式・要約）

| # | 判断 | 理由 / 代替案 |
|---|---|---|
| D1 | 専用フォルダ `022-meetledger/` に新規構築。既存 #001〜#021 は変更しない | 指示どおり（本リポジトリには #001〜#021 は存在しない） |
| D2 | **PostgreSQL 16 + FORCE ROW LEVEL SECURITY** を全テナントテーブルに適用し、アプリ層でも org/workspace を必ず絞る | テナント分離の多層防御。アプリロールは非superuser/NOBYPASSRLS（テストで検証）。SQLite は単一ファイルで手軽だが多テナント/同時実行/RLS が弱い |
| D3 | 日本語全文検索は **アプリ側 bigram tokenizer で tsvector/tsquery リテラルを生成** | pg_bigm/PGroonga は拡張導入が必要で配布先依存。pg_trgm は2文字語に弱い。リテラル生成ならロケール非依存。限界: 1文字検索は前方一致のみ |
| D4 | ベクトルは `real[]` 列 + ACL絞り込み後にアプリでcosine計算（FTSで候補を前段絞り込みするhybrid） | pgvector が入っていない環境でも動く。大規模時は pgvector への置換を Pro候補とする |
| D5 | ジョブは Postgres `jobs` テーブル（冪等キー UNIQUE + SKIP LOCKED + リース） | Redis 等の追加インフラ不要。同一キー再投入で重複しない（必須テスト#2） |
| D6 | **Local-first 既定**：文字起こし=local（sherpa-onnx）、AI=local-rules、embedding=local-hash、クラウド送信は Workspace admin の opt-in + インストール側設定の二重許可 | Privacy First（§4,§27）。クラウドは明示許可時のみ |
| D7 | すべての外部通信を `GuardedHttp` に集約。transcription/ai/embedding は PolicyDecision 必須、送信直前に DB で AI OFF/Confidential/Local を再確認し、metadata のみ `external_calls` に記録 | 「AI OFF Meeting を provider へ送らない」「local mode で cloud call 0」をコードパス単位で保証・監査（必須テスト#17,#28） |
| D8 | AI 抽出結果はサーバ側で **常に Candidate に強制**、根拠 segment/quote を検証し不一致は破棄 | Transcript にない内容を作らない・無確認確定禁止・prompt injection 耐性 |
| D9 | Private Meeting は **作成者のみ**（Owner/Admin でも閲覧不可）。Selected は明示ユーザーのみ | 1on1 Private default、プライバシー優先。管理者は削除・保持ポリシーで統制 |
| D10 | 権限外リソースは 403 でなく 404 | 存在の漏えい防止 |
| D11 | Desktop companion は **Electron 44**（Tauri 不採用） | system audio loopback が数行、sherpa-onnx-node をそのまま利用、録音コードを PWA と共有。代償はサイズ（130–160MB）。詳細 DESKTOP_COMPANION.md |
| D12 | Local ASR は **sherpa-onnx + SenseVoice int8**（ja/en、FunASR Model License: 商用可・出典表記）。diarization は pyannote-seg-3.0(MIT)+CAM++ | whisper.cpp より日本語/速度のバランス、npm prebuilt あり。reverb-diarization は商用不可で不採用 |
| D13 | 2ch 録音（mic=L / system=R）で **チャンネル基準の話者分離**（声紋による本人特定はしない） | 「声だけから実在人物を勝手に特定しない」。人物割当は常に人間 |
| D14 | Follow-up 文面は **テンプレート合成（確定済み項目のみ）**、AI は挨拶/結びの調整のみ + 新しい約束/日付の混入を検証で拒否 | 「Meeting にない約束を追加しない」（必須テスト#11） |
| D15 | 外部 write（Slack/Gmail draft/HubSpot/Webhook）は `external_write_requests` で preview → 明示承認 → 1回だけ実行（payload hash で冪等） | §25 |
| D16 | MCP の write tool は 2 段階確認（preview + confirmation token）、send 系 tool は提供しない | §26 |
| D17 | PDF は印刷最適化 HTML をブラウザの「PDFとして保存」で生成 | 日本語フォント同梱（ライセンス）を避ける |
| D18 | 認証は server-side session（httpOnly cookie, SameSite=Lax）+ session 紐付け CSRF token（custom header）+ Origin 検査。パスワードは scrypt N=2^17 | OWASP 推奨 |
| D19 | メディアは org 別 HKDF 派生鍵で AES-256-GCM 暗号化保存、配信は user+期限に束縛した HMAC 署名URL + ACL 再確認 | §33 signed URLs |
| D20 | 名称「MeetLedger」は変更しない。商標DB未検索のため販売前に人間が確認（候補名は BRANDING.md / SOURCE_NOTES.md） | §43 |
