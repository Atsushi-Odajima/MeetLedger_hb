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
