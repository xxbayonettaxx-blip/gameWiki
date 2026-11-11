# Basic Board (v0.5 MVP)

ツリー形式の返信コメント、日替わりID（`HMAC-SHA256`）、論理削除によるツリー維持、およびCUD（色覚多様性）配慮カラーパレット・文字サイズ・コントラスト切替を備えた汎用小規模掲示板です。

---

## 1. 動作環境・技術構成

- **Node.js**: `v24.x`（実測検証版: `v24.22.1` / `package.json` の `engines.node` も `>=24.0.0 <25.0.0` に設定。`--env-file-if-exists` とフラグ不要の `node:sqlite` を使用）
- **外部npm依存パッケージ**: **なし（0個）**
  - HTTPサーバー（`node:http`）、SQLite接続（`node:sqlite`）、暗号処理（`node:crypto`）、自動テスト（`node:test`, `node:assert/strict`）、環境変数読込（`--env-file-if-exists=.env`）のすべてをNode.js公式標準機能のみで構成し、サプライチェーン攻撃リスクと保守コストを最小化しています。
- **画面構成（上から順）**:
  - カテゴリ選択（PC時は左サイドバー、モバイル時は上部カード）
  - メイン領域：①スレッド選択 ＞ ②スレッドタイトル ＞ ③ピン留めされた通常投稿・返信ツリー（該当投稿がある時のみ表示） ＞ ④通常投稿・返信ツリー

---

## 2. セットアップと環境変数（`.env`）

1. `.env.example` をコピーして `.env` を作成します（`.env` は `.gitignore` によりGit管理から除外されます）。
2. 以下のコマンド等でランダムな秘密鍵を生成し、`.env` の `ID_SECRET`（必須）と `ADMIN_TOKEN`（任意）へ設定します。

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

- **環境変数の読み込み方**: `package.json` の各スクリプトで `node --env-file-if-exists=.env ...` を使用しています（`systemd` 配備時は `EnvironmentFile=/etc/basic_board.env` 等からも注入可能）。
- **安全停止仕様**: `ID_SECRET` が未設定、16文字未満、または `.env.example` の見本値（`CHANGE_ME...`）のままの場合は、起動時にエラーを出して即停止します（起動ごとにランダム再生成する挙動は行いません）。

---

## 3. 起動・初期データ投入・テスト・管理コマンド

プロジェクトフォルダ（`C:\product\project\live-service\on-VPS\basic_board`）で実行します。

| 用途 | コマンド | 説明 |
| :--- | :--- | :--- |
| **自動テスト実行** | `npm test` | 実DB（`data/board.db`）には一切触れず、メモリ内DBとOS一時フォルダのみで全検査を実行します。 |
| **初期データ投入** | `npm run seed` | 空DBに固定カテゴリ3件と初期スレッド10件を投入します。カテゴリがあるDBでは処理を終了します。 |
| **サーバー起動** | `npm start` | 既定で `http://127.0.0.1:3001` で待ち受けます。起動ログに公開フォルダ・DBパス・`foreign_keys=1`・`journal_mode=wal` が出力されます。 |
| **デザイン実験起動** | `npm run sandbox -- <案名> [ポート]` | `public/` を変更せず、`ui-sandbox/<案名>/`（例: `sample-base`, `slide-drawer`）を別ポート（既定 `3002`）で実DB接続起動します。 |
| **カテゴリ・スレッド一覧確認** | `npm run moderate -- list` | 現在登録されているカテゴリ・スレッドのID・表示順・投稿数を一覧表示します。 |
| **カテゴリの追加 / 名前変更** | `npm run moderate -- add-category "<名前>" [表示順]`<br>`npm run moderate -- rename-category <ID> "<新名>" [表示順]` | 既存データを消さずに新しいカテゴリを追加、または既存カテゴリの名前・表示順を変更します。 |
| **スレッドの追加 / 名前変更** | `npm run moderate -- add-thread <カテゴリID> "<題名>" ["案内文"]`<br>`npm run moderate -- rename-thread <ID> "<新題名>"` | 指定カテゴリ内に新しいスレッドを追加、または既存スレッドのタイトルを変更します。 |
| **投稿のピン留め / 解除** | `npm run moderate -- pin <投稿ID>` / `unpin <投稿ID>` | 指定した投稿（＋返信ツリー）を上部のピン留め枠へ固定表示、または解除します。 |
| **投稿の論理削除** | `npm run moderate -- delete <投稿ID>` | 指定した投稿を `is_deleted = 1` に更新（ピン留めも自動解除）します。API/画面からは本文と名前がマスクされ、子返信はそのまま読めます。 |
| **投稿ツリーの物理削除** | `npm run moderate -- purge-tree <投稿ID> [--force]` | 指定した投稿およびその配下（子・孫すべて）のカードをDBから完全削除します。既定はDry-run（プレビュー表示のみ）、`--force` を付与して本実行します。 |
| **スレッドの物理削除** | `npm run moderate -- purge-thread <スレッドID> [--force]` | 指定スレッド内の全投稿を末端から削除し、スレッド行も完全削除します。既定はDry-run、`--force` で本実行します。 |
| **安全日次バックアップ** | `npm run backup` | 元DBの存在・非空・スキーマ整合性（quick_check / foreign_key_check）を検査し、安全性が実証された場合のみ原子的（atomic）にバックアップを更新します。 |

### フロントの回帰テスト

`npm run test:frontend` はインストール済みのChromeまたはEdgeをヘッドレスで起動し、スレッド別の下書き、返信先、遅延応答、320px幅の入力シートを確認します。専用の一時プロファイルとメモリ内DBを使います。ブラウザが見つからない場合は環境変数 `CHROME_PATH` に実行ファイルを指定してください。試験用ブラウザも追加のnpm依存も自動インストールしません。

下書きはスレッドごとにページ内のメモリで保持します。スレッドを戻すと本文と返信先を復元し、下書きを開き直した場合は返信モードを維持します。「新規投稿へ切替」で返信先を解除できます。再読み込み・タブを閉じる操作では下書きは消えます。スマホの実キーボードと日本語変換は実機で確認してください。

---

## 4. データベース保存先・バックアップ・リセット条件

- **DB保存先**: 既定で `data/board.db`（`__dirname` 基準で解決されるため、どのカレントディレクトリから起動しても同じ場所を指します）。稼働中は同じ `data/` フォルダ内に `board.db-wal` と `board.db-shm` が生成されます。
- **バックアップと復元確認（VPS / ローカル共通）**:
  - バックアップ取得時はファイル単純コピーではなく、SQLiteの `.backup` コマンド（または `VACUUM INTO`）を使用してください。
  - 例: `sqlite3 data/board.db ".backup 'data/board_backup.db'"`
- **開発中のDB手動リセット手順（※「seed」とは別操作）**:
  - 自動でデータを全消去するスクリプトは安全のため用意していません。
  - **廃棄可能なローカル開発データに限り**、スキーマを作り直したい場合は「①サーバーを停止 ➔ ② `data/board.db` / `board.db-wal` / `board.db-shm` を手動削除 ➔ ③ `npm run seed` を実行」の手順で行ってください（※参加者の残したい投稿が入った後は削除厳禁）。
