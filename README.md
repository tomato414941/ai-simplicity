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

- `OPENAI_API_KEY`: 必須。Agents API の読み書きと Responses API の実行権限が必要
- `OPENAI_MODEL`: 新しいセッションで使用するモデル。初期値は `gpt-6-astra`
- `PORT`: HTTP ポート。初期値は `3000`
- `STATE_PATH`: セッション ID と表示履歴の保存先。初期値は `data/state.json`

API キーはブラウザへ渡さず、サーバーだけが保持します。ローカルの状態ファイルは Git の対象外です。

## エージェント

[OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/quickstart) と公式 JavaScript SDK を使います。エージェントの実行ループ、ツール実行、会話コンテキストの管理は OpenAI 側に任せています。

- Web 検索を `live` モードで有効化
- 外向き通信ができる OpenAI-hosted 環境で、必要に応じて HTTP 取得やコード実行
- 同じセッションを継続利用。アプリを再起動しても保存済み ID を再利用

コードはアプリのサーバーではなく OpenAI 側の隔離環境で実行されます。アプリの API キーや環境変数はその環境に渡しません。ブラウザのクリック操作、サイトへのログイン、個別サービスの認証連携はまだありません。モデル利用に加えて検索・実行環境の料金がかかります。

以前の表示履歴と Conversations API の ID は消しません。初回の入力に既存履歴を役割付きの引用テキストとして含め、以降は Agents API のセッション内で会話を続けます。これは従来の Conversations オブジェクトのネイティブ移行ではありません。

入力は順番に処理し、最終回答だけを表示履歴に保存します。[公式 SDK のストリーム処理](https://developers.openai.com/api/docs/guides/agents-api/sessions/events)を利用し、途中切断や失敗を完了扱いにしません。上流の通信が切れた場合は、次の送信時に保存済みの実行結果を確認します。同じメッセージの再送で完了済みの結果を取得でき、実行中なら新しい入力を送りません。自動再接続や、未完了の処理を操作する画面はまだありません。画面を閉じても開始済みの処理は続きます。

表示履歴と[実行環境内のファイル](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted#files-and-lifetime)の寿命は別です。実行環境は永続ストレージとして扱わず、ファイルのダウンロードや環境期限切れからの自動復旧はこのプロトタイプの対象外です。

外部への送信・購入・変更は明示的な依頼なしに行わないよう指示していますが、強制的な承認ゲートは未実装です。認証のない一人用プロトタイプなので、信頼できる私用ネットワークだけで利用し、インターネットへ公開しないでください。

## API

- `GET /api/messages`: 表示用の会話履歴を返す
- `POST /api/messages`: `{ "text": "..." }` を受け取り、同じ会話の続きとしてSSEで応答する
- `GET /api/health`: 稼働状態を返す

OpenAI 固有のセッション ID やイベント形式は、この API の内側に閉じ込めています。

ストリームには次のイベントだけが流れます。待機中には接続維持用の SSE コメントも送ります。

- `delta`: 追加表示するテキスト
- `done`: 保存済みの最終メッセージ
- `error`: 応答を完了できなかったこと

## テスト

```sh
npm test
```

テストでは OpenAI API を呼びません。
