# MeetLedger Desktop（デスクトップコンパニオン）設計・運用ガイド

- 対象: `apps/desktop`（Windows / macOS 向け Electron アプリ。Linux は開発・検証用）
- 作成日: 2026-10-02 ／ Electron **44.5.1**（Chromium 152.0.7977.130 / Node 24.21.0）
- 前提資料: `docs/research/B_local_asr_audio_capture.md`（§4 システム音声、§1.4 sherpa-onnx）、`docs/API_CONTRACT.md`（audio / consent / start / end）
- 「未検証」= このリポジトリの Linux コンテナでは確認できず、実機での確認が必要な項目（§10 に手順）

---

## 1. 目的と範囲

Web/PWA だけでは取得できない **オンライン会議の相手の声（システム音声）** を取得し、必要に応じて **音声を端末外に出さずに文字起こし** するためのコンパニオンアプリ。

| 機能 | 内容 |
|---|---|
| Web アプリ表示 | 設定したサーバーURL（1オリジンのみ）の MeetLedger Web アプリを表示。ログインは Web アプリで行う |
| デスクトップ録音 | マイク → 左ch、システム音声 → 右ch のステレオで記録（WebAudio ChannelMerger） |
| 同意ステップ | サーバーの consent API で通知/同意を記録してからでないと録音を準備できない（サーバー側 `/start` も 409 `consent_required` で再検証） |
| 常時表示インジケーター | 録音中は録音ウィンドウ最前面・最小化不可、全ウィンドウタイトルに「● 録音中」、トレイ赤アイコン、Windows タスクバーオーバーレイ、macOS Dock バッジ |
| 端末内文字起こし | 16 kHz mono WAV を utility process 内の `@meetledger/local-asr`（sherpa-onnx / SenseVoice）で認識し、**テキストのみ** `POST /transcript/local` |
| サーバー処理 | 録音した opus/webm（ステレオ）を `POST /media` |

## 2. Electron vs Tauri 比較と判断

| 観点 | Electron 44.5.1 | Tauri 2.12.1 |
|---|---|---|
| システム音声取得 | `session.setDisplayMediaRequestHandler` で `audio: 'loopback'`。Windows は公式サポート（WASAPI loopback）。macOS 14.2+ は Chromium の Core Audio Tap 経路が既定（ただし公式文書間で矛盾・Issue #52738 未解決） | 組込なし。Rust で cpal（WASAPI loopback / macOS 14.6+ tap）や screencapturekit を実装し、PCM を IPC で渡す必要 |
| ローカルASR | `sherpa-onnx-node`（N-API、win-x64/ia32・mac-arm64/x64・linux-x64/arm64 のプリビルド）を utility process で直接利用 | crate `sherpa-onnx` 1.13.8 / whisper-rs、またはサイドカー |
| WebView | 全OSで同一 Chromium → Web/PWA と同じ録音・WebAudio コードが同じ挙動 | WebView2 / WKWebView / WebKitGTK で getDisplayMedia・MediaRecorder の挙動が OS 依存 |
| サイズ | 大（Electron ランタイム zip で 130–160 MB。今回の Linux AppImage は 130 MB） | 小（最小 600 KB 未満） |
| 署名・公証 | Developer ID 署名 + notarization（electron-builder 統合）、Windows は Authenticode | 同等に必要 |
| 自動更新 | 組込 `autoUpdater`（macOS/Windows、Linux なし） | `tauri-plugin-updater`（全OS、署名必須） |
| セキュリティ面 | Node を持つ main プロセスがある分、設定ミスの影響が大きい → 本実装は contextIsolation/sandbox/fuses で対策 | Rust コア＋ capability ベースで攻撃面は小さい |

**判断: Electron を採用。** 理由: (1) Windows のシステム音声が公式APIで数行で実現でき、macOS も Chromium 既定の Core Audio Tap 経路に乗れる、(2) sherpa-onnx-node のプリビルドが主要ターゲットに揃い、実際にこのコンテナで Electron の utility process から日本語認識まで動作確認できた（§9）、(3) Web/PWA と WebAudio・MediaRecorder のコードとブラウザ挙動を共有できる。サイズ増（~130–160 MB + モデル 160 MB〜）は会議録アプリとして許容。
**撤退条件:** macOS 14.2 / 15 / 26 の実機 PoC（§10.2）で loopback が安定しない場合、macOS のみ Swift/Rust の Core Audio Tap ネイティブモジュール（utility process から PCM を供給）に置き換える。Tauri 全面移行はその後の選択肢。

## 3. アーキテクチャ

```
┌──────────────────────────── main process (dist/main.cjs) ────────────────────────────┐
│ config.json / 単一インスタンス / メニュー / トレイ / 録音インジケーター                   │
│ security.ts: ナビゲーション制限・権限ハンドラ・setDisplayMediaRequestHandler(loopback)    │
│ ipc.ts: 名前付きチャネルのみ（送信元フレーム検証 + 入力検証）                            │
│ RecorderSession: idle→ready→recording→stopped（録音状態の唯一の正）                     │
│ MeetLedgerApi: 許可リスト化したサーバーAPI呼び出し（Web と同じ Cookie + CSRF）           │
│ AsrHost ──utilityProcess.fork──► asr-worker.cjs（@meetledger/local-asr + sherpa-onnx）  │
└───────────────┬──────────────────────────┬───────────────────────────┬─────────────────┘
                │ preload.cjs（sandbox）    │                           │
     ┌──────────▼─────────┐      ┌─────────▼──────────┐      ┌─────────▼──────────┐
     │ メインウィンドウ      │      │ 設定ページ           │      │ 録音ウィンドウ        │
     │ https://<server>/   │      │ app://desktop/      │      │ app://desktop/      │
     │ window.meetledger-  │      │  settings/          │      │  recorder/          │
     │  Desktop            │      │ + meetledgerLocal   │      │ + meetledgerLocal   │
     └─────────────────────┘      └─────────────────────┘      │ WebAudio/MediaRecorder│
                                                               │ AudioWorklet(16kHz)  │
                                                               └──────────────────────┘
```

| パス | 役割 |
|---|---|
| `src/main/main.ts` | ライフサイクル、ウィンドウ生成（全ウィンドウ `contextIsolation:true, sandbox:true, nodeIntegration:false, webSecurity:true, webviewTag:false`）、`requestSingleInstanceLock`、`app.enableSandbox()` |
| `src/main/security.ts` | `will-navigate` / `will-redirect` / `will-frame-navigate` / `setWindowOpenHandler` / `will-attach-webview`、権限ハンドラ、表示メディアハンドラ |
| `src/main/appProtocol.ts` | `app://desktop/*` を `dist/renderer` から配信（privileged standard+secure、パストラバーサル拒否、CSP ヘッダ付与） |
| `src/main/ipc.ts` | IPC ハンドラ（ACL は `src/shared/ipc.ts` の `CHANNEL_ACL`） |
| `src/main/recorderSession.ts` | 同意確認 → `/start` → ディスクへストリーム書き込み → `/end` → ASR → 送信/アップロード |
| `src/main/apiClient.ts` | `GET /api/me`（CSRF 取得）、meetings、consent、start/end、`/transcript/local`、`/media` |
| `src/main/asrHost.ts` / `src/worker/asrWorker.ts` | ASR utility process（5分アイドルで終了しメモリ解放） |
| `src/preload/preload.ts` | `window.meetledgerDesktop`（サーバーオリジン + ローカルページ）、`window.meetledgerLocal`（ローカルページのみ） |
| `src/renderer/recorder/*` | 録音UI、`capture.ts`（ChannelMerger / MediaRecorder / AudioWorklet）、`pcmTap.worklet.ts`、`convert.ts`（OfflineAudioContext フォールバック） |
| `src/shared/*` | 検証（validate）、URL 許可リスト（urlPolicy）、OS 能力判定（capability）、DSP / WAV / 話者帰属（audio/*）、モデル情報正規化（models） |
| `scripts/build.mjs` | esbuild。`--local-asr=auto|real|stub|none`（release は `real` 必須） |
| `scripts/smoke.mjs` / `scripts/smoke-packaged.mjs` | Electron スモークテスト（§9） |

### 3.1 Web アプリ連携（apps/web 向け契約）

`window.meetledgerDesktop`（型: `apps/desktop/src/shared/bridge.ts`）。存在チェックでデスクトップ判定できる（UA にも `MeetLedgerDesktop/<version>` を付与）。

| メンバー | 説明 |
|---|---|
| `version`, `platform`, `bridgeVersion: 1` | 同期プロパティ |
| `capabilities()` | `{ systemAudio: true \| false \| 'unknown', reason, localTranscription: { available, reason }, platform, arch, osVersion }` |
| `listModels()` | local-asr カタログ（サイズ・ライセンス・クレジット・導入済みか） |
| `downloadModel(id)` | **main がネイティブ確認ダイアログ（サイズ・ライセンス・配布元・保存先）を表示**し、承認時のみダウンロード。`onModelDownloadProgress(cb)` で進捗 |
| `saveRecording({mimeType, data})` | 音声バイト列（≤512 MB, `audio/wav|webm|ogg|mp4`）を端末に保存し、そのページ専用の不透明トークン（64 hex）を返す。ページ/ウィンドウ破棄時に削除 |
| `transcribeLocal(fileToken, {model?, language?, diarization?})` | **16 kHz / mono / PCM16 WAV のみ**。端末内で認識し `{provider:'local-sherpa', model, language, diarization, segments}` を返す（音声は送信しない）。送信は Web アプリが `POST /transcript/local` で行う |
| `discardRecording(fileToken)` | 削除 |
| `openRecorder({workspaceId, meetingId}?)` | デスクトップ録音ウィンドウを開く（**システム音声が必要な録音はこちらを使う**） |
| `openSettings()` | 設定 |

エラーは `Error` で、`message` が `"[code] 説明"` 形式（contextBridge は `message` 以外を保持しないため）。`bridgeErrorCode()` で解析。主なコード: `invalid_input`, `forbidden`, `not_found`, `consent_required`, `consent_declined`, `unauthenticated`, `local_asr_unavailable`, `no_model`, `bad_state`, `busy`, `network`, `internal`。

### 3.2 サーバー側への申し送り（チャンネル規約）

デスクトップからの `POST /media` は **opus/webm ステレオ、ch0(L)=マイク=「あなた」、ch1(R)=システム音声=相手側**（ファイル名 `desktop-<ISO時刻>.webm`、会議 source は `desktop_capture` で作成可能）。サーバーの audio パイプラインはこの規約でチャンネル話者分離できる。システム音声が取れなかった場合 R は無音。
端末内文字起こしの `speaker` は、L/R の 100 ms エネルギー包絡（各chの実効レベルで正規化、±6 dB 判定）で `あなた` / `相手`（話者分離があれば `相手1, 相手2…`）/ 判定不能は `話者N` または `不明`。システム音声なしの録音では **「あなた」を推定しない**（中立ラベルのみ）。声による個人識別はしない。

## 4. セキュリティ設計

| 対策 | 実装 |
|---|---|
| 表示できるオリジン | 設定済みサーバーの **1オリジンのみ**（https 必須、http は localhost/127.0.0.1/[::1] のみ）。他オリジンへの遷移・リダイレクト・iframe 遷移は拒否し、https/mailto は既定ブラウザで開く（カレンダー連携 OAuth もブラウザ側） |
| レンダラ | 全ウィンドウ contextIsolation / sandbox / nodeIntegration 無効 / webSecurity / webview 禁止、`app.enableSandbox()` |
| ブリッジ | 名前付き操作のみ。`ipcRenderer` や汎用 invoke は非公開。main で **送信元が最上位フレームか・期待ウィンドウか・許可オリジン/ページか** を `CHANNEL_ACL` で検証し、全引数を手書きバリデータ（未知キー拒否、UUID・トークン・モデルID形式、サイズ上限、制御文字拒否）で検証 |
| 権限 | `media`（**音声のみ**）: サーバーオリジンのメインウィンドウ、または録音ページ（同意確認済みセッションが ready/recording の間だけ）。`display-capture`: 録音ページの armed 中のみ。それ以外（カメラ、通知、クリップボード、位置情報、HID/USB/Serial 等）は全拒否 |
| システム音声 | `setDisplayMediaRequestHandler` は「録音ページ・最上位フレーム・armed・OS 対応」の場合のみ許可。映像ソースは **録音ページ自身**（画面は一切キャプチャしない）、音声は `'loopback'`。リモートの Web ページはシステム音声を取得できない |
| ローカルページ | `app://desktop`（privileged standard/secure）。CSP `default-src 'none'; script-src 'self'; …`（ヘッダ + meta）、インラインスクリプト不可 |
| Fuses（パッケージ時） | RunAsNode 無効、`NODE_OPTIONS` 無効、`--inspect` 無効、Cookie 暗号化、ASAR 整合性検証、asar からのみ起動、file: 特権なし |
| ログ | 文字起こし本文・音声・トークン・URL を出さない（ID/件数/コードのみ） |
| 保存データ | `userData/recordings`（0700/0600）。送信・アップロード完了で作業ファイル削除。設定画面から一括削除 |

> 注: Web アプリが非同期クリップボード API や通知を使う場合は `clipboard-sanitized-write` / `notifications` を意図的に追加する必要がある（現在は仕様どおり media / display-capture 以外は拒否）。

## 5. 録音フロー（同意・インジケーター）

1. 会議を選択（または「新規作成」→ `POST /meetings {title, source:'desktop_capture'}`）
2. 会議の `consentState` が `notified` / `confirmed` でなければ、「参加者全員に録音・文字起こしすることを伝えました」チェック + 方法（口頭/チャット/招待状/メール/アプリ内/その他）+ 状態（通知した/同意を得た）→ `POST /consent {kind:'recording', state, method, details:{client:'desktop'}}`。`declined` の会議は録音不可
3. 処理方法を選択 →「録音を準備」: main が会議を再取得して同意を再確認し `POST /start {capture:'desktop'}`（サーバーも 409 `consent_required` で再検証）→ **ready**（バナー・タイトル「● 録音準備中」）
4. 「● 録音開始」（明示クリック）→ getUserMedia（＋対応OSなら getDisplayMedia loopback）→ **recording**。録音ウィンドウは最前面・全ワークスペース表示・最小化不可（Linux では最小化を即時復元）、全ウィンドウタイトル「● 録音中」（Web ページが `document.title` を変えても付与し直す）、トレイ赤、Windows オーバーレイ、macOS Dock「REC」
5. 「■ 停止」→ 残りデータをフラッシュし WAV ヘッダ確定 → `POST /end {expectMedia}` → **stopped**
6. 端末内: 「この端末で文字起こし」→ 結果をプレビュー →「文字起こし結果を送信」（`POST /transcript/local`、テキストのみ）。音声アップロード: 「音声をアップロード」（`POST /media`）。「完了」で端末の作業ファイルを削除
7. 録音中にウィンドウを閉じる / アプリ終了 → 確認ダイアログ → 停止して会議を終了。録音済みファイルは端末に残す（黙って削除しない）。リロード・レンダラクラッシュでもセッションを閉じる

## 6. 何がキャプチャされるか

| 対象 | Windows 10/11 | macOS 14.2+ | macOS ≤14.1 | Linux（開発用） |
|---|---|---|---|---|
| マイク（L） | ○ | ○（TCC 許可） | ○ | ○ |
| システム音声（R） | ○ WASAPI loopback = **既定出力デバイスに流れる全音声**（会議アプリ以外の通知音・動画等も含む） | △ Core Audio Tap 経由（Chromium 既定）。**未検証** | × | × |
| 画面 | 取得しない（getDisplayMedia の映像は録音ページ自身のタブ映像で、即停止） | 同左 | — | — |
| 自分の声の二重化 | AEC（echoCancellation）を有効化。スピーカー使用時は相手の声がマイクにも入るが、R が優勢なので帰属は「相手」になる | 同左 | 同左 | 同左 |

利用者向け注意（UI/購入者ドキュメントに記載すること）: システム音声録音中は通知音や他アプリの音も記録される。ヘッドホン使用を推奨。

## 7. OS 別の権限

### Windows 10 / 11
- マイク: 設定 > プライバシーとセキュリティ > マイク >「デスクトップ アプリがマイクにアクセスできるようにする」がオンであること（Win32 アプリはアプリ単位の許可ダイアログが出ない）。
- システム音声: WASAPI loopback は追加の OS 許可不要（Microsoft 明文は未確認 — 研究資料 §4.3）。
- 署名なしビルドは SmartScreen 警告。

### macOS（Info.plist は electron-builder `mac.extendInfo` で付与）
| キー / エンタイトルメント | 用途 |
|---|---|
| `NSMicrophoneUsageDescription` | マイク TCC 許可ダイアログの文言（必須） |
| `NSAudioCaptureUsageDescription` | **macOS 14.2+ のシステムオーディオ収録（Core Audio Tap）に必須**。無いと無音の `ended` トラックがエラーなしで返る |
| `NSScreenCaptureUsageDescription` | getDisplayMedia 経由のため画面収録許可が要求される可能性に備えた文言（画面内容は記録しない旨） |
| `com.apple.security.device.audio-input` | Hardened Runtime 下でのマイク入力（main / helper 双方） |
| `com.apple.security.cs.allow-jit` | V8 |

- 初回: マイク許可 →（システム音声 ON の場合）「システムオーディオ収録」許可。macOS 15+ の設定名は「画面とシステムオーディオ収録」で「システムオーディオ収録のみ」を許可可能。
- システム音声トラックが即 `ended` / 無音の場合、録音ページは警告を出しマイクのみで継続する。R ch に実際の音声を観測した OS バージョンは config に記録され、以後 `capabilities().systemAudio` が `true` になる（OS 更新で再判定）。
- 設定画面の macOS 詳細オプション（再起動で反映、既定オフ）: 「macOS 標準ピッカー」（`useSystemPicker`、Issue #52738 回避候補・実験的）、「旧方式」（`--disable-features=MacCatapLoopbackAudioForScreenShare`、Electron 44 のみ・45 で削除予定）。

### Linux
- システム音声は非対応（Electron の loopback は Windows/macOS のみ）。capabilities は `false` を返し、マイクのみ録音。

## 8. ローカルモードのデータフロー（何が端末外に出るか）

```
マイク ┐                        ┌─► AudioWorklet tap ─► 16kHz mono PCM16 + L/R包絡 ─► IPC ─► userData/recordings/rec-*.wav
システム音声 ┴► ChannelMerger(L/R) ┤
                                 └─► MediaRecorder opus/webm（「音声もアップロード」時のみ）─► rec-*.webm
停止 → ASR utility process（sherpa-onnx SenseVoice + Silero VAD、任意で pyannote+CAM++ 話者分離）→ L/R 包絡で話者帰属
     → プレビュー →［送信］ POST /transcript/local（テキスト・時刻・話者ラベルのみ）→ rec-*.wav 削除
```

| データ | 端末内モード（既定） | 端末内 +「音声もアップロード」 | サーバー処理モード |
|---|---|---|---|
| 同意記録（kind/state/method、client/appVersion/platform） | 送信 | 送信 | 送信 |
| 会議開始/終了（`/start` `/end`） | 送信 | 送信 | 送信 |
| 音声 | **送信しない** | `/media` に webm（明示ボタン） | `/media` に webm（明示ボタン） |
| 文字起こしテキスト + 時刻 + 話者ラベル | `/transcript/local`（明示ボタン） | 同左 | —（サーバーで処理） |
| モデル | 初回のみ配布元（k2-fsa/sherpa-onnx GitHub Releases）から明示操作でダウンロード（SHA-256 検証は local-asr 側）。会議データは送らない | 同左 | — |

- 端末内ASRの利用可否は `capabilities().localTranscription`。会議の `transcriptionMode` が `none` の場合、端末内文字起こしは拒否（`transcription_disabled`）。
- 長時間録音: WAV は録音中に逐次ディスクへ書き込むためレンダラのメモリは増えない（32 KB/秒、2時間 ≈ 230 MB）。AudioWorklet が使えない環境だけ、停止後に OfflineAudioContext で変換（90 分まで。ffmpeg は GPL ビルド配布リスクと容量のため同梱しない）。

## 9. 検証結果（2026-10-02、Linux x64 コンテナ / xvfb）

| 項目 | 結果 |
|---|---|
| `npx tsc -p tsconfig.json` / `tsconfig.renderer.json` | ✅ エラー 0 |
| `npx vitest run` | ✅ 8 ファイル 58 テスト（IPC 入力検証、URL 許可リスト/送信元分類/ACL、app:// パストラバーサル、WAV エンコード/パース、ストリーミングリサンプラ（48k/44.1k→16k、エイリアス抑圧、ブロック境界一致）、チャンネルミックス、包絡、話者帰属、OS 能力判定、モデル情報正規化、local-asr 実カタログとの契約、API クライアント（CSRF/409/401）、RecorderSession（同意ゲート・ストリーム書込・非同期レース）） |
| `xvfb-run -a npm run smoke` | ✅ **66/66 チェック**（初回設定→保存→サーバー表示、CSP、ブリッジ露出と Node 非露出、webPreferences、UA、capabilities、IPC 不正入力拒否、モデルDL 確認ダイアログ（サイズ/ライセンス/キャンセル）、web オリジンのマイク許可・カメラ/画面/通知拒否、他オリジン遷移ブロック + 外部ブラウザ、同意前のマイク拒否、consent→start→録音→停止→end、インジケーター（タイトル/最前面/最小化復元/タイトル改ざん耐性/解除）、WAV 16k mono、**webm opus 2ch で L=マイク（-21 dB）/R=無音**、stub ASR→`/transcript/local`、`/media` multipart、作業ファイル削除、Cookie+CSRF+Origin、サーバー側同意ゲート） |
| 実 local-asr（`packages/local-asr` + sherpa-onnx-node 1.13.8 + SenseVoice、リポジトリ `models/` を参照） | ✅ Electron utility process で `ja.wav` → 「うちの中学は弁当制で…」（約3秒）。**偽マイクに ja.wav を流した録音 → AudioWorklet 16kHz WAV → 端末内認識 → `/transcript/local`** まで一気通貫で確認 |
| `electron-builder --linux dir` / AppImage | ✅ 生成（AppImage 130 MB）。asar 内容・`app.asar.unpacked/node_modules/sherpa-onnx-*` を確認 |
| `node scripts/smoke-packaged.mjs`（パッケージ版） | ✅ 6/6（RunAsNode/--inspect fuse 無効化、asar からの起動、utility process + ネイティブアドオンが asar.unpacked から読み込まれ ja.wav を認識） |
| Windows NSIS クロスビルド | ⚠️ Linux 上では wine 不在で失敗（rcedit）。Windows ランナーでの実行が必要 |

注意: コンテナは root 実行のため Chromium の OS サンドボックスは `--no-sandbox` で無効化して試験（`--no-sandbox` 指定時のみ `app.enableSandbox()` をスキップ）。レンダラの JS サンドボックス（preload の制限環境）は有効のまま。

### 未検証（実機で要確認）
- Windows 10/11 の WASAPI loopback 実録音、NSIS インストーラ、Authenticode 署名、SmartScreen
- macOS 14.2 / 15 / 26 の Core Audio Tap loopback、TCC ダイアログ、Info.plist 文言表示、Hardened Runtime 下での sherpa-onnx dylib 読込、Developer ID 署名、notarization、dmg（arm64/x64）
- 実際の会議アプリ（Zoom/Teams/Meet）音声での L/R 帰属精度、AEC の効き、長時間（2時間）録音
- Windows の `tar.exe` による .tar.bz2 展開（local-asr のモデル DL）、プロキシ環境でのモデル DL（utility process の `net.fetch` を使用）

## 10. 実機テスト手順

### 10.0 共通準備
1. `cd apps/desktop && npm ci`（ルートの `npm install` も済ませておく: local-asr が `@meetledger/shared` を参照する場合に備える）
2. `npm run typecheck && npm test`
3. 開発起動: `npm start`（初回は設定画面 → サーバーURL → 接続テスト → 保存して開く → Web アプリでログイン）
4. 設定画面で SenseVoice（約164 MB）をダウンロード（確認ダイアログでサイズ/ライセンスを確認）

### 10.1 Windows 10 (22H2) / Windows 11 (23H2, 24H2)
1. `npm run dist:win`（Windows x64 マシン、署名する場合は §11 の環境変数）→ `release/MeetLedger Desktop Setup 1.0.0.exe` をインストール
2. 起動 → メニュー「ファイル > デスクトップ録音…」→ 会議選択 → 同意記録 →「システム音声も録音する」ON →「録音を準備」→「● 録音開始」
3. YouTube 等で音声を再生しつつ自分も話す（ヘッドホンあり/なし両方）。録音ウィンドウのメーター「システム音声（相手）」が振れること、タイトル/タスクバーのオーバーレイ表示、最小化できないこと
4. 停止 →（「音声もアップロード」ON の場合）サーバー側で受信した webm を `ffprobe` → opus 2ch、`ffmpeg -i x.webm -af astats -f null -` で Channel 1=マイク、Channel 2=再生音のレベルになっていること
5. 端末内文字起こし → 話者列が自分の発話=「あなた」、再生音=「相手」になること → 送信 → Web アプリでトランスクリプト確認
6. マイクのプライバシー設定をオフ → 録音開始でエラー表示（NotAllowedError）になること
7. Teams / Zoom 実会議で 30 分録音 → CPU 使用率、WAV/webm サイズ、取りこぼしがないこと
8. SmartScreen 表示（署名あり/なし）、アンインストール時に `%APPDATA%\MeetLedger Desktop` が残ること（`deleteAppDataOnUninstall:false`）

### 10.2 macOS 14.2（Sonoma）/ 15（Sequoia）/ 26（Tahoe）— Apple Silicon と Intel
1. `npm run dist:mac`（Xcode CLT、署名・公証用 env 設定済み）→ `spctl -a -vv "release/mac-arm64/MeetLedger Desktop.app"` が `accepted / Notarized Developer ID`
2. `codesign -d --entitlements - "…/MeetLedger Desktop.app"` に `device.audio-input`、`plutil -p …/Contents/Info.plist` に 3 つの UsageDescription
3. 録音: マイク許可ダイアログ → システム音声 ON で「システムオーディオ収録」許可ダイアログ（15+ は「画面とシステムオーディオ収録」）。**画面収録の許可を求められるかを記録**
4. Music/Safari で音を再生 → 「システム音声（相手）」メーターが振れるか。振れない/警告が出る場合: (a) システム設定で許可を確認、(b) 設定 > macOS 詳細 >「標準ピッカー」ON → 再起動して再試行、(c)「旧方式」ON → 再起動して再試行。どの組合せで成功したかを OS バージョン別に記録（Issue #52738 の再現確認: macOS 26 で `useSystemPicker:false` 時に即 `ended` になるか）
5. 成功後、設定画面のシステム音声表示が「取得できます（確認済み）」に変わること
6. 端末内文字起こし（arm64 と x64 双方）: sherpa-onnx dylib が Hardened Runtime + 署名で読み込めるか（失敗時は `capabilities().localTranscription.reason` を記録）
7. 許可を「拒否」にした状態で録音 → マイクのみで続行し警告が出ること

## 11. ビルド・署名・公証

| コマンド | 内容 |
|---|---|
| `npm run build` | esbuild（local-asr が無い/壊れている場合は警告して「なし」でビルド） |
| `npm run build:release` | local-asr 必須（バンドル失敗でエラー） |
| `npm run dist:win` | NSIS x64（Windows 上で実行） |
| `npm run dist:mac` | dmg arm64 + x64（macOS 上で実行） |
| `npm run dist:linux` | AppImage（開発用） |
| `xvfb-run -a npm run smoke` | Electron スモーク（stub ASR + 実 ASR） |

- **ネイティブアドオン**: `sherpa-onnx-node` は optionalDependency。npm はホストOS/CPU 用のプラットフォームパッケージ（`sherpa-onnx-<os>-<arch>`）しか入れないため、各ターゲットはそのOS/CPUのランナーでビルドするか、`npm install --no-save --os=<os> --cpu=<arch> sherpa-onnx-<os>-<arch>@1.13.8` で追加する。win-arm64 のプリビルドは存在しない（端末内ASR不可と表示）。`asarUnpack: node_modules/sherpa-onnx-*/**`、他OSの prebuilt は `files` で除外。
- **macOS 署名**: `CSC_LINK`（Developer ID Application .p12）+ `CSC_KEY_PASSWORD`。`hardenedRuntime: true`、entitlements は `build/entitlements.mac*.plist`。
- **macOS 公証**: `notarize: true`（electron-builder 26 統合）。推奨 `APPLE_API_KEY`（.p8 パス）+ `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`。代替 `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`。未設定時は公証をスキップ（配布不可）。
- **Windows 署名**: `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`（OV/EV .pfx）、またはクラウド HSM の Azure Trusted Signing（`electron-builder.yml` のコメント参照、`AZURE_TENANT_ID` 等）。EV でも SmartScreen の即時評価は付かない（研究資料 §4.4）。
- **アイコン**: `build/icon.png`（1024px, Linux/トレイ）、`build/icon.icns`（mac）、`build/icon.ico`（win）はブランド担当の成果物を使用。`icon.png` が無い場合のみ `scripts/make-placeholder-icon.mjs` が仮アイコンを生成し `build/icon.png.placeholder` マーカーを置く（`dist/build-info.json` の `iconPlaceholder` で確認）。
- 自動更新は未実装（`publish: null`）。導入時は署名必須（macOS Squirrel.Mac）。

## 12. local-asr 連携状況

- `packages/local-asr` を esbuild で worker バンドルに取り込み（alias `@meetledger/local-asr` → `packages/local-asr/src/index.ts`、`import.meta.url` は CJS 用にシム）。tsc は `src/worker/local-asr-contract.d.ts` の契約型で検査し、実行時は全エクスポートの存在を確認して欠落時は「未実装」と表示（クラッシュしない）。
- 合意 API との差分（アダプタで吸収済み）: `transcribeFile` の `diarization` が boolean ではなく `'provider' | 'none'`、`language` が `null` あり、カタログは `title` / `licenses[]`（component・commercialUse・attribution）/ `downloads[]` 形式、`downloadModel` の進捗は `{phase, receivedBytes, totalBytes}`。`downloadModel` の第4引数 `{fetchImpl}` に Electron `net.fetch`（OS プロキシ・証明書ストア）を渡す。
- 契約テスト `test/localAsrContract.test.ts` が実カタログを読み、全モデルにサイズ・ライセンス・配布元があることを確認。
- クレジット表記（SenseVoiceSmall の FunASR Model License §2.2 等）は設定画面「クレジット表記」に導入済みモデル分を表示。3D-Speaker CAM++ は商用利用「未確認」と表示される（販売前に法務確認）。

## 13. 既知のリスク・制約

| リスク | 内容 / 対応 |
|---|---|
| macOS loopback の文書矛盾 | Electron `session.md` は「loopback は Windows のみ」、`desktop-capturer.md`（44-x-y）は「macOS 14.2+ は Core Audio Tap 既定・`NSAudioCaptureUsageDescription` 必須」。→ capabilities は `'unknown'` を返し、実音声を観測した OS バージョンのみ `true`。§10.2 の PoC 必須 |
| Electron Issue #52738 | Electron 43.3.0 / macOS 26.5.2、`useSystemPicker:false` で loopback トラックが即 `ended`（2026-08-09 起票・Open）。→ 検出して警告・マイクのみ継続、設定で標準ピッカー/旧方式を試せる |
| Electron 45 で旧方式フラグ削除 | `MacCatapLoopbackAudioForScreenShare` 無効化は 44 のみ。45 へ上げる前に macOS PoC 結果で判断 |
| 画面収録許可 | getDisplayMedia は映像必須のため、映像ソースに録音ページ自身を指定して画面を取得しない設計だが、macOS が画面収録許可を要求するかは未検証 |
| Windows loopback の範囲 | 既定出力の全音（通知音等）を含む。プロセス単位 loopback（Win10 20348+）は Electron 非対応 → ヘッドホン推奨・利用者告知 |
| sherpa-onnx | win-arm64 なし。macOS Hardened Runtime での dylib 読込は未検証（`DYLD_LIBRARY_PATH` は無視されるため @loader_path 依存）。モデルは数百MB。local-asr は WAV を一括読み込みするため 2 時間録音で数百MB のメモリを utility process が使う |
| 話者帰属 | チャンネルエネルギー比による推定。ダブルトークや音量差で誤り得る → 「不明」ラベル、レビュー画面で手動修正前提 |
| OAuth / 外部リンク | 他オリジンは既定ブラウザで開くため、カレンダー連携の OAuth はブラウザ側のログインで行う |
| クリップボード/通知 | 権限ハンドラで拒否（仕様どおり）。Web アプリが必要とする場合は追加判断 |
| root 実行 | Chromium は root で `--no-sandbox` 必須（CI のみ）。製品では非サポート |
| 未実装 | 自動更新、クラッシュレポート、録音ファイルの個別復旧UI（現在は一括削除のみ）、英語UI |
