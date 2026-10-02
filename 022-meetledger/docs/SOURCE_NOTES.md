# SOURCE_NOTES — MeetLedger (#022) 実装時調査ノート

確認日: **2026-10-02**（全項目）。調査は公式ソース優先。ネットワークポリシーで多くの公式サイト（huggingface.co, developer.chrome.com, MDN, developers.openai.com, J-PlatPat, USPTO, WIPO 等）が遮断されたため、
各事実には取得経路を付記している：

- **[一次]** 公式ページ/公式GitHub/公式npm・PyPI/公式API endpointを直接取得
- **[検索要約] / ［検索経由］** 公式ページの検索結果スニペットのみ確認 → **販売前に人間が原文を再確認すること**
- **未確認** 確認できなかった事項（推測で埋めていない）

## 要点サマリ（設計に反映した判断）

| テーマ | 結論 | 反映先 |
|---|---|---|
| 名称/商標 | "MeetLedger" の同名商用製品は Web 検索で未発見。類似: joinledger.co（"Ledger – The memory of leadership decisions"）、LEDGER（暗号資産ウォレット社）の著名商標。**J-PlatPat/USPTO/WIPO は未検索 → 人間が確認必須**。代替候補（人間向け参考のみ、改名しない）: 決め録(Kimeroku) / 議事帳(Gijichō) / FollowTrace | docs/BRANDING.md, RELEASE_CHECKLIST.md |
| 市場 | 録音同意をめぐる訴訟（Otter: 2026-08-13 盗聴請求の審理継続、Granola: bot不在録音の同意問題を主張する訴え）。ChatGPT Meetings plugin（2026-09-29）、Rimo Actions 等と競合 | PRIVACY_CONSENT.md（同意UIを必須化） |
| Cloud文字起こし | AssemblyAI Universal-3.5 Pro $0.21/h(+話者$0.02)、ElevenLabs Scribe v2 $0.22/h、Deepgram Nova-3 $0.258–0.312/h(+話者$0.12)、OpenAI gpt-4o-mini-transcribe $0.18/h、gpt-4o-transcribe $0.36/h。**OpenAI gpt-4o系transcribeは2027-02-26終了予定** | providers/transcription（model設定可能）, OPERATING_COSTS.md |
| LLM | Anthropic: Haiku 4.5 $1/$5, Sonnet 5.5 $2/$10, Opus 5.5 $4/$20 per MTok [一次]。OpenAI: 検索要約のみ。API dataは既定で学習に使われない（両社, 要原文確認） | providers/ai, OPERATING_COSTS.md |
| Embedding | text-embedding-3-small $0.02/MTok | providers/embeddings |
| Infra | S3 Tokyo $0.025/GB-mo, RDS t4g.micro 約$18/mo, SES $0.10/1000通 [一次: AWS price list] | OPERATING_COSTS.md |
| Local ASR | sherpa-onnx-node 1.13.8 (Apache-2.0, win-x64/mac-arm64/mac-x64/linux-x64 prebuilt)。既定 SenseVoice int8 (ja/en, FunASR Model License: 商用可・出典表記/モデル名保持)。VAD silero。高精度日本語候補: ReazonSpeech zipformer(Apache-2.0)/Parakeet ja(CC-BY-4.0) | packages/local-asr, TRANSCRIPTION.md |
| Local diarization | pyannote segmentation-3.0 ONNX (MIT, sherpa-onnx配布版は非gated) + 3D-Speaker CAM++ embedding。reverb-diarization-v1 は商用不可のため不採用 | packages/local-asr |
| System audio | Win Chrome/Edge: 画面共有で可。macOS Chrome 141+ (macOS 14.2+): 報告ありだが公式doc未確認。Linux Chrome: tab音声のみ。Firefox/Safari: 不可。**iOS/Android PWA: マイクのみ**（iOSはバックグラウンドで停止） | Web UI表示, スマホ-PWA.txt |
| Desktop | Electron 44.5.1 推奨（loopback数行、macOS 14.2+はNSAudioCaptureUsageDescription必須、macOS側doc矛盾/issue #52738 → PoC必須）。Tauri は軽量だがRust実装量大 | DESKTOP_COMPANION.md, DECISIONS.md |
| MCP | 最新spec 2026-07-28（initialize廃止, server/discover, MRTR）。TS SDK v2 (`@modelcontextprotocol/server` 2.2.0)。旧 `@modelcontextprotocol/sdk` 1.31.0 は 2025-11-25。Tool annotations: destructiveHint/openWorldHint は既定true → 明示設定 | MCP_PLUGIN.md |
| ChatGPT/Codex | ChatGPT: Developer mode → Plugins に MCP URL 登録、公開配布は OAuth 2.1+PKCE・privacy policy URL・審査（5 positive/3 negative test cases）。Codex: `~/.codex/config.toml` `[mcp_servers.<name>] url / bearer_token_env_var / default_tools_approval_mode` | MCP_PLUGIN.md |
| Calendar scope | Google: `calendar.events.readonly`（+ `calendar.calendarlist.readonly`）。Microsoft Graph: `Calendars.ReadBasic` + `offline_access`。Gmail draft `gmail.compose` は restricted scope（審査要） | CONNECTORS.md |
| Password/CSRF | OWASP scrypt N=2^17,r=8,p=1 / Argon2id m=19MiB,t=2,p=1。CSRF: session-bound token をcustom headerで送る + Origin/Sec-Fetch-Site | SECURITY.md |

## 詳細（URL・確認日つき原ノート）

以下 3 ファイルが一次記録（各事実に URL と確認日）。

- [research/A_market_providers_costs.md](research/A_market_providers_costs.md) — 市場・商標・文字起こし/LLM/Embedding/インフラ料金
- [research/B_local_asr_audio_capture.md](research/B_local_asr_audio_capture.md) — Local ASR/diarization・ライセンス・ブラウザ/OS音声キャプチャ・Electron vs Tauri・PWA
- [research/C_mcp_connectors_consent.md](research/C_mcp_connectors_consent.md) — MCP spec/SDK・ChatGPT/Codex・Calendar/Slack/HubSpot/Gmail scope・録音同意/個人情報・OWASP

---


<!-- ===== included: research/A_market_providers_costs.md ===== -->

# A. 市場・プロバイダ・単価リサーチ（MeetLedger / 商品#022）

- 調査日: 2026-10-02（全項目の確認日）
- 目的: 競合把握、名称の衝突確認、運用コストモデル用の単価収集
- **取得方法の凡例**（信頼度の高い順）
  - **[直]** 公式ページを直接取得して確認
  - **[PL]** AWS Price List API（公式の機械可読 JSON）から抽出。publicationDate を併記
  - **[公式検索]** 公式ドメインに絞った Web 検索の結果スニペットで確認。この環境ではネットワーク制限で直接取得できなかった（openai.com / deepgram.com / assemblyai.com / elevenlabs.io / azure.microsoft.com / learn.microsoft.com / docs.cloud.google.com / aws.amazon.com / resend.com / supabase.com / granola.ai / J-PlatPat / USPTO / WIPO はすべて EGRESS_BLOCKED）。**数値は契約・見積前に人が公式ページで再確認すること**
  - **[二次]** 第三者サイト（報道・法律事務所ブログ・比較サイト）。一次情報で裏付けが必要
- 「未確認」= 公式情報で確認できなかった項目。推測値は記載していない。

---

## 1. AI ノートテイカー市場の概況（2026年後半）

### 1.1 主要プレイヤー（料金は見出し価格のみ、USD/ユーザー/月。年払い表記がある場合は年払い）

| 製品 | 収録方式 | 有料プラン見出し価格 | 特徴・メモ | 出典 |
|---|---|---|---|---|
| Otter.ai | ボット（OtterPilot）＋アプリ | Free（300分/月・1会話30分）、Pro $8.33、Business $19.99、Enterprise 個別見積 | Pro は 1,200分/月、Business は 6,000分/月。Enterprise は HIPAA・MCP サーバー対応 | https://otter.ai/pricing [公式検索] |
| Fireflies.ai | ボット | Pro $10（年）/$18（月）、Business $19/$29、Enterprise $39（年払いのみ） | 全プランで文字起こし・AI要約は無制限、AI クレジット制 | https://fireflies.ai/pricing [公式検索] |
| Fathom | ボット | Free（録画・要約無制限）、Premium $16（年）/$20、Team $15/$19（2名〜）、Business $25/$34 | AI アクションアイテム、CRM 連携、90日返金保証 | https://www.fathom.ai/pricing [公式検索] |
| tl;dv | ボット | Pro $18（年）/$29、Business $35/$65 | 文字起こし 40言語以上（tl;dv ブログ・二次情報）。**日本法人・日本向け専用版（「tl;dv JP」）は未確認** | https://tldv.io/blog/tldv-vs-meetgeek/ [公式検索] |
| Granola | **ボットなし**（端末の音声を直接取得） | Free、Business $14、Enterprise $35〜 | 音声は破棄し、トランスクリプトとメモのみ保存。Enterprise は組織単位で AI 学習をオプトアウト可 | https://www.granola.ai/pricing, https://www.granola.ai/blog/ai-meeting-notes-pricing-granola-costs-less-alternatives [公式検索] |
| Read AI | ボット | Pro $15（年）/$19.75、Enterprise $22.50/$29.75、Enterprise+ $29.75/$39.75 | Enterprise+ でデータ保持ポリシー・SAML | https://support.read.ai/hc/en-us/articles/22307341312275 [公式検索] |
| Microsoft Teams（Copilot / Teams Premium） | プラットフォーム内蔵 | Teams Premium $10、Microsoft 365 Copilot Business $18〜、Business Standard + Copilot $23.50 | テキストのインテリジェントリキャップは Teams Premium か Copilot ライセンスが必要。音声・動画リキャップは Copilot が必要 | https://www.microsoft.com/en-us/microsoft-365-copilot/pricing, https://support.microsoft.com/en-us/office/recap-in-microsoft-teams-c2e3a0fe-504f-4b2c-bf85-504938f110ef [公式検索] |
| Google Meet「Take notes for me」 | プラットフォーム内蔵 | Workspace Business Standard/Plus、Enterprise Standard/Plus 等に同梱 | **日本語対応**（英・仏・独・伊・日・韓・葡・西）。1会議内の多言語混在は非対応。日本語の「suggested next steps」も対応 | https://support.google.com/meet/answer/14754931, https://workspaceupdates.googleblog.com/2025/08/more-languages-suggested-next-steps-take-notes-google-meet-gemini.html [公式検索] |
| Zoom AI Companion | プラットフォーム内蔵 | 有料 Zoom Workplace（$14.16〜）に追加費用なしで同梱。Custom AI Companion アドオンは $12 | AI Companion 3.0 でエージェント機能を推進 | https://news.zoom.com/zoom-introduces-ai-companion-2-0/ [公式検索] |
| Notion AI Meeting Notes | **ボットなし** | Business $20（Notion AI 無制限込み）/ Enterprise | Business 以上が必要。文字起こし・要約・アクションアイテム | https://www.notion.com/help/ai-meeting-notes, https://www.notion.com/pricing [公式検索] |

### 1.2 国内プレイヤー

| 製品 | 料金（税抜） | 特徴 | 出典 |
|---|---|---|---|
| Notta | ビジネス 月2,280円相当（年27,360円）、ビジネスPlus 月5,400円相当（年64,800円）。プレミアムは文字起こし 1,800分/月・AI要約 100回/月 | ビジネスは文字起こし無制限、AI要約 200回/アカウント/月 | https://www.notta.ai/business, https://support.notta.ai/hc/ja/articles/55447618158491 [公式検索] |
| Rimo Voice | 文字起こし 1,650円（年払い 1,100円）、プロ 4,950円（3,300円）、チーム 6,600円（4,950円）、法人は見積 | 「**Rimo Actions**」は会議で決まったタスクを AI が抽出し、承認後に資料・メール下書き等を生成。MeetLedger の Action 台帳と**直接競合する方向** | https://rimo.app/about/voice/plans, https://rimo.app/about/actions [公式検索] |
| YOMEL（PKSHA） | スターター 28,000円（30h/月）、スタンダード 95,000円（130h）、ビジネス 180,000円（300h）。ID数無制限、最低6か月 | 時間課金型 | **二次情報のみ**: https://gijiroku-hikaku.com/yomel-pricing/ 。公式価格は未確認 |
| スマート書記 → **Otolio（オトリオ）に改称** | 初期費用＋AIクレジット（人数課金ではない）。**具体的な金額は未確認**（問い合わせ制） | 14日間無料トライアル（10時間相当） | https://www.smartshoki.com/pricing/ [公式検索] |

### 1.3 注目トレンド

1. **ボットなし収録の普及**: Granola、Notion などが端末の音声を直接取得する方式（会議にボットを入れない）。Granola は「ボット型はストリーミング・動画保存・クラウド計算のコストがかかる」と主張（https://www.granola.ai/blog/ai-meeting-notes-pricing-granola-costs-less-alternatives [公式検索]）。
2. **同意・盗聴リスクの訴訟化（重要）**:
   - In re Otter.ai Privacy Litigation（N.D. Cal., 5:25-cv-06911）: 2026-08-13 に棄却申立てを一部認容・一部棄却。Otter が録音を自社目的にも使う点から「第三者の盗聴者」と主張されることは妥当とされ、連邦盗聴法・CIPA・BIPA の請求は継続（https://cand.uscourts.gov/cases-e-filing/cases/525-cv-06911-ekl/re-otterai-privacy-litigation , https://natlawreview.com/article/invited-participant-or-third-party-eavesdropper-court-holds-otterai-third-party [二次]）。
   - Chamberlain v. Granola, Inc.（N.D. Cal., 3:26-cv-07926、2026-07-30 提訴とされる）: **ボットなし（目に見えない）収録こそ同意上の問題**と主張し、学習利用がデフォルトである点も指摘（https://sigmalawgroup.com/blog/2026-08-03-granola-ai-notetaker-cipa/ [二次]、一次資料は未確認）。
   - → MeetLedger への示唆: 「ボットなし＝安全」ではない。**参加者への明示的な通知・同意記録・学習不使用の明記**が差別化要素になる（日本法での評価は別途要検討）。
3. **アクション追跡・実行への拡張**: Fathom（AI アクションアイテム・CRM 同期）、Rimo Actions（タスクを実行して成果物を作成）、Teams Recap（フォロータスク生成）。「要約」から「決定・タスクの台帳と実行」へ競争軸が移りつつある。
4. **プラットフォーム内蔵機能の無料化圧力**: Zoom・Google Meet・Teams が上位プランに同梱しているため、単体ノートテイカーは要約だけでは差別化しにくい。

---

## 2. 名称・商標チェック:「MeetLedger」

### 2.1 Web 検索の結果

| 検索 | 結果 | 出典 |
|---|---|---|
| "MeetLedger"（Web） | **同名の商用製品・企業は見つからず** | WebSearch（2026-10-02） |
| meetledger.com / .app / .io | インデックスされたサイトなし（ドメインの登録状況は未確認、WHOIS は未実施） | WebSearch |
| "ミートレジャー" / 日本語 | 該当なし | WebSearch |
| GitHub リポジトリ名 "meetledger" | 個人リポジトリ 3件（スター 0）: `the-dezeray/MeetLedger`（2026-04 作成）、`ameyashinde07/MeetLedger`（「プロ向けネットワーキング」アプリ）、`naritas2006/meetledger1` | https://github.com/ameyashinde07/MeetLedger ほか（GitHub API 検索） |
| "Meeting Ledger" | 個人・ポートフォリオ案件: `wojciechmocarski/meeting-ledger`（会議資料を監査可能なプロジェクト記録にする、スター 2）、patrickndille.com の「Meeting Ledger - AI Meeting Assistant」（ポートフォリオ、アクション・決定を抽出）、GitHub の `Meeting-Decision-Ledger` | https://github.com/wojciechmocarski/meeting-ledger , https://www.patrickndille.com/portfolio/meeting-ledger , https://github.com/udayasri10435/Meeting-Decision-Ledger |
| 類似コンセプト（名称は異なる） | **「Ledger – The memory of leadership decisions」（joinledger.co）**: Slack・会議メモから決定を抽出する AI 決定ログ SaaS。**「Ledger」を会議の決定台帳の名前として使う商用製品** | https://joinledger.co/ [公式検索] |
| 類似コンセプト | 「Decisions」（meetingdecisions.com）: M365/Teams 向け会議管理（決定・アクション・Planner 同期） | https://www.meetingdecisions.com/ |
| 一般語の「Ledger」 | Ledger SAS（暗号資産ウォレット「Ledger Wallet」）が著名ブランド。**商標の指定区分（9類・42類など）が重なるかは未確認** | https://www.ledger.com/ |

### 2.2 商標データベース

| DB | 状態 |
|---|---|
| J-PlatPat（https://www.j-platpat.inpit.go.jp/） | **未確認**（EGRESS_BLOCKED）。人による検索が必要: 称呼検索「ミートレジャー」「レジャー」、文字「MEETLEDGER」「MEET LEDGER」。区分は 9類（ソフトウェア）・42類（SaaS）・35類（事業管理）を推奨 |
| USPTO（tmsearch.uspto.gov） | **未確認**（EGRESS_BLOCKED）。人による検索が必要 |
| WIPO Global Brand Database（branddb.wipo.int） | **未確認**（EGRESS_BLOCKED）。人による検索が必要 |

**現時点の結論**: Web 上には「MeetLedger」という同名の商用製品は見当たらない。ただし (a)「Meeting Ledger」名の個人プロジェクトが複数ある、(b) 会議の決定台帳という同じコンセプトで「Ledger」を名乗る SaaS（joinledger.co）がある、(c)「LEDGER」には著名な権利者（Ledger SAS）がいる、の3点は**商標調査で要確認**。登録可否の判断は未確認（人による商標 DB 検索と専門家への確認が必要）。

### 2.3 代替候補名（参考。改名を推奨するものではない）

| 候補 | 狙い | 簡易 Web 検索 |
|---|---|---|
| Kimeroku（決め録） | 「決めたことの記録」を和名で表現 | 同名の製品はヒットせず |
| Gijichō（議事帳） | 議事録＋台帳（Ledger）の和訳 | 同名の製品はヒットせず |
| FollowTrace | フォローアップの追跡を表現 | 同名のソフトウェアはヒットせず |

（参考: 「CommitRail」は同名の Node SDK が既にあるため候補から外した: https://github.com/CommitRail/commitrail-node ）

---

## 3. クラウド文字起こし・話者分離プロバイダ

### 3.1 単価の比較（USD。$/時は $/分 × 60 で換算）

| プロバイダ / モデル | 日本語 | 話者分離 | 単価（バッチ） | $/時 換算 | 出典 |
|---|---|---|---|---|---|
| OpenAI **gpt-transcribe**（新・推奨） | 対応（多言語） | **未確認**（ガイドでは話者ラベルが必要なら gpt-4o-transcribe-diarize を使うよう案内） | $0.0045/分 | $0.27 | https://developers.openai.com/api/docs/pricing , https://developers.openai.com/api/docs/models/gpt-transcribe [公式検索] |
| OpenAI gpt-4o-transcribe | 対応 | なし | $0.006/分 | $0.36 | 同上 [公式検索] |
| OpenAI gpt-4o-mini-transcribe | 対応（2025-12-15版は日本語が強化されたと記載） | なし | $0.003/分 | $0.18 | 同上 [公式検索] |
| OpenAI gpt-4o-transcribe-diarize | 対応 | **あり**（`diarized_json`、既知話者は最大4名、各サンプル2〜10秒） | トークン課金（音声入力 $2.50/1M、出力 $10/1M）。**分単価の公式見積は未確認**（第三者サイトは $0.006/分） | 未確認 | https://developers.openai.com/api/docs/models/gpt-4o-transcribe-diarize [公式検索] |
| OpenAI whisper-1 | 対応 | なし | $0.006/分 | $0.36 | https://developers.openai.com/api/docs/models/whisper-1 [公式検索] |
| OpenAI gpt-live-transcribe（ストリーミング） | 対応 | 未確認 | $0.017/分 | $1.02 | https://developers.openai.com/api/docs/pricing [公式検索] |
| Deepgram **Nova-3 Multilingual**（録音済み） | 対応（`ja`） | アドオン **$0.0020/分** | $0.0052/分 | $0.312（話者分離込み $0.432） | https://deepgram.com/pricing [公式検索] |
| Deepgram Nova-3 Monolingual（録音済み） | 日本語単一言語版が使えるかは要確認 | 同上 | $0.0043/分 | $0.258（話者分離込み $0.378） | 同上 [公式検索] |
| Deepgram Nova-3 ストリーミング | 同上 | 同上 | 多言語 $0.0058/分、単一言語 $0.0048/分 | $0.348 / $0.288 | 同上 [公式検索] |
| AssemblyAI **Universal-3.5 Pro**（録音済み） | **対応**（18言語に日本語を含む。対象外の言語は Universal-2 に自動で切り替わる） | アドオン $0.02/時 | $0.21/時 | $0.21（話者分離込み $0.23） | https://www.assemblyai.com/pricing , https://www.assemblyai.com/docs/pre-recorded-audio/universal-3-5-pro [公式検索] |
| AssemblyAI Universal-2 | 対応（99言語） | 未確認 | $0.15/時 | $0.15 | 同上 [公式検索] |
| ElevenLabs **Scribe v2** | 対応（90言語以上。日本語の FLEURS WER 3.1% と記載） | **込み**（最大32話者） | $0.22/時（従量・超過分）。リアルタイムは $0.39/時 | $0.22 | https://elevenlabs.io/pricing/api [公式検索] |
| Google Cloud STT V2 **Chirp 3** | **ja-JP は GA** | **ja-JP 対応**（BatchRecognize のみ） | 標準: $0.016/分（50万分まで）→ $0.01 → $0.008 → $0.004（200万分超） | $0.96（低ボリューム時） | https://cloud.google.com/speech-to-text/pricing , https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3 [公式検索] |
| Google Cloud STT V2 Dynamic Batch | 同上 | 同上 | $0.003/分（最大24時間待ち）。**Chirp 3 に適用されるかは未確認** | $0.18 | 同上 [公式検索] |
| Azure AI Speech（Batch / Fast / Real-time） | ja-JP 対応（Fast transcription） | 対応（Batch で話者分離を有効にすると1ファイル240分まで） | **未確認**（公式ページは価格が動的表示で取得できず。Microsoft Q&A 由来の値（Batch/Fast $0.36/時、Real-time $1.32/時、話者分離アドオン $0.30/時）は検証できていない） | 未確認 | https://azure.microsoft.com/en-us/pricing/details/speech/ （価格未取得）, https://learn.microsoft.com/en-us/azure/ai-services/Speech-Service/fast-transcription-create [公式検索] |

### 3.2 データ保持・学習利用・リージョン・制限

| プロバイダ | 学習利用（デフォルト） | 保持 / ZDR | データリージョン | ファイル制限 | 出典 |
|---|---|---|---|---|---|
| OpenAI | API データは**デフォルトで学習に使わない**（明示的なオプトイン時のみ） | 不正利用監視ログは原則30日。`/v1/audio/transcriptions` は ZDR 対象で、データコントロール表では「学習: No、不正利用監視の保持: None」 | **日本のデータレジデンシーあり**（jp.api.openai.com。transcriptions・chat/completions・batches 等が対象）。2026-03-05 以降に公開されたモデルは地域処理で **+10%**。利用には営業経由の資格確認が必要 | 25 MB（mp3/mp4/mpeg/mpga/m4a/wav/webm） | https://developers.openai.com/api/docs/guides/your-data , https://openai.com/index/introducing-data-residency-in-asia/ , https://developers.openai.com/api/docs/guides/speech-to-text [公式検索] |
| Deepgram | Model Improvement Program あり。`mip_opt_out=true` でオプトアウトすると処理に必要な期間のみ保持 | 「デフォルトで処理後ゼロ保持」との記載あり（MIP との関係は要確認） | EU エンドポイント（api.eu.deepgram.com）GA、インドエンドポイントあり。**日本リージョンは未確認** | 2 GB/ファイル、処理時間上限10分（Whisper は20分）、音声長の上限なし | https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program , https://deepgram.com/learn/deepgram-eu-endpoint-now-generally-available [公式検索] |
| AssemblyAI | Model improvement program あり（ダッシュボードからセルフサービスでオプトアウト） | 録音済みのトランスクリプトはデフォルト30日で自動削除。TTL は最短1時間（1/3/7/30日のプリセットまたは任意）。DELETE 時は元ファイルも即時削除。ストリーミングはオプトアウト時に ZDR | EU（api.eu.assemblyai.com、US と同価格）。**日本リージョンは未確認** | 5 GB / 10時間（/v2/upload 経由のローカルファイルは 2.2 GB） | https://www.assemblyai.com/docs/data-retention-and-model-training , https://www.assemblyai.com/docs/faq/are-there-any-limits-on-file-size-or-file-duration-for-files-submitted-to-the-api [公式検索] |
| ElevenLabs | Enterprise 以外は「データ利用」設定でオプトアウトが必要（Enterprise はデフォルトで学習しない） | Zero Retention Mode は **Enterprise のみ** | データレジデンシー（EU・インド）は Enterprise 機能。**日本は未確認** | 3 GB / 10時間（マルチチャネルは1時間） | https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode , https://help.elevenlabs.io/hc/en-us/articles/29952728805393 [公式検索] |
| Google Cloud STT | デフォルトでは音声・トランスクリプトを記録しない。データロギングにオプトインすると割引価格 | 同左 | リージョンエンドポイントあり。**Chirp 3 の asia-northeast1（東京）提供は未確認** | BatchRecognize は1ファイル最大8時間、1リクエスト最大15ファイル、入力は GCS URI のみ | https://cloud.google.com/speech-to-text/docs/data-logging , https://docs.cloud.google.com/speech-to-text/docs/quotas [公式検索] |
| Azure AI Speech | 未確認 | 未確認 | 未確認（Azure の日本リージョンでの提供は未確認） | Fast transcription: 500 MB 未満・5時間未満（2時間・300 MB 以下で安定した速度） | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits [公式検索] |

### 3.3 重要な注意点

- **OpenAI の旧文字起こしモデル4種（whisper-1、gpt-4o-transcribe、gpt-4o-mini-transcribe、gpt-4o-transcribe-diarize）は 2027-02-26 に提供終了予定**（2026-08-26 に通知）。後継は gpt-transcribe / gpt-live-transcribe（https://developers.openai.com/api/docs/deprecations [公式検索]）。**話者分離を OpenAI だけで実現する場合、後継モデルで話者分離が使えるかは未確認**のため、設計上のリスクになる。
- 話者分離込みのバッチ単価（低ボリューム時）: AssemblyAI $0.23/時 ≒ ElevenLabs $0.22/時 < Deepgram $0.38〜0.43/時 < Google Chirp 3 $0.96/時。

---

## 4. 要約・抽出用の LLM と埋め込み

### 4.1 Anthropic（Claude API）[直]

| モデル | 入力 $/MTok | 出力 $/MTok | キャッシュ読取 | Batch（入/出） | 出典 |
|---|---|---|---|---|---|
| Claude Fable 5.1（最上位） | 10 | 50 | 0.25 | 5 / 25 | https://platform.claude.com/docs/en/about-claude/pricing |
| Claude Opus 5.5 | 4 | 20 | 0.20 | 2 / 10 | 同上 |
| **Claude Sonnet 5.5**（主力候補） | 2 | 10 | 0.20 | 1 / 5 | 同上 |
| **Claude Haiku 4.5**（小型） | 1 | 5 | 0.10 | 0.50 / 2.50 | 同上（https://claude.com/pricing でも同額を確認） |

- Batch API は入出力とも 50% 引き。5分キャッシュの書き込みは入力単価の 1.25 倍、1時間キャッシュは 2 倍。
- **Claude 4.7 以降のモデルは新しいトークナイザーを使い、同じテキストで約30%多くトークンを生成する**（Sonnet 4.6 以前は旧トークナイザー）。コストモデルで日本語のトークン数を見積もる際は要注意。
- 4.6 以降のモデルは 1M コンテキストを標準料金で利用可（長尺の会議トランスクリプトを1回で処理できる）。
- **データ保持と学習利用**: 保持したデータは明示的な許可なく学習に使わない。プラットフォームのドキュメントには「会話内容はデフォルトで保持しない（Covered Models を除く）」とある（https://platform.claude.com/docs/en/manage-claude/api-and-data-retention [直]）。一方、プライバシーセンターの記事は「API の入出力は30日以内に自動削除」と記載（https://privacy.claude.com/en/articles/7996866 [公式検索]）。**どちらが現行の規定かは要確認**。利用規約違反として検知された場合は入出力を最大2年保持。
- **ZDR**: 営業への申請で組織単位に有効化。Fable 5.1 / Mythos 5.1 / Fable 5 / Mythos 5 は30日保持が必須で ZDR の対象外。
- **データレジデンシー**: `inference_geo` は `global`（デフォルト）または `us`。`us` は全トークン区分で **1.1 倍**。workspace geo は `us` のみ。**日本国内での推論は不可**。Bedrock や Google Cloud のリージョナルエンドポイントは +10%（https://platform.claude.com/docs/en/manage-claude/data-residency [直]）。

### 4.2 OpenAI [公式検索]（直接取得はできていないため要再確認）

| モデル | 位置づけ | 入力 $/MTok | キャッシュ入力 | 出力 $/MTok | 出典 |
|---|---|---|---|---|---|
| **GPT-6.1 Sol** | 最新のフラッグシップ | 2.00 | 0.10 | 10.00 | https://developers.openai.com/api/docs/models/gpt-6.1-sol |
| GPT-5.6 Sol | 前世代のフラッグシップ（期間限定の値下げ価格、2026-11-21 頃まで） | 4.00 | 0.40 | 20.00 | https://developers.openai.com/api/docs/models/gpt-5.6-sol |
| GPT-5.6 Terra | 中位 | 2.00 | 0.20 | 12.00 | https://developers.openai.com/api/docs/models/gpt-5.6-terra |
| **GPT-6 Luna** | 小型・大量処理向け | 0.10 | 0.01 | 0.50 | https://developers.openai.com/api/docs/models/gpt-6-luna |

- 入力が 272K トークンを超えるプロンプトは、リクエスト全体が入力 2 倍・出力 1.5 倍。Batch と Flex は 50%。Fast モードは 2 倍。
- 学習利用・保持・ZDR・日本リージョンは 3.2 の OpenAI 行を参照（デフォルトで学習しない、不正利用監視 30日、ZDR は資格審査あり、日本のデータレジデンシーは +10%）。

### 4.3 埋め込み [公式検索]

| モデル | $/MTok | Batch | 出典 |
|---|---|---|---|
| OpenAI text-embedding-3-small | 0.02 | 未確認 | https://developers.openai.com/api/docs/models/text-embedding-3-small |
| OpenAI text-embedding-3-large | 0.13 | 0.065 | https://developers.openai.com/api/docs/models/text-embedding-3-large |
| より新しい OpenAI 埋め込みモデル | **未確認**（検索では見つからず） | — | — |
| Anthropic | 自社の埋め込みモデルは料金表に掲載なし | — | https://platform.claude.com/docs/en/about-claude/pricing [直] |

---

## 5. ストレージ・インフラの単価

### 5.1 AWS 東京リージョン（ap-northeast-1）[PL]

| 項目 | 単価 | 月額換算（730時間） | 出典 |
|---|---|---|---|
| S3 Standard ストレージ | **$0.025/GB-月**（最初の50TB）、次の450TB は $0.024、500TB超は $0.023 | — | AWS Price List API AmazonS3/ap-northeast-1（publicationDate 2026-09-28） |
| インターネットへのデータ転送（東京から） | $0.114/GB（最初の10TB、グローバル無料枠の超過分）、次の40TB は $0.089 | — | AWSDataTransfer/ap-northeast-1（2026-09-16） |
| RDS PostgreSQL db.t4g.micro Single-AZ | $0.025/時 | 約 $18.3 | AmazonRDS/ap-northeast-1（2026-10-01） |
| RDS PostgreSQL db.t4g.small Single-AZ | $0.05/時 | 約 $36.5 | 同上 |
| RDS PostgreSQL db.t4g.medium Single-AZ | $0.101/時 | 約 $73.7 | 同上 |
| RDS Multi-AZ（micro / small / medium） | $0.05 / $0.101 / $0.202 /時 | 約 $36.5 / $73.7 / $147.5 | 同上 |
| RDS gp3 ストレージ（Single-AZ） | $0.138/GB-月 | — | 同上 |
| SES 送信（従量） | **$0.0001/通 = $0.10/1,000通**。添付ファイルは $0.12/GB | — | AmazonSES/ap-northeast-1（2026-09-11） |
| SES Essentials プラン | $0.16/1,000通（〜1,000万通） | — | 同上 |
| SES 無料枠 | 2026-07-21 以降、新規顧客向けの SES 専用無料枠（3,000通/月）は廃止。AWS 全体の Free Tier クレジット（最大 $200）に統合 | — | https://aws.amazon.com/ses/pricing/ [公式検索] |

※ 一般向けの S3 料金ページ（$0.023/GB）は US East の価格。東京は $0.025。

### 5.2 マネージド Postgres の代替 [公式検索]

| サービス | 料金 | 出典 |
|---|---|---|
| Supabase | Pro $25/月（$10/月のコンピュートクレジット込み = Micro 1台分）。Micro $10/月（1GB RAM）、Small $15/月（2GB RAM）。**東京リージョンの有無と地域別価格は未確認** | https://supabase.com/pricing , https://supabase.com/docs/guides/platform/manage-your-usage/compute |
| Render Postgres | 0.1c-256mb $6/月、0.5c-1g $19/月、ストレージ $0.30/GB-月。**東京リージョンの有無は未確認** | https://render.com/pricing , https://render.com/docs/postgresql-legacy-instance-types |

### 5.3 トランザクションメール [公式検索]

| サービス | 見出し価格 | 超過分 /1,000通 | 出典 |
|---|---|---|---|
| Amazon SES（東京） | 従量 $0.10/1,000通 | — | [PL] 上記 |
| Resend | Pro $20/月（50,000通込み） | $0.90 | https://resend.com/pricing , https://resend.com/docs/knowledge-base/what-is-resend-pricing |
| Postmark（10,000通/月プラン） | Basic $15 / Pro $16.50 / Platform $18 | $1.80 / $1.30 / $1.20 | https://postmarkapp.com/pricing |

---

## 6. 未確認事項（人による確認が必要）

1. **商標**: J-PlatPat・USPTO・WIPO はいずれもアクセスできず。「MEETLEDGER」「ミートレジャー」と、「LEDGER」を含む先行商標（Ledger SAS 等）の 9・35・42類での状況。
2. 環境のネットワーク制限により、OpenAI・Deepgram・AssemblyAI・ElevenLabs・Google の価格はすべて公式ドメインの検索スニペット経由。**公式ページで再確認が必要**。
3. Azure AI Speech の価格（全項目）と、データ保持・学習利用のポリシー。
4. OpenAI gpt-transcribe（後継モデル）の話者分離対応と、gpt-4o-transcribe-diarize の分単価。
5. Google Chirp 3 が東京リージョンで使えるか、Dynamic Batch が Chirp 3 に適用されるか。
6. Deepgram で日本語に単一言語の価格（$0.0043/分）が適用されるか。話者分離アドオン（$0.0020/分）は、旧ブログの「無料」という記述と食い違うため要確認。
7. Anthropic API のデフォルト保持期間（ドキュメントの「デフォルトで保持しない」とプライバシーセンターの「30日以内に削除」が食い違う）。
8. YOMEL の公式価格（現在は二次情報のみ）、Otolio（旧スマート書記）の具体的な金額、tl;dv の日本向け提供体制。
9. Granola 訴訟（Chamberlain v. Granola）の一次資料（裁判所の記録）。
10. Supabase・Render の東京リージョンの有無と価格。

<!-- ===== included: research/B_local_asr_audio_capture.md ===== -->

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

<!-- ===== included: research/C_mcp_connectors_consent.md ===== -->

# C. MCP / ChatGPT・Codex / カレンダー等コネクタ / 録音同意・プライバシー / Webセキュリティ 調査メモ

- 確認日: 2026-10-02（全項目共通）
- 目的: MeetLedger（AI会議フォローアップ + MCPサーバ「プラグイン」 + カレンダー連携 + 同意機能）の設計前提を固める
- 本書は法的助言ではない（not legal advice）。法務判断は専門家確認が必要。

## 0. 出典の確度ラベル

この環境では次のドメインがネットワークポリシーで遮断され、本文を直接取得できなかった:
modelcontextprotocol.io / developers.openai.com / help.openai.com / developers.google.com / support.google.com /
learn.microsoft.com / docs.slack.dev / api.slack.com / developers.hubspot.com / www.ppc.go.jp / e-gov / www.meti.go.jp /
eur-lex.europa.eu / edpb / rfc-editor.org / ietf.org / rcfp.org / law.cornell.edu / cheatsheetseries.owasp.org

- **[一次]** = 公式の一次ソースを直接取得して確認（GitHub上の公式リポジトリ、npm registry、Google Discovery API、OIDC discovery 等）
- **[検索要約]** = 公式ページURLの検索結果要約のみで確認（本文は未取得）。実装前に原文の再確認を推奨
- **未確認** = 公式ソースで裏付けが取れなかったもの

---

## 1. Model Context Protocol (MCP)

### 1.1 最新仕様リビジョン
- 最新リビジョンは **`2026-07-28`**（前リビジョンは `2025-11-25`）。[一次]
  - https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/changelog.mdx （確認日 2026-10-02）
  - 公式ブログ: https://blog.modelcontextprotocol.io/posts/2026-07-28/ （確認日 2026-10-02）
- 主な変更点（changelog より）[一次]
  - **ステートレス化**: `initialize`/`notifications/initialized` ハンドシェイク廃止。各リクエストの `_meta` に `io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities` を載せる。
  - **`Mcp-Session-Id` ヘッダ（プロトコルレベルのセッション）廃止**。状態が必要ならサーバ発行のハンドルをツール引数で渡す（SEP-2567）。
  - **`server/discover`** RPC をサーバは MUST 実装。
  - **Multi Round-Trip Requests (MRTR)**: サーバ発の `elicitation/create`・`sampling/createMessage`・`roots/list` を置換。サーバは `resultType: "input_required"` と `inputRequests` を返し、クライアントは `inputResponses` を付けて元リクエストを再送（SEP-2322）。全結果に `resultType` 必須。
  - Streamable HTTP の POST に **`Mcp-Method` / `Mcp-Name` ヘッダ必須**（SEP-2243）。
  - `tools/list` 等に `ttlMs` / `cacheScope` 必須（SEP-2549）。
  - SSE の再開（`Last-Event-ID`）削除。
  - 非推奨（Deprecated, 最低12か月猶予）: Roots / Sampling / Logging、旧 HTTP+SSE トランスポート、**Dynamic Client Registration (RFC7591) → Client ID Metadata Documents (CIMD) を推奨**。
  - 出典: 同 changelog.mdx （確認日 2026-10-02）

### 1.2 トランスポート
- 標準トランスポートは **stdio** と **Streamable HTTP** の2つ。Streamable HTTP は「各メッセージを単一 MCP エンドポイントへの HTTP POST とし、応答は JSON または リクエスト単位の SSE ストリーム」。[一次]
  - https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/transports/index.mdx （確認日 2026-10-02）
- 旧 HTTP+SSE は Deprecated（2025-03-26 以来非推奨）。[一次] changelog.mdx 同上

### 1.3 認可（Authorization）
出典: https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/authorization/index.mdx （確認日 2026-10-02）[一次]
- HTTP系トランスポートは本仕様に SHOULD 準拠、**stdio は本仕様に従わず環境から資格情報を取得**（SHOULD NOT follow）。
- 参照規格: OAuth 2.1 draft-ietf-oauth-v2-1-13 / RFC8414（AS metadata）/ RFC8707（Resource Indicators）/ **RFC9728（Protected Resource Metadata）** / CIMD draft。
- MCPサーバ = OAuth 2.1 リソースサーバ。**MCPサーバは RFC9728 Protected Resource Metadata を MUST 実装**、クライアントはそれで AS を発見。
- 401 応答で `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource", scope="..."` を返す（scope は SHOULD）。
- クライアントは `resource` パラメータ（RFC8707、MCPサーバの正規URI）を認可・トークン両リクエストに MUST 付与。PKCE 必須。
- サーバはトークンの audience が自分宛てであることを MUST 検証。トークンをクエリ文字列に入れてはならない。
- 2026-07-28 追加: RFC9207 `iss` 検証（クライアント MUST）、資格情報を発行 AS ごとに分離（SEP-2352）。

### 1.4 ツールアノテーション
出典: https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts （`interface ToolAnnotations`）（確認日 2026-10-02）[一次]

| フィールド | 意味 | 既定値 |
|---|---|---|
| `title` | 表示名 | – |
| `readOnlyHint` | true なら環境を変更しない | false |
| `destructiveHint` | true なら破壊的更新の可能性（readOnlyHint=false時のみ有意） | **true** |
| `idempotentHint` | 同一引数の繰り返しで追加効果なし（readOnlyHint=false時のみ有意） | false |
| `openWorldHint` | 外部の「開かれた世界」と相互作用 | **true** |

- 「クライアントはアノテーションを信頼済みサーバ由来でない限り **untrusted** として扱う MUST」。[一次] server/tools.mdx
- 「人間がツール呼び出しを拒否できる human-in-the-loop が SHOULD」「操作の確認プロンプト提示 SHOULD」。[一次]
  https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/server/tools.mdx （確認日 2026-10-02）
- → MeetLedger: 読み取り系は `readOnlyHint:true, openWorldHint:false`、Slack投稿/Gmail下書き/HubSpotノート作成は `readOnlyHint:false, destructiveHint:false(追加のみ), openWorldHint:true` を明示（既定値が destructive/openWorld=true なので省略しない）。

### 1.5 Elicitation / 確認
出典: https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/client/elicitation.mdx （確認日 2026-10-02）[一次]
- モード: **form**（構造化入力）と **url**（外部URLへ誘導、機微情報用）。
- サーバは form モードでパスワード・APIキー・アクセストークン・決済情報を MUST NOT 要求。機微情報は URL モード MUST。
- クライアントは要求元サーバの明示、拒否/キャンセル手段、URLモードではドメイン表示と遷移前同意 MUST。
- 2026-07-28 では elicitation は MRTR（`input_required`）経由で返す形。`notifications/elicitation/complete` と `elicitationId` は削除。[一次] changelog.mdx
- 注意: ChatGPT/Codex が 2026-07-28 の elicitation/MRTR をどこまでサポートするかは **未確認**。書き込み確認はホスト側の確認UI（§2.4）に依存する前提で設計し、elicitation は任意の強化策とするのが安全。

### 1.6 TypeScript SDK
- **v2 が安定版**（2026-07-28 仕様実装）。パッケージは分割: `@modelcontextprotocol/server` **2.2.0**（2026-09-28公開）、`@modelcontextprotocol/client` 2.2.0、`@modelcontextprotocol/core` 2.2.0、`@modelcontextprotocol/node` 2.1.0、`@modelcontextprotocol/express` 2.0.1（ほか fastify / hono）。Node.js >= 20、zod ^4 依存。[一次]
  - npm registry: https://registry.npmjs.org/@modelcontextprotocol%2fserver （確認日 2026-10-02）
  - README: https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md （確認日 2026-10-02）
- 旧モノリシック **`@modelcontextprotocol/sdk` の latest は 1.31.0**（2026-09-28）。同版の `LATEST_PROTOCOL_VERSION = '2025-11-25'`（= 2026-07-28 未対応）。v1.x は v2 リリース後少なくとも6か月はバグ/セキュリティ修正継続。[一次]
  - https://registry.npmjs.org/@modelcontextprotocol%2fsdk （tarball 内 dist/esm/types.js を確認）（確認日 2026-10-02）
- サーバAPI（v2）[一次]
  - `import { McpServer } from '@modelcontextprotocol/server'` → `new McpServer({ name, version })`
  - `server.registerTool(name, { title?, description, inputSchema: z.object({...}), outputSchema?, annotations? }, handler)`（v2 では Standard Schema オブジェクト。旧 raw shape は deprecated overload。`server.tool()` は codemod で registerTool に置換）
  - stdio: `import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio'`。**2026-07-28 を stdio で話すには `serveStdio(() => buildServer())`**（`server.connect(new StdioServerTransport())` は 2025 系のみ）。
  - HTTP（推奨エントリ）: **`createMcpHandler(factory)`**（`@modelcontextprotocol/server`）。Web標準 `{ fetch }` ハンドラで、既定 `legacy: 'stateless'` で 2025 系クライアントも同一エンドポイントで処理。Node/Express では `toNodeHandler(handler)`（`@modelcontextprotocol/node`）。
  - v1 の `StreamableHTTPServerTransport` は v2 で **`NodeStreamableHTTPServerTransport`（@modelcontextprotocol/node）** / **`WebStandardStreamableHTTPServerTransport`（@modelcontextprotocol/server）** に改名（オプション `sessionIdGenerator`, `enableJsonResponse` 等と `handleRequest` は同じ）。
  - MRTR: `return inputRequired({ inputRequests: { id: inputRequired.elicit({...}) }, requestState })`、再入時 `ctx.mcpReq.inputResponses` / `acceptedContent(...)`。
  - 出典: https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/migration/upgrade-to-v2.md 、 https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/migration/support-2026-07-28.md （確認日 2026-10-02）
- 移行 codemod: `npx @modelcontextprotocol/codemod@latest v1-to-v2 .` [一次] upgrade-to-v2.md

---

## 2. OpenAI（ChatGPT / Codex）

### 2.1 「プラグイン」概念（2026）
- 2026-07-09 にアプリディレクトリが **Plugin Directory** に移行、プラグインが ChatGPT と Codex 横断の主要な機能配布単位に。[検索要約]
  https://help.openai.com/en/articles/6825453-chatgpt-release-notes / https://openai.com/index/devday-2026-recap/ （確認日 2026-10-02）
- プラグインは skills・apps（MCPサーバ）・app templates を束ねる。Web/デスクトップの ChatGPT（Work・Codex含む）で利用可。Business/Enterprise ではワークスペース内共有可。[検索要約]
  https://help.openai.com/en/articles/20001256-plugins-in-chatgpt （確認日 2026-10-02）
- パッケージ構成: `plugin.json`（必須、ポータブル manifest）、`skills/`、`mcp.json`（任意）、`.codex-plugin/plugin.json`（任意の互換 fallback）、`hooks/`、`assets/`。ZIPでアップロード。[検索要約]
  https://developers.openai.com/plugins/build/plugins （確認日 2026-10-02）
- ChatGPT は 2026-02 に MCP Apps 仕様と完全互換に。[検索要約] https://openai.com/index/devday-2026-recap/ （確認日 2026-10-02）
- 競合情報: 2026-09-29 発表の ChatGPT **Meetings plugin**（macOS デスクトップ、Pro/Business でベータ）。会議ノート・アクションアイテム生成。ヘルプに「開始前に全参加者の同意を確認」「音声はノート作成後に削除」と記載。[検索要約]
  https://help.openai.com/en/articles/20001546-the-meetings-plugin-in-chatgpt （確認日 2026-10-02）

### 2.2 ChatGPT にカスタム MCP サーバを接続する方法（現行）
- 開発者モード: **Settings → Security and login → Developer mode をオン**。[検索要約]
  https://developers.openai.com/api/docs/guides/developer-mode / https://developers.openai.com/plugins/deploy/connect-chatgpt （確認日 2026-10-02）
- **ChatGPT Plugins → 「+」→ 名前・説明 → Connection に公開 MCP URL（`/mcp` パス含む）**。プライベート環境は **Secure MCP Tunnel**（`tunnel_id` 指定）。会話のツールメニュー（composer の Developer mode）から追加。メタデータ変更後は Plugins で **Refresh**。[検索要約] 同上
- 対応プロトコル: SSE と streaming HTTP。認証: OAuth / No Authentication / Mixed。[検索要約] https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt （確認日 2026-10-02）
- 開発者モードの対象プラン: 「Pro, Plus, Business, Enterprise, Education（Web）」。[検索要約] developer-mode ガイド（同上）
  - ⚠ 矛盾情報: 同ヘルプ記事/リリースノートの検索要約に「Full MCP（write含む）は Business/Enterprise/Edu、Pro は read/fetch のみ」との旧記述も出現。**Plus/Pro での write ツール可否は 未確認**（原文要確認）。
- 認証（ChatGPT/Codex 共通）[検索要約] https://developers.openai.com/plugins/build/auth （確認日 2026-10-02）
  - OAuth 2.1 + PKCE、MCP 認可仕様準拠。`/.well-known/oauth-protected-resource`（RFC9728）で `resource` と `authorization_servers` を返す。AS は RFC8414 か OIDC discovery。
  - クライアント登録: **CIMD 優先**（`client_id_metadata_document_supported: true`）、DCR（`registration_endpoint`）、事前登録クライアントも可。
  - リダイレクトURI: AS が issuer 識別要件を満たせば `https://chatgpt.com/connector_platform_oauth_redirect`、満たさなければ `https://chatgpt.com/connector/oauth/{callback_id}`。

### 2.3 Codex の MCP 設定（config.toml）
- 設定ファイル: 既定 `~/.codex/config.toml`、プロジェクト単位は `.codex/config.toml`。[検索要約] https://developers.openai.com/codex/mcp （確認日 2026-10-02）
- フィールド定義は Codex ソースで確認 [一次] https://raw.githubusercontent.com/openai/codex/main/codex-rs/config/src/mcp_types.rs （確認日 2026-10-02）
  - stdio: `command`（必須）, `args`, `env`, `env_vars`, `cwd`
  - Streamable HTTP: `url`（必須）, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `http_headers_helper`, `oauth_resource`, `scopes`, `[...oauth] client_id/callback_port/...`
  - 共通: `enabled`, `required`, `startup_timeout_sec`, `tool_timeout_sec`, `enabled_tools`, `disabled_tools`, `auth`（`oauth` 既定 / `chatgpt` / `ema_auth`）
  - **承認**: `default_tools_approval_mode` と `[mcp_servers.<name>.tools.<tool>] approval_mode` に `"auto" | "prompt" | "writes" | "approve"`
  - 注意: ヘッダは `http_headers`（`headers` ではない）。

```toml
# Streamable HTTP（MeetLedger リモート）
[mcp_servers.meetledger]
url = "https://mcp.meetledger.example/mcp"
bearer_token_env_var = "MEETLEDGER_TOKEN"   # OAuth を使う場合は省略して `codex mcp login meetledger`
default_tools_approval_mode = "writes"       # 値: auto | prompt | writes | approve
tool_timeout_sec = 60

[mcp_servers.meetledger.tools.post_slack_message]
approval_mode = "prompt"

# stdio（ローカル）
[mcp_servers.meetledger_local]
command = "npx"
args = ["-y", "@meetledger/mcp"]
env_vars = ["MEETLEDGER_TOKEN"]
[mcp_servers.meetledger_local.env]
MEETLEDGER_REGION = "jp"
```
- CLI: `codex mcp add <name> --env K=V -- <stdio command>` / `codex mcp add <name> --url https://... [--oauth-client-id ...]` / `codex mcp login <name> [--scopes ...]`。[検索要約] https://developers.openai.com/codex/mcp , https://developers.openai.com/codex/cli/reference （確認日 2026-10-02）
- `writes` / `prompt` の正確な判定ロジック（readOnlyHint を参照するか等）は 未確認（enum 名のみ一次確認）。

### 2.4 書き込みアクション / 確認の要件
- 開発者モードでは **write アクションは既定で確認が必要**。会話内で「承認/拒否を記憶」可能（新規会話では再確認）。[検索要約] https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt （確認日 2026-10-02）
- ツール定義ガイド: `readOnlyHint` は状態を変えない場合のみ true。`destructiveHint` は削除・上書き・取消・権限剥奪・取り消し不能な送信/取引で true（ホストが明示承認を求める）。`openWorldHint` は公開インターネット/外部エンティティにアクセスする場合 true。[検索要約] https://developers.openai.com/plugins/plan/tools （確認日 2026-10-02）
- Plugin guidelines: 境界外へデータを送るアクション（メッセージ投稿・メール送信・ファイルアップロード）は **write として明示し、ホストが確認やプレビューを要求できるように** すること。破壊的アクションはラベルと摩擦（確認）必須。アカウント連携/書き込み権限付与をユーザーに理解させる。[検索要約] https://developers.openai.com/plugins/plugin-guidelines （確認日 2026-10-02）

### 2.5 提出・審査・プライバシーポリシー要件
- 提出者: 組織 Owner、または Apps Management Write（`api.apps.write`）権限保持者。**個人または法人の本人確認（verification）** 完了が必要。ZIPをアップロード→自動チェック→審査→承認後に公開タイミングを選択。[検索要約] https://developers.openai.com/plugins/deploy/submission （確認日 2026-10-02）
- MCP サーバは公開ドメインでホスト（ローカル/テスト用エンドポイント不可）。UI を返す場合は CSP で取得先ドメインを明示。審査用の実在 MCP URL 必須。[検索要約] https://developers.openai.com/plugins/deploy/app-review （確認日 2026-10-02）
- 必要情報: 名称・ロゴ・説明・会社URL・**プライバシーポリシーURL（HTTPS, 1,024文字以内）**・ツール情報・テストプロンプトと期待応答（初回MCP審査で **正例5件・負例3件**）・ローカライズ。[検索要約] 同上 / https://developers.openai.com/plugins/deploy/submission-errors （確認日 2026-10-02）
- プライバシーポリシーには最低限「収集する個人データの種類、利用目的、受領者の種類、保存期間、ユーザーが使える管理手段」を記載。ツール応答は必要最小限（不要なPII・内部ID・認証秘密を返さない）。入力に会話履歴全体や「念のため」の広い文脈を要求しない。[検索要約] https://developers.openai.com/plugins/plugin-guidelines , https://developers.openai.com/plugins/deploy/app-review （確認日 2026-10-02）

---

## 3. カレンダー連携

### 3.1 Google Calendar API スコープ
スコープ一覧と説明は Discovery Document で確認 [一次]
https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest （revision 20260925、確認日 2026-10-02）

| スコープ | 公式説明 | events.list 可 |
|---|---|---|
| `.../auth/calendar.events.owned.readonly` | See the events on Google calendars you own | ○ |
| `.../auth/calendar.events.readonly` | View events on all your calendars | ○ |
| `.../auth/calendar.calendarlist.readonly` | See the list of Google calendars you're subscribed to | ×（calendarList.list 用） |
| `.../auth/calendar.readonly` | See and download any calendar you can access | ○（広い） |
| `.../auth/calendar.events.freebusy` | See the availability on Google calendars you have access to | ○（空き情報のみ想定） |
| `.../auth/calendar.app.created` | Make secondary calendars, and see/create/change/delete events on them | ○（アプリ作成カレンダーのみ） |

- `events.list` を受け付けるスコープ: calendar, calendar.app.created, calendar.events, calendar.events.freebusy, calendar.events.owned, calendar.events.owned.readonly, calendar.events.public.readonly, calendar.events.readonly, calendar.readonly。`calendarList.list` は calendar, calendar.calendarlist, calendar.calendarlist.readonly, calendar.readonly。[一次] 同 Discovery
- **MeetLedger 推奨最小構成**: `calendar.events.readonly`（全カレンダーの予定）、ユーザーにカレンダー選択させるなら + `calendar.calendarlist.readonly`。主カレンダーのみで良いなら `calendar.events.owned.readonly` が最小候補。ただし他者主催の招待予定が owned.readonly で取得できるかは **未確認**（要実機検証）。
- OAuth エンドポイント: 認可 `https://accounts.google.com/o/oauth2/v2/auth`、トークン `https://oauth2.googleapis.com/token`、失効 `https://oauth2.googleapis.com/revoke`、PKCE `S256` 対応。[一次] https://accounts.google.com/.well-known/openid-configuration （確認日 2026-10-02）
- 感度分類（sensitive / restricted）
  - 各 Calendar スコープ個別の分類（Sensitive か Non-sensitive か）: **未確認**（公式ページ https://developers.google.com/workspace/calendar/api/auth が遮断。検索要約は相互に矛盾）。Cloud Console の OAuth 同意画面で表示される分類を正とする。
  - Google Workspace の **restricted** スコープとして列挙されるのは Gmail（readonly / compose / insert / modify / metadata / settings.* / mail.google.com）と Drive 系。Calendar は列挙に含まれていない。[検索要約] https://developers.google.com/workspace/workspace-api-user-data-developer-policy （確認日 2026-10-02）
  - 検証要件: sensitive/restricted を要求するアプリは OAuth アプリ検証が必要。未検証アプリは **新規ユーザー100人上限**。restricted はさらに第三者評価機関による **セキュリティアセスメント**（サーバで保存/送信する場合）。目安: ブランド検証2〜3営業日、sensitive 約10営業日、restricted 約6週間。[検索要約] https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification , https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification , https://support.google.com/cloud/answer/13463073 （確認日 2026-10-02）

### 3.2 Microsoft Graph
- `GET /me/calendarView?startDateTime=..&endDateTime=..` の権限表: **最小権限 = `Calendars.ReadBasic`**（委任・職場/学校、委任・個人MSA、アプリ）、上位 = `Calendars.Read`, `Calendars.ReadWrite`。[一次]
  https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-docs-contrib/main/api-reference/v1.0/includes/permissions/user-list-calendarview-permissions.md （公開先 learn.microsoft.com/graph/api/user-list-calendarview）（確認日 2026-10-02）
- `Calendars.ReadBasic`（委任）: 「本文(body)・添付・拡張以外のイベントを読める」、**管理者同意不要**、個人MSAでも同意可。`Calendars.Read`（委任）: イベント読取（本文含む）、管理者同意不要。アプリ権限の `Calendars.Read` は管理者同意必要。[一次]
  https://raw.githubusercontent.com/microsoftgraph/microsoft-graph-docs-contrib/main/concepts/permissions-reference.md （確認日 2026-10-02）
- → MeetLedger: 会議のタイトル・時刻・参加者だけなら `Calendars.ReadBasic` + `offline_access`（リフレッシュトークン、管理者同意不要）。招待本文内の議題も使うなら `Calendars.Read`。
- OAuth エンドポイント: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` / `.../token`。`{tenant}` は `common` / `organizations` / `consumers` / テナントID。PKCE は全アプリ種別で推奨（SPAは必須）、`S256` 推奨。[一次]
  https://raw.githubusercontent.com/MicrosoftDocs/entra-docs/main/docs/identity-platform/v2-oauth2-auth-code-flow.md , https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration （確認日 2026-10-02）

### 3.3 iCalendar (.ics) フォールバック（OAuth不要）
- RFC 5545（2009-09）。`VEVENT` に `UID`（MUST）、`DTSTAMP`、`DTSTART`、`DTEND`/`DURATION`、`SUMMARY`、`ORGANIZER`（最大1回）、`ATTENDEE`（複数可）。メディアタイプ `text/calendar`、拡張子 `.ics`。[検索要約] https://www.rfc-editor.org/rfc/rfc5545.html （確認日 2026-10-02）
- Google カレンダー: 設定 → カレンダーの統合 → **「iCal 形式の非公開アドレス（secret address）」**。他人と共有すべきでない旨の注意あり。.ics エクスポートも可。[検索要約] https://support.google.com/calendar/answer/37648 , https://support.google.com/calendar/answer/37111 （確認日 2026-10-02）
- Outlook: カレンダーを公開して ICS リンクを取得（購読で自動更新、ファイルインポートは更新されない）。[検索要約] https://support.microsoft.com/en-us/office/introduction-to-publishing-internet-calendars-a25e68d6-695a-41c6-a701-103d44ba151d （確認日 2026-10-02）
- 設計上の注意: 非公開ICS URL は実質的な秘密情報（漏えい＝予定流出）。保存時暗号化・表示時マスク・ユーザーによる再発行手順の案内が必要。RRULE/タイムゾーン(VTIMEZONE)展開の実装コストに注意（推論、出典なし）。

---

## 4. 書き込みコネクタの最小スコープ（明示承認後の作成/投稿）

### 4.1 Slack
- `chat:write`: アプリとしてメッセージ送信（`chat.postMessage` 等）。**ボットがチャンネルメンバーでないと `not_in_channel` / `channel_not_found`**。`chat:write.public` を追加すると公開チャンネルに未参加でも投稿可（`chat:write` 併用必須）。[検索要約] https://docs.slack.dev/reference/scopes/chat.write/ , https://api.slack.com/scopes/chat:write.public （確認日 2026-10-02）
- Incoming Webhooks: スコープ `incoming-webhook`。URL は **単一チャンネルに固定**（インストール時にユーザーが選択）、URL 自体が秘密（漏えいは Slack が検知し失効）。OAuth 応答の `incoming_webhook` に URL が入る。[検索要約] https://api.slack.com/messaging/webhooks （確認日 2026-10-02）
- OAuth v2: `https://slack.com/oauth/v2/authorize`（`scope=` ボット / `user_scope=` ユーザー）→ `oauth.v2.access` で交換。[検索要約] https://docs.slack.dev/authentication/installing-with-oauth/ （確認日 2026-10-02）
- → 最小: 「1チャンネルに投稿だけ」なら `incoming-webhook`（チャンネル固定で権限最小）。複数チャンネル選択なら `chat:write`（+招待運用）、`chat:write.public` は必要時のみ。

### 4.2 HubSpot（ノート）
- HubSpot 公式 OpenAPI 仕様（Notes, 2026-09）で、`POST /crm/objects/2026-09/{objectType}`（作成）・`PATCH`・`DELETE`・batch 系は **`crm.objects.contacts.write`**、`GET`/search/batch read は `crm.objects.contacts.read`（oauth2 / private_apps 共通）。Notes 専用スコープは scopes 一覧に存在しない。OAuth 認可URL `https://app.hubspot.com/oauth/authorize`、トークン `https://api.hubapi.com/oauth/v1/token`。[一次]
  https://raw.githubusercontent.com/HubSpot/HubSpot-public-api-spec-collection/main/PublicApiSpecs/CRM/Notes/Rollouts/424/2026-09/notes.json （確認日 2026-10-02）
- 必須プロパティ `hs_timestamp`、本文 `hs_note_body`（最大65,536文字）、`associations` でコンタクト/会社/取引に関連付け。[検索要約] https://developers.hubspot.com/docs/api-reference/latest/crm/activities/notes/guide （確認日 2026-10-02）
- 取引(deal)へ関連付ける際に `crm.objects.deals.read/write` が追加で要るかは 未確認。

### 4.3 Gmail（下書き作成）
- `users.drafts.create` が受け付けるスコープ: `https://mail.google.com/`, `gmail.addons.current.action.compose`, **`gmail.compose`**（"Manage drafts and send emails"）, `gmail.modify`。下書き作成のみの専用スコープは無く、**最小は `gmail.compose`**（送信権限も含む点に注意）。[一次] https://gmail.googleapis.com/$discovery/rest?version=v1 （revision 20260928、確認日 2026-10-02）
- `gmail.compose` は **restricted スコープ**（restricted scope 検証 + サーバ保存/送信時はセキュリティアセスメント）。[検索要約] https://developers.google.com/workspace/gmail/api/auth/scopes （確認日 2026-10-02）
- → MVP 代替案: Gmail API を使わず「下書き本文をコピー」「`mailto:` リンク」で restricted 検証を回避（設計判断、出典なし）。

---

## 5. 録音・文字起こしの同意とプライバシー（概要・法的助言ではない）

### 5.1 日本
- 秘密録音: 刑事事件で最高裁（平成12年7月12日）は相手方の同意なき会話録音を「違法ではなく、証拠能力は否定されない」と判示したとされる。一方、民事で秘密録音の証拠能力を否定した例（東京高判平成28年5月19日、委員会審議の無断録音）もある。[検索要約・非公式（法律事務所等の解説）] https://szoh-law.jp/2022/08/16/himiturokuonn-ihousei/ , https://ja.wikipedia.org/wiki/%E7%A7%98%E5%AF%86%E9%8C%B2%E9%9F%B3 （確認日 2026-10-02）→ 判決原文は 未確認
- 個人情報該当性: 通話内容から特定の個人を識別できる場合は個人情報に該当。**APPI 上は利用目的の通知又は公表義務はあるが、「録音している旨を伝える義務」までは負わない**（PPC Q&A 1-10）。[検索要約] https://www.ppc.go.jp/all_faq_index/faq1-q1-10/ （確認日 2026-10-02）
- 識別できない録音は原則個人情報に非該当だが、声から特徴量を抽出し話者認識に使えるデータにすれば **個人識別符号**（PPC Q&A 1-11）。[検索要約] https://www.ppc.go.jp/all_faq_index/faq1-q1-11/ （確認日 2026-10-02）→ 話者識別（声紋）機能は要注意
- 利用目的: できる限り特定（法17条1項）、取得時に通知又は公表（法21条1項）。本人が一般的・合理的に予測できる程度の具体性が必要。[検索要約] https://www.ppc.go.jp/all_faq_index/faq4-q103/ , https://www.ppc.go.jp/personalinfo/legal/guidelines_tsusoku/ （確認日 2026-10-02）
- 外国にある第三者への提供（法28条）
  - 原則あらかじめ本人同意。同意取得時に **(1) 移転先の国名 (2) その国の個人情報保護制度に関する情報 (3) 移転先が講ずる保護措置に関する情報** を提供（28条2項）。[検索要約] https://www.ppc.go.jp/personalinfo/legal/guidelines_offshore/ , https://www.ppc.go.jp/all_faq_index/faq2-q5-8/ （確認日 2026-10-02）
  - 例外: 同等水準国（EU/英国）または移転先が **基準適合体制** を整備している場合 → 同意不要だが、相当措置の継続的実施の確保措置と本人の求めに応じた情報提供（28条3項）。**委託でも外国の第三者なら28条が適用**（Q&A 12-1）。[検索要約] https://www.ppc.go.jp/all_faq_index/faq1-q12-1/ , https://www.ppc.go.jp/all_faq_index/faq2-q5-10/ （確認日 2026-10-02）
  - クラウド: 事業者が契約上個人データを取り扱わず適切にアクセス制御している場合は「提供」に当たらない（Q&A 7-53, 12-3）。ただし外的環境の把握（安全管理措置の公表事項）は必要（Q&A 10-25）。[検索要約] https://www.ppc.go.jp/all_faq_index/faq1-q7-53/ , https://www.ppc.go.jp/all_faq_index/faq1-q12-3/ , https://www.ppc.go.jp/all_faq_index/faq1-q10-25/ （確認日 2026-10-02）
  - → 米国 LLM API（OpenAI 等）に文字起こしを送る構成は「委託先が取り扱う」ため 28条の対象になり得る。基準適合体制（DPA等）で処理するか同意取得かを法務確認（推論）。
- **AI事業者ガイドライン 第1.2版**（総務省・経済産業省、令和8年(2026年)3月31日）。対象: AI開発者・AI提供者・AI利用者。プライバシー尊重と関係法令遵守を共通指針として掲げる。[検索要約] https://www.meti.go.jp/shingikai/mono_info_service/ai_shakai_jisso/20260331_report.html , https://www.soumu.go.jp/main_sosiki/kenkyu/ai_network/02ryutsu20_04000019.html （確認日 2026-10-02）→ 第1.2版の具体的変更点は 未確認

### 5.2 米国
- 連邦法 18 U.S.C. §2511(2)(d): 当事者である者、または当事者の一方が事前同意した場合の傍受は違法でない（犯罪・不法行為目的を除く）＝**one-party consent**。州法はより厳格にできる。[検索要約・二次] https://www.law.cornell.edu/uscode/text/18/2511 （確認日 2026-10-02）
- **All-party consent としてよく挙げられる州（RCFP）**: California, Delaware, Florida, Illinois, Maryland, Massachusetts, Michigan, Montana, New Hampshire, Pennsylvania, Washington（約11州）。Connecticut・Nevada は電話のみ全員同意、Oregon は対面会話で全員同意とされる。[検索要約] https://www.rcfp.org/introduction-to-reporters-recording-guide/ （確認日 2026-10-02）
  - 注: Michigan・Delaware は解釈に争いがあるとされることが多い／州ごとの例外は 未確認。多州にまたがるオンライン会議は「最も厳しい州」に合わせ全員通知・同意を既定とするのが実務的（推論）。

### 5.3 EU（GDPR）
- 適法性: Art. 6(1)(a)〜(f) の6根拠のいずれかが必要。正当な利益（6(1)(f)）なら具体的利益を特定し Art.13(1)(d)/14(2)(b) で通知。[検索要約] https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202401_legitimateinterest_en.pdf （確認日 2026-10-02）
- 透明性: Art. 13 — 取得時に管理者の身元・連絡先、DPO連絡先、目的と法的根拠、保存期間、アクセス/訂正/消去/制限/異議/ポータビリティ権等を提供。[検索要約] https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng （確認日 2026-10-02）
- 参考: EDPS（EU機関向け, EUDPR）の生成AIガイダンス改訂版（2025-10-28）に会議文字起こしの例 — 録音と文字起こし処理の双方についての通知/同意、DPIA 事前実施、AI生成である旨の明示。[検索要約] https://www.edps.europa.eu/data-protection/our-work/publications/guidelines/2025-10-28-guidance-generative-ai-strengthening-data-protection-rapidly-changing-digital-era_en （確認日 2026-10-02）※GDPR直接ではない

### 5.4 主要ノートテイカー/会議基盤の同意UX
- **Otter**: Enterprise で会議5〜10分前に招待者全員へ事前録音通知メール。Teams では Otter リンク経由参加者が録音許可ページで同意しないと参加不可（免責文カスタム可）。[検索要約] https://help.otter.ai/hc/en-us/articles/13353091821591-Enforce-pre-meeting-recording-notifications , https://help.otter.ai/hc/en-us/articles/39339238308503-Recording-Permissions-with-Otter （確認日 2026-10-02）
- **Fireflies**: ボットが「Fireflies.ai Notetaker」として参加者一覧に表示（サイレント参加しない）。Opt-out / Opt-in 方式。会議1時間前に録音予告メール（辞退リンクでボット不参加）。会議チャットに録音告知を固定表示。ボットなしデスクトップ録音では音声告知・チャット通知・透かし。[検索要約] https://guide.fireflies.ai/articles/7003995379-Recording+Consent+and+Meeting+Compliance+in+Fireflies%3A+Opt-In%2C+Opt-Out%2C+and+Controls , https://guide.fireflies.ai/articles/3917896272-how-consent-notifications-work-on-the-fireflies-desktop-app （確認日 2026-10-02）
- **Zoom**: 録音中は常に参加者へ通知、デスクトップ/モバイルでは録音同意の免責表示（同意して残るか退出）。小規模アカウントは無効化不可。AI 有効時に明示同意を要求する設定あり。[検索要約] https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0068228 , https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0082011 （確認日 2026-10-02）
- **Google Meet**: 録音開始/停止を通知。「Take notes for me」起動時は全員に通知し鉛筆アイコン表示。管理者は録音・文字起こし・Gemini メモの事前同意を必須化でき、拒否者の退出 or 機能停止を選択。[検索要約] https://support.google.com/meet/answer/14754931 , https://knowledge.workspace.google.com/admin/meet/manage-participant-consent （確認日 2026-10-02）
- **Microsoft Teams**: 明示的録音同意ポリシー（`-ExplicitRecordingConsent`）有効時、録音/文字起こし開始で他参加者はミュート・カメラ/共有オフ、操作時に Yes/No 同意。No は閲覧のみ、同意結果は出席レポートに記録。[検索要約] https://learn.microsoft.com/en-us/microsoftteams/participant-agreement-recording-transcription （確認日 2026-10-02）
- **ChatGPT Meetings plugin**: 「開始前に全参加者の同意を確認」、音声はノート完成後に削除。[検索要約] §2.1 参照

→ MeetLedger 同意機能の要件案（推論）: (1) 事前通知メール（辞退リンク）(2) 会議内告知（チャット/音声）(3) 録音中インジケータ (4) 同意ログ（誰が・いつ・どの文面に）(5) 音声の即時削除オプション (6) 声紋等の話者識別はオプトイン。

---

## 6. Web セキュリティ早見

出典: OWASP Cheat Sheet Series（GitHub 正本）[一次]
- CSRF: https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.md （確認日 2026-10-02）
- Password: https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Password_Storage_Cheat_Sheet.md （確認日 2026-10-02）

### 6.1 CSRF（SPA + Cookie セッション）
- 原則: フレームワーク組込みを優先。無ければ状態変更リクエスト全てに CSRF トークン。**ステートフル→Synchronizer Token、ステートレス→Double Submit Cookie**。`<form>` を使わない API 駆動サイトは **カスタムリクエストヘッダ** を検討。GET で状態変更しない。
- **Signed Double-Submit Cookie（RECOMMENDED）**: セッションIDに束縛した HMAC トークン（サーバ秘密鍵、定数時間比較）。**Naive Double-Submit は DISCOURAGED**（サブドメイン等からの Cookie 注入で回避可能）。
- カスタムヘッダ方式（例 `X-CSRF-Token`）: CORS プリフライトに依存。`Access-Control-Allow-Origin` は自社管理の限定オリジンのみ、`*` と credentials 併用不可。
- Fetch Metadata: モダンブラウザのみ対象なら `Sec-Fetch-Site: cross-site` の非安全メソッドを拒否。ヘッダ欠如時の Origin/Referer 検証フォールバックは **必須**。HTTPS 全面適用、`Vary: Sec-Fetch-Site, Origin`。
- SameSite はセッション Cookie に使用可（Domain 属性で親ドメイン指定しない）。多層防御の一つとして扱う。XSS は全 CSRF 対策を無効化し得る。
- → 推奨構成（推論）: `__Host-` セッション Cookie（Secure, HttpOnly, SameSite=Lax, Path=/）+ Signed Double-Submit（`X-CSRF-Token` ヘッダ）+ Sec-Fetch-Site/Origin 検証。

### 6.2 パスワードハッシュ（OWASP 推奨パラメータ）
- **Argon2id**: 最小 m=19 MiB(19456 KiB), t=2, p=1。同等の代替: m=47104(46MiB),t=1,p=1 / m=12288(12MiB),t=3,p=1 / m=9216(9MiB),t=4,p=1 / m=7168(7MiB),t=5,p=1。
- **scrypt**（Argon2id 不可時）: **N=2^17(128MiB), r=8, p=1**。同等: N=2^16,r=8,p=2 / N=2^15,r=8,p=3 / N=2^14,r=8,p=5 / N=2^13,r=8,p=10。
- bcrypt（レガシーのみ）: work factor ≥10、入力72バイト上限。PBKDF2（FIPS要件時）: HMAC-SHA-256 で 600,000 回以上。
- ハッシュ計算は1秒未満を目安。ログイン時の再ハッシュで work factor を引き上げ。
- 補足（推論）: Node.js `crypto.scrypt` で N=2^17,r=8 は約128MiB を要し、既定 `maxmem`(32MiB) を超えるため `maxmem` 明示が必要 — Node 公式で 未確認。

---

## 7. 未確認事項まとめ
1. ChatGPT Plus/Pro の開発者モードで write ツールが使えるか（検索要約が矛盾）。
2. ChatGPT / Codex が MCP 2026-07-28（MRTR・elicitation）をどこまでサポートするか。
3. Codex `approval_mode = "writes"` が `readOnlyHint` をどう参照するかの正確な仕様。
4. Google Calendar 各スコープの sensitive / non-sensitive 個別分類（Cloud Console で確認要）。
5. `calendar.events.owned.readonly` で他者主催の招待イベントが取得できるか。
6. HubSpot で deal 関連付け時に deals スコープが追加で必要か。
7. 秘密録音に関する判決原文、米国各州の例外詳細（Michigan/Delaware 解釈等）。
8. AI事業者ガイドライン第1.2版の具体的改定内容。
9. 遮断ドメイン由来の [検索要約] 項目全般は、原文での再確認を推奨。
