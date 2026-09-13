# ai-simplicity

一つの連続した会話として AI を使うプロトタイプです。会話一覧、モデル選択、スレッド作成の操作はありません。

Web は自分たちの API サーバーを呼びます。OpenAI のキーはサーバーだけが保持します。API の概念・データ構造・イベントは、現在利用している [Agents API](https://developers.openai.com/api/docs/guides/agents-api/sessions) に揃えています。互換性は、ブラウザから OpenAI を直接呼ぶことや、クライアントに公式 SDK を要求することではありません。

## 起動

Node.js 22 以上が必要です。

```sh
npm install
cp .env.example .env
```

`.env` に `OPENAI_API_KEY` を設定します。

```sh
set -a
source .env
set +a
npm start
```

ブラウザで <http://localhost:3000> を開きます。

- `OPENAI_API_KEY`: 必須。Agents API の読み書きとモデル実行に必要な権限を持つキー
- `OPENAI_MODEL`: 新しいセッションのモデル。初期値は `gpt-6-astra`
- `PORT`: 初期値は `3000`
- `STATE_PATH`: セッション ID の保存先。初期値は `data/state.json`

初回起動時だけセッションを作成します。以後は保存した ID を再利用します。状態ファイルは `{ "session_id": "..." }` だけを保存し、権限は `0600`、Git の対象外です。既存ファイルが異なる形式なら起動を拒否し、別の会話を黙って作りません。

## API の対応範囲

現在の一人用アプリが利用するセッションだけを公開します。任意の OpenAI リソースへアクセスする汎用プロキシではありません。

| 操作 | エンドポイント |
| --- | --- |
| セッション一覧 | `GET /v1/agents/sessions` |
| セッション取得 | `GET /v1/agents/sessions/{session_id}` |
| items 取得 | `GET /v1/agents/sessions/{session_id}/items` |
| turns 取得 | `GET /v1/agents/sessions/{session_id}/turns` |
| turn 取得 | `GET /v1/agents/sessions/{session_id}/turns/{turn_id}` |
| イベント購読（SSE） | `GET /v1/agents/sessions/{session_id}/events` |
| 入力・停止 | `POST /v1/agents/sessions/{session_id}/events` |

一覧は `object: "list"`、`data`、`first_id`、`last_id`、`has_more` を返します。`after`・`limit`（1–100）・`order` に対応し、セッション一覧は `agent_id` でも絞り込めます。items はメッセージだけでなくツール呼び出し等も元の型のまま返します。`id`、`turn_id`、`content`、`phase`、`status` を独自形式へ変換しません。

入力は [Agents API の入力イベント](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/events/methods/create) を使います。

```json
{
  "events": [{
    "type": "agent.session.input.message",
    "input": [{
      "role": "user",
      "content": [{ "type": "input_text", "text": "こんにちは" }]
    }]
  }]
}
```

この実装は一回に一イベント、ユーザーのテキスト入力（合計20,000文字まで）と `agent.session.input.cancel` に対応します。本文を変更せず、`Idempotency-Key` ヘッダーを渡します。受け付けは `204 No Content` で、生成や停止の完了を意味しません。エラーは HTTP ステータスと `{ "error": { "message", "type", "param", "code" } }` で返します。

画像入力、クライアント側 function tool、セッション作成・削除・設定変更、`/v1/responses` などは未対応です。未対応のパラメーターや操作はエラーにし、黙って無視しません。Agents の `turn` を Responses の `response` に、`session` を `conversation` に名前だけ置き換える層はありません。両 API の完全互換をうたうものではありません。

`GET /api/health` はアプリの稼働確認です。旧 `/api/messages`・`/api/retry`・`/api/stop` は提供しません。

## ストリーミングと復旧

通常時は Web → 自分たちの API サーバー → OpenAI の SSE 接続で受信します。サーバーは実際のイベント本文を転送し、遅い受信側には backpressure を適用します。イベント名の変更、疑似的な完了イベント、独自のイベント履歴基盤は追加しません。

Web は `item_id` と `content_index` ごとに表示を更新します。delta ごとの HTTP 確認、履歴全体の描画し直し、サーバーへの履歴書き込みはありません。通常の履歴取得は初期表示・turn 終了時で、通信断後にも取得します。

切断時は [公式の復旧手順](https://developers.openai.com/api/docs/guides/agents-api/sessions/events#how-to-recover-a-disconnected-stream) に沿って、先に新しいストリームを開き、受信イベントを一時的に保持しながらセッション・items・turns を取得します。保存済みの確定 item に古い delta を重ねません。欠落した途中の本文のつなぎ方は推測せず、表示済みの断片を残し、`output_text.done`・確定 item で本文を置き換えます。Agents のイベント再生・再開カーソルは前提にしません。

接続が切れたりストリームが終わったりしても、turn の失敗とは扱いません。復旧は読み取りだけで、新しい生成を自動で始めません。

正常な生成・推論には60秒の制限も、出力がない時間を理由にしたタイムアウトもありません。状態を確認できなくなってから60秒の間だけ、間隔を広げながら再接続します。確認できなければ「もう一度確認」を表示します。接続開始・通常の HTTP 要求には短いタイムアウトがありますが、ストリーム受信時間には適用しません。

送信内容は送信前に端末へ保存します。受け付けが不明な場合の再送は手動で、同じ `Idempotency-Key` を使います。失敗した turn の「再試行」は新しいキーで明示的に入力し直す操作です。下書きは端末に保存し、履歴・受信済み item のキャッシュは復旧・turn 終了・画面を閉じる時などに更新します。delta ごとには書き込みません。

## 停止

入力欄の同じボタンを送信と停止に使います。生成中の Enter は送信も停止もしません。

停止は `agent.session.input.cancel` を送ります。ネイティブ仕様どおり、対象はセッションの active turn です。独自の turn 指定キャンセルは追加しません。受け付け後は「停止しています」と表示し、`cancelled` を確認したら「停止しました」と表示します。完了が先に確定した場合は完了として残します。

通信断・画面を閉じる操作は購読を閉じるだけで、生成を停止しません。停止イベントを自動で再送することもありません。ストリームが切れていても、既知の active turn への停止を試せます。停止後の入力に「ユーザーが停止した」等の説明は追加しません。すでに行われた外部操作は取り消せません。

## 既存データの移行

旧形式からの移行は明示的な一回限りの操作です。アプリの実行コードに旧形式への互換処理はありません。

アプリを停止し、未解決の入力がない状態で、使用中のファイルを指定します。

```sh
node scripts/migrate-session.js /absolute/path/to/state.json
```

元の全データを同じ場所の `state.json.before-agents-api` に権限 `0600` で退避し、使用中ファイルをセッション ID だけの形式に切り替えます。既存の退避ファイルは上書きしません。履歴の読み取り元は、その同じセッションの保存済み items になります。退避したファイルは削除しません。

## 公開前に必要なこと

現状は認証のない一人用プロトタイプで、接続端末は同じセッションを共有します。信頼できる私用ネットワークだけで利用し、インターネットには公開しないでください。iPhone・Android のネイティブアプリは未実装です。

公開版では、初回に明示的なログイン操作を求めず匿名ユーザーとして認証し、後から同じユーザー ID に確認済みメールアドレスを追加する方針です。全会話操作の認証とアクセス制御、ユーザーとセッションの対応保存、ストア決済・利用権、濫用対策が必要です。既存の私用履歴は最初の訪問者へ自動で割り当てません。

ホスティングと認証サービスの選定は、想定負荷・通信量・運用を含む総費用の評価待ちです。Render や Supabase の採用は確定しておらず、クラウド環境・契約は追加していません。

エージェントは既存の設定を維持し、Web 検索と外向き通信が可能な OpenAI-hosted 環境を使います。モデル以外に検索・実行環境の料金もかかります。実行環境のファイルは永続ストレージとは扱いません。外部操作の強制的な承認ゲート、環境期限切れからの自動復旧は未実装です。

## テスト

```sh
npm test
```

テストは外部 API を呼びません。公式 SDK を使った HTTP 契約検証、SSE の分割・文字コード・エラー、ページング、切断復旧、重複送信、停止と完了の競合、履歴の退避を検証します。Web は DOM のテスト用実装と仮想時計で、実際の配信スクリプトを実行して表示文言・操作を確認します。ブラウザ操作は行いません。
