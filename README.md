# ai-simplicity

AI の内部構造を利用者に管理させず、一つの連続した会話として提供するためのプロトタイプです。

この段階では、一つのサーバーインスタンスを一人の利用者として扱います。会話一覧、モデル選択、スレッド作成はありません。ブラウザを閉じたり別の端末から接続したりしても、同じバックエンドを使う限り同じ会話が続きます。

## 起動

Node.js 22 以上が必要です。

```sh
npm install
cp .env.example .env
```

`.env` に `OPENAI_API_KEY` を設定してから起動します。

```sh
set -a
source .env
set +a
npm start
```

ブラウザで <http://localhost:3000> を開きます。

## 設定

- `OPENAI_API_KEY`: 必須
- `OPENAI_MODEL`: 使用するモデル。初期値は `gpt-6-astra`
- `PORT`: HTTP ポート。初期値は `3000`
- `STATE_PATH`: 会話 ID と表示履歴の保存先。初期値は `data/state.json`

API キーはブラウザへ渡さず、サーバーだけが保持します。ローカルの状態ファイルは Git の対象外です。

## API

- `GET /api/messages`: 表示用の会話履歴を返す
- `POST /api/messages`: `{ "text": "..." }` を受け取り、同じ会話の続きとして応答する
- `GET /api/health`: 稼働状態を返す

OpenAI 固有の conversation ID やレスポンス形式は、この API の内側に閉じ込めています。

## テスト

```sh
npm test
```

テストでは OpenAI API を呼びません。
