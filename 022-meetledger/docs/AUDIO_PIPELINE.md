# 音声パイプライン（audio module）

対象コード: `apps/server/src/modules/audio/**`, `apps/server/src/providers/{transcription,diarization}/**`, `packages/local-asr/**`
関連: [TRANSCRIPTION.md](./TRANSCRIPTION.md)（Provider・モデル・ライセンス・実測値）, [API_CONTRACT.md](./API_CONTRACT.md) の audio 節

## 1. 全体の流れ

```
アップロード (POST /meetings/:id/media, multipart)
  │  サイズ上限 → magic bytes / 拡張子 / MIME 照合 → ffprobe（音声トラック必須）
  ▼
暗号化保存 (storage.putFile: AES-256-GCM, key = org/<org>/meeting/<meeting>/original/<assetId>)
  │  media_assets 行（sha256, size, duration, channels, retention_until）
  ▼
ジョブ audio.process（冪等キー audio:<assetId>:<provider>）
  1. 一時ディレクトリへ復号（TMP_DIR/audio-xxxx）
  2. ffprobe
  3. ffmpeg 正規化: 16 kHz mono PCM16 WAV（-bitexact, メタデータ除去）
     ＋ 2ch 以上なら 16 kHz stereo WAV（ch0 = ローカルマイク, ch1 = システム/相手側）
  4. input_hash = 正規化PCMの SHA-256 → 同一 (meeting, input_hash, provider) の transcript があれば
     Provider を呼ばずに終了（クラウド再送なし）
  5. 文字起こし（Provider 選択は §4）
  6. 話者ラベル正規化（Speaker 1..N）／チャネル分離／タイムスタンプ整列／品質フラグ
  7. transcript version を冪等に書き込み（前の version は is_current=false、segments に tsv）
  8. ai.extract（key ai:<transcriptId>、decideAi が許可した場合のみ）と index.meeting を enqueue
  9. Meeting status → needs_review（人間確認）
 10. 保持ポリシー適用（§6）
  └ finally: 一時ファイルを必ず削除
```

元音声（暗号化ストレージ）と派生 transcript（DB の transcripts / transcript_segments）は分離して保存し、正規化 WAV は一時ファイルとしてのみ存在します（永続化しません）。

## 2. アップロード検証

| チェック | 内容 | エラー |
|---|---|---|
| 認可 | Workspace member 以上 + `loadMeeting(..., 'write')`（Meeting ACL） | 403 / 404 |
| 形式 | `multipart/form-data` の `file` フィールド | 415 |
| サイズ | `MAX_UPLOAD_MB`（@fastify/multipart の fileSize 制限。超過分は保存されない） | 413 |
| magic bytes | 先頭バイトでコンテナ判定（下表） | 415 |
| 拡張子 | 判定コンテナの拡張子リストに含まれること | 415 |
| MIME | 宣言 MIME が判定コンテナと整合（`application/octet-stream` は許容） | 415 |
| デコード | ffprobe で読めて音声ストリームがあること | 415 |

| コンテナ | magic bytes | 拡張子 | 保存 MIME |
|---|---|---|---|
| WAV | `RIFF....WAVE` | wav, wave | audio/wav |
| MP3 | `ID3` または MPEG Layer III フレーム同期 | mp3 | audio/mpeg |
| MP4/M4A/MOV | 4–8 バイト目 `ftyp`/`moov`/`mdat`/`wide`/`free`/`skip` | m4a, mp4, mov, m4v, aac | audio/mp4, video/mp4, video/quicktime |
| WebM/MKV | `1A 45 DF A3`（EBML） | webm, mkv, mka | audio/webm, video/webm, *-matroska |
| Ogg/Opus | `OggS` | ogg, oga, opus, ogv | audio/ogg |
| FLAC | `fLaC` | flac | audio/flac |

- ファイルは一時ファイルへストリーミングしながら SHA-256 / サイズを計算し、検証後に暗号化ストレージへ移します。リクエスト中に DB トランザクションを保持しません。
- 映像トラックがあれば `kind = original_video`、それ以外は `original_audio`。
- **同一 Meeting に同じファイル（同じ sha256）を再送**した場合は既存 asset を再利用し、同じジョブキーになるため処理は重複しません（レスポンス `created:false`）。

レスポンス: `{ assetId, jobId, created, jobStatus, transcription: { allowed, provider, isLocal, reason, available, unavailableReason } }`

## 3. ジョブ `audio.process`

- payload: `{ meetingId, assetId, provider }`。キー `audio:<assetId>:<providerId>`（`none` = 文字起こし無し）。
- 実行時に Meeting / Workspace 設定を **再評価** して Provider を決めます（アップロード後にモードが変わっても、実行時点のプライバシー設定が優先）。
- 失敗: 一時的エラー（5xx/429/ネットワーク）は `jobs` のバックオフで再試行。恒久エラー（4xx, モデル未導入, fixture 不在, ポリシー拒否）は即 `dead`。最終失敗時は Meeting を `needs_review` にし、`audit_events` に `audio.process_failed`（メッセージは 200 文字に切り詰め、本文は含まない）。
- 再処理: `POST /meetings/:id/process {rerun:true}` は最新の未削除元音声について同じキーのジョブを再キューします。同一入力・同一 Provider の transcript が既にあれば Provider は呼ばれず version も増えません（Provider を変えた場合のみ新 version）。
- `GET /meetings/:id/processing`: Meeting status、現在の Provider 判定（allowed / isLocal / reason / available）、`audio.process` と `ai.extract` のジョブ状態、現在の transcript。

## 4. Provider の選択

| meeting.transcription_mode | 使用 Provider |
|---|---|
| `local` | `local-sherpa`（環境変数 `LOCAL_TRANSCRIPTION_PROVIDER=fixture` のときは `fixture`） |
| `cloud` | `decideTranscription()` の結果（Confidential / Workspace 未許可 / Provider 未設定なら文字起こししない） |
| `none` | 文字起こししない（音声は保持ポリシーに従って扱う） |

クラウドがブロックされた場合に **ローカルへ自動フォールバックはしません**（ユーザーの選択を黙って変えない）。理由は `transcription.reason` と processing API で表示され、ユーザーがモードを変えて再処理します。

## 5. 後処理（整列・品質フラグ・話者）

### タイムスタンプ整列
- 各 segment を `[0, duration]` にクランプ、`end >= start`、開始時刻は単調非減少（重なり＝クロストークは許容）。
- 500 ms 未満の断片は、同一話者かつ直前との間隔 300 ms 以内なら直前に結合（日本語同士は空白なし、それ以外は空白で連結。信頼度は小さい方を採用）。
- 内容が空で 50 ms 未満の断片は捨てる（アーティファクト）。

### 聞き取れない部分（[inaudible] ポリシー）
- 文字・数字を含まない結果（空、句読点のみ、ノイズ）は **テキストを正確に `[inaudible]`** にし `flags: ['inaudible']`。
- `[INAUDIBLE]`, `(inaudible)`, `[unintelligible]`, `[聞き取れず]` などの表記揺れは `[inaudible]` に統一。部分的に含む文もフラグ `inaudible`。
- 信頼度 < `MAX_INAUDIBLE_CONFIDENCE`（0.35）は `low_confidence` フラグ。**テキストは改変せず**人間のレビューに回します。
- AI による補完・推測での穴埋めは一切行いません。人間がセグメント編集で書き換えた場合のみ変わります（履歴に残る）。

### 話者
- Provider の話者クラスタ（`A`, `speaker_3` など）は出現順に `Speaker 1..N` に正規化。ラベルの無い segment は直前の話者を継承。
- **声から実在人物を特定しません。** `meeting_speakers.person_id` は人間の `PATCH /meetings/:id/speakers/:speakerId` でのみ設定（同一 Workspace の Person のみ、viewer 不可、audit 記録）。
- チャネル分離（2ch 音源で Provider 話者分離なし）: segment ごとに ch0/ch1 の RMS を比較し、ch0 優勢 → 提案 `あなた（マイク）`、ch1 優勢 → 提案 `相手側（システム音声）`。`source='channel'`、`suggestion` に保存するだけで自動割当はしません。
- Provider 話者分離あり＋2ch 音源: 発話時間の 70% 超がマイクチャネルのクラスタにだけ `あなた（マイク）` を提案。
- `meeting_speakers` は Meeting 単位（UNIQUE(meeting_id, label)）。新 version で同じラベルが出た場合は既存のマッピングを引き継ぎます（Provider を変えた再処理ではクラスタ順が変わり得るため、レビューで確認してください）。

## 6. 保持期間（audio_retention）

| 設定 | 動作 | retention_until（保険） |
|---|---|---|
| `never` | 処理中も **再生・ダウンロード不可**。処理終了時（成功・最終失敗いずれも）に元音声を削除 | アップロード + 24 時間（ジョブが走らない場合でも retention.sweep が削除） |
| `until_processed` | 文字起こし **成功直後に削除**。失敗時は再処理のため保持 | アップロード + 7 日 |
| `7d` / `30d` | 期間中は再生可 | アップロード + 7 / 30 日 |
| `custom` | 期間中は再生可 | アップロード + `audio_retention_days` 日 |

- 削除はストレージオブジェクトの削除＋ `media_assets.deleted_at` 設定（行はメタデータのみ残り、`retention_until` は NULL）。`deleteMediaAsset()` を data module（retention.sweep / delete-audio）でも利用可能。
- Confidential Meeting は core 側で `never` / `until_processed` に強制されます。
- 元音声を削除しても transcript（派生データ）は残ります。

## 7. 再生（署名 URL）

- `GET /meetings/:id/media` は asset 一覧（ストレージキーは返さない）と、再生可能なものに短命の署名 URL を返します。
- URL: `/api/files/:assetId?u=<userId>&exp=<unix秒>&sig=<HMAC-SHA256(SESSION_SECRET, "media:v1:<assetId>:<userId>:<exp>")>`、有効期限 `SIGNED_URL_TTL_SEC`（既定 300 秒）。
- `/api/files` は (1) ログイン必須（401）、(2) 署名・期限検証（403）、(3) `u` がログインユーザーと一致（別ユーザーは 403）、(4) Workspace メンバーシップ＋ Meeting ACL を再チェック（見えなければ 404）、(5) 削除済み／`never` は 404。
- 応答は復号ストリーム（`Cache-Control: private, no-store`、`Accept-Ranges: none`）。アクセスは `media.accessed` として audit に記録。
- 署名 URL 発行時の asset → Workspace 解決のみ system コンテキスト（ID のみ参照）で行い、以降はテナント RLS 内で処理します。

## 8. Transcript の取り込み・デスクトップ結果・編集

- `POST /transcript/import {format: srt|vtt|txt|json, content, language?}`: `Name: text`（全角コロン可）や VTT の `<v Name>` を話者ラベルとして使用（ファイルに書かれた名前であり声からの特定ではない。Person への紐付けは人間が行う）。`10:00` のような時刻は話者扱いしません。タイムスタンプの無い TXT 行は直前の時刻位置に置き `no_timestamp` フラグ（時刻を捏造しない）。同一内容の再取り込みは `created:false`。
- `POST /transcript/local`（デスクトップのローカル文字起こし結果）: `provider` はローカル ID（`local-sherpa` / `fixture`）のみ。音声はアップロードされません。話者ラベルが `mic`/`system`（`ch0`/`ch1`）だけならチャネル分離として扱い提案を付与。transcription_mode=`none` の Meeting は 409。
- `GET /transcript[?version=n]`, `GET /transcript/versions`。
- `PATCH /segments/:segmentId {text?, speakerId?, expectedRevision}`: revision 不一致は 409（`details.server` に最新セグメント）。`segment_revisions` に旧/新テキスト・話者を記録、tsv 更新、`index.meeting` を enqueue。人間の編集で `low_confidence` は外れ、`edited` が付く（`[inaudible]` が残る限り `inaudible` も残る）。
- `GET /segments/:segmentId/revisions`、`GET /meetings/:id/speakers`。

## 9. ログ・一時ファイル・セキュリティ

- transcript 本文・音声・プロンプトはログに出しません（ログは jobId / meetingId / 件数のみ。テストで検証）。ffmpeg の stderr はログに出さず、エラー時に最終行（160 文字）だけをジョブエラーに残します。
- ffmpeg / ffprobe は固定引数で `spawn`（シェル不使用）、タイムアウト付き。
- 一時ファイル（アップロード／復号原本／正規化 WAV／クラウド送信用 MP3）は `TMP_DIR` 配下の専用ディレクトリに作り、成功・失敗に関わらず削除します。復号原本は正規化後ただちに削除。
- ストレージは org ごとの導出鍵で AES-256-GCM 暗号化（`MLE1` ヘッダ）。

## 10. 他モジュール向けエクスポート（`modules/audio/index.ts`）

| 関数 | 用途 |
|---|---|
| `deleteMediaAsset(deps, db, asset)` | 元音声オブジェクト削除＋ `deleted_at`（data module の retention / delete-audio） |
| `retentionUntil(meeting, now)`, `isPlayable(meeting, asset)` | 保持期間の計算・再生可否 |
| `signFileUrl(cfg, clock, assetId, userId)` / `verifyFileSignature(...)` | 署名 URL（エクスポートのメディア同梱など） |
| `loadTranscriptDto(db, meetingId, version?)`, `listTranscriptVersions(db, meetingId)` | Transcript 取得（呼び出し側で Meeting ACL を確認すること） |
| `writeTranscriptVersion(db, w)`, `prepareTranscript(raw, opts)`, `afterTranscriptWritten(deps, db, meetingId, transcriptId)` | サンプルデータ投入・インポート等で transcript を冪等に作る |
| `parseTranscriptImport(format, content)` | SRT/VTT/TXT/JSON パーサ |
| `chooseTranscriptionProvider`, `enqueueAudioProcess`, `audioJobKey`, `AUDIO_PROCESS_JOB` | 処理の再キュー |

## 11. 設定（環境変数）

| 変数 | 既定 | 説明 |
|---|---|---|
| `MAX_UPLOAD_MB` | 1024 | アップロード上限 |
| `TMP_DIR` | ./.data/tmp | 一時ディレクトリ |
| `SIGNED_URL_TTL_SEC` | 300 | 署名 URL の有効期限 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | ffmpeg / ffprobe | |
| `LOCAL_ASR_MODEL_DIR` / `LOCAL_ASR_MODEL` | ./models / sense-voice | **絶対パス推奨**（相対パスはサーバーの cwd 基準） |
| `LOCAL_TRANSCRIPTION_PROVIDER` | （未設定 = local-sherpa） | `fixture` で決定的 fixture Provider（テスト/デモ/E2E 用）。config.ts ではなく audio module が直接読む |
| `LOCAL_ASR_NUM_THREADS` | min(4, CPU数) | ローカル ASR のスレッド数 |
| `LOCAL_ASR_DIARIZATION` | auto | `auto`（話者分離モデルがあれば実行）/ `on` / `off` |
| `CLOUD_TRANSCRIPTION_PROVIDER` 他 | | [TRANSCRIPTION.md](./TRANSCRIPTION.md) 参照 |

## 12. 既知の制約

- 再生は全体ストリーム（Range 非対応）。長い音声のシークはブラウザ側バッファに依存します。
- クラウド送信はファイル 1 回分のみ（OpenAI 25MB 上限。超える場合 32kbps MP3 に圧縮、なお超えるなら恒久エラー。分割送信は話者ラベルが分割間で一致しないため未実装）。
- チャネル分離はエネルギー比較のヒューリスティック。スピーカー出力をマイクが拾う環境（ヘッドホン無し）では誤判定し得ます。
- ローカル ASR はサーバープロセス内で実行（VAD は定期的にイベントループへ譲り、認識・話者分離はネイティブ非同期 API）。大量同時処理時は `WORKER_CONCURRENCY` で制御してください。
