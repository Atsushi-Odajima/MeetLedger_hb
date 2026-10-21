# MeetLedger — 会議の決定と約束を追いかける

録音・文字起こしから、決定事項・担当・期限・次回確認までを管理するミーティング支援アプリです。

> **実装ブランチ：`claude/022-meetledger`**。この既定ブランチのREADMEは製品の案内です。以下のソース・資料リンクと起動手順は、実装ブランチを参照します。

## できること

- 録音・取込、ローカル文字起こし、原文を参照する要約候補
- Decision / Commitmentの台帳、フォローアップと会議横断検索
- Web / PWA、Electron companion、MCP、バックアップと復元

## 現在の範囲・制限

- AI抽出は人が確認する候補です。録音前の参加者への通知・同意を前提にします。
- ローカルASRにはモデル取得が必要です。クラウドAIは任意接続で、OS別のシステム音声録音・署名・実機確認は未完了です。

## 実装の見どころ

**構成：** React / TypeScript / Vite、Node.js / PostgreSQL、sherpa-onnx、Electron、MCP。

- [022-meetledger/apps](https://github.com/Atsushi-Odajima/MeetLedger_hb/tree/claude%2F022-meetledger/022-meetledger/apps)
- [022-meetledger/packages](https://github.com/Atsushi-Odajima/MeetLedger_hb/tree/claude%2F022-meetledger/022-meetledger/packages)
- [022-meetledger/e2e](https://github.com/Atsushi-Odajima/MeetLedger_hb/tree/claude%2F022-meetledger/022-meetledger/e2e)

## ローカルで試す

Node.js 22.12以上、PostgreSQL。DB補助とモデル取得のスクリプトはBash形式です。

実装ブランチを取得し、次のディレクトリで作業します。

```sh
git clone --branch claude/022-meetledger https://github.com/Atsushi-Odajima/MeetLedger_hb.git
cd MeetLedger_hb/022-meetledger
npm install
```

実装フォルダーのREADMEの開発手順でDBとDATABASE_URLを設定します。必要なら文字起こしモデルを取得し、npm run build 後に node apps/server/dist/index.js を実行すると初回セットアップを開けます。

環境設定・初期化の詳細：[セットアップ手順](https://github.com/Atsushi-Odajima/MeetLedger_hb/blob/claude%2F022-meetledger/022-meetledger/docs/DEVELOPMENT.md)。

## 検証方法

`022-meetledger/` の `package.json` に定義された主な確認コマンドです。DB・ブラウザ・外部ツールを要するものは、開発手順の事前設定が必要です。

```sh
npm run typecheck
npm run test
npm run e2e
npm run build
```

試験の実施環境・結果・未実施項目は、下記の記録を参照してください。画面エミュレーションと実機確認、モックと外部サービスでの確認を区別しています。

## 資料

- [022-meetledger/docs/DEVELOPMENT.md](https://github.com/Atsushi-Odajima/MeetLedger_hb/blob/claude%2F022-meetledger/022-meetledger/docs/DEVELOPMENT.md)
- [022-meetledger/NEXT_STEPS.txt](https://github.com/Atsushi-Odajima/MeetLedger_hb/blob/claude%2F022-meetledger/022-meetledger/NEXT_STEPS.txt)
- [022-meetledger/README.md](https://github.com/Atsushi-Odajima/MeetLedger_hb/blob/claude%2F022-meetledger/022-meetledger/README.md)
- [022-meetledger/docs/TEST_REPORT.md](https://github.com/Atsushi-Odajima/MeetLedger_hb/blob/claude%2F022-meetledger/022-meetledger/docs/TEST_REPORT.md)
- [022-meetledger/docs/RELEASE_CHECKLIST.md](https://github.com/Atsushi-Odajima/MeetLedger_hb/blob/claude%2F022-meetledger/022-meetledger/docs/RELEASE_CHECKLIST.md)
- [022-meetledger/docs/DATA_MODEL.md](https://github.com/Atsushi-Odajima/MeetLedger_hb/blob/claude%2F022-meetledger/022-meetledger/docs/DATA_MODEL.md)
- [022-meetledger/docs/DECISIONS.md](https://github.com/Atsushi-Odajima/MeetLedger_hb/blob/claude%2F022-meetledger/022-meetledger/docs/DECISIONS.md)
- [022-meetledger/docs/SECURITY.md](https://github.com/Atsushi-Odajima/MeetLedger_hb/blob/claude%2F022-meetledger/022-meetledger/docs/SECURITY.md)
- [022-meetledger/docs/OPERATIONS.md](https://github.com/Atsushi-Odajima/MeetLedger_hb/blob/claude%2F022-meetledger/022-meetledger/docs/OPERATIONS.md)

## 制作・利用条件

制作・管理：**Atsushi Odajima**。実装・資料作成にはAI支援を利用しています。
ソース・同梱ライブラリ・フォント・モデル等の利用条件は、各ライセンスと第三者表記を参照してください。リポジトリの閲覧可能性と、再配布・商用利用の許諾は別です。
