# PLAN — MeetLedger (#022)「会議しただけで終わらせない。」

## 目的
録音・文字起こし・要約で終わる AI Notetaker ではなく、**「何が決まった・誰がやる・いつまで・次に何を話す」を次の会議まで追いかける**
Meeting OS。Meeting準備 → 過去Meeting/人物/未完了約束Brief → Capture → Transcription → Speaker → AI Summary →
Decision/Action/Commitment/Open Question 抽出（Candidate）→ 人間確認 → 担当/期限 → Follow-up → Reminder → 完了 → 次回Brief。

## 非目標（§41 今回広げない）
高度CRM、営業自動送信、Cold Email、汎用Project Management、従業員監視、感情認識、採用候補者の人格評価、秘密録音支援、
面接不正回答、電話盗聴、AIによる人事評価、医療/法律助言、無断Voice Clone。Pro候補（§42）は初版に入れない。

## アーキテクチャ
| 層 | 採用 | 理由 |
|---|---|---|
| Web/PWA | React 19 + Vite 8 + react-router 7、独自軽量コンポーネント、Service Worker + IndexedDB | 依存最小・PWA制御を自前で |
| Server | Node 22 + Fastify 5 + zod 4 | スキーマ検証・性能・単一言語(TS) |
| DB | PostgreSQL 16（RLS強制、tsvector GIN、real[] 埋め込み） | テナント分離をDB層でも保証、10年分データに耐える |
| 日本語検索 | 自前 bigram tokenizer → tsvector/tsquery リテラル | OSロケール/拡張(pg_bigm等)不要、どの環境でも同一挙動 |
| Object Storage | ローカル暗号化FS（AES-256-GCM, org別鍵）既定 / S3互換 adapter | 自己ホスト容易、保存時暗号化 |
| Jobs | Postgres jobs テーブル（SKIP LOCKED リース、冪等キー） | 追加インフラ不要、重複処理防止 |
| Transcription | Provider抽象: local-sherpa（既定）/ fixture / OpenAI / Deepgram | Local-first、lock-in回避 |
| AI | Provider抽象: local-rules（既定・外部送信なし）/ Ollama / OpenAI / Anthropic | 同上 |
| Embedding | local-hash（既定）/ OpenAI / Ollama | 同上 |
| Desktop | Electron 44 companion（system audio loopback + local ASR） | 調査結果（DECISIONS.md） |
| MCP | /mcp Streamable HTTP（Bearer token、write は2段階確認） | ChatGPT/Codex 連携基盤 |

## Phase 計画（§46）と担当範囲
| Phase | 内容 | 主な成果物 |
|---|---|---|
| 0 | 市場/名称/技術/provider/license/料金調査、Audio/Transcription PoC、Privacy設計 | SOURCE_NOTES.md, research/*, local-asr 実測 |
| 1 | Auth、Workspace、Meeting、manual scheduling、RBAC | modules/core, RLS, tests core/tenant |
| 2 | Capture/upload、Audio pipeline、Transcription、Speaker、Editor | modules/audio, packages/local-asr |
| 3 | Summary、Decision/Action/Commitment/Open Question抽出、Review Inbox | modules/ledger, providers/ai |
| 4 | Follow-up、Notifications、Person、Timeline、Project、Recurring | modules/followup |
| 5 | Pre-meeting Brief、Meeting Memory、Cross-meeting Search | modules/followup, modules/search |
| 6 | Semantic/RAG、AI Ask、Contradiction Candidate、AI Privacy | modules/search, modules/ledger |
| 7 | Local mode、PWA、Export/Import、Retention | local-asr, apps/web SW, modules/data |
| 8 | Connector architecture、MCP Plugin、external write preview | modules/connectors, mcp/ |
| 9 | Backup/Restore、Security、Performance、Accessibility | cli backup/restore, scripts/perf, TEST_REPORT |
| 10 | Windows/macOS/Web/iPhone/Android E2E、Docs、Branding、Deploy、販売前check | e2e/, buyer-docs/, brand/, RELEASE_CHECKLIST |

各 Phase の完了/未完了/未検証は PROGRESS.md と TEST_REPORT.md に記録する。**未完成 Phase があれば全体完成と報告しない。**

## 人間の承認が必要な行為（自動では行わない）
有料契約、実課金、本番公開、実会議録音、実 Calendar/Email/CRM 接続、実参加者への通知/メール、実個人データの外部AI送信、秘密情報の利用。
