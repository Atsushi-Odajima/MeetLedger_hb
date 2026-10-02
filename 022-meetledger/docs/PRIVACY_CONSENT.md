# PRIVACY_CONSENT — 録音・文字起こしの同意とデータの扱い（MeetLedger #022）

> **重要**: MeetLedger は参加者への通知・同意取得を「支援」し記録を残すが、**法的適合（個人情報保護法・各国の録音同意法・GDPR 等）を保証しない**。
> 録音の可否・通知方法・外国移転の扱いは、利用者（事業者）が自らの法務判断で決定すること。以下の法令情報は SOURCE_NOTES.md §C-5 の調査メモ（確認日 2026-10-02、一部は検索要約）であり法的助言ではない。

## 1. 製品としての立場
- **秘密録音を促進しない**: 録音・文字起こし機能は、参加者へ通知した記録（consent record）がない Meeting では開始できない（API: `POST /meetings/:id/start` が `409 consent_required`）。録音中は Web/Desktop に常時インジケータ（Desktop は全ウィンドウのタイトルに「● 録音中」、トレイアイコン変化）。隠し録音・バックグラウンド自動録音・会議への無断参加ボットは提供しない。
- **面接での不正支援・人物評価をしない**: Interview テンプレートは記録のみ。リアルタイムで相手に秘密で回答を表示する機能、候補者の人格/能力評価、感情認識、声による本人特定は提供しない（§41）。
- **参加者への自動送信はしない**: 事前通知メール・催促メール等を MeetLedger が自動で第三者へ送ることはない。通知文面はコピーして利用者自身が送る（下の文例）。

## 2. 同意ワークフロー（実装）
| ステップ | 画面/API | 記録 |
|---|---|---|
| 1. Meeting 作成時に「どこで処理されるか」を表示 | Meeting 詳細 `privacy`（transcription/ai の provider・local/cloud・理由） | — |
| 2. 録音前の同意ダイアログ | Capture タブ（Web）/ Recorder（Desktop）: 録音・文字起こし・保存期間・AI 処理・外部送信先を表示し、参加者へ通知した方法（口頭/カレンダー記載/チャット/メール/その他）を選択 | `consent_records`（kind=recording/transcription/ai_processing/external_transfer, state=notified/confirmed/declined, method, 記録者, 日時）+ `audit_events` |
| 3. 参加者が拒否 | state=declined → 録音系の開始不可（手動メモのみ可） | 同上 |
| 4. 録音開始 | `POST /start {capture}`。`notes_only` は同意不要 | `meeting.started` audit |

**Recording OFF でも利用可能**: 手動メモ（Notes）だけで Decision/Action/Commitment/Question を登録でき、AI 抽出もメモから行える（AI ON の場合）。

## 3. どのデータがどこへ行くか
| データ | 既定（Local-first） | Cloud を有効にした場合 | 制御 |
|---|---|---|---|
| 元音声/動画 | MeetLedger サーバ内に **AES-256-GCM 暗号化**保存（org 別鍵）。**既定は処理後に削除（Until processed）** | 文字起こし Provider（OpenAI/Deepgram）へ送信 | Meeting ごとの保存期間、Confidential、transcriptionMode |
| Desktop Local mode の音声 | **PC 内で文字起こし、音声はアップロードしない**（テキストのみ送信）。「音声もアップロード」を選んだ場合のみ送信 | — | Desktop の設定 |
| Transcript / メモ | サーバ DB（PostgreSQL、RLS でテナント分離） | Cloud LLM（要約・抽出・Ask）へ抜粋を送信 | Meeting の AI ON/OFF、Workspace の cloudAllowed |
| 検索 index / 埋め込み | サーバ DB（`search_docs`, `ai_chunks`）。AI OFF Meeting は `ai_chunks` を作らない | OpenAI Embedding へ送信（cloud 設定時） | AI ON/OFF、embeddings 設定 |
| 話者分離の声の特徴量 | 処理中のメモリ内でのみ使用、**保存しない**。声による本人特定はしない（Speaker 1/2 → 人間が名前を割当） | Provider 側の diarization | — |
| 外部連携（Slack/Gmail/HubSpot/Webhook） | 送信しない | **preview → 明示承認 → 1回送信** | external_write_requests |

- **外部送信の監査**: クラウドへの送信はすべて `GuardedHttp` を通り、送信直前に DB 上の Meeting 設定（AI OFF / Confidential / Local）を再確認し、メタデータ（日時・種類・送信先ホスト・バイト数、**本文なし**）を `external_calls` に記録する。Settings > Privacy の「どこに何が送られるか」と `GET /ai/privacy-preview` で事前に確認できる。
- **二重の opt-in**: クラウド処理は (1) インストール設定（`CLOUD_TRANSCRIPTION_PROVIDER` / `AI_PROVIDER` と API キー）と (2) Workspace 管理者の `cloudAllowed` の両方が必要。既定はどちらも OFF。
- **Confidential Meeting**: AI OFF、クラウド文字起こし不可（local へ変更）、音声は処理後削除、Workspace 全体公開不可（private へ）。
- **Local mode の実際の動作**: 文字起こし（sherpa-onnx SenseVoice）と話者分離（pyannote-seg-3.0 + CAM++）はサーバ（自己ホスト）または Desktop の CPU 上で実行され、音声は文字起こし事業者へ送られない（必須テスト#28/E2E-7 で外部呼び出し 0 件を検証）。モデルの初回ダウンロード（GitHub releases）は利用者の明示操作でのみ行う。**「local だから完全に安全」ではない**: サーバ/PC 自体の管理（OS 更新、ディスク暗号化、アクセス権、バックアップの保管）は利用者の責任。

## 4. 保存期間と削除（概要。詳細 RETENTION_DELETE.md）
| 種類 | 選択肢 | 削除時の挙動 |
|---|---|---|
| 音声/動画 | Never（保存期間0、処理後即削除・再生不可）/ Until processed（既定）/ 7日 / 30日 / Custom | ストレージ実体削除 + DB 行を削除済みに |
| Transcript | 無期限（既定）/ N日 | 段落・改訂履歴を削除。Ledger 項目の本文は残り、根拠は「missing」表示 |
| AI index | 無期限 / N日 / Meeting の AI OFF 切替で即時削除 | `ai_chunks` 削除 |
| 成果物（要約・Follow-up 下書き・エクスポート） | 無期限 / N日 | 削除 |
| Meeting 全削除 | 作成者または Admin | DB（cascade）・ストレージ・検索 index・AI index・キャッシュを削除し `deletion_requests` に手順を記録。**バックアップ内のデータはバックアップの保持期間満了まで残る**（運用で世代数を定める） |

## 5. 法令メモ（確認日 2026-10-02、要原文確認・法的助言ではない）
- **日本（個人情報保護法）**: 録音から個人を識別できれば個人情報。利用目的の特定・通知又は公表が必要（17条・21条）。PPC Q&A 1-10 では「録音している旨を伝える義務」までは課されないとされる一方、**音声から話者認識用の特徴量を作ると個人識別符号になり得る**（Q&A 1-11）→ MeetLedger は声紋を保存・照合しない設計。
- **外国にある第三者への提供（28条）**: 米国等のクラウド文字起こし/LLM に送る構成は、委託でも 28 条の対象になり得る。本人同意（移転先国名・制度・保護措置の情報提供）か基準適合体制（DPA 等）かを法務確認すること。**MeetLedger の既定（Local-first）ではこの移転は発生しない。**
- **米国**: 連邦法は one-party consent。California・Florida・Illinois・Maryland・Massachusetts・Montana・New Hampshire・Pennsylvania・Washington 等は all-party consent とされる（州法の例外は未確認）。多州参加のオンライン会議は全員への通知・同意を既定にするのが実務的。
- **EU（GDPR）**: 適法性根拠（Art.6）と透明性（Art.13: 目的・根拠・保存期間・権利）。生成 AI による文字起こしは DPIA と AI 生成の明示が推奨される（EDPS ガイダンス）。
- **AI事業者ガイドライン 第1.2版**（2026-03-31）: AI 利用者としてプライバシー尊重・関係法令遵守。

## 6. 参加者への通知文例（利用者がコピーして使う）
**事前（カレンダー招待・メール）**
> 本会議は議事録作成と決定事項・宿題の管理のため、MeetLedger で録音・文字起こしを行います。音声は文字起こし後に削除し（保存期間: ○○）、文字起こしと要約は社内の関係者のみが閲覧します。[クラウドを使う場合: 文字起こし/要約のため ○○社（所在国: ○○）のサービスへ送信します。] 録音を希望されない場合は事前にお知らせください。録音なしで進行します。

**会議冒頭（口頭/チャット）**
> これから議事録作成のため録音と文字起こしを開始します。録音を希望されない方はお知らせください。

**English**
> This meeting will be recorded and transcribed with MeetLedger to keep track of decisions and action items. Audio is deleted after transcription. Let us know if you prefer not to be recorded — we will continue without recording.

## 7. 利用者（導入企業）がやること
1. 利用目的とプライバシーポリシーへの記載（録音・文字起こし・AI 処理・保存期間・委託先）。
2. Cloud を有効にする前に、委託先の契約（DPA、学習利用なし、保存期間、リージョン）と 28 条の扱いを確認。
3. 保存期間の既定値（Workspace 設定）を決める。
4. 管理者アカウントの保護（強いパスワード、退職者の削除）、サーバ/バックアップの暗号化と保管。
5. MCP（ChatGPT/Codex）連携トークンの発行は必要な人だけ、read-only を基本に。
