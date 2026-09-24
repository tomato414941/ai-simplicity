# ai-simplicity

一つの連続した会話として AI を使うアプリです。会話一覧、モデル選択、スレッド作成はありません。話しかけると、その人専用の会話が一つだけ続きます。

Web は自分たちの API サーバーを呼び、サーバーが OpenAI の [Agents API](https://developers.openai.com/api/docs/guides/agents-api/sessions) を使います。OpenAI のキーはサーバーだけが持ちます。利用者は匿名で始まり、あとからメールアドレスを結びつけると別の端末でも同じ会話を続けられます（認証は Supabase）。

## 動かし方

Node.js 22 以上。

```sh
npm install
cp .env.example .env   # 値を入れる
npm start              # http://127.0.0.1:3000
npm test
```

| 環境変数 | 内容 |
| --- | --- |
| `OPENAI_API_KEY` | 必須。Agents API を使えるプロジェクトのキー |
| `OPENAI_MODEL` | 会話のモデル。初期値は `gpt-6-astra` |
| `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` | 必須。認証と保存 |
| `FOUNDATION_URL` / `FOUNDATION_INTEGRATION_KEY` / `FOUNDATION_WEBHOOK_SECRET` | 任意。[Foundation](https://github.com/tomato414941/foundation) との連携 |
| `HOST` / `PORT` | 初期値は `127.0.0.1` / `3000` |

データベースの定義は `supabase/migrations/` にあります。順に Supabase へ当ててください。

モバイルアプリ（Expo）は `mobile/` にあります。`EXPO_PUBLIC_API_URL` にサーバーの URL を入れて `npm start` します。

## Foundation との連携

利用者の AI が、その人のトークンや鍵を使って作業できるようにする仕組みです。利用者は Foundation に登録しません。

- 会話を作るとき、サーバーがその利用者の Foundation アカウントとキーを用意し、キーを AI に MCP の接続として渡します。AI にキーは見えません。
- AI が「トークンを預けてほしい」と依頼すると、利用者は `/foundation?foundation_request=<id>` から Foundation の画面へ移り、値を貼って戻ってきます。値はこのサーバーを通りません。
- 依頼が終わると、Foundation から署名付きの通知が `POST /api/foundation/events` に届きます。

## 構成

| 場所 | 内容 |
| --- | --- |
| `src/` | API サーバー。`server.js` が経路、`user-sessions.js` が利用者ごとの会話、`foundation.js` が Foundation との窓口 |
| `public/` | Web の画面 |
| `mobile/` | iPhone・Android のアプリ |
| `shared/` | Web とモバイルで共有する会話の状態の処理 |
| `supabase/migrations/` | データベースの定義 |
| `test/` | テスト。外部の API は呼ばない |

## まだないもの

- 決済と利用権。クレジットの記録はあるが、購入と請求はない
- 濫用対策
- AI の実行環境が期限切れになったときの自動復旧
- モバイルアプリからの Foundation の依頼の受け口
