# MeetLedger（商品 #022）— 会議しただけで終わらせない。

会話を記録するだけでなく、**「何が決まった・誰がやる・いつまで・次に何を話す」を会議後まで追いかける** AI ミーティング OS。
録音/文字起こし/話者分離/要約に加えて、Decision Ledger・Commitment Ledger・Follow-up Engine・Pre-meeting Brief・
Decision Revisit（矛盾候補）・Open Questions・Relationship Context・Cross-meeting Search・MCP を備えます。

- **対応**: Web / PWA（iPhone・Android）/ Windows・macOS Desktop companion（Electron）/ MCP（Codex 等）
- **既定は Local-first**: 文字起こし=サーバ/PC 内（sherpa-onnx SenseVoice）、AI=local-rules、外部送信なし。クラウド AI/文字起こしは管理者の明示的な opt-in のみ。
- **AI 抽出はすべて「候補」**。人が確認して初めて確定。Transcript にない内容は作らない。
- 録音前に参加者への通知・同意の記録が必要（秘密録音を支援しない）。

## 構成
| パス | 内容 |
|---|---|
| `apps/server` | Fastify API + Job Worker + MCP（PostgreSQL 16 / RLS） |
| `apps/web` | React PWA |
| `apps/desktop` | Electron companion（system audio + local 文字起こし） |
| `packages/shared` / `packages/local-asr` | 共有型・日本語検索 tokenizer / ローカル ASR |
| `e2e/` | Playwright E2E（E2E-1〜9） |
| `docs/` | 設計・運用ドキュメント（下表） |
| `buyer-docs/` | 購入者向け資料（.txt） |
| `brand/` | ロゴ・アイコン・Brand Board |
| `deploy/`, `Dockerfile`, `.env.example` | セルフホスト用 |
| `scripts/` | テスト用 PG、モデル取得、性能データ生成/計測、運用コスト試算 |

## クイックスタート（開発）
```bash
npm install
bash scripts/pg-test.sh start                 # 開発/テスト用 PostgreSQL（127.0.0.1:55432）
bash scripts/download-models.sh               # ローカル文字起こしモデル（任意・約 170MB〜）
export DATABASE_URL=postgres://meetledger:meetledger@127.0.0.1:55432/meetledger LOCAL_ASR_MODEL_DIR=$PWD/models
npm run build && node apps/server/dist/index.js   # http://localhost:8787 → 初回セットアップ
```
本番運用は `buyer-docs/はじめに.txt` と `docs/OPERATIONS.md`（Docker compose: `cd deploy && docker compose --env-file ../.env up -d`）。

## テスト
```bash
npm run test                 # shared + server(Vitest, 実 PostgreSQL) + web
npm run e2e                  # Playwright E2E-1〜9 + smoke
npx tsx scripts/perf/measure.ts   # 性能計測（scripts/perf/generate.mjs で生成した大規模データに対して）
```
結果は `docs/TEST_REPORT.md`。

## ドキュメント
PLAN / PROGRESS / DECISIONS / NEXT_STEPS.txt / DEVELOPMENT / DATA_MODEL / API_CONTRACT / AUDIO_PIPELINE / TRANSCRIPTION / MEETING_MEMORY /
DECISION_LEDGER / COMMITMENT_LEDGER / AI_EXTRACTION / AI_RAG_SECURITY / PRIVACY_CONSENT / CONNECTORS / MCP_PLUGIN / SECURITY /
OPERATIONS / OPERATING_COSTS / TEST_REPORT / RELEASE_CHECKLIST / SOURCE_NOTES（調査・確認日）/ その他（FOLLOWUP_NOTIFICATIONS, RETENTION_DELETE, DESKTOP_COMPANION, BRANDING）

## ライセンス・注意
商用製品（UNLICENSED）。第三者ソフトウェア・モデル・フォントの表示は `buyer-docs/THIRD_PARTY_NOTICES.txt` とアプリ内「設定 → このアプリについて・ライセンス」。
法的適合（録音同意・個人情報保護）を保証するものではありません（`docs/PRIVACY_CONSENT.md`）。
