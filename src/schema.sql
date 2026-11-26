-- =====================================================================
-- basic_board v1.1 データベーススキーマ正本 (src/schema.sql)
-- 設計書 管理画面設計書・実装ロードマップ（第2.1版）PRAGMA user_version = 3 準拠
-- ※ 本ファイルは単一トランザクションで原子適用できるよう純粋なDDLのみを定義する。
-- ※ 接続時PRAGMA（busy_timeout / journal_mode = WAL / foreign_keys = ON）は
--    src/db.js 側でトランザクション外にて設定・検証する。
-- =====================================================================

-- 1. ユーザーテーブル（外部キー参照元のため先に定義。v1.0認証対応）
-- ※ char(12288)=全角空白(U+3000), char(9)=タブ, char(10)=LF, char(13)=CR を除去して空欄を拒否
-- ※ auth_version: パスワード変更/強制リセット/ロール変更時に加算し、進行中ログイン/変更の競合発行を防ぐ
-- ※ must_change_password: 管理者リセット時の仮パスワード強制変更フラグ（1のあいだ通常投稿等を制限）
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE
        CHECK(length(trim(username, ' ' || char(12288) || char(9) || char(10) || char(13))) >= 3 AND length(username) <= 30),
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    auth_version INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 2. カテゴリテーブル（左サイドバーの項目）
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
        CHECK(length(trim(name, ' ' || char(12288) || char(9) || char(10) || char(13))) >= 1 AND length(name) <= 30),
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 3. スレッドテーブル（上部タブ切替 ＞ タイトル ＞ スレッド別ピン留め案内文）
CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    title TEXT NOT NULL
        CHECK(length(trim(title, ' ' || char(12288) || char(9) || char(10) || char(13))) >= 1 AND length(title) <= 100),
    pinned_text TEXT
        CHECK(pinned_text IS NULL OR length(pinned_text) <= 500),
    is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
    display_order INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- 4. 通常投稿・返信ツリーテーブル
-- ・is_pinned = 1 の投稿（＋その返信ツリー）をスレッド上部にピン留め固定する
-- ・UNIQUE(id, thread_id) と複合外部キーにより「同一スレッド内の実在する投稿」への返信のみ許可
-- ・ON DELETE RESTRICT により返信がある親の誤った物理削除を阻止（通常運用は is_deleted = 1 の論理削除）
CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    parent_id INTEGER,
    author_name TEXT NOT NULL DEFAULT '名無しさん'
        CHECK(length(trim(author_name, ' ' || char(12288) || char(9) || char(10) || char(13))) >= 1 AND length(author_name) <= 30),
    visitor_id TEXT NOT NULL CHECK(length(trim(visitor_id)) >= 1),
    content TEXT NOT NULL
        CHECK(length(trim(content, ' ' || char(12288) || char(9) || char(10) || char(13))) >= 1 AND length(content) <= 2000),
    is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)),
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    CHECK (parent_id IS NULL OR parent_id != id),
    UNIQUE (id, thread_id),
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
    FOREIGN KEY (parent_id, thread_id) REFERENCES posts(id, thread_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- 5. 検索・一覧取得用インデックス
CREATE INDEX IF NOT EXISTS idx_threads_category ON threads(category_id, is_pinned DESC, display_order ASC, id);
CREATE INDEX IF NOT EXISTS idx_posts_thread_parent ON posts(thread_id, parent_id, id);

-- 6. ログインセッションテーブル（v1.0認証用）
-- ・ブラウザCookieには高エントロピーな生トークンを渡し、DBにはSHA-256ハッシュ(64桁hex)のみを保存する
-- ・ユーザー削除時は ON DELETE CASCADE によりセッションも自動消去する
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- 7. 管理操作監査ログテーブル（v1.1 Step 1追加）
-- ・Web管理操作とCLI操作の両方を状態変更と同一トランザクションで記録する
-- ・detail_json は許可キー要約のみ最大 2048 bytes に制限し、秘密情報を含めない
CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('admin_web', 'cli')),
    actor_user_id INTEGER,
    actor_username TEXT NOT NULL CHECK(length(actor_username) BETWEEN 1 AND 64),
    action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 64),
    target_type TEXT NOT NULL CHECK(length(target_type) BETWEEN 1 AND 32),
    target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 128),
    detail_json TEXT NOT NULL CHECK(json_valid(detail_json) AND length(CAST(detail_json AS BLOB)) <= 2048),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at ON admin_audit_logs(created_at DESC, id DESC);
