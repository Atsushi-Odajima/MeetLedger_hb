# B. ローカルASR・話者分離・音声キャプチャ調査（MeetLedger）

- 調査日 / 確認日: **2026-10-02**（本書の全事実の確認日。各項目末尾に出典URLを併記）
- 調査方法の注記: 本調査環境のエグレスプロキシにより `huggingface.co` / `developer.chrome.com` / `developer.mozilla.org` / `webkit.org` / `learn.microsoft.com` / `electronjs.org` / `tauri.app` / `k2-fsa.github.io` / `modelscope.cn` / `ngc.nvidia.com` への直接アクセスが遮断された。代替として (a) 同じ公式ドキュメントの GitHub ソース（raw.githubusercontent.com / git clone）、(b) npm / PyPI / crates.io インデックス、(c) MDN browser-compat-data（npm `@mdn/browser-compat-data@8.1.4`, データ timestamp 2026-10-01）、(d) 公式URLを指す Web 検索結果スニペット を用いた。(d) に依拠した事実は **［検索経由］** と明記（本文未取得のため、実装前に原文確認を推奨）。
- 「未確認」= 公式一次情報で確認できなかった事項。

---

## 1. ローカル文字起こし（ASR）

### 1.1 whisper.cpp
| 項目 | 内容 | 出典（確認日 2026-10-02） |
|---|---|---|
| ライセンス | MIT | https://github.com/ggml-org/whisper.cpp |
| 最新版 | **v1.9.4**（タグコミット 2026-09-10、GitHub表示 9/11）。Windows on Arm CUDA 更新、ggml 0.23.0 同期等 | https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.4 |
| 対応OS | macOS(Intel/Arm), iOS, Android, Linux, Windows(MSVC/MinGW), WebAssembly 等 | https://github.com/ggml-org/whisper.cpp |
| GPU/高速化 | Metal, CUDA, Vulkan, Core ML(ANE), OpenVINO, ROCm 等。量子化対応。Silero-VAD 内蔵 | https://github.com/ggml-org/whisper.cpp |
| 日本語 | `.en` 以外のモデルは多言語（日本語含む） | https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/models/README.md |
| 話者分離 | tinydiarize（実験的、`small.en-tdrz` 英語モデルのみ）→ 日本語会議には使えない | https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/README.md |
| モデル取得先 | `models/download-ggml-model.sh` / https://huggingface.co/ggerganov/whisper.cpp/tree/main | https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/models/README.md |

モデルサイズ・メモリ（whisper.cpp 公式表）— 出典: https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/README.md , models/README.md（確認日 2026-10-02）

| モデル | Disk | RAM(目安) |
|---|---|---|
| tiny | 75 MiB | ~273 MB |
| base | 142 MiB | ~388 MB |
| small | 466 MiB | ~852 MB |
| medium | 1.5 GiB | ~2.1 GB |
| large(v1/v2/v3) | 2.9 GiB | ~3.9 GB |
| large-v3-q5_0 | 1.1 GiB | 未確認 |
| large-v3-turbo | 1.5 GiB | 未確認 |
| large-v3-turbo-q5_0 | 547 MiB | 未確認 |

速度メモ: 13分の音声・small・CPU(i7-12700K 8スレッド)で whisper.cpp fp32 = 2m05s / RAM 1049MB、OpenVINO版 1m45s。large-v2・GPU(RTX 3070 Ti)で whisper.cpp(Flash Attention) fp16 = 1m05s / VRAM 4127MB（faster-whisper README のベンチ、whisper.cpp v1.7.2 時点）— 出典: https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/README.md（確認日 2026-10-02）

### 1.2 OpenAI Whisper（重み）
- 「Whisper's code and model weights are released under the MIT License」— 出典: https://raw.githubusercontent.com/openai/whisper/main/README.md（確認日 2026-10-02）
- パラメータ/VRAM: tiny 39M ~1GB / base 74M ~1GB / small 244M ~2GB / medium 769M ~5GB / large 1550M ~10GB / turbo 809M ~6GB（相対速度 ~8x）。turbo は翻訳タスク非対応 — 同上（確認日 2026-10-02）

### 1.3 faster-whisper
- ライセンス MIT、最新 PyPI 1.2.1（2025-10-31）。CTranslate2 ベース。最新 ctranslate2 は CUDA 12 / cuDNN 9 のみ — 出典: https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/README.md , https://pypi.org/pypi/faster-whisper/json（確認日 2026-10-02）
- ベンチ（13分音声）: small・CPU int8 1m42s / RAM 1477MB、large-v2・GPU int8 59s / VRAM 2926MB、batch_size=8 で 16s — 同上
- モデルは HF Hub（Systran）から自動DL。**Python 依存のためデスクトップ同梱には不向き**（Node/Electron から使うには別プロセス化が必要：設計判断）。

### 1.4 sherpa-onnx（k2-fsa）
| 項目 | 内容 | 出典（確認日 2026-10-02） |
|---|---|---|
| ライセンス | Apache-2.0（コード） | https://github.com/k2-fsa/sherpa-onnx , npm メタデータ |
| 最新版 | **1.13.8**（npm 公開 2026-09-10） | https://registry.npmjs.org/sherpa-onnx-node |
| 機能 | オフライン/ストリーミングASR、VAD、話者分離、話者識別、句読点付与、言語識別、TTS 等 | https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/README.md |
| バインディング | C/C++/Python/JavaScript/Java/C#/Kotlin/Swift/Go/Dart/Rust/Pascal、WASM | 同上 |
| Rust crate | crates.io `sherpa-onnx` 1.13.8 が存在（Tauri から利用可能性あり） | https://index.crates.io/sh/er/sherpa-onnx |

**npm `sherpa-onnx-node`（node-addon-api ネイティブ addon・マルチスレッド対応, Node >= 16）のプリビルド** — 出典: https://registry.npmjs.org/sherpa-onnx-node と各プラットフォームパッケージ（確認日 2026-10-02）

| optionalDependency | os/cpu | v1.13.8 | unpacked size |
|---|---|---|---|
| sherpa-onnx-win-x64 | win32/x64 | あり | 23.5 MB |
| sherpa-onnx-win-ia32 | win32/ia32 | あり | 19.9 MB |
| sherpa-onnx-darwin-arm64 | darwin/arm64 | あり | 34.1 MB |
| sherpa-onnx-darwin-x64 | darwin/x64 | あり | 37.7 MB |
| sherpa-onnx-linux-x64 | linux/x64 | あり | 33.4 MB |
| sherpa-onnx-linux-arm64 | linux/arm64 | あり | 40.3 MB |
| sherpa-onnx-win-arm64 | — | **npm に存在しない（Not found）** | — |

- 注意: macOS/Linux では `DYLD_LIBRARY_PATH` / `LD_LIBRARY_PATH` にプラットフォームパッケージのパスを通す手順が README に記載 — 出典: https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/nodejs-addon-examples/README.md（確認日 2026-10-02）。Electron 同梱時のパス解決・ASAR unpack は要PoC（Electron 公式な動作保証記載は**未確認**）。
- 別パッケージ `sherpa-onnx`（WASM 版, 1.13.8）は「マルチスレッド非対応」— 同上 README。

**日本語/英語に使える sherpa-onnx 配布モデル（GitHub Releases、全URL HTTP 200 を確認）**

| モデル | 言語 | DL URL | サイズ(tar) | 元モデル / ライセンス |
|---|---|---|---|---|
| SenseVoice int8 2024-07-17 | zh/en/**ja**/ko/yue | https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2 | 163 MB | iic/SenseVoiceSmall / FunASR Model Open Source License v1.1（後述） |
| SenseVoice int8 2025-09-09 | 同上 | …/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2 | 166 MB | ASLP-lab/WSYue-ASR（広東語2.18万hで追加学習、句読点非対応）/ ライセンス**未確認** → 非推奨 |
| ReazonSpeech Zipformer 2024-08-01 | **ja のみ** | …/asr-models/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01.tar.bz2 | 713 MB（encoder int8 148MB/fp32 565MB） | reazon-research/reazonspeech-k2-v2 / Apache-2.0［検索経由］ |
| NeMo Parakeet TDT-CTC 0.6B ja int8 | **ja のみ**（句読点付き） | …/asr-models/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8.tar.bz2 | 489 MB（model.int8 625MB 展開後） | nvidia/parakeet-tdt_ctc-0.6b-ja / CC-BY-4.0［検索経由］ |
| Whisper turbo (ONNX) | 多言語 | …/asr-models/sherpa-onnx-whisper-turbo.tar.bz2 | 564 MB | OpenAI Whisper / MIT |
| Whisper small (ONNX) | 多言語 | …/asr-models/sherpa-onnx-whisper-small.tar.bz2 | 639 MB | OpenAI Whisper / MIT |
| Silero VAD | — | …/asr-models/silero_vad.onnx | 0.64 MB | silero-vad（MIT：ライセンス原文は本調査で**未確認**） |

出典: sherpa ドキュメントソース https://github.com/k2-fsa/sherpa （docs/source/onnx/sense-voice/pretrained.rst, pretrained_models/offline-transducer/zipformer-transducer-models.rst, pretrained_models/offline-ctc/nemo/japanese.rst, pretrained_models/whisper/export-onnx.rst）、サイズは各 URL の Content-Length（確認日 2026-10-02）。リリース一覧: https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models
- ReazonSpeech zipformer は「ReazonSpeech 3.5万時間で学習」「日本語のみ」、元モデル reazonspeech-k2-v2 は約30秒までのクリップ想定［検索経由: https://huggingface.co/reazon-research/reazonspeech-k2-v2］→ 長時間音声は VAD 分割必須。
- SenseVoiceSmall は非自己回帰で「Whisper-Small の5倍超、Whisper-Large の15倍高速」（公式ベンチ条件下）— 出典: https://raw.githubusercontent.com/FunAudioLLM/SenseVoice/main/README.md（確認日 2026-10-02）。日本語 CER の公式数値は**未確認**。

### 1.5 SenseVoice のライセンス（商用可否）
- リポジトリのコードは MIT。重みは各モデルカードに従い、公式 SenseVoiceSmall は **FunASR Model Open Source License Agreement v1.1**。公式見解（Issue #334）として「公式 SenseVoiceSmall 重みの商用利用はライセンス遵守を条件に許可、Section 3 は免責であり非商用制限ではない、§2.2 の出典・モデル名表示義務は適用」。第三者変換物は別途確認が必要 — 出典: https://raw.githubusercontent.com/FunAudioLLM/SenseVoice/main/README.md（確認日 2026-10-02）
- §2.2「使用・複製・改変・共有時は出典と作者情報を明示し、関連モデル名を保持すること」、§4.2 で中傷行為禁止（違反で自動失効）、§6 で改訂が自動発効 — 出典: https://raw.githubusercontent.com/modelscope/FunASR/main/MODEL_LICENSE（確認日 2026-10-02）
- → 商用可。ただし **アプリ内クレジット表示（FunASR/SenseVoiceSmall, Alibaba）必須**、ライセンス改訂の監視が必要。

### 1.6 Kotoba-Whisper（日本語特化）
- Whisper large-v3 の蒸留モデル。v1.0/v1.1/v2.0/v2.1 の学習スクリプトが公開、学習データは ReazonSpeech — 出典: https://raw.githubusercontent.com/kotoba-tech/kotoba-whisper/main/README.md（確認日 2026-10-02）
- kotoba-whisper-v2.0 のライセンス **Apache-2.0**［検索経由: https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0］。whisper.cpp 用 ggml 版 https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml 、faster-whisper 用 https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-faster が存在［検索経由］。
- 速度・精度（「large-v3 比 6.3倍高速」等）は二次情報のみ → **未確認**。v2.1/v2.2 のライセンス・パイプライン詳細も**未確認**。

### 1.7 ReazonSpeech
- GitHub リポジトリ（reazon-research/ReazonSpeech）のコードは Apache-2.0 — 出典: https://raw.githubusercontent.com/reazon-research/ReazonSpeech/master/LICENSE（確認日 2026-10-02）
- モデル reazonspeech-k2-v2 / reazonspeech-nemo-v2 は Apache-2.0［検索経由: https://huggingface.co/reazon-research/reazonspeech-k2-v2 , https://huggingface.co/reazon-research/reazonspeech-nemo-v2］
- コーパス（ReazonSpeech v2, TV放送由来）は CDLA-Sharing-1.0 かつ「著作権法30条の4の範囲に限定」との記載［検索経由、原文**未確認**］。モデル重み自体にこの制限が及ぶかは**未確認**（法務確認推奨）。

---

## 2. ローカル話者分離（Speaker Diarization）

### 2.1 sherpa-onnx の構成
- 構成 = セグメンテーション（pyannote 系 ONNX）＋ 話者埋め込み（3D-Speaker / NeMo / WeSpeaker）＋ クラスタリング（`numClusters` 既知なら指定、未知なら -1 と `threshold` 調整：「大きいほど話者数が少なくなる。自分で調整が必要」）— 出典: https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/nodejs-addon-examples/test_offline_speaker_diarization.js（確認日 2026-10-02）
- Node API `sherpa_onnx.OfflineSpeakerDiarization` あり（入力サンプルレートはモデルと一致必須）— 同上

### 2.2 モデル一覧・ライセンス・DL先
| 種別 | モデル | DL URL（HTTP 200確認） | サイズ | ライセンス | 出典（確認日 2026-10-02） |
|---|---|---|---|---|---|
| セグメンテーション | pyannote segmentation-3.0 | https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 | 7 MB（model.onnx 5.7M / int8 1.5M） | **MIT (c) 2022 CNRS**（tar 内 LICENSE を実ファイルで確認） | sherpa docs models.rst / 実DL |
| セグメンテーション | reverb-diarization-v1 | …/speaker-segmentation-models/sherpa-onnx-reverb-diarization-v1.tar.bz2 | 10.9 MB | **Rev Model Non-Production License（商用・SaaS 利用禁止）→ 使用不可** | tar 内 LICENSE §3.2 |
| 埋め込み | 3D-Speaker ERes2Net base (zh-cn) | https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx | 39.6 MB | 3D-Speaker リポジトリは Apache-2.0。ModelScope 個別モデルカードは**未確認** | https://raw.githubusercontent.com/modelscope/3D-Speaker/main/README.md |
| 埋め込み | 3D-Speaker CAM++ zh_en advanced | …/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx | 28.3 MB | 同上 | 同上 / scripts/3dspeaker/run.sh |
| 埋め込み | NeMo TitaNet small (en) | …/speaker-recongition-models/nemo_en_titanet_small.onnx | 40.3 MB | NGC: 「NeMo Toolkit のライセンスに従う」［検索経由］。TitaNet-Large(HF) は CC-BY-4.0［検索経由］。small の正確な条項は**未確認** | scripts/nemo/speaker-verification/README.md |
| 埋め込み | WeSpeaker ResNet34 (VoxCeleb) | …/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx | 26.5 MB | WeSpeaker コードは Apache-2.0、**事前学習モデルはデータセットのライセンスに従う（VoxCeleb = CC BY 4.0）** | https://raw.githubusercontent.com/wenet-e2e/wespeaker/master/docs/pretrained.md |

- リリースページ: https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models （"recongition" は原文の綴り）。同ページに「各モデルにはそれぞれのライセンスがあるので元リポジトリを参照」と記載 — 確認日 2026-10-02
- 精度上の注意:
  - segmentation-3.0 は 10秒窓・16kHz モノラル、1窓あたり最大3話者（重なり2人まで）の powerset 7クラス［検索経由: https://huggingface.co/pyannote/segmentation-3.0］。
  - 3D-Speaker ERes2Net base / CAM++ は中国語中心データで学習、TitaNet/WeSpeaker は英語中心。**日本語会議でのDER（話者分離誤り率）は公開値なし＝未確認**。自社評価セットでの閾値チューニング必須。
  - 参考: pyannote 公式ベンチ（2025-09更新）の DER は AMI(IHM) で legacy 3.1 = 18.8% / community-1 = 17.0%、AliMeeting で 24.5% / 20.3% — 出典: https://raw.githubusercontent.com/pyannote/pyannote-audio/main/README.md（確認日 2026-10-02）。sherpa-onnx の pyannote-seg-3.0 + 埋め込み構成の DER 公式値は**未確認**（クラスタリング実装が異なるため同値ではない）。

### 2.3 pyannote.audio 本体
- ライセンス MIT (c) 2020 CNRS、PyPI 最新 4.0.7（2026-06-30）— 出典: https://raw.githubusercontent.com/pyannote/pyannote-audio/main/LICENSE , https://pypi.org/pypi/pyannote.audio/json（確認日 2026-10-02）
- オープンパイプライン `speaker-diarization-community-1` は「HF でユーザー条件に同意 + アクセストークン作成」が必要（= gated）。有償 `precision-2` は pyannoteAI API キー、pyannoteAI サーバーで処理 — 出典: 同 README（確認日 2026-10-02）
- community-1 のライセンス CC-BY-4.0、gated（連絡先・用途入力）［検索経由: https://huggingface.co/pyannote/speaker-diarization-community-1］
- segmentation-3.0（HF）: MIT だが gated（連絡先共有に同意が必要）［検索経由: https://huggingface.co/pyannote/segmentation-3.0］。**sherpa-onnx の GitHub Releases 版は HF ゲートなしで取得可能**（MIT のため再配布可、LICENSE 同梱義務あり）。
- オプションのテレメトリ機能あり（利用モデル名等を送信）— 同 README。オフライン/プライバシー要件時は無効化を確認。

---

## 3. ブラウザでの音声キャプチャ（2026年10月時点）

### 3.1 API サポート（MDN browser-compat-data 8.1.4 / 2026-10-01 データ）
出典: https://registry.npmjs.org/@mdn/browser-compat-data （data.json, 確認日 2026-10-02）、対応する MDN ページ https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia

| API | Chrome | Edge | Firefox | Safari(mac) | iOS Safari | Chrome Android |
|---|---|---|---|---|---|---|
| getUserMedia | 53 | 12 | 36 | 11 | 11 | 53 |
| getDisplayMedia | 72 | 79 | 66 | 13 | **非対応** | **非対応** |
| getDisplayMedia の音声 | 74 | 79 | **非対応** | **非対応** | 非対応 | 非対応 |
| systemAudio オプション | 105 | 105 | × | × | × | — |
| windowAudio オプション | 141（"exclude"/"system"のみ、既定 system） | 141 | × | × | × | — |
| MediaRecorder | 47 | 79 | 25 | 14.1 | 14 | 47 |

- BCD の注記: 「Windows と ChromeOS では画面全体共有時にシステム音声全体を取得可能。Linux と macOS ではタブ音声のみ」（Chrome/Edge）— 同上。※macOS については下記 3.2 の通り Chrome 141 以降で状況が変わっており、BCD 注記は更新遅れの可能性。
- getDisplayMedia は transient user activation（クリック等）必須、Secure Context 必須。`systemAudio:"include"` は保証ではなくヒント — 出典: https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/mediadevices/getdisplaymedia/index.md（確認日 2026-10-02）

### 3.2 OS/ブラウザ別「システム音声」取得マトリクス
| 環境 | マイク | タブ音声 | システム音声（他アプリ=Zoom/Teams等の音） | 根拠 |
|---|---|---|---|---|
| Windows + Chrome/Edge | ○ | ○ | **○（画面全体共有時、ユーザーがチェック）**。Chrome/Edge 141+ はウィンドウ共有時もシステム音声選択可（windowAudio） | BCD |
| macOS + Chrome | ○ | ○ | **△ Chrome 141+ かつ macOS 14.2+ で対応とされる**（画面/ウィンドウ共有時）。Chromium ソース上、CoreAudio Tap は macOS ≥14.2 で有効、旧 SCK 経路は macOS 15.0 以降無効 | ［検索経由］addpipe 検証記事 + Chromium `media/base/media_switches.cc`（raw.githubusercontent.com/chromium/chromium/main）。Google 公式ドキュメントでの明記は**未確認**、BCD は未反映 |
| macOS + Edge | ○ | ○ | 未確認（Chromium 準拠の可能性） | — |
| Linux + Chrome | ○ | ○ | **×（タブのみ）**。Chromium 内部には PulseAudio ループバック実装があるが getDisplayMedia での提供は未確認 | BCD / media_switches.cc |
| Firefox（全OS） | ○ | × | × | BCD |
| Safari macOS | ○ | × | × | BCD |
| iOS Safari / iOS PWA | ○ | ×（getDisplayMedia 自体なし） | × | BCD |
| Android Chrome / PWA | ○ | ×（getDisplayMedia なし） | × | BCD |

結論: **Web/PWA 単体で「相手側の声（会議アプリの出力音）」を確実に取れるのは Windows の Chrome/Edge のみ**。macOS Chrome は 141+/14.2+ で可能性あり（PoC 必須）。iOS/Android/Safari/Firefox はマイクのみ → 対面会議・スピーカー出力をマイクで拾う運用、またはデスクトップコンパニオンが必要。

### 3.3 MediaRecorder の MIME
- Chromium: `audio/webm`（opus, pcm）と `audio/mp4`（opus, mp4a.40.2）を受理 — 出典: https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/mediarecorder/media_recorder_handler.cc（確認日 2026-10-02）。Chrome 126 で MP4 マルチプレクス対応［検索経由: https://developer.chrome.google.cn/release-notes/126］
- Safari: 14.1 で MediaRecorder 対応、MP4（H.264/AAC）＝ `audio/mp4` が基本［検索経由: https://webkit.org/blog/11353/mediarecorder-api/］。**Safari 18.4 で WebM（Opus + VP8/VP9）生成に対応**、fragmented MP4、ALAC/PCM も追加［検索経由: https://webkit.org/blog/16574/webkit-features-in-safari-18-4/］
- 実装方針: `MediaRecorder.isTypeSupported()` で `audio/webm;codecs=opus` → `audio/mp4` の順にフォールバック（MDN が各ブラウザでリストが異なる旨を明記）。

### 3.4 iOS PWA のバックグラウンド録音制約
- WebKit Bug 226620: getUserMedia のマイクは Safari が前面表示中のみ有効、バックグラウンドへ移ると音声が途絶える［検索経由: https://bugs.webkit.org/show_bug.cgi?id=226620］
- Home Screen PWA で約90秒後に再度 getUserMedia を呼ぶと権限プロンプトが再表示される等の報告［検索経由、一次情報**未確認**］
- Screen Wake Lock: iOS 16.4–18.3 はホーム画面 Web アプリで動作せず、**iOS 18.4 で修正** — 出典: BCD `api.WakeLock`（webkit.org/b/254545 参照）（確認日 2026-10-02）
- Apple による「PWA でのバックグラウンド録音可否」の公式明文は**未確認**。設計上は「iOS では画面ON・前面維持（Wake Lock）を前提、長時間録音はネイティブアプリ推奨」とする。

---

## 4. デスクトップコンパニオンのシステム音声取得

### 4.1 Electron
- 最新安定版 **Electron 44.5.1**（2026-09-30）。44.0.0 は 2026-08-25、45 は alpha — 出典: https://registry.npmjs.org/electron（確認日 2026-10-02）
- 方式: main で `session.setDisplayMediaRequestHandler((req, cb) => cb({ video: source, audio: 'loopback' }))`、renderer で `getDisplayMedia({audio:true, video:true})` — 出典: https://raw.githubusercontent.com/electron/electron/main/docs/api/desktop-capturer.md（確認日 2026-10-02）
- `audio: 'loopback' | 'loopbackWithMute'` は「システム音声を取得、**現在 Windows のみサポート**」と session.md に記載 — 出典: https://raw.githubusercontent.com/electron/electron/main/docs/api/session.md（確認日 2026-10-02）
- 一方 desktop-capturer.md（44-x-y ブランチ）: **macOS 14.2+ では Info.plist に `NSAudioCaptureUsageDescription` が必須**。Electron v39.0.0-beta.4 以降 Chromium は **CoreAudio Tap API を既定**で使用し、旧「Screen & System Audio Recording」方式へのフォールバックなし（44 では `--disable-features=MacCatapLoopbackAudioForScreenShare` で旧方式に戻せるが、**main ブランチ記載では Electron 45 でこのフラグは削除**）。権限欠如時は `ended` 状態の無音トラックが返りエラーは出ない — 出典: https://raw.githubusercontent.com/electron/electron/44-x-y/docs/api/desktop-capturer.md , main 版（確認日 2026-10-02）
- macOS 12.7.6 以前はシステム音声取得不可（BlackHole 等の仮想デバイスが必要）。Linux(PipeWire) は getSources が単一ソースのみ — 同上
- `useSystemPicker`（macOS 15+、実験的）— session.md
- 既知の不具合報告: Electron 43.3.0 / macOS 26.5.2 で `useSystemPicker:false`（独自ピッカー）時に loopback 音声トラックが即 `ended` になる（Issue #52738、2026-08-09 起票、Open）— 出典: https://github.com/electron/electron/issues/52738（確認日 2026-10-02）
- **ドキュメント間で macOS loopback の記述が矛盾**しているため、macOS 14.2 / 15 / 26 で PoC 必須。

### 4.2 Tauri v2（組み込みなし → Rust で自前実装）
- 最新 Tauri 2.12.1（@tauri-apps/cli・api、2026-09-30）— 出典: https://registry.npmjs.org/@tauri-apps/cli（確認日 2026-10-02）
- **Windows**: `cpal`（Apache-2.0, 最新 0.18.2 / 2026-08-16）は出力(render)デバイスに入力ストリームを張ると `AUDCLNT_STREAMFLAGS_LOOPBACK` を付与 = WASAPI ループバック — 出典: https://raw.githubusercontent.com/RustAudio/cpal/master/src/host/wasapi/device.rs , CHANGELOG.md（確認日 2026-10-02）
- **macOS**: cpal 0.17.0（2025-12-20）で CoreAudio ループバック録音対応、README の最小要件は「macOS 14.2（ループバック録音は 14.6+）」— 出典: https://raw.githubusercontent.com/RustAudio/cpal/master/README.md（確認日 2026-10-02）。代替: `screencapturekit` crate 11.0.0（MIT OR Apache-2.0、システム音声は macOS 13.0+、マイクは 15.0+）— 出典: https://raw.githubusercontent.com/doom-fish/screencapturekit-rs/main/README.md , Cargo.toml（確認日 2026-10-02）
- **Linux**: PulseAudio/PipeWire のモニターソース経由（cpal は PipeWire 0.3.53+/PulseAudio バックエンドあり）。モニター取得の具体手順は**未確認**。

### 4.3 macOS / Windows の OS API と権限
- Core Audio Tap: `AudioHardwareCreateProcessTap` は **macOS 14.2+**。初回録音時に「システムオーディオ録音」許可プロンプト。`NSAudioCaptureUsageDescription`（macOS 14.2+）に用途文言 — 出典: https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps , https://developer.apple.com/documentation/bundleresources/information-property-list/nsaudiocaptureusagedescription（JSON版で確認, 2026-10-02）
- ScreenCaptureKit: `SCStreamConfiguration.capturesAudio` は macOS 13.0+、`captureMicrophone` は macOS 15.0+ — 出典: https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio（確認日 2026-10-02）
- macOS Sequoia(15) 以降のプライバシー設定名は「画面とシステムオーディオ収録（Screen & System Audio Recording）」で、アプリごとに「画面と音声」または「**システムオーディオ収録のみ**」を許可可能［検索経由: https://support.apple.com/guide/mac-help/mchl2844ecab/mac , https://support.apple.com/guide/mac-help/mchld6aa7d23/mac］。画面収録許可の定期再確認（月次）が報告されている［検索経由、Apple 一次情報**未確認**］。
- マイク: `NSMicrophoneUsageDescription` 必須、macOS 10.14+ で同意必要、画面は 10.15+ — 出典: https://raw.githubusercontent.com/electron/electron/main/docs/api/system-preferences.md（確認日 2026-10-02）
- Windows WASAPI ループバック: render エンドポイントに `AUDCLNT_STREAMFLAGS_LOOPBACK` で共有モードのキャプチャを開く（排他モード不可）。Win10 1703+ はイベント駆動ループバック対応 — 出典: https://raw.githubusercontent.com/MicrosoftDocs/win32/docs/desktop-src/CoreAudio/loopback-recording.md（確認日 2026-10-02）。プロセス単位ループバック（`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`）は Windows 10 Build 20348+ — 出典: https://raw.githubusercontent.com/MicrosoftDocs/sdk-api/docs/sdk-api-src/content/audioclientactivationparams/ne-audioclientactivationparams-audioclient_activation_type.md（確認日 2026-10-02）。ループバックに OS の追加許可ダイアログは不要（Windows 側の明文は**未確認**、マイクはプライバシー設定で全体制御 — Electron system-preferences.md）。

### 4.4 Electron vs Tauri 比較
| 観点 | Electron 44 | Tauri 2.12 |
|---|---|---|
| バンドルサイズ | ランタイム zip だけで darwin-arm64 130MB / win32-x64 158MB（v44.5.1 リリース資産の Content-Length） | 最小アプリ 600KB 未満（OS の WebView 利用）— tauri-docs `start/index.mdx` |
| システム音声の実装工数 | **小**: getDisplayMedia + `audio:'loopback'`（Windows 公式、macOS 14.2+ は CoreAudio Tap 既定・Info.plist キー必須、ただし文書矛盾/既知Issueあり） | **中〜大**: Rust で cpal(WASAPI loopback / macOS 14.6+ tap) または screencapturekit を実装し、PCM を IPC で受け渡し |
| ローカルASR統合 | sherpa-onnx-node（N-API プリビルド: win-x64/ia32, mac-arm64/x64, linux-x64/arm64）を main/utility process で直接利用 | Rust crate `sherpa-onnx` 1.13.8 / whisper-rs 0.16.0 等、またはサイドカー |
| macOS 署名・公証 | Developer ID 署名＋notarization 必要（@electron/osx-sign / @electron/notarize）、macOS の autoUpdater は署名必須（Squirrel.Mac の要件） | 署名＋notarization 必要（Developer ID 利用時は公証必須、有料 Apple Developer $99/年）— tauri-docs `distribute/Sign/macos.mdx` |
| Windows 署名 | SmartScreen 対策に推奨（EV でも即時評価付与なし：2024〜） | 同左（Tauri docs に明記）— `distribute/Sign/windows.mdx` |
| 自動更新 | 組込 `autoUpdater`（macOS: Squirrel.Mac、Windows: Squirrel.Windows/MSIX）、**Linux 組込なし** — electron docs `api/auto-updater.md` | `tauri-plugin-updater`（Linux/Windows/macOS、署名検証必須で無効化不可）— plugins-workspace README / tauri-docs `plugin/updater.mdx` |
| WebView 差異 | 全OSで同一 Chromium（PWA と同じ録音コードを流用可） | Windows=WebView2, macOS=WKWebView, Linux=WebKitGTK（getDisplayMedia 挙動が OS 依存→音声は Rust 側で取る前提） |

出典URL（確認日 2026-10-02）: https://github.com/electron/electron/releases/tag/v44.5.1 , https://raw.githubusercontent.com/electron/electron/main/docs/api/auto-updater.md , https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/code-signing.md , https://github.com/tauri-apps/tauri-docs , https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/updater/README.md

**推奨**: MVP は **Electron**。理由: (1) Windows のシステム音声が公式 API で数行、macOS も 14.2+ で Chromium の CoreAudio Tap 経路が既定、(2) sherpa-onnx-node のプリビルドが主要4ターゲット（win-x64 / mac-arm64 / mac-x64 / linux-x64）に揃う、(3) Web/PWA と録音・UI コードを共有できる。サイズ（~130–160MB + モデル数百MB）は会議録アプリでは許容範囲。リスクは macOS loopback の文書矛盾と Issue #52738 → macOS 14.2/15/26 実機 PoC を最初のスプリントで実施し、失敗時は Rust/Swift の CoreAudio Tap ネイティブモジュール（または Tauri + cpal）へ切替。

---

## 5. PWA 機能（iOS/Android, 2026）

| 機能 | 状況 | 出典（確認日 2026-10-02） |
|---|---|---|
| Web Push（iOS） | iOS/iPadOS **16.4+、ホーム画面に追加した Web アプリのみ**（BCD: safari_ios 16.4 注記 "supported in web apps saved to the home screen"）。macOS Safari は 16（Ventura 以降） | BCD `api.PushManager`、［検索経由］https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ |
| Declarative Web Push | WebKit が発表（対応 Safari バージョンは本調査では**未確認**） | ［検索経由］https://webkit.org/blog/16535/meet-declarative-web-push/ |
| インストール促進 | `beforeinstallprompt` は Chromium（Chrome 44/61, Edge 79）のみ。Firefox/Safari/iOS 非対応 | BCD `api.Window.beforeinstallprompt_event` |
| iOS 26 のホーム画面追加 | iOS/iPadOS 26 では**どのサイトもホーム画面追加で既定 Web アプリとして起動**（manifest 不要、ユーザーが「Webアプリとして開く」をオフ可） | ［検索経由］https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/ |
| Safari の7日間削除 | トラッキング防止有効時、**ユーザー操作のない7日間（Safari 使用日数）**でスクリプト作成データ（IndexedDB 等）を削除。サーバー設定 Cookie は除外 | https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/storage_api/storage_quotas_and_eviction_criteria/index.md |
| ホーム画面アプリと7日ルール | 「ホーム画面に追加した Web アプリは Safari の一部ではなく独自の日数カウンタを持つ」 | ［検索経由］https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ |
| クォータ（Safari 17 / macOS 14 / iOS 17+） | ブラウザアプリ: オリジンあたり総ディスクの約60%、全体80%。WKWebView 埋め込み: 約15%/20%。ホーム画面 Web アプリはブラウザと同じ約60%。旧版は初期1GiB | MDN 同上 / ［検索経由］https://webkit.org/blog/14403/updates-to-storage-policy/ |
| persist() | Chrome 55 / Firefox 57 / Safari・iOS 15.2。WebKit はホーム画面 Web アプリ等のヒューリスティックで許可。Chromium/Safari はプロンプトなし自動判定、Firefox はプロンプト | BCD `api.StorageManager.persist`、MDN 同上 |
| estimate() | Chrome 61 / Firefox 57 / Safari・iOS 17 | BCD `api.StorageManager.estimate` |
| Chromium のクォータ | オリジンあたり総ディスクの最大60% | MDN 同上 |
| Background Sync | `SyncManager` は Chrome/Edge/Chrome Android 49+ のみ。Firefox・Safari・iOS 非対応（webkit.org/b/182565） | BCD `api.SyncManager` |
| Periodic Sync / Background Fetch | Chromium のみ（80+ / 74+）、実験的 | BCD |
| オフライン IndexedDB | 全主要ブラウザで利用可。ただし Safari の7日ルール・ストレージ逼迫時の best-effort 削除に注意（persist() 要求推奨） | MDN 同上 |

**設計への示唆**: 録音チャンクは IndexedDB に逐次保存し、iOS では Background Sync が無いため「アプリ前面復帰時に再送」ロジックを必須化。iOS ユーザーにはホーム画面追加を促し、persist() を要求する。

---

## 6. 推奨ローカルスタック（暫定）

1. ランタイム: **sherpa-onnx-node 1.13.8**（Apache-2.0）を Electron の utility process で実行。VAD = silero_vad.onnx。
2. ASR（日本語主体）: **SenseVoice int8 2024-07-17**（軽量 163MB、ja/en 混在可、FunASR Model License v1.1・クレジット表示必須）を標準。日本語高精度モードは **ReazonSpeech zipformer 2024-08-01（Apache-2.0）** または **Parakeet TDT-CTC 0.6B ja（CC-BY-4.0, 句読点付き）**。英語/多言語は **Whisper turbo（MIT）**（sherpa ONNX 版 or whisper.cpp `large-v3-turbo-q5_0` 547MiB + Metal/CUDA）。
3. 話者分離: **pyannote segmentation-3.0 ONNX（MIT）＋ 3D-Speaker CAM++ zh_en advanced または WeSpeaker ResNet34（CC BY 4.0）**。reverb-diarization-v1 は非商用ライセンスのため**採用不可**。
4. 精度・速度の日本語ベンチマークは公式値がほぼ無い → 自社評価セット（会議音声 ja/en、2〜8人）で CER/DER と RTF を計測してから既定モデルを確定。

## 7. 未確認事項まとめ
- Google 公式ドキュメントにおける「Chrome 141+ macOS 14.2+ でシステム音声共有」の明記（Chromium ソースと第三者検証のみ確認）、macOS Edge の挙動
- Electron の macOS `audio:'loopback'` 正式サポート範囲（session.md「Windows のみ」と desktop-capturer.md の記述が矛盾）
- sherpa-onnx-node の Windows arm64 プリビルド（存在しない）・Electron での公式動作保証
- 3D-Speaker 個別 ModelScope モデルカードのライセンス、NeMo titanet_small の正確なライセンス条項、silero_vad のライセンス原文
- SenseVoice 2025-09-09（WSYue）版のライセンス
- Kotoba-Whisper v2.1/v2.2 のライセンス・ベンチ値、ReazonSpeech コーパスの「30条の4」制限のモデルへの波及
- 日本語会議での各話者分離構成の DER、各 ASR の日本語 CER/RTF（同一条件比較）
- iOS PWA のバックグラウンド録音に関する Apple 公式の明文
- Linux でのシステム音声（Chrome/Electron/Tauri いずれも）具体手順
