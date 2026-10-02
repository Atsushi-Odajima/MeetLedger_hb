# MeetLedger ブランドガイドライン

> 会議しただけで終わらせない。

アセット一覧と再生成手順は [`brand/README.md`](../brand/README.md)、全体像は [`brand/brand-board.png`](../brand/brand-board.png) を参照。

---

## 1. コンセプト

**「会話が、そのまま “済み” になる。」**

吹き出し（会議での会話）のしっぽが、途切れずにチェックマーク（約束の完了）へつながる。吹き出しの中の 2 本の線は台帳（Ledger）の行。会議の記録、決まったこと、やること・約束、次回のフォローアップという流れを、1 本の線で表した。

- 録音マイクのモチーフは使わない。録音は手段であり、価値は「決まったことが実行される」こと。
- 人物写真は使わない。人物を描くときは単色のシルエット（頭＋肩）だけにする。
- トーン：modern / professional / calm / trustworthy。派手なグラデーションや装飾は使わない。

## 2. ロゴの構成

### マーク（64×64 グリッド）

| 要素 | 仕様 |
|---|---|
| 吹き出し＋チェック | 1 本の連続した線。線幅 6.5、角丸半径 12（線の中心）、端と角は丸（round cap / round join） |
| 吹き出し本体 | 中心線で x 8–56 / y 10–44 |
| しっぽ＝チェック | 左下の角 (20,44) → 頂点 (27,53) → 右上へ伸びて (44,28) で止まる |
| 切れ目 | 右下の角は (44,44) で止め、チェックの長い線との間に約 2.5 の切れ目を残す（つなげない） |
| 台帳の行 | 線幅 4.5（外枠より細く）。(19.5–33, 21.5) と (19.5–25, 30) |
| 配置 | 線の外形（4.75–59.25 × 6.75–56.25）がキャンバスのほぼ中央に来る |

幾何と色の正本は `brand/scripts/build.py` にある。手で SVG を直接編集しないこと。

### 横組み（ロックアップ）

- ワードマーク「MeetLedger」は **Inter Display SemiBold** をアウトライン化したもの。トラッキング −0.01em、カーニングあり。
- キャップハイト = 26（マークの高さ 64 に対して約 0.41）。
- マークとワードマークの間隔 = キャップハイト × 0.55。
- ベースライン = 40。大文字が吹き出し本体の上下中央に来る位置。
- 色分け：「Meet」は Ink、「Ledger」は Ledger Teal。どちらも同系色で、差は控えめにしている。

### 小サイズ用の別形（16px）

16px では台帳の行を省き、吹き出しの右辺を開けて、チェックを Mint で描く（`favicon.svg`、`favicon.ico` の 16px）。32px 以上では通常のアプリアイコンを使う。

## 3. カラー

コントラスト比は WCAG 2.x の式で計算した。本文テキストは 4.5:1 以上、図形・UI 部品は 3:1 以上を基準にしている。

### ブランドカラー

| トークン | HEX | 用途 | コントラスト |
|---|---|---|---|
| `--ml-teal`（Ledger Teal / Primary） | `#0F4C5C` | マーク、Primary ボタン、アプリアイコンの地 | 白地で 9.51、白文字を載せて 9.51 |
| `--ml-ink`（Ink） | `#0B2A33` | 本文、ワードマークの「Meet」 | 白地で 15.07、Paper 地で 14.24 |
| `--ml-teal-800` | `#0B3A46` | Primary の押下状態 | — |
| `--ml-teal-50` | `#EAF4F3` | 薄い面（チップ、選択状態） | Teal 文字を載せて 8.48 |
| `--ml-green`（Commit Green / Accent） | `#1E9E82` | ロゴの台帳行、完了チェック、図形のアクセント（明るい背景） | 白地で 3.35（図形用。本文には使わない） |
| `--ml-green-700` | `#147A64` | アクセント色の文字（明るい背景） | 白地で 5.25、Paper 地で 4.96 |
| `--ml-mint`（Mint） | `#5FD4BC` | 暗い背景や Teal 地でのアクセント、ダークモードの Primary | Night 地で 10.17、Teal 地で 5.27 |
| `--ml-indigo` | `#3D4FA0` | Secondary（リンク、フォーカス、AI・検索の補助色） | 白地で 7.44 |
| `--ml-indigo-300` | `#9AA8F0` | ダークモードの Secondary | Night 地で 8.07 |

### ステータス色

| トークン | HEX | 用途 |
|---|---|---|
| `--ml-amber` | `#E3A33B` | 期限・注意を示す図形（塗り）。白地では 2.19 しかないので**文字には使わない** |
| `--ml-amber-800` | `#8A5A00` | 期限・注意の文字（白地で 5.93） |
| `--ml-red` / `--ml-red-300` | `#B42318` / `#F97066` | エラー（明るい背景 6.57、暗い背景 6.59） |

### ニュートラル

| トークン | HEX | 用途 |
|---|---|---|
| `--ml-paper` | `#F6F9F9` | アプリの背景（ライト） |
| `--ml-white` | `#FFFFFF` | カードなどの面 |
| `--ml-gray-100` | `#EEF3F4` | 控えめな塗り |
| `--ml-gray-300` | `#C2CFD2` | 装飾用の罫線（区切りだけ。1.60） |
| `--ml-gray-400` | `#7D9196` | フォーム部品の枠線（白地で 3.30） |
| `--ml-gray-600` | `#51646A` | 補足テキスト（白地で 6.21） |
| `--ml-night` | `#0A161B` | アプリの背景（ダーク） |
| `--ml-night-900` / `--ml-night-800` | `#102229` / `#1A3038` | ダークモードの面と罫線 |
| `--ml-frost` / `--ml-frost-300` | `#EAF5F3` / `#9DB3B8` | ダークモードの文字と補足文字（Night 地で 16.49 / 8.37） |

意味ベースのトークン（`--ml-color-bg`、`--ml-color-primary` など）は、ライト用とダーク用を `brand/tokens.css` と `tokens.json` に用意してある。ダーク側は `prefers-color-scheme` で切り替わる。

> 実装との差異：現在の `apps/web/index.html` と `manifest.webmanifest` の `theme_color` は `#0e5a63`（ダークは `#0b1f24`）、`background_color` は `#f6f7f9` になっている。ブランドトークンに合わせるなら、それぞれ `#0F4C5C`、`#0A161B`、`#F6F9F9` が推奨値。この作業ではこれらのファイルを変更していない。

### ロゴの色の組み合わせ

| 背景 | 線（吹き出し＋チェック） | 台帳の行 | 「Meet」 | 「Ledger」 |
|---|---|---|---|---|
| 明るい背景（白・Paper） | Teal `#0F4C5C` | Green `#1E9E82` | Ink | Teal |
| 暗い背景（Night など） | Frost `#EAF5F3` | Mint `#5FD4BC` | Frost | Mint |
| アプリアイコン（Teal 地） | White | Mint | — | — |
| 単色 | `currentColor`（`logo-mark-mono.svg`） | 同じ色 | — | — |

## 4. タイポグラフィ

- **UI はシステムフォントを使う。** Web フォントは同梱しない。

  ```css
  font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN",
               "Yu Gothic UI", "Meiryo", "Noto Sans JP", "Noto Sans CJK JP", sans-serif;
  ```

  `tokens.css` の `--ml-font-ui` に同じ値が入っている。
- **ワードマークだけは Inter Display SemiBold（SIL OFL 1.1）のアウトライン。** SVG パスに変換済みなので、フォントのインストールも同梱も要らない。ロゴを UI のテキストで組み直さないこと。
- og.png とブランドボードの和文は、Noto Sans JP 2.004（SIL OFL 1.1）で画像にしたもの。ビルド時に一時ディレクトリへダウンロードして使い、リポジトリには入れていない。
- 用語は、一般語を先に出し、専門用語を後に添える。
  - 会議を記録（Transcription / Speaker Diarization）
  - 決まったこと（Decision Ledger）
  - やること・約束（Commitment Tracking）
  - 次回準備
  - 検索・AIに聞く（Semantic Search / MCP）
  - プライバシー・Local mode
- フォントの出典、バージョン、ハッシュは `brand/THIRD_PARTY_FONT_NOTICE.txt` に記録してある。

## 5. クリアスペースと最小サイズ

- **クリアスペース**：ロゴの周囲に、マークの高さの 1/4 以上の余白を取る。64 グリッドでは 16、マークが 48px なら 12px。SVG のキャンバスには 4.75 ぶんの余白が含まれている。
- **最小サイズ**

| 形 | 画面 | 印刷 |
|---|---|---|
| 横組み | 幅 120px 推奨、96px が下限 | 幅 30mm |
| マーク（背景なし） | 24px | 6mm |
| 24px 未満 | `favicon.svg`（16px 用の別形）を使う | — |

- **検証方法**：Playwright の Chromium で 16 / 32 / 48 / 64 / 192 / 512px に書き出し、等倍と最近傍補間の拡大で目視した。白、Paper、Night、ブラウザのタブ（ライト `#DEE1E6`、ダーク `#202124`）の各背景で確認している。16px では台帳の行が潰れ、チェックが外枠に埋もれたため、別形を作った（§2）。

## 6. Do / Don't

**Do**

- 明るい背景には `logo-horizontal.svg`、暗い背景には `logo-horizontal-dark.svg` を使う。
- アイコンやタイルには `app-icon*.svg` の派生物を使う。
- 小さな場所ではマークだけにする。16px には専用の別形を使う。
- 色は必ずトークンから取る。
- 人物はシルエットで、機能はピクトグラムで表す。

**Don't**

- マイク、波形だけ、録音ボタンをロゴの主役にしない。
- 吹き出しとチェックの間の切れ目を埋めたり、線を閉じたりしない。
- 台帳の行の本数・長さ・色を変えない。
- 縦横比を変える、回転する、影・グラデーション・縁取りを足す、といった加工をしない。
- ワードマークを別のフォントで組み直さない。字間も変えない。
- コントラストが足りない背景に載せない。Teal のマークを Night の背景に置くと 1.93:1 しかないので、ダーク版を使う。
- 写真の上に直接載せない。載せる場合は単色の面を敷く。
- Green `#1E9E82` や Amber `#E3A33B` を本文の文字色にしない。
- フォントファイルをリポジトリや製品に無断で同梱しない。

## 7. アセット一覧

| 場所 | ファイル |
|---|---|
| `brand/` | logo-mark(.svg / -dark / -mono / -auto)、logo-horizontal(.svg / -dark / -auto)、wordmark(.svg / -dark)、app-icon(.svg / -maskable / -touch / -macos)、favicon.svg / .ico、og.html / og.png、brand-board.html / .png、tokens.css / tokens.json、README.md、THIRD_PARTY_FONT_NOTICE.txt、scripts/ |
| `brand/png/` | apple-touch-icon.png (180)、icon-192/512.png、maskable-192/512.png、favicon-16/32/48.png、desktop-icon-1024.png、desktop-icon.ico、desktop-icon.icns、logo-horizontal(-dark)-1200.png |
| `apps/web/public/` | favicon.svg、favicon.ico (16/32/48)、og.png (1200×630) |
| `apps/web/public/icons/` | apple-touch-icon.png、icon-192.png、icon-512.png、maskable-192.png、maskable-512.png、icon.svg |
| `apps/web/src/assets/` | logo-horizontal.svg、logo-mark.svg |
| `apps/desktop/build/` | icon.png (1024)、icon.ico (16–256)、icon.icns |

`apps/web/src/assets/` に置くのはテーマ自動切替版の 2 ファイルだけにしている。中身は `*-auto.svg` と同じで、SVG 内の `prefers-color-scheme` で色が変わる。`Logo.tsx` はファイル名の部分一致で最初に見つかったファイルを選ぶため、`-dark` の固定版が同じフォルダにあると、ライトの UI で白いロゴが選ばれるおそれがある。アプリが OS とは別に手動のテーマ切替を持つ場合は、`brand/` の固定版を明示的に import すること。

- **maskable**：マークは中心から半径 40%（安全領域 80%）の円に収まる。
- **apple-touch-icon**：角を丸めない全面塗り。角丸は iOS が付ける。
- **デスクトップアイコン**：macOS のグリッド（1024 キャンバスに 824 のタイル、角丸 185、影）。ICO は角丸タイルで、16px には小サイズ用の別形を入れている。

## 8. ブランドボード

`brand/brand-board.png`（元は `brand-board.html`）は、上から次の順に並べている。説明は最小限にとどめた。写真は使わず、ピクトグラムはすべて手描きのインライン SVG。

1. ロゴ
2. 「会議しただけで終わらせない。」
3. 困りごと 3 つ
4. 利用シーン 4 つ（クライアント定例、社内定例、1on1、営業商談）
5. 主要機能 5 ステップ＋プライバシー・Local mode
6. PWA アイコン

## 9. 名称・商標について（要人手確認）

- 「MeetLedger」は Web 検索では同名の商用製品が見つからなかった（`docs/research/A_market_providers_costs.md` §2）。
- 一方で、次の点は確認が必要。
  - 会議の決定台帳という同じコンセプトで「Ledger」を名乗る SaaS がある。
  - 「LEDGER」には著名な権利者（Ledger SAS）がいる。
  - 「Meeting Ledger」名の個人プロジェクトが複数ある。
- **J-PlatPat・USPTO・WIPO の公式商標データベースは未検索。** リリース前に、人が次の条件で検索し、必要に応じて専門家に確認すること。
  - 対象：称呼「ミートレジャー」「レジャー」、文字「MEETLEDGER」「MEET LEDGER」
  - 区分：9 類、35 類、42 類
- 同じ文書に挙がっている代替候補名（Kimeroku、Gijichō、FollowTrace）は、人が判断するための参考情報。本ブランドは「MeetLedger」で制作しており、名前は変えていない。
- 改名する場合は、マーク（吹き出し→チェック→台帳）はそのまま使える。ワードマークは `build.py` の `WORD` を変えて再生成する。

## 10. 再生成

```bash
python3 brand/scripts/build.py --inter-dir /tmp/inter --jp-dir /tmp/notojp
```

フォントの取得方法は `brand/README.md` を参照。フォントは一時ディレクトリにだけ置き、リポジトリには入れない。
