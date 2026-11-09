-- =====================================================================
-- basic_board v0.5 データベーススキーマ正本 (src/schema.sql)
-- 設計書 C:\product\project\game-wiki\基本構成・機能\DB設計.md 第3版と完全一致
-- =====================================================================

-- 0. 接続ごとの必須設定（src/db.js 側でも実行後に戻り値をプログラム検証する）
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 1. ユーザーテーブル（外部キー参照元のため先に定義。v0.5は未使用・v1.0ログイン用予約）
-- ※ char(12288)=全角空白(U+3000), char(9)=タブ, char(10)=LF, char(13)=CR を除去して空欄を拒否
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE
        CHECK(length(trim(username, ' ' || char(12288) || char(9) || char(10) || char(13))) >= 3 AND length(username) <= 30),
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
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
CREATE INDEX IF NOT EXISTS idx_threads_category ON threads(category_id, is_pinned DESC, id);
CREATE INDEX IF NOT EXISTS idx_posts_thread_parent ON posts(thread_id, parent_id, id);
