# PROGRESS — MeetLedger (#022)

更新: 2026-10-02。凡例: ✅ 完了（本環境で検証済） / 🟡 実装済・一部未検証 / ⛔ 未実施（人間の承認・実機・契約が必要）

## Phase 状況（§46）
| Phase | 内容 | 状態 | 未完了・未検証 |
|---|---|---|---|
| 0 | 市場/名称/技術/provider/license/料金調査、Audio/Transcription PoC、Privacy 設計 | 🟡 | SOURCE_NOTES.md（確認日・出典付き）。Local ASR PoC は実測済。**商標 DB（J-PlatPat/USPTO/WIPO）は未検索**、一部単価は検索要約のみ |
| 1 | Auth、Workspace、Meeting、Calendar/manual scheduling、RBAC | ✅ | 実 Google/Microsoft OAuth は未検証（ICS・manual は検証済） |
| 2 | Capture/upload、Audio pipeline、Transcription、Speaker、Editor | 🟡 | 実クラウド文字起こし API 未検証、実会議音声の精度未測定、Desktop の system audio は Windows/macOS 実機未検証 |
| 3 | Summary、Decision/Action/Commitment/Open Question 抽出、Review Inbox | 🟡 | local-rules で検証。実 LLM API（OpenAI/Anthropic/Ollama）未検証 |
| 4 | Follow-up、Notifications、Person、Timeline、Project、Recurring | ✅ | SMTP 実送信は未検証（JSON transport で検証） |
| 5 | Pre-meeting Brief、Meeting Memory、Cross-meeting Search | ✅ | — |
| 6 | Semantic/RAG、AI Ask、Contradiction Candidate、AI Privacy | 🟡 | 既定 embedding は lexical（local-hash）。OpenAI embedding・実 LLM は未検証 |
| 7 | Local mode、PWA、Export/Import、Retention | 🟡 | iPhone/Android 実機 PWA 未検証（Chromium エミュレーションのみ） |
| 8 | Connector architecture、MCP Plugin、external write preview | 🟡 | MCP は Bearer token のみ（**ChatGPT 接続に必要な OAuth 2.1 は未実装**）。Codex・各 SaaS 実接続は未検証 |
| 9 | Backup/Restore、Security、Performance、Accessibility | ✅ | 外部ペネトレーションテスト・人手のアクセシビリティ監査は未実施 |
| 10 | Windows/macOS/Web/iPhone/Android E2E、Docs、Branding、Deploy、販売前 check | 🟡 | Web E2E-1〜9 は合格（Chromium）。**Windows/macOS/iPhone/Android 実機 E2E 未実施**、Docker 起動未検証、**本番公開は承認が必要なため未実施**、販売前 check は人間の項目が残る |

**結論: 全 Phase の実装は完了しているが、Phase 0/2/3/6/7/8/10 に未検証項目（実機・実 API・商標・本番公開）が残るため「全体完成」とは報告しない。**

## 完成条件（§48）チェック
| # | 条件 | 状態 |
|---|---|---|
| 1 | Windows/macOS/Web/PWA 主要 UX | 🟡 Web/PWA ✅（Chromium）、Desktop は Linux で smoke 66/66、Win/mac 実機未検証 |
| 2 | Meeting scheduling/manual | ✅ |
| 3 | Capture/upload/manual notes | ✅（ブラウザ mic、ファイル upload、Desktop 2ch 録音、手動メモ・オフライン） |
| 4 | Transcription | ✅ Local（実モデル）/ 🟡 Cloud（未検証） |
| 5 | Speaker diarization/mapping | ✅（local pyannote+CAM++、channel 基準、手動割当） |
| 6 | Transcript editor | ✅（revision 履歴、409、検索、音声シーク=Range 対応） |
| 7 | Summary | ✅（AI 生成表示） |
| 8 | Decision Ledger | ✅ |
| 9 | Decision supersede history | ✅ |
| 10 | Action | ✅ |
| 11 | Commitment Ledger | ✅ |
| 12 | Open Questions | ✅ |
| 13 | Review Inbox | ✅ |
| 14 | Follow-up Draft/Engine | ✅ |
| 15 | Person/Timeline | ✅ |
| 16 | Project/Recurring Meeting | ✅ |
| 17 | Pre-meeting Brief | ✅ |
| 18 | Meeting Memory | ✅ |
| 19 | Cross-meeting Search | ✅ |
| 20 | Semantic/RAG optional | ✅（hybrid FTS + vector、既定 local-hash） |
| 21 | source citation | ✅ |
| 22 | AI privacy / Meeting AI OFF | ✅ |
| 23 | Local transcription option | ✅（サーバ・Desktop。実モデルで検証） |
| 24 | Export/Import | ✅ |
| 25 | Retention/Delete | ✅ |
| 26 | PWA | ✅（manifest/SW/offline outbox）/ 実機未検証 |
| 27 | Connector architecture | ✅（実接続は未検証） |
| 28 | MCP Plugin foundation | ✅ foundation（ChatGPT 用 OAuth は未実装） |
| 29 | Security/Privacy/Consent | ✅ |
| 30 | 必須/E2E/performance tests | ✅（TEST_REPORT.md） |
| 31 | Branding/PWA assets | ✅ |
| 32 | 購入者資料/運用費 | ✅ |
