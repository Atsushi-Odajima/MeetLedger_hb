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
