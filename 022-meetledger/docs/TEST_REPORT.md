# TEST_REPORT — MeetLedger (#022)

実施日: 2026-10-02 / 環境: Linux x86_64 コンテナ（4 vCPU Intel Xeon 2.1GHz, 15GB RAM）, Node 22.22, PostgreSQL 16（テスト用クラスタ: fsync off）,
ffmpeg, Chromium 1194（Playwright）。**Windows / macOS / iPhone / Android 実機は使用していない**（未検証項目は §6）。

## 1. 自動テスト結果（最終実行）
| スイート | コマンド | 結果 |
|---|---|---|
| shared（tokenizer 等） | `cd packages/shared && npx vitest run` | ✅ 4/4 |
| local-asr（実モデル 4 件含む） | `cd packages/local-asr && npx vitest run` | ✅ 10/10 |
| server（実 PostgreSQL・RLS・ジョブ・全モジュール） | `cd apps/server && npx vitest run` | ✅ **203/203（21 files）** |
| server typecheck | `npx tsc -p apps/server/tsconfig.json` | ✅ 0 errors |
| web（unit） | `npm test -w @meetledger/web` | __WEB_UNIT__ |
| web build / typecheck | `npm run build -w @meetledger/web` / `tsc` | __WEB_BUILD__ |
| desktop（unit） | `cd apps/desktop && npx vitest run` | ✅ 58/58（typecheck 0 errors） |
| desktop smoke（Electron, xvfb） | `xvfb-run -a npm run smoke` | ✅ 66/66 checks（desktop engineer 実施）、packaged Linux build 6/6 |
| E2E（Playwright, Chromium） | `npm run e2e` | __E2E__ |
| 依存脆弱性 | `npm audit`（root / desktop） | ✅ 0 vulnerabilities |
| 本番ビルド起動 | `npm run build` → `NODE_ENV=production node apps/server/dist/index.js` | ✅ 自動 migration、PWA/manifest/SW/SPA 配信、CSP 等ヘッダ、setup→sample→meeting 作成、CSRF なし POST=403、`dist/cli` backup |

## 2. 必須テスト（§38）対応表
| # | 内容 | テスト | 結果 |
|---|---|---|---|
| 1 | audio import → transcript | audio.test.ts | ✅ |
| 2 | processing job 再送で duplicate なし | audio.test.ts | ✅ |
| 3 | inaudible を補完しない | audio.test.ts | ✅ |
| 4 | speaker mapping 修正 | audio.test.ts | ✅ |
| 5 | AI Decision は Candidate | ledger.test.ts | ✅ |
| 6 | Confirmed Decision の source range | ledger.test.ts | ✅ |
| 7 | superseded Decision 履歴 | ledger.test.ts | ✅ |
| 8 | Action 担当/期限不明を捏造しない | ledger.test.ts | ✅ |
| 9 | Commitment promisedBy/To | ledger.test.ts | ✅ |
| 10 | Open Question → 次回 Brief | ledger.test.ts, followup.test.ts | ✅ |
| 11 | Follow-up に存在しない約束を追加しない | followup.test.ts | ✅ |
| 12 | Person timeline | followup.test.ts | ✅ |
| 13 | Project current Decision | followup.test.ts | ✅ |
| 14 | recurring 前回 Action | followup.test.ts | ✅ |
| 15 | cross-meeting search citation | search.test.ts | ✅ |
| 16 | ACL 外 Meeting を search/RAG で返さない | search.test.ts | ✅ |
| 17 | AI OFF Meeting を provider へ送らない | ledger-ai.test.ts, search-privacy.test.ts, privacy-guard.test.ts | ✅ |
| 18 | deleted Meeting を vector から削除 | data.test.ts, search.test.ts | ✅ |
| 19 | prompt injection 耐性 | ledger-ai.test.ts, search.test.ts | ✅ |
| 20 | connector write 前確認 | connectors-writes.test.ts | ✅ |
| 21 | notification 重複なし | followup-notify.test.ts | ✅ |
| 22 | retention delete | data.test.ts | ✅ |
| 23 | export/import | data-export.test.ts | ✅ |
| 24 | Backup/Restore | data-backup.test.ts（新 DB へ restore、件数・関係・メディア復号・ログイン） | ✅ |
| 25 | tenant A→B 拒否 | tenant.test.ts（API + RLS + 非 superuser ロール） | ✅ |
| 26 | signed URL 期限 | audio.test.ts | ✅ |
| 27 | secret log 非露出 | security.test.ts（全ログ行を走査: パスワード・API キー・セッション・CSRF・Transcript・メモ・質問） | ✅ |
| 28 | local mode 時 cloud transcription call 0 | audio.test.ts（FakeHttp 0 件・external_calls 0 行、cloud 時 1 件の陽性対照） | ✅ |
| 29 | transcript edit 後の source 整合 | ledger.test.ts（source status `edited`、ID/引用保持） | ✅ |
| 30 | Review Inbox Accept/Edit/Reject | ledger.test.ts | ✅ |

## 3. E2E（§39）
__E2E_TABLE__

## 4. 性能（§40）— 販売保証値ではない
### 4.1 生成データ（scripts/perf/generate.mjs, 生成 6.2 分）
10 年分・Meetings **50,000**・Transcript segments **10,000,000**（6.2GB）・Decisions **500,000**・Actions+Commitments **1,000,000**・Questions 100,000・search_docs 160 万。
### 4.2 API レイテンシ（in-process `fastify.inject`、RLS/ACL 有効、10 回・ウォームアップ 2 回、`scripts/perf/measure.ts`）
**既定構成（ts_match_vq NOT LEAKPROOF = マネージド DB 想定）**
| case | status | p50 ms | p95 ms | max ms | response bytes |
|---|---|---|---|---|---|
| search: 価格 (common, 2-char JA) | 200 | 84 | 91 | 91 | 13860 |
| search: ProofFlow | 200 | 78 | 95 | 95 | 13829 |
| search: 公開日 11月 (AND) | 200 | 87 | 105 | 105 | 13892 |
| search: rare phrase 研修の日程 | 200 | 86 | 89 | 89 | 13820 |
| search: no match (zzqxj) | 200 | 349 | 350 | 350 | 300 |
| search: 価格 + person filter | 200 | 41 | 53 | 53 | 14554 |
| search: 価格 + project filter | 200 | 86 | 104 | 104 | 14564 |
| ask: 価格について何を決めた？ (local) | 200 | 75 | 81 | 81 | 1327 |
| brief: last meeting of series (167 meetings) | 200 | 90 | 115 | 115 | 17380 |
| project memory (250 meetings) | 200 | 54 | 66 | 66 | 27774 |
| series memory (167 meetings) | 200 | 39 | 48 | 48 | 21773 |
| person timeline (75 meetings) | 200 | 34 | 37 | 37 | 39734 |
| topic memory: 公開日 | 200 | 525 | 575 | 575 | 34738 |
| dashboard | 200 | 168 | 198 | 198 | 40738 |
| decisions current (first page) | 200 | 303 | 331 | 331 | 41892 |
| actions assignee=me | 200 | 135 | 158 | 158 | 45369 |
| meetings list (50) | 200 | 6 | 10 | 10 | 40811 |
| meeting transcript (200 segments) | 200 | 9 | 10 | 10 | 47196 |
| review inbox | 200 | 285 | 289 | 289 | 109788 |

改善前（初回計測）: search 10.3 秒〜timeout(>15s)、dashboard 23 秒(500)、brief/project/series memory 3.3〜3.8 秒、review inbox 6.9 秒(1.5MB)、decisions 1.2 秒。
原因と対策: RLS 下では非 leakproof 演算子（`@@`、配列演算子）や COALESCE 式で index が使えない → recency window 検索、keyset pagination、
主キー経由の ACL 判定、件数上限＋総数、JIT 無効化、索引追加（migrations 021/022/031/041）。詳細は AI_RAG_SECURITY.md §10 ほか。

**LEAKPROOF 構成（セルフホストで `ALTER FUNCTION ts_match_vq LEAKPROOF` を実行した場合, hybrid 判定後）**: 公開日 11月 p50 80 / p95 100ms、研修の日程 69/82ms、
価格+person 37/47ms、価格 64/75ms、該当なし語 8〜14/14〜19ms（完全一致経路）、ask 82/98ms（search engineer 計測、CPU ベンチ並行中）。
既定構成では「該当なし/稀な語」は時間予算で打ち切り `truncated:true` + 期間指定のヒントを返す（約 350ms）。

### 4.3 パイプライン（`scripts/perf/pipeline.ts`, perf/out/pipeline.json）
| 項目 | 結果 |
|---|---|
| Upload: 60 分 Opus 64kbps（30.3MB）multipart | 460ms（65.8 MB/s, in-process） |
| Local 文字起こし: 60 分（SenseVoice int8 + VAD + 話者分離 + DB 書込み） | 492.5 秒 = **RTF 0.137**、500 segments、external calls **0** |
| Local 文字起こし: 短いクリップ（audio engineer 計測） | RTF ≈ 0.12（ASR のみ）/ 0.21（話者分離込み） |
| AI 抽出（local-rules）: 1 時間 transcript（900 segments） | 1.19 秒（index.meeting 含む）。候補は種類ごとの上限あり |
| Audio queue（8 × 60 秒、実 local ASR） | concurrency 1: 7.67 / 2: 7.02 / 4: 6.27 audio-sec per wall-sec → **4 vCPU では並列化の効果なし**（各ジョブが全コアを使用）。WORKER_CONCURRENCY は 1〜2 推奨 |

### 4.4 文字起こし品質（参考）
同梱クリーン音声: 日本語 ja.wav で 1 語誤り（「持っていけない」→「持っていきない」）、英語 en.wav で 1 語誤り。話者分離 30/30 正解（短いテスト）。
**実会議音声での CER/DER は未測定**（RELEASE_CHECKLIST B4）。

## 5. 手動/目視確認
- Brand Board / アイコン 16〜512px の視認性（brand engineer + lead 目視）。
- Web UI 360px 幅で横スクロールなし（web engineer, Chromium）。
- 本番ビルドの起動と主要フロー（§1）。

## 6. 未検証（この環境では実施不可・人間が実施）
Windows/macOS Desktop の system audio 録音・署名・公証・インストーラ、iPhone Safari/Android Chrome 実機 PWA（WebKit 未導入、E2E-8 は Chromium エミュレーション）、
実クラウド API（OpenAI/Anthropic/Deepgram/Ollama）、Google/Microsoft OAuth、Slack/HubSpot/Gmail 実送信、SMTP 実送信、ChatGPT 接続（OAuth 未実装）、
Codex 実機、Docker image ビルド/compose 起動、実会議音声の精度、外部ペネトレーションテスト。→ RELEASE_CHECKLIST.md
