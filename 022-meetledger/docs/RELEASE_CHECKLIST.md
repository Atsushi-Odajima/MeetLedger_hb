# RELEASE_CHECKLIST — 販売前チェック（MeetLedger #022）

凡例: ✅ = 本開発環境で実施・合格 / 👤 = **人間による確認・判断が必要（未実施）** / ⚠️ = 既知の制限（購入者資料に明記済み）

## A. 名称・商標・法務
| # | 項目 | 状態 |
|---|---|---|
| A1 | 「MeetLedger」の商標調査（J-PlatPat / USPTO / WIPO Global Brand Database、第9・42類）。Web 検索では同名製品なし、類似: joinledger.co、LEDGER（暗号資産ウォレット社） | 👤 未実施（DB にアクセス不可）。問題があれば BRANDING.md の候補名（決め録 / 議事帳 / FollowTrace）から人間が選択。**勝手に改名しない** |
| A2 | 利用規約・プライバシーポリシー（録音/文字起こし/AI 処理/保存期間/委託先/外国移転）の作成 | 👤 |
| A3 | 録音同意に関する法務確認（日本 APPI 17/21/28 条、米国 all-party consent 州、GDPR） | 👤（PRIVACY_CONSENT.md は法的助言ではない） |
| A4 | SenseVoice（FunASR Model License v1.1）の出典表記: アプリ内「設定 → このアプリについて・ライセンス」に表示 | ✅ 実装済 / 👤 ライセンス原文で最終確認 |
| A5 | 3D-Speaker CAM++ 話者埋め込みモデルのライセンス確定、silero VAD のライセンス原文確認 | 👤 要確認（THIRD_PARTY_NOTICES に「要確認」） |
| A6 | THIRD_PARTY_NOTICES（187 本番依存 + モデル + フォント）の確認、Electron/ONNX Runtime の配布物ライセンス同梱 | ✅ 生成済（scripts/gen-third-party-notices.mjs）/ 👤 パッケージ版で同梱確認 |
| A7 | 料金表示: [検索要約] の単価（OpenAI/Deepgram/AssemblyAI/ElevenLabs/Google）を公式料金ページで再確認 | 👤 |

## B. 品質・テスト
| # | 項目 | 状態 |
|---|---|---|
| B1 | 必須テスト #1〜#30 | ✅ server Vitest（TEST_REPORT.md） |
| B2 | E2E-1〜9（Playwright, Chromium） | ✅ 2 連続合格（E2E-8 はモバイル**エミュレーション**） |
| B3 | 性能（10年・50,000 会議・1,000万 segment・50万 Decision・100万 Action/Commitment） | ✅ 主要 API p95 < 0.6 秒（TEST_REPORT.md、販売保証値ではない） |
| B4 | 実会議音声での文字起こし精度（CER）・話者分離精度（DER）の測定（日本語・雑音・重なり発話） | 👤 未測定（同梱クリーン音声のみ確認） |
| B5 | 実機: Windows 10/11 Desktop（WASAPI loopback, NSIS, 署名） | 👤 未検証（手順: DESKTOP_COMPANION.md §10） |
| B6 | 実機: macOS 14.2 / 15 / 26 Desktop（Core Audio Tap, 権限ダイアログ, 署名・公証, dmg） | 👤 未検証（Electron の macOS loopback は不確実 → capability は 'unknown' 表示） |
| B7 | 実機: iPhone（Safari / ホーム画面 PWA）・Android（Chrome PWA） | 👤 未検証（WebKit 未導入、Chromium エミュレーションのみ） |
| B8 | 実 Zoom / Teams / Meet 音声での Desktop 録音 | 👤 未検証 |
| B9 | アクセシビリティ（キーボード・スクリーンリーダー・コントラスト）の人手確認 | 👤（実装は labels/focus/aria-live、ブランド色はコントラスト確認済） |

## C. 外部サービス（いずれも本環境では実接続していない）
| # | 項目 | 状態 |
|---|---|---|
| C1 | OpenAI / Anthropic / Deepgram / Ollama の実 API 呼び出し（AI 抽出・文字起こし・Embedding） | 👤 未検証（FakeHttp で要求形状のみ検証）。既定モデル ID（AI_MODEL）は本番で明示設定 |
| C2 | Google Calendar / Microsoft 365 OAuth（client 作成、同意画面、Google の scope 審査） | 👤 未検証 |
| C3 | Gmail 下書き（`gmail.compose` は restricted scope → Google の審査・セキュリティ評価が必要） | 👤 |
| C4 | Slack / HubSpot / Webhook への実送信 | 👤 未検証（承認フローはテスト済） |
| C5 | ChatGPT への MCP 接続（OAuth 2.1 / RFC 9728 が必要 → **未実装**、Pro 候補）。Codex（config.toml + Bearer token）/ stdio | ⚠️ ChatGPT 不可 / 👤 Codex 実機未検証 |
| C6 | SMTP 実送信 | 👤 未検証（nodemailer の JSON transport で検証） |

## D. セキュリティ・運用
| # | 項目 | 状態 |
|---|---|---|
| D1 | テナント分離（RLS + アプリ ACL）、CSRF、署名 URL、ログ秘匿、SSRF ガード、rate limit | ✅ テスト済（SECURITY.md §8） |
| D2 | 依存脆弱性監査（`npm audit` / Electron 版の更新方針） | ✅ 2026-10-02 `npm audit --omit=dev`: root 0件・desktop 0件 / 👤 リリース直前に再実施・Electron 更新方針 |
| D3 | 外部ペネトレーションテスト | 👤 |
| D4 | TLS 終端（リバースプロキシ）、`COOKIE_SECURE=true`、`APP_ORIGIN`、強い `SESSION_SECRET` / `MASTER_KEY`（production では既定値で起動不可） | 👤 デプロイ時 |
| D5 | MASTER_KEY の保管（紛失すると音声・バックアップ復号不可） | 👤 |
| D6 | バックアップ（CLI backup / pg_dump）と復元訓練、バックアップの暗号化保管と保持世代 | ✅ restore テスト済 / 👤 運用で実施 |
| D7 | Docker image のビルドと compose 起動（本環境は Docker daemon なし） | 👤 未検証 |
| D8 | 本番公開（ドメイン・ホスティング契約） | 👤 **承認が必要なため未実施** |

## E. 販売物
| # | 項目 | 状態 |
|---|---|---|
| E1 | 購入者資料 16 本（buyer-docs/）と UI ラベルの一致 | ✅（最終 UI ラベルで照合） |
| E2 | Brand assets（logo/mark/dark、favicon、apple-touch、PWA 192/512、maskable、OG、Desktop icon）、Brand Board | ✅ |
| E3 | サンプル Workspace（架空データのみ・本番と分離） | ✅ |
| E4 | 価格（49,800 円〜89,800 円）・提供形態（セルフホスト + サポート範囲）の決定 | 👤 |
