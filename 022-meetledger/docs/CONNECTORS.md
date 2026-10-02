# Connectors（カレンダー / 外部書き込み / Webhook / API トークン）

担当モジュール: `apps/server/src/modules/connectors/`
（`calendar.ts` `ics.ts` `oauth.ts` `sync.ts` `routes.ts` `externalWrites.ts` `webhooks.ts` `apiTokens.ts` `netguard.ts` `secrets.ts`）。
マイグレーション: `060_connectors_core.sql`。テスト: `test/connectors-calendar.test.ts`, `test/connectors-writes.test.ts`。
調査の出典: `docs/research/C_mcp_connectors_consent.md`（確認日 2026-10-02）。

> **検証状況の凡例** — この開発環境には Google / Microsoft / Slack / HubSpot の OAuth クライアントや実アカウントが無く、外部への実通信も行っていません。
> 外部 API との連携はすべて `FakeHttp`（`deps.http` の偽応答）でテストしています。
> 「**テスト済み（FakeHttp）**」= 本リポジトリのテストで要求形式・処理を確認済み、「**未検証**」= 実サービスでの動作確認をしていない、の意味です。
> **全ての実サービス接続（Google / Microsoft / Slack / HubSpot / Gmail）は 未検証 です。** 本番導入前に各社の開発者コンソールで実機確認してください。

## 0. 原則

| 原則 | 実装 |
|---|---|
| カレンダーは公式 OAuth・最小 scope | Google: `calendar.events.readonly`（任意で `calendar.calendarlist.readonly`）、Microsoft: `Calendars.ReadBasic` + `offline_access`。**読み取りのみ**。プロバイダへの書き込みは一切しない |
| カレンダー無しでも使える | Meeting は手動作成・ICS（ファイル/URL）取り込み・MCP から作成可能 |
| 同期は preview のみ | `sync` / バックグラウンドジョブはプレビュー（`connector_events`）を更新するだけ。Meeting は **選択したイベントの明示 import** でのみ作成（例外: 管理者が明示的に有効化した `autoImport`、既定 OFF） |
| 外部 write は preview → 明示承認 → 1回だけ実行 | `external_write_requests`（`pending_approval` → 承認でのみ送信、payload hash で冪等、再承認しても再送しない）。**API トークン / MCP からは承認できない** |
| トークンは安全に保管 | 全資格情報を `encryptString(deriveKey(MASTER_KEY,'connector'))`（AES-256-GCM）で暗号化して `secret_ciphertext` に保存。API レスポンス・ログに出さない |
| 外部通信は `deps.http.fetch` のみ | kind `connector`（OAuth / カレンダー / 外部 write / ICS URL）、kind `webhook`（送信 Webhook）。`external_calls` にメタデータのみ記録 |
| SSRF 対策 | ユーザー指定 URL（Webhook / 汎用 webhook write / ICS URL）は https のみ（http は development の localhost のみ）、プライベート IP 禁止（env で明示許可時のみ可）、リダイレクトは自動追従しない |
| AI API キーをクライアントに出さない | コネクタ系 API はキー類を返さない（`hasCredentials: true/false` のみ） |

## 1. REST API（`/api/w/:workspaceId/...`）

| Method | Path | 権限 | 内容 |
|---|---|---|---|
| GET | `/connectors` | viewer+ | 自分のコネクタ + Workspace 共有の write コネクタ（Slack/HubSpot/Webhook）。admin は全件のメタデータ。`available` = サーバで OAuth クライアントが設定済みか |
| POST | `/connectors` | **admin** | 共有 write コネクタ登録（`slack` incoming_webhook / bot、`hubspot`、`webhook`）。資格情報は暗号化保存・以後返さない。`webhook` は署名シークレットを**この応答で1回だけ**返す |
| PATCH | `/connectors/:id` | 所有者 / admin | `displayName`、`calendarId`（自分の Google）、Slack 表示名/既定チャンネル（admin）、**`autoImport`（admin のみ）** |
| DELETE | `/connectors/:id` | 所有者 / admin（共有は admin） | 削除。Google はトークン失効（best effort）。プレビューキャッシュも削除。作成済み Meeting は残る |
| POST | `/connectors/ics` | member+ | `{content}`（.ics 本文）または `{url}`（購読 URL, `webcal://` 可）→ コネクタ作成 + プレビュー |
| GET | `/connectors/:provider/start` | member+（**セッションのみ**） | provider = `google_calendar` / `microsoft_calendar` / `gmail` → `{authorizeUrl, scopes, redirectUri}`。`?calendarList=1` で Google カレンダー一覧 scope を追加 |
| GET | `/api/connectors/oauth/callback` | 開始したユーザー本人のセッション | code 交換 → 暗号化保存 → `APP_ORIGIN/settings/connectors?connected=…`（失敗時 `?error=…`）へ 302 |
| POST | `/connectors/:id/sync` | 所有者 | プロバイダから取得してプレビュー更新（**Meeting は作らない**）。`{from?, to?}`（最大 366 日）。アップロード型 ICS は `{content}` で再アップロード |
| GET | `/connectors/:id/events` | 所有者 | キャッシュ済みプレビュー |
| POST | `/connectors/:id/import` | 所有者（member+） | `{eventIds[], visibility?, meetingType?, projectId?}` → `{created, existing, skipped}` |
| GET/POST | `/external-writes` | viewer+ / member+ | 一覧（自分の依頼。admin は他者分も、ただし見えない Meeting 由来は除外）/ 作成（`pending_approval`） |
| POST | `/external-writes/:id/approve` | 依頼者 or admin、**セッションのみ** | 1回だけ実行 |
| POST | `/external-writes/:id/reject` | 依頼者 or admin | 却下（送信しない） |
| GET/POST/DELETE | `/webhooks`, `/webhooks/:id` | **admin** | 送信 Webhook の CRUD |
| POST | `/webhooks/:id/test` | admin | `ping` を配信キューへ |
| GET | `/webhooks/:id/deliveries` | admin | 配信履歴（状態・HTTP ステータス・試行回数のみ） |
| GET/POST/DELETE | `/api-tokens`, `/api-tokens/:id` | **セッションのみ** | API トークン一覧 / 作成（平文は1回だけ表示）/ 失効 |

エラー形式は `API_CONTRACT.md` 共通。見えないコネクタ・依頼は 404。

## 2. カレンダー

### 共通フロー
1. 接続（OAuth / ICS アップロード / ICS URL）
2. **プレビュー**: `sync`（または ICS 作成時）でイベントを取得し `connector_events` に保存。各イベントに `imported`（自分に見える Meeting が既にある）/ `importedByOther`（他メンバーが非公開で取り込み済み。Meeting ID は返さない）を付与。
3. **明示 import**: 選択した `eventIds` だけ Meeting を作成（`source='calendar'`, `calendar_event_id`, `calendar_connection_id`）。
   - 参加者 = 主催者（role organizer）+ 出席者（会議室リソースは除外）。メールで People と照合/作成（core の `createMeeting` を使用）。
   - **再 import で重複しない**: `meetings(workspace_id, calendar_event_id)` の一意インデックス。既存は `existing` として返す（同時実行時も SAVEPOINT + 一意制約で重複不可）。
   - **繰り返し予定は Series にまとめる**: Google `recurringEventId` / Microsoft `seriesMasterId` / ICS `UID` を `series.calendar_recurring_id`（060 で一意インデックス追加）に入れ、同じ Series に紐付け。
   - 可視性は Workspace 既定（`visibility` 指定で上書き）。
4. **バックグラウンド `connectors.sync`**（org-less、`modules/scheduler.ts` が 15 分毎に投入）: 有効なカレンダーコネクタのプレビューだけ更新。
   `config.autoImport === true`（**admin が PATCH で明示有効化した場合のみ**、`autoImportEnabledBy/At` を記録）なら、今後 14 日以内の終日以外の未取り込みイベントを所有者名義で import。既定は OFF。
   併せて期限切れの OAuth state / MCP 確認トークンを削除。
5. `calendar_event_id` はプロバイダ接頭辞付き（`google:<id>` / `ms:<id>` / `ics:<UID>[::<元の開始UTC>]`、300 文字超はハッシュ化）。

イベント本文（description / body）は**保存しません**（タイトル・日時・主催者・出席者のみ）。

### Google Calendar（`google_calendar`）
| 項目 | 内容 |
|---|---|
| 認可 | OAuth 2.0 Authorization Code + **PKCE (S256)**、`access_type=offline`, `prompt=consent`, `include_granted_scopes=false` |
| state | 32 byte 乱数。**サーバ側** `connector_oauth_states` に sha256 で保存、code_verifier は暗号化保存、10 分・1回限り。callback は**開始したユーザー本人のセッション**でのみ成功（他人のブラウザで完了させるアカウント連携 CSRF を拒否） |
| scope | `https://www.googleapis.com/auth/calendar.events.readonly`（必須）、`…/calendar.calendarlist.readonly`（`?calendarList=1` の時のみ）。交換結果の `scope` に必須 scope が無ければ拒否（Granular consent 対策） |
| 読むデータ | `GET calendar/v3/calendars/{calendarId|primary}/events?singleEvents=true&timeMin&timeMax`（`fields` で id/summary/start/end/organizer/attendees/recurringEventId/status のみ取得、最大 8 ページ×250 件） |
| 書くデータ | なし |
| トークン | `{accessToken, refreshToken, expiresAt}` を暗号化保存。期限 60 秒前から `refresh_token` で自動更新し再暗号化保存。`invalid_grant` → `status='error'`, `last_error='reauth_required'`。削除時に `oauth2.googleapis.com/revoke` を best effort 呼び出し |
| 設定 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`。リダイレクト URI = `${APP_ORIGIN}/api/connectors/oauth/callback` を Google Cloud Console に登録 |
| 検証状況 | テスト済み（FakeHttp）: PKCE/state/暗号化保存/非返却/refresh/プレビュー/重複なし import。**実 Google への接続は 未検証**。各 scope の sensitive 分類、未検証アプリの 100 ユーザー上限・アプリ審査の要否は Cloud Console の表示で要確認（**未検証**） |

### Microsoft 365 / Outlook（`microsoft_calendar`）
| 項目 | 内容 |
|---|---|
| 認可 | `https://login.microsoftonline.com/{MICROSOFT_TENANT}/oauth2/v2.0/authorize`、PKCE S256、`response_mode=query`。token 要求にも `scope` を付与 |
| scope | `offline_access https://graph.microsoft.com/Calendars.ReadBasic`（委任・管理者同意不要とされる。本文・添付は読まない） |
| 読むデータ | `GET /v1.0/me/calendarView?startDateTime&endDateTime&$select=…`、`Prefer: outlook.timezone="UTC"`。`@odata.nextLink` は `graph.microsoft.com` 以外なら追従しない |
| 書くデータ | なし |
| トークン | Google と同じ（refresh token はローテーションされた値を保存） |
| 設定 | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT`（既定 `common`） |
| 検証状況 | テスト済み（FakeHttp）。**実 Microsoft Graph は 未検証**（ReadBasic で attendees が返るか等も実機確認が必要） |

### iCalendar（`ics`、OAuth 不要）
- **アップロード**（`{content}`）: ファイル本文は保存せず、解析結果だけをプレビューに保存。更新は再アップロード（`sync {content}`）。
- **購読 URL**（`{url}`）: 非公開 ICS URL は実質パスワードなので**暗号化保存**し、表示は `https://host/…` のマスクのみ。取得は `deps.http`（kind `connector`）、SSRF ガード、リダイレクトは手動で最大 3 回まで各ホップを再検証、サイズ上限。
- パーサ（`ics.ts`, RFC 5545 サブセット、依存ライブラリなし）:
  - 行の折り返し解除（CRLF + 1 空白）、TEXT のエスケープ解除、引用符付きパラメータ
  - `VEVENT` の `UID` `DTSTART` `DTEND` `DURATION` `SUMMARY` `DESCRIPTION` `LOCATION` `STATUS` `ORGANIZER` `ATTENDEE`（`CN` + `mailto:`）。`VALARM` 内のプロパティは無視
  - 時刻: UTC（`Z`）/ `TZID`（IANA 名、Outlook の Windows 名の主要なもの、`/mozilla.org/…/Asia/Tokyo` 形式）/ フローティング・`X-WR-TIMEZONE` / 終日（`VALUE=DATE`、取り込むユーザーのタイムゾーンで 0:00）。DST 対応（`Intl` で壁時計→UTC 変換）
  - `RRULE`: `FREQ=DAILY|WEEKLY` + `INTERVAL` / `COUNT` / `UNTIL` / `BYDAY`（週次）。`EXDATE`、`RECURRENCE-ID` による個別変更・キャンセル。要求範囲内にだけ展開
  - 未対応（`MONTHLY` `YEARLY` `BYMONTHDAY` `BYSETPOS` 序数 `BYDAY` `RDATE` 等）は**最初の 1 回だけ**を `rrule_unsupported` フラグ付きで返す（推測で回数を作らない）。不明 `TZID` は `unknown_tzid`（ユーザーのタイムゾーンとして解釈）
  - 上限: 既定 2,000,000 byte（`ICS_MAX_BYTES`、超過は 413）、5,000 イベント、展開 2,000 件
- 検証状況: パーサと API はテスト済み。Google / Outlook が実際に出力する ICS での確認は **未検証**。

## 3. 外部書き込み（external writes）

### フロー（D15）
1. `POST /external-writes` `{connectorId, text | followupId, subject?, to?, channel?, objectType?, objectId?, meetingId?, acknowledgeConfidential?}`
   - `followupId` を指定すると followup モジュールの下書き（`followup_drafts`）の件名・本文を使い、`external_write_id` を紐付け（Meeting ACL 適用、discarded は不可）。
   - Confidential Meeting 由来の内容は `acknowledgeConfidential: true` が無いと 409（`confidential_ack_required`）、プレビューに `warnings: ['confidential_meeting']`。
   - 応答 = **完全なプレビュー**: 送信先（target）、レンダリング済み本文、プロバイダに送る payload（秘密情報を除く）、`payloadHash`（sha256）。**この時点では外部へ何も送らない。**
   - 同じ payload（コネクタ・種類・宛先・件名・本文）が `pending_approval/approved/executed` で既にあれば、それを返す（`deduplicated: true`）。DB の部分一意インデックスでも保証。
2. `POST /external-writes/:id/approve` — **対話セッションのみ**（API トークン / MCP クライアントは 403）。依頼者本人または admin。
   - 行ロック下で `pending_approval → approved` を確保した 1 リクエストだけが送信（同時承認は 409）。結果を `executed` / `failed` で記録。
   - 実行済みの再承認は `alreadyExecuted: true` を返すだけで**再送しない**。`failed` は終端（自動再送しない。新しい依頼を作成）。
   - 保存する結果は ID / HTTP ステータスのみ（Slack `ts`、Gmail draft id、HubSpot note id）。レスポンス本文は保存しない。
   - 成功時に送信 Webhook `external_write.executed` を発行。
3. `POST /external-writes/:id/reject` → `rejected`（以後承認不可）。
監査ログ: `external_write.requested / executed / failed / rejected`（メタデータのみ）。

### アダプタ
| provider / kind | 送信先・API | 最小 scope / 資格情報 | 書くデータ | 検証状況 |
|---|---|---|---|---|
| `slack` incoming_webhook / `slack_message` | 登録された `https://hooks.slack.com/services/…` に POST `{text}` | Incoming Webhook URL（`incoming-webhook`、チャンネル固定）。URL 自体が秘密 → 暗号化保存 | テキスト 1 件。`& < >` をエスケープし、会議内容からの `<!channel>` 等のメンション注入を無効化 | テスト済み（FakeHttp）／実 Slack **未検証** |
| `slack` bot / `slack_message` | `POST https://slack.com/api/chat.postMessage` `{channel, text}` | Bot token `xoxb-…`（`chat:write`。Bot がチャンネル未参加だと `not_in_channel`。`chat:write.public` は付けない） | 同上。応答 `ok:false` は failed | テスト済み（FakeHttp）／**未検証** |
| `gmail` / `gmail_draft` | `POST https://gmail.googleapis.com/gmail/v1/users/me/drafts`（RFC 2822, UTF-8 base64） | OAuth `https://www.googleapis.com/auth/gmail.compose`（下書き専用 scope は無く、これが最小。送信権限も含む）。**gmail.compose は Google の RESTRICTED scope**: 本番公開には OAuth アプリ審査 + 第三者セキュリティ評価（CASA 等）が必要、未審査アプリは 100 ユーザー上限 | **下書きのみ作成**（送信 API は呼ばない）。宛先・件名は改行禁止（ヘッダインジェクション対策） | アダプタ実装済み・単体の FakeHttp 経路のみ。**実 Gmail・審査とも 未検証**。審査を避けたい場合は「本文コピー / mailto:」運用を推奨 |
| `hubspot` / `hubspot_note` | `POST https://api.hubapi.com/crm/v3/objects/notes`（`hs_note_body` は HTML エスケープ、`hs_timestamp` は実行時刻、`associations` で contact / company / deal に関連付け） | Private App token（`crm.objects.contacts.write`）。deal 関連付けに追加 scope が要るかは **未確認** | ノート 1 件。association type id（note→contact 202 / company 190 / deal 214）は **未検証** | テスト済み（FakeHttp）／**未検証**。新しい日付版 API（`/crm/objects/2026-09/notes`）への移行も要確認 |
| `webhook` / `webhook_post` | 登録 URL に署名付き POST（§4 と同じ署名形式、`x-meetledger-event: external_write`） | URL + 署名シークレット（作成時に1回表示） | `{id, event:'external_write', subject, text, meetingId, followupId, createdAt}` | テスト対象は送信 Webhook と共通の署名・SSRF ロジック |

外部 write の HTTP 呼び出しは `deps.http.fetch`（kind `connector`、`meetingIds` 付き → GuardedHttp が Meeting の存在を再確認）、`redirect: 'manual'`、15 秒タイムアウト。

## 4. 送信 Webhook

- 登録は **admin のみ**（API トークンは role が member 上限のため不可）。`events`: `meeting.created` `meeting.ready` `decision.confirmed` `decision.changed` `action.created` `action.updated` `commitment.updated` `followup.approved` `external_write.executed` `ping` または `*`。
- **URL 制約（SSRF）**: `https://` のみ（`http://localhost` は `NODE_ENV=development` のときだけ）。URL に認証情報不可。ホストが次のいずれかである / に解決されるなら拒否:
  `0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16（メタデータ）, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4, ::, ::1, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 2001:db8::/32, IPv4 埋め込み IPv6（::ffff:… / 64:ff9b::）`、
  および `localhost` / `*.local` / `*.internal` / `*.lan` / ドット無しホスト。解決できないホストも拒否。
  社内向け受信先が必要な場合のみ `CONNECTOR_ALLOW_PRIVATE_NETWORKS=1` で明示許可（ICS URL / 汎用 webhook write にも適用）。
- **配信時に再検証**（DNS 変更・リバインディング対策）し、NG なら送信せず `failed`（`unsafe_url`）。リダイレクトは追従しない。
  残存リスク: 検証と実接続の間の DNS 再解決（TOCTOU）は Node の `fetch` では IP 固定できないため完全には防げない（運用ではエグレスプロキシ / FW の併用を推奨）。
- **署名**: ヘッダ `X-MeetLedger-Signature: t=<unix秒>,v1=<hex>`、`v1 = HMAC-SHA256(secret, "<t>.<raw body>")`。ほかに `X-MeetLedger-Event`, `X-MeetLedger-Delivery`。
  シークレット（`whsec_…`）は作成時に1回だけ表示、暗号化保存。受信側の検証例（Node）:
  ```js
  const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const ok = Math.abs(Date.now() / 1000 - Number(t)) < 300 && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  ```
- **配信**: `webhook_deliveries` に記録し、ジョブ `webhooks.deliver`（キー `webhook:<deliveryId>`、最大 5 回、指数バックオフ 15s→30s→60s…）で送信。2xx で `delivered`、最終失敗で `failed`。10 秒タイムアウト。
- **payload は ID と最小メタデータのみ**（文字起こし・メモ・AI 出力は含めない）。受信側は API トークンで詳細を取得。
- **他モジュールからの発行 API**（tenant tx 内で呼ぶ）:
  ```ts
  import { emitWebhookEvent } from '../connectors';
  await emitWebhookEvent(db, deps, { orgId, workspaceId }, 'decision.confirmed', { decisionId, meetingId }, `decision.confirmed:${decisionId}`);
  ```
  第 6 引数 `dedupeKey` で同一イベントの重複配信を防止。※ 2026-10-02 時点で ledger / followup 等からの呼び出し配線は各モジュール側の作業（未配線のイベントは `ping` / `external_write.executed` のみ発行される）。

## 5. API トークン（MCP / 連携用）

- 作成・一覧・失効は**対話セッションのみ**（トークンでトークンを作れない）。平文 `mlt_…` は作成応答で**1回だけ**表示、DB は `sha256` のみ。
- **Workspace 固定**（`api_tokens.workspace_id`）。他 Workspace へのアクセスは 403。
- scope: `['read']` または `['read','write']`（write は read を含む）。`workspaceCtx` が minRole `member` 以上の操作に `write` を要求 → **read トークンは書き込み不可**（403）。viewer は read のみ作成可。
- トークンの権限は **member 上限**（admin 操作・外部 write 承認・トークン管理・OAuth 開始は不可）。
- 1 ユーザー / Workspace あたり有効トークン 20 個まで。`expiresInDays`（1〜365、省略で無期限）。失効は即時（以後 401）。

## 6. データ保護・ログ

- 資格情報（OAuth トークン、Slack/HubSpot トークン、Webhook URL/シークレット、非公開 ICS URL、PKCE verifier）は `secret_ciphertext` / `verifier_ciphertext` に暗号化保存。`config` には秘密を入れない（返却は許可リストのキーのみ）。
- OAuth callback ルートは `logLevel: 'warn'`（URL の認可コードを info リクエストログに残さない）。プロバイダのエラー本文は保存・返却しない（RFC 6749 の error コードのみ）。
- 新テーブル（`connector_oauth_states`, `connector_events`, `webhook_deliveries`）は org_id + FORCED RLS。

## 7. 環境変数

| 変数 | 用途 |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Calendar / Gmail OAuth |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT` | Microsoft Graph OAuth |
| `APP_ORIGIN` | OAuth リダイレクト URI の基点（`/api/connectors/oauth/callback`）と完了後の戻り先 |
| `MASTER_KEY` | 暗号鍵の元（`deriveKey(MASTER_KEY,'connector')`）。変更すると既存の資格情報は復号不可 → 再接続が必要 |
| `CONNECTOR_ALLOW_PRIVATE_NETWORKS` | `1` でプライベートアドレス宛ての Webhook / ICS URL を許可（既定 OFF） |
| `ICS_MAX_BYTES` | ICS 上限（既定 2,000,000） |

## 8. 未検証・制限事項

- Google / Microsoft / Slack / HubSpot / Gmail への**実接続はすべて未検証**（資格情報なし・外部通信なし）。
- Google 各 scope の sensitive 区分、`calendar.events.owned.readonly` で他者主催の招待が取れるか、Gmail restricted scope 審査の所要は **未確認**。
- Microsoft `Calendars.ReadBasic` での attendees 取得、HubSpot association type id / deal 関連付け scope は **未検証**。
- ICS: `MONTHLY/YEARLY` 等の複雑な RRULE、`VTIMEZONE` 定義のみの独自 TZID は未対応（フラグ付きで最初の 1 回のみ / ユーザー TZ 解釈）。
- Google の複数カレンダー選択 UI は未実装（`PATCH calendarId` で 1 つ指定可能）。
- 送信 Webhook のイベント発行は他モジュールからの `emitWebhookEvent` 呼び出しが必要（未配線分あり）。
- DNS 再解決の TOCTOU は残存（§4）。
