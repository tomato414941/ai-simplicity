# ai-simplicity

一つの連続した会話として AI を使うアプリです。会話一覧、モデル選択、スレッド作成はありません。話しかけると、その人専用の会話が一つだけ続きます。利用者は匿名で始まり、あとからメールアドレスを結びつけると別の端末でも同じ会話を続けられます。

AI がその人のトークンや鍵を使って作業できるように、[Foundation](https://github.com/tomato414941/foundation) とつながります。利用者は Foundation に登録しません。

## 動かし方

Node.js 22 以上。`.env.example` を `.env` にして値を入れ、`npm install`、`npm start`。データベースへの変更は `supabase db push` で当てます。モバイルアプリは `mobile/` にあります。

## まだないもの

- 決済と利用権
- 濫用対策
- AI の実行環境が期限切れになったときの自動復旧
- モバイルアプリからの Foundation の依頼の受け口
