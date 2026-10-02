# 文字起こし（Transcription）と話者分離

対象: `apps/server/src/providers/transcription/**`, `apps/server/src/providers/diarization/**`, `packages/local-asr/**`, `scripts/download-models.sh`
パイプライン全体は [AUDIO_PIPELINE.md](./AUDIO_PIPELINE.md)。確認日: 2026-10-02。

## 1. Provider 一覧（何がどこへ送られるか）

| ID | 種別 | 実行場所 | 外部へ送るもの | 話者分離 | 使われる条件 |
|---|---|---|---|---|---|
| `local-sherpa` | Local | このサーバー（またはデスクトップアプリ）内 | **なし**（ネットワーク呼び出しゼロ） | ローカル（pyannote seg-3.0 + CAM++）またはチャネル分離 | transcription_mode=`local`（既定） |
| `fixture` | Local | このサーバー内 | なし | fixture に含まれる話者 | `LOCAL_TRANSCRIPTION_PROVIDER=fixture`（テスト・デモ・E2E） |
| `openai` | Cloud | OpenAI API（`OPENAI_BASE_URL`/audio/transcriptions） | 正規化済み 16kHz mono 音声（WAV。約25MB の上限を超える場合は 32kbps MP3 に再エンコード）、model / response_format / language | `*-diarize` モデルのみ（diarized_json） | transcription_mode=`cloud` かつ Workspace が cloudAllowed かつ `CLOUD_TRANSCRIPTION_PROVIDER=openai` かつ非 Confidential |
| `deepgram` | Cloud | Deepgram API（`/v1/listen`） | 同上（200MiB 超は MP3）、model / language クエリ | あり（`diarize=true`） | 同上で `CLOUD_TRANSCRIPTION_PROVIDER=deepgram` |

- 送らないもの: Meeting タイトル、参加者名、メモ、元ファイル名、元のコンテナ（映像トラックは除去済み）。
- クラウド呼び出しは **必ず** `deps.http.fetch({kind:'transcription', decision, meetingIds:[meetingId], ...})` 経由。`GuardedHttp` が送信直前に DB の Meeting を再確認し（`transcription_mode='cloud'` かつ非 Confidential でなければ `policy_denied`）、`external_calls` に **メタデータのみ**（host, provider, bytes_sent, status）を記録します。
- Local mode では `external_calls` は 0 件、FakeHttp の transcription 呼び出しも 0 件であることをテスト（#28）で検証しています。
- 同一入力（正規化 PCM の SHA-256）・同一 Provider の transcript が既にある場合は Provider を呼ばないため、再処理でクラウドへ再送されません。

## 2. クラウド Provider の詳細

### OpenAI
- エンドポイント: `POST {OPENAI_BASE_URL}/audio/transcriptions`（multipart）。認証 `Authorization: Bearer OPENAI_API_KEY`。
- モデルは `OPENAI_TRANSCRIBE_MODEL`（既定 `gpt-4o-transcribe-diarize`）で変更可能。
  - `*diariz*` → `response_format=diarized_json`, `chunking_strategy=auto`（話者ラベル `A`, `B`… → Speaker 1..N）
  - `whisper*` → `verbose_json`（segment タイムスタンプ、`exp(avg_logprob)` を信頼度に使用。Whisper 自身の無音判定 `no_speech_prob>0.6 && avg_logprob<-1` の区間は空 → `[inaudible]`）
  - その他（`gpt-4o-transcribe`, `gpt-transcribe` 等）→ `json`（タイムスタンプ無し：全体を 1 segment として保存）
- **重要（調査 A, 2026-10-02 時点）: OpenAI は whisper-1 / gpt-4o-transcribe / gpt-4o-mini-transcribe / gpt-4o-transcribe-diarize の提供終了を 2027-02-26 と告知**（2026-08-26 通知）。後継は gpt-transcribe / gpt-live-transcribe。**後継モデルで話者分離が使えるかは未確認**。モデル名は設定で差し替えられますが、後継モデルのレスポンス形式は未検証のため、切替前に `mapOpenAi` の対応確認が必要です。
- ファイル上限 25MB。正規化 WAV（約 1.9MB/分）が収まらない場合は 32kbps MP3（約 14MB/時）に圧縮。それでも超える場合は恒久エラー（Local を使うよう案内）。分割送信は未対応（分割間で話者ラベルが一致しないため）。
- データ取扱い（調査 A）: API データは既定で学習に使われない、`/v1/audio/transcriptions` は ZDR 対象、日本データレジデンシーは要資格確認。契約前に公式で再確認してください。

### Deepgram
- `POST {DEEPGRAM_BASE_URL or https://api.deepgram.com/v1}/listen?model=nova-3&diarize=true&punctuate=true&smart_format=true&utterances=true&mip_opt_out=true&language=ja`
  - `language=auto` 時は `language=multi`。`mip_opt_out=true`（Model Improvement Program からのオプトアウト）を常に付与。
  - 認証 `Authorization: Token DEEPGRAM_API_KEY`、本文は音声バイナリ（`audio/wav` または `audio/mpeg`）。
- `DEEPGRAM_MODEL`（既定 nova-3）、`DEEPGRAM_BASE_URL`（EU エンドポイント等）は audio module が環境変数から直接読みます（config.ts 非変更）。
- `results.utterances` → segment（speaker `speaker_N`、confidence）。utterances が無い場合は words を話者ターンでまとめる。

### エラー
- HTTP 4xx（408/429 除く）は恒久エラー（再試行しない）、5xx/429/ネットワークは再試行。エラーメッセージに Provider の応答本文は含めません。

## 3. ローカル ASR（packages/local-asr）

Electron デスクトップアプリと共用の純 Node パッケージ。公開 API（安定）:

```ts
MODEL_CATALOG, getModelEntry(id), DEFAULT_ASR_MODEL ('sense-voice'), DIARIZATION_MODEL ('diarization')
checkModels(modelDir, modelId) → { ok, files, missing }          // ネットワーク不使用
downloadModel(id, modelDir, onProgress?, {signal, fetchImpl, tarPath}) // 明示的なユーザー操作でのみ呼ぶ
transcribeFile(wav16kMonoPath, { modelDir, model?, numThreads?, diarization?, language? })
  → { segments: [{startMs, endMs, text, confidence?, speaker?, lang?}], model, language, diarization: 'provider'|'none', durationMs, diarizationError? }
localAsrAvailable(modelDir, model?) / sherpaStatus() → { ok, reason? }
setSherpaModule(mod)   // Electron で asar.unpacked のアドオンを注入する場合
readWavFile / wavPcmSha256 / INAUDIBLE
```

- `sherpa-onnx-node`（1.13.8, Apache-2.0）は `createRequire` で **遅延ロード**。ネイティブバイナリが無い環境（例: win-arm64）でも import は成功し、`available()` が理由付きで false を返します。
- 処理: Silero VAD（threshold 0.5, 最小無音 0.5 秒, 最大発話 20 秒）で区間分割 → SenseVoice（`useInverseTextNormalization`=1、言語 ja/en/auto）で区間ごとに認識（ネイティブ `decodeAsync`）→ 任意で話者分離（ネイティブ `offlineSpeakerDiarizationProcessAsync`、クラスタ数未知・閾値 0.5）→ 最大重なりで話者を割当。
- 認識器はモデル・スレッド数・言語ごとにキャッシュ（初回のみロード 1〜2 秒）。
- 雑音対策: 文字を含まない結果、`event` が Speech 以外で 2 文字以下、**会議の主言語と異なる言語の 1 文字だけの結果**（実測: 雑音で `그.` が出力された）は `[inaudible]`。
- SenseVoice（sherpa-onnx 経由）は **トークン確率を返さない**（`ys_log_probs` が空）ため、ローカル結果の `confidence` は付きません（low_confidence フラグはクラウド/インポート由来のみ）。

### モデル（`MODEL_CATALOG`）

| ID | ファイル | 取得元（k2-fsa/sherpa-onnx GitHub Releases） | サイズ | SHA-256（固定・検証） |
|---|---|---|---|---|
| `sense-voice` | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/{model.int8.onnx,tokens.txt}` | asr-models/…-2024-07-17.tar.bz2 | 163,002,883 B | 7d1efa21…d347e |
| 〃 | `silero_vad.onnx` | asr-models/silero_vad.onnx | 643,854 B | 9e2449e1…b1fd6 |
| `diarization` | `sherpa-onnx-pyannote-segmentation-3-0/model.onnx` | speaker-segmentation-models/…-3-0.tar.bz2 | 6,958,444 B | 24615ee8…96488 |
| 〃 | `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` | speaker-recongition-models/（原文の綴り） | 28,281,164 B | aa3cfc16…ceba2 |

- ダウンロード: `bash scripts/download-models.sh [sense-voice] [diarization]`（既定は両方、保存先 `LOCAL_ASR_MODEL_DIR` または `<repo>/models`、gitignore 済み）。サイズと SHA-256 を検証してから展開（`tar -xjf`）。プロキシ環境では `NODE_USE_ENV_PROXY=1` を自動設定。
- サーバーもデスクトップも **自動ダウンロードはしません**（管理者/ユーザーの明示操作のみ）。

### ライセンス（表示義務あり）

| コンポーネント | ライセンス | 商用 | 注意 |
|---|---|---|---|
| SenseVoiceSmall 重み（iic/SenseVoiceSmall, Alibaba） | FunASR Model Open Source License v1.1 | 可（条件付き） | **§2.2 出典・作者・モデル名の表示が必須**（アプリの「ライセンス」画面に `SenseVoiceSmall © Alibaba Group (FunAudioLLM), FunASR Model License v1.1` を表示）。ライセンス改訂が自動発効するため定期確認 |
| Silero VAD | MIT（原文は未再確認） | 可 | |
| pyannote segmentation-3.0 | MIT (c) 2022 CNRS | 可 | 再配布時は LICENSE 同梱 |
| 3D-Speaker CAM++ zh_en | 3D-Speaker リポジトリは Apache-2.0、個別モデルカードは **未確認** | 要確認 | 販売前に法務確認 |
| sherpa-onnx | Apache-2.0 | 可 | |
| reverb-diarization-v1 | Non-Production License | **不可** | カタログに含めない |

`MODEL_CATALOG[].licenses[].attribution` に表示用文言を持たせています（デスクトップ/Web の About 画面で使用してください）。

## 4. 聞き取れない部分の扱い（共通ポリシー）

1. Provider が空・記号のみ・雑音判定を返した区間は `[inaudible]`（正確にこの文字列）＋ `inaudible` フラグ。
2. 低信頼度（< 0.35）は `low_confidence` フラグを付けるだけで **本文は変更しない**。
3. AI・ルールいずれでも穴埋め・推測補完をしない。要約/抽出側（ledger）も transcript をデータとして扱い、`[inaudible]` を埋めない前提。
4. 人間がセグメント編集で修正した場合のみ本文が変わり、`segment_revisions` に履歴が残る。

## 5. 話者分離の限界

- **ローカル話者分離（pyannote seg-3.0 + CAM++）の日本語会議での DER は公開値なし・未評価。** CAM++ は中国語/英語中心の学習データ。クラスタ閾値 0.5 は暫定値で、実会議音声での調整が必要。
- 同時発話（重なり）は 1 segment に 1 話者しか付けられません（最大重なりで割当）。
- 話者は匿名クラスタ（Speaker 1/2…）で、**声から実在人物を特定しない**（声紋登録・照合機能は持たない）。名前の割当は人間のみ。
- チャネル分離は「マイク＝自分」の仮定に基づく提案で、ヘッドホン無しで相手の声がマイクに回り込むと誤ります。提案は `suggestion` にのみ保存し、自動割当しません。
- クラウド: OpenAI は `*-diarize` モデルのみ。Deepgram は `diarize=true`。いずれも日本語会議での精度は未検証。

## 6. 実測結果（2026-10-02, このリポジトリの環境で実行）

環境: Intel Xeon @ 2.10GHz 4 vCPU / 15GB RAM / Linux x64 / Node 22.22 / sherpa-onnx-node 1.13.8（onnxruntime 1.28.2）。モデル同梱のテスト音声（**クリーンな朗読音声であり、実際の会議音声の精度を代表しません**）。

| 入力 | 結果（そのまま転記） | 備考 |
|---|---|---|
| `test_wavs/ja.wav`（7.2 秒） | `うちの中学は弁当制で持っていきない場合は五十円の学校販売のパンを買う。` | 「持っていけない」が「持っていきない」に誤認識。約 2.1 秒（初回モデルロード込み） |
| `test_wavs/en.wav`（7.15 秒） | `The tribal chieftain called for the boy and presented him with 50 pieces of code.` | 末尾 "gold" → "code" の誤認識 |
| ja + 無音1.5秒 + en + 無音1.5秒 + ja（24.5 秒）＋話者分離 | 3 区間。ja/en/ja の文は上記とほぼ同じ（同じ ja 音声でも区間境界により「いけない」と正しく出る回もある）。話者: 1・3 区間目が同一クラスタ、2 区間目が別クラスタ | 処理 3.8 秒 |
| 上記を 10 回繰り返した 245.5 秒 | ASR のみ: 30 区間 / 29.4 秒（**RTF 0.12**）。話者分離込み: 52.7 秒（**RTF 0.21**）、2 クラスタ、30/30 区間で正しいクラスタ | 同一音声の繰り返しでも ja 12/20 回「いきない」、en 2/10 回「chief then … code」と揺れる |
| ピンクノイズ 4 秒（-26 dBFS 程度） | 区間 0（何も出力しない） | 単体認識器に直接雑音を入れると `그.` が出た → 言語不一致 1 文字は `[inaudible]` 扱いにする対策を実装 |
| サーバーパイプライン（m4a アップロード → audio.process） | 上記 3 区間を Speaker 1 / 2 / 1 で保存、外部呼び出し 0 件 | 約 9.3 秒（コールドスタート、デコード・話者分離込み） |
| 2ch 音源（左 = ja, 右 = en）、話者分離 off | ja → Speaker 1（提案「あなた（マイク）」）、en → Speaker 2（提案「相手側（システム音声）」） | チャネル分離 |

評価: 短いクリーン音声でも 1 文に 1 語程度の誤りがあり、同じ音声でも VAD 区間の切れ目で結果が揺れます。**会議用途では「人間のレビュー前提の下書き」品質**と考えてください。日本語会議音声での CER/DER 評価セットによる計測は未実施（下記）。

再現手順:
```bash
bash scripts/download-models.sh
cd packages/local-asr && npx vitest run            # 実モデルでの ja/en/雑音/話者分離テスト（モデルが無ければ skip）
cd apps/server && npx vitest run test/audio-local   # サーバーパイプライン経由の実テスト
npx tsx packages/local-asr/src/cli.ts transcribe <16k-mono.wav> --dir models --diarization
```

## 7. fixture Provider（テスト・デモ・E2E）

- `LOCAL_TRANSCRIPTION_PROVIDER=fixture` で Local mode の Provider が `fixture` になります（ネットワーク・モデル不要、決定的）。
- 検索順: (1) `registerFixtureTranscript(sha256, transcript)` で登録したもの（テスト）、(2) `<LOCAL_ASR_MODEL_DIR>/../fixtures/transcripts/<sha256>.json`、(3) `'*'` で登録した既定値。見つからなければ恒久エラー（テキストを捏造しない）。
- キー `sha256` は **正規化後 PCM の SHA-256**（`wavPcmSha256`、WAV ヘッダ・メタデータを除く）。テストでは `test/audio-helpers.ts` の `normalizedPcmSha(file)` で計算できます。
- JSON 形式: `{ "language": "ja", "segments": [{ "startMs": 0, "endMs": 1500, "text": "…", "speaker": "A", "confidence": 0.9 }] }`

## 8. 未確認・未検証事項

- 日本語会議音声での SenseVoice CER・ローカル話者分離 DER（自社評価セット未整備）。
- OpenAI 後継モデル（gpt-transcribe）のレスポンス形式・話者分離対応、2027-02-26 以降の移行。
- Deepgram の日本語での `nova-3` 単一言語価格適用・話者分離アドオン条件（調査 A の未確認事項）。実 API への疎通は行っていません（テストは FakeHttp のみ）。
- 3D-Speaker CAM++ 個別モデルのライセンス原文、Silero VAD ライセンス原文。
- Windows / macOS / Electron での sherpa-onnx-node 動作と、Windows 標準 `tar.exe` による `.tar.bz2` 展開（Linux x64 でのみ実行確認）。
