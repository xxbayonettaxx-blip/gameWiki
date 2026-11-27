'use strict';

/**
 * =====================================================================
 * src/db.js
 * 役割：【金庫番】SQLite接続管理・PRAGMA検証・データ取得/更新・削除文マスク処理
 * 方針：
 *   - require('./db') しただけでは固定の data/board.db を一切開かない（実データ保護）。
 *   - createBoardDb({ dbPath }) で接続先（':memory:' / 一時ファイル / 実DB）を明示注入する。
 *   - 生のSQL文と node:sqlite 固有APIはこのファイル内部に閉じ込める。
 *   - is_deleted = 1 の投稿はSQLレベルで本文・名前・IDをマスクし、外部へ流出させない。
 * =====================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  ValidationError,
  PERMISSION_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
  parsePositiveInt,
  validatePostInput,
  validateUsername,
  validateUserRole,
  validatePermissionRole,
  validateRolePermissionsPayload,
  validateCategoryName,
  validateThreadTitle,
  validateThreadPinnedText,
  validateNonNegativeInt,
  parsePaginationLimit,
  parsePaginationOffset,
} = require('./validators');

// プロジェクトルートおよびスキーマ正本のパス（カレントディレクトリに依存しない __dirname 基準）
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const TARGET_SCHEMA_VERSION = 4;

// 1スレッドあたりの保存・取得上限と返信階層の深さ上限（見えない投稿の蓄積とネストDoSを防止）
const DEFAULT_MAX_POSTS_PER_THREAD = 500;
const DEFAULT_MAX_REPLY_DEPTH = 20;

// ---------------------------------------------------------------------
// 1. 本番・ローカル通常起動用のDBパス解決ヘルパー
// systemd 等どこから起動してもプロジェクトルート基準の同一ファイルを指すようにする。
// ---------------------------------------------------------------------
function resolveProjectDbPath(rawDbPath = './data/board.db') {
  if (rawDbPath === ':memory:') {
    return ':memory:';
  }
  if (path.isAbsolute(rawDbPath)) {
    return path.normalize(rawDbPath);
  }
  return path.resolve(PROJECT_ROOT, rawDbPath);
}

// ---------------------------------------------------------------------
// 1b. 非移行・原子的バックアップ複製ヘルパー（backup.js / db.backupTo 共用）
// 開いている SQLite 接続から一時ファイルへ VACUUM INTO し、整合性検証後に原子的置換する。
// DDL や user_version の更新は一切行わないため、readOnly 接続からの前世代退避にも安全に使える。
// ---------------------------------------------------------------------
function vacuumSqliteConnectionToFile(sqlite, destinationPath, options = {}) {
  const dest = path.resolve(destinationPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const tmpDest = `${dest}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 8)}`;
  const escapedTmp = tmpDest.replace(/'/g, "''");

  try {
    sqlite.exec(`VACUUM INTO '${escapedTmp}';`);

    // 生成された新世代バックアップの整合性と代表テーブルの読取可能性を検証してから切り替える
    const checkDb = new DatabaseSync(tmpDest, { readOnly: true });
    try {
      const qc = checkDb.prepare('PRAGMA quick_check;').get();
      if (!qc || String(qc.quick_check).toLowerCase() !== 'ok') {
        throw new Error('生成されたバックアップファイルの整合性検査（quick_check）に失敗しました。');
      }
      const fk = checkDb.prepare('PRAGMA foreign_key_check;').all();
      if (fk && fk.length > 0) {
        throw new Error('生成されたバックアップファイルで外部キー制約違反（foreign_key_check）が検出されました。');
      }
      const catCount = checkDb.prepare('SELECT COUNT(*) AS c FROM categories;').get();
      checkDb.prepare('SELECT COUNT(*) AS c FROM threads;').get();
      checkDb.prepare('SELECT COUNT(*) AS c FROM posts;').get();
      if (options.requireNonEmptyCategories && Number(catCount?.c ?? 0) === 0) {
        throw new Error('バックアップ対象DBのカテゴリ件数が0件です。空のDBで既存バックアップを上書きすることを拒否しました。');
      }
    } finally {
      checkDb.close();
    }

    fs.renameSync(tmpDest, dest);
    return dest;
  } catch (err) {
    try {
      if (fs.existsSync(tmpDest)) {
        fs.unlinkSync(tmpDest);
      }
    } catch {
      // 一時ファイル掃除失敗は無視し、元の例外を優先して投げる
    }
    throw err;
  }
}

// ---------------------------------------------------------------------
// 2. DBインスタンス生成ファクトリ関数
// ---------------------------------------------------------------------
function createBoardDb(options = {}) {
  const {
    dbPath,
    schemaPath = DEFAULT_SCHEMA_PATH,
    maxPostsPerThread = DEFAULT_MAX_POSTS_PER_THREAD,
    maxReplyDepth = DEFAULT_MAX_REPLY_DEPTH,
  } = options;

  // 接続先未指定のまま暗黙で実DBを開く事故を防止するガード節
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    throw new Error('createBoardDb には接続先 dbPath（ファイルパスまたは ":memory:"）の明示指定が必須です。');
  }

  const targetPath = dbPath === ':memory:' ? ':memory:' : path.resolve(dbPath);

  // ファイルDBの場合は親ディレクトリ（data/ や一時フォルダ）を事前に作成する
  if (targetPath !== ':memory:') {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  }

  // SQLite接続を確立
  const sqlite = new DatabaseSync(targetPath);

  try {
    // 接続ごとの必須設定（PRAGMA WAL / foreign_keys はトランザクション外で設定・検証する）
    sqlite.exec('PRAGMA busy_timeout = 5000;');
    sqlite.exec('PRAGMA journal_mode = WAL;');
    sqlite.exec('PRAGMA foreign_keys = ON;');
    const fkRow = sqlite.prepare('PRAGMA foreign_keys;').get();
    const foreignKeys = fkRow ? fkRow.foreign_keys : 0;
    if (foreignKeys !== 1) {
      throw new Error(`SQLite の PRAGMA foreign_keys が有効化できませんでした（値: ${foreignKeys}）。`);
    }

    // 実際の journal_mode を取得（ファイルDBなら 'wal'、:memory: なら 'memory' になる）
    const jmRow = sqlite.prepare('PRAGMA journal_mode;').get();
    const journalMode = jmRow ? String(jmRow.journal_mode).toLowerCase() : 'unknown';

    // スキーマ適用版を確認し、旧版であれば DDL と user_version 更新を単一トランザクションで原子適用する
    const uvRow = sqlite.prepare('PRAGMA user_version;').get();
    let schemaVersion = uvRow ? Number(uvRow.user_version) : 0;
    if (schemaVersion < TARGET_SCHEMA_VERSION) {
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      sqlite.exec('BEGIN IMMEDIATE;');
      try {
        const lockedUvRow = sqlite.prepare('PRAGMA user_version;').get();
        const lockedVersion = lockedUvRow ? Number(lockedUvRow.user_version) : 0;
        if (lockedVersion < TARGET_SCHEMA_VERSION) {
          // 既存DBからの非破壊アップグレード：不足カラムをインデックス作成前に追加する
          const postColumns = sqlite.prepare('PRAGMA table_info(posts);').all();
          if (postColumns.length > 0 && !postColumns.some((col) => col.name === 'is_pinned')) {
            sqlite.exec(
              'ALTER TABLE posts ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1));'
            );
          }

          const threadColumns = sqlite.prepare('PRAGMA table_info(threads);').all();
          if (threadColumns.length > 0 && !threadColumns.some((col) => col.name === 'display_order')) {
            sqlite.exec(
              'ALTER TABLE threads ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;'
            );
          }

          const userColumns = sqlite.prepare('PRAGMA table_info(users);').all();
          if (userColumns.length > 0 && !userColumns.some((col) => col.name === 'auth_version')) {
            sqlite.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;');
          }
          if (userColumns.length > 0 && !userColumns.some((col) => col.name === 'must_change_password')) {
            sqlite.exec(
              'ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0, 1));'
            );
          }

          // スキーマ正本（純粋DDLのみ）を単一トランザクション内で適用
          sqlite.exec(schemaSql);

          // 極初期スキーマ(created_by欠落DB)からの非破壊移行（usersテーブル作成後に外部キー付きで追加）
          if (postColumns.length > 0 && !postColumns.some((col) => col.name === 'created_by')) {
            sqlite.exec('ALTER TABLE posts ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;');
          }
          if (threadColumns.length > 0 && !threadColumns.some((col) => col.name === 'created_by')) {
            sqlite.exec('ALTER TABLE threads ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;');
          }

          // Step 2 (v1.2): 既定ロール権限の冪等初期シード（既存カスタマイズ値を上書きしないため INSERT OR IGNORE 固定）
          sqlite.exec(`
            INSERT OR IGNORE INTO role_permissions (role, permission_key, allowed) VALUES
              ('user',  'create_post',   1),
              ('user',  'create_thread', 0),
              ('user',  'pin_post',      0),
              ('user',  'upload_image',  1),
              ('guest', 'create_post',   1),
              ('guest', 'create_thread', 0),
              ('guest', 'pin_post',      0),
              ('guest', 'upload_image',  0);
          `);

          sqlite.exec(`PRAGMA user_version = ${TARGET_SCHEMA_VERSION};`);
        }
        sqlite.exec('COMMIT;');
        schemaVersion = Math.max(lockedVersion, TARGET_SCHEMA_VERSION);
      } catch (migrationErr) {
        try {
          sqlite.exec('ROLLBACK;');
        } catch {
          // ロールバック失敗時は元の例外を優先
        }
        throw migrationErr;
      }
    }

    // -----------------------------------------------------------------
    // 3. プリペアドステートメントの定義（パラメータ束縛によりSQLインジェクションを防止）
    // -----------------------------------------------------------------
    const stmts = {
      listCategories: sqlite.prepare(`
        SELECT id, name, display_order, created_at
        FROM categories
        ORDER BY display_order ASC, id ASC
      `),

      listAllThreadsSummary: sqlite.prepare(`
        SELECT
          t.id,
          t.category_id,
          t.title,
          t.is_pinned,
          t.display_order,
          t.created_at,
          COUNT(p.id) AS post_count,
          COALESCE(MAX(CASE WHEN p.is_deleted = 0 THEN p.created_at END), t.created_at) AS latest_post_at
        FROM threads t
        LEFT JOIN posts p ON p.thread_id = t.id
        GROUP BY t.id
        ORDER BY t.category_id ASC, t.is_pinned DESC, t.display_order ASC, t.id ASC
      `),

      getThreadById: sqlite.prepare(`
        SELECT id, category_id, title, pinned_text, is_pinned, display_order, created_at
        FROM threads
        WHERE id = ?
      `),

      // ★重要：論理削除（is_deleted = 1）の行はSQL段階で本文・名前・日替わりID・会員判定をマスクし、
      // 削除前の生データがAPIレスポンスやメモリ上の公開配列に乗らないようにする。
      listPublicPostsByThread: sqlite.prepare(`
        SELECT
          id,
          thread_id,
          parent_id,
          CASE WHEN is_deleted = 1 THEN '削除済み' ELSE author_name END AS author_name,
          CASE WHEN is_deleted = 1 THEN '----------' ELSE visitor_id END AS visitor_id,
          CASE WHEN is_deleted = 1 THEN 'この投稿は削除されました。' ELSE content END AS content,
          CASE WHEN is_deleted = 1 THEN 0 ELSE is_pinned END AS is_pinned,
          CASE WHEN is_deleted = 1 THEN 0 WHEN created_by IS NOT NULL THEN 1 ELSE 0 END AS is_member,
          is_deleted,
          created_at
        FROM posts
        WHERE thread_id = ?
        ORDER BY id ASC
        LIMIT ?
      `),

      getPublicPostById: sqlite.prepare(`
        SELECT
          id,
          thread_id,
          parent_id,
          CASE WHEN is_deleted = 1 THEN '削除済み' ELSE author_name END AS author_name,
          CASE WHEN is_deleted = 1 THEN '----------' ELSE visitor_id END AS visitor_id,
          CASE WHEN is_deleted = 1 THEN 'この投稿は削除されました。' ELSE content END AS content,
          CASE WHEN is_deleted = 1 THEN 0 ELSE is_pinned END AS is_pinned,
          CASE WHEN is_deleted = 1 THEN 0 WHEN created_by IS NOT NULL THEN 1 ELSE 0 END AS is_member,
          is_deleted,
          created_at
        FROM posts
        WHERE id = ?
      `),

      countPostsInThread: sqlite.prepare(`
        SELECT COUNT(*) AS cnt
        FROM posts
        WHERE thread_id = ?
      `),

      getPostLineageNode: sqlite.prepare(`
        SELECT id, thread_id, parent_id
        FROM posts
        WHERE id = ?
      `),

      insertPost: sqlite.prepare(`
        INSERT INTO posts (thread_id, parent_id, author_name, visitor_id, content, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `),

      insertPostWithPin: sqlite.prepare(`
        INSERT INTO posts (thread_id, parent_id, author_name, visitor_id, content, is_pinned)
        VALUES (?, ?, ?, ?, ?, ?)
      `),

      getPostDeleteState: sqlite.prepare(`
        SELECT id, is_deleted, is_pinned
        FROM posts
        WHERE id = ?
      `),

      markPostDeleted: sqlite.prepare(`
        UPDATE posts
        SET is_deleted = 1, is_pinned = 0
        WHERE id = ?
      `),

      updatePostPinned: sqlite.prepare(`
        UPDATE posts
        SET is_pinned = ?
        WHERE id = ?
      `),

      updatePostById: sqlite.prepare(`
        UPDATE posts
        SET content = ?, author_name = ?
        WHERE id = ?
      `),

      // 以下は seed.js（初期データ投入）および moderate.js（カテゴリ・スレッド管理CLI）用のステートメント
      getCategoryById: sqlite.prepare(`
        SELECT id, name, display_order, created_at FROM categories WHERE id = ?
      `),
      findCategoryByName: sqlite.prepare(`
        SELECT id, name, display_order FROM categories WHERE name = ?
      `),
      getMaxCategoryOrder: sqlite.prepare(`
        SELECT COALESCE(MAX(display_order), 0) AS max_order FROM categories
      `),
      insertCategory: sqlite.prepare(`
        INSERT INTO categories (name, display_order) VALUES (?, ?)
      `),
      updateCategoryById: sqlite.prepare(`
        UPDATE categories SET name = ?, display_order = ? WHERE id = ?
      `),
      findThreadByCategoryAndTitle: sqlite.prepare(`
        SELECT id, title FROM threads WHERE category_id = ? AND title = ?
      `),
      getMaxThreadOrderInCategory: sqlite.prepare(`
        SELECT COALESCE(MAX(display_order), 0) AS max_order FROM threads WHERE category_id = ?
      `),
      insertThread: sqlite.prepare(`
        INSERT INTO threads (category_id, title, pinned_text, is_pinned, display_order, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      updateThreadById: sqlite.prepare(`
        UPDATE threads SET title = ?, pinned_text = ?, is_pinned = ?, display_order = ? WHERE id = ?
      `),
      countThreadsInCategory: sqlite.prepare(`
        SELECT COUNT(*) AS cnt FROM threads WHERE category_id = ?
      `),
      deleteCategoryById: sqlite.prepare(`
        DELETE FROM categories WHERE id = ?
      `),
      listAdminThreadsSummary: sqlite.prepare(`
        SELECT
          t.id,
          t.category_id,
          t.title,
          t.pinned_text,
          t.is_pinned,
          t.display_order,
          t.created_at,
          COUNT(p.id) AS post_count,
          COALESCE(MAX(CASE WHEN p.is_deleted = 0 THEN p.created_at END), t.created_at) AS latest_post_at
        FROM threads t
        LEFT JOIN posts p ON p.thread_id = t.id
        GROUP BY t.id
        ORDER BY t.category_id ASC, t.is_pinned DESC, t.display_order ASC, t.id ASC
      `),
      countCategories: sqlite.prepare('SELECT COUNT(*) AS cnt FROM categories'),
      countThreads: sqlite.prepare('SELECT COUNT(*) AS cnt FROM threads'),
      countPostsTotal: sqlite.prepare('SELECT COUNT(*) AS cnt FROM posts'),
      countUsersTotal: sqlite.prepare('SELECT COUNT(*) AS cnt FROM users'),
      countAdminUsers: sqlite.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin'"),

      // 物理削除（purge-tree / purge-thread）用のステートメント
      getPostWithThreadAndCategory: sqlite.prepare(`
        SELECT
          p.id, p.thread_id, p.parent_id, p.author_name, p.visitor_id, p.content, p.is_pinned, p.is_deleted, p.created_by, p.created_at,
          t.title AS thread_title, t.category_id,
          c.name AS category_name
        FROM posts p
        JOIN threads t ON t.id = p.thread_id
        JOIN categories c ON c.id = t.category_id
        WHERE p.id = ?
      `),

      getPostDescendantsInLeafOrder: sqlite.prepare(`
        WITH RECURSIVE tree AS (
          SELECT id, parent_id, thread_id, author_name, visitor_id, content, is_pinned, is_deleted, created_at, 1 AS depth
          FROM posts WHERE id = ?
          UNION ALL
          SELECT p.id, p.parent_id, p.thread_id, p.author_name, p.visitor_id, p.content, p.is_pinned, p.is_deleted, p.created_at, t.depth + 1
          FROM posts p JOIN tree t ON p.parent_id = t.id
        )
        SELECT id, parent_id, thread_id, author_name, visitor_id, content, is_pinned, is_deleted, created_at, depth
        FROM tree
        ORDER BY depth DESC, id DESC
      `),

      deletePostById: sqlite.prepare(`
        DELETE FROM posts WHERE id = ?
      `),

      getThreadWithCategory: sqlite.prepare(`
        SELECT
          t.id, t.category_id, t.title, t.pinned_text, t.is_pinned, t.display_order, t.created_at,
          c.name AS category_name
        FROM threads t
        JOIN categories c ON c.id = t.category_id
        WHERE t.id = ?
      `),

      getThreadPostsInLeafOrder: sqlite.prepare(`
        WITH RECURSIVE tree AS (
          SELECT id, parent_id, thread_id, author_name, visitor_id, content, is_pinned, is_deleted, created_at, 1 AS depth
          FROM posts
          WHERE thread_id = ? AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM posts WHERE thread_id = ?))
          UNION ALL
          SELECT p.id, p.parent_id, p.thread_id, p.author_name, p.visitor_id, p.content, p.is_pinned, p.is_deleted, p.created_at, t.depth + 1
          FROM posts p JOIN tree t ON p.parent_id = t.id
        )
        SELECT id, parent_id, thread_id, author_name, visitor_id, content, is_pinned, is_deleted, created_at, depth
        FROM tree
        ORDER BY depth DESC, id DESC
      `),

      deleteThreadById: sqlite.prepare(`
        DELETE FROM threads WHERE id = ?
      `),

      // ユーザー・セッション認証用ステートメント（password_hash と token_hash の扱いを閉じる）
      insertUser: sqlite.prepare(`
        INSERT INTO users (username, password_hash, role, auth_version, must_change_password)
        VALUES (?, ?, ?, 0, ?)
      `),

      getUserByUsername: sqlite.prepare(`
        SELECT id, username, password_hash, role, auth_version, must_change_password, created_at
        FROM users
        WHERE username = ?
      `),

      getUserById: sqlite.prepare(`
        SELECT id, username, password_hash, role, auth_version, must_change_password, created_at
        FROM users
        WHERE id = ?
      `),

      listUsersSummary: sqlite.prepare(`
        SELECT
          u.id,
          u.username,
          u.role,
          u.auth_version,
          u.must_change_password,
          u.created_at,
          COUNT(CASE WHEN s.expires_at > ? THEN 1 END) AS active_sessions
        FROM users u
        LEFT JOIN sessions s ON s.user_id = u.id
        GROUP BY u.id
        ORDER BY u.id ASC
      `),

      listAdminUsersPaged: sqlite.prepare(`
        SELECT
          u.id,
          u.username,
          u.role,
          u.must_change_password,
          u.created_at,
          COUNT(CASE WHEN s.expires_at > ? THEN 1 END) AS active_sessions
        FROM users u
        LEFT JOIN sessions s ON s.user_id = u.id
        GROUP BY u.id
        ORDER BY u.id ASC
        LIMIT ? OFFSET ?
      `),

      insertAdminAuditLog: sqlite.prepare(`
        INSERT INTO admin_audit_logs (
          actor_type, actor_user_id, actor_username, action, target_type, target_id, detail_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `),

      listAdminAuditLogsInitial: sqlite.prepare(`
        SELECT id, actor_type, actor_user_id, actor_username, action, target_type, target_id, detail_json, created_at
        FROM admin_audit_logs
        ORDER BY id DESC
        LIMIT ?
      `),

      listAdminAuditLogsBefore: sqlite.prepare(`
        SELECT id, actor_type, actor_user_id, actor_username, action, target_type, target_id, detail_json, created_at
        FROM admin_audit_logs
        WHERE id < ?
        ORDER BY id DESC
        LIMIT ?
      `),

      insertSession: sqlite.prepare(`
        INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `),

      getSessionAndUserByTokenHash: sqlite.prepare(`
        SELECT
          s.id AS session_id,
          s.token_hash,
          s.expires_at,
          s.created_at AS session_created_at,
          u.id AS user_id,
          u.username,
          u.password_hash,
          u.role,
          u.auth_version,
          u.must_change_password
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
      `),

      listUserSessionIdsAsc: sqlite.prepare(`
        SELECT id
        FROM sessions
        WHERE user_id = ?
        ORDER BY created_at ASC, id ASC
      `),

      deleteSessionById: sqlite.prepare(`
        DELETE FROM sessions WHERE id = ?
      `),

      deleteSessionByTokenHash: sqlite.prepare(`
        DELETE FROM sessions WHERE token_hash = ?
      `),

      deleteExpiredSessionsForUser: sqlite.prepare(`
        DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?
      `),

      deleteAllSessionsForUser: sqlite.prepare(`
        DELETE FROM sessions WHERE user_id = ?
      `),

      deleteAllSessions: sqlite.prepare(`
        DELETE FROM sessions
      `),

      deleteExpiredSessionsBatch: sqlite.prepare(`
        DELETE FROM sessions
        WHERE id IN (
          SELECT id FROM sessions WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?
        )
      `),

      updatePasswordAndBumpVersion: sqlite.prepare(`
        UPDATE users
        SET password_hash = ?, must_change_password = ?, auth_version = auth_version + 1
        WHERE id = ?
      `),

      updateRoleAndBumpVersion: sqlite.prepare(`
        UPDATE users
        SET role = ?, auth_version = auth_version + 1
        WHERE id = ?
      `),

      bumpUserAuthVersion: sqlite.prepare(`
        UPDATE users
        SET auth_version = auth_version + 1
        WHERE id = ?
      `),

      listPermissionsByRole: sqlite.prepare(`
        SELECT permission_key, allowed
        FROM role_permissions
        WHERE role = ?
      `),

      upsertRolePermission: sqlite.prepare(`
        INSERT INTO role_permissions (role, permission_key, allowed, updated_at)
        VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        ON CONFLICT(role, permission_key) DO UPDATE SET
          allowed = excluded.allowed,
          updated_at = excluded.updated_at
      `),
    };

    // node:sqlite が返す null prototype オブジェクトを通常のプレーンオブジェクトへ変換する補助関数
    const toPlain = (row) => (row ? { ...row } : null);
    const toPublicPost = (row) => {
      if (!row) return null;
      return {
        ...row,
        is_member: Boolean(row.is_member),
      };
    };
    const toPublicUser = (row) => {
      if (!row) return null;
      return {
        id: Number(row.id),
        username: row.username,
        role: row.role,
        mustChangePassword: Boolean(row.must_change_password),
      };
    };

    function isUniqueConstraintError(err) {
      const text = `${err?.message || ''} ${err?.errstr || ''}`;
      return /UNIQUE constraint failed/i.test(text);
    }

    function pruneAndInsertSession({
      userId,
      tokenHash,
      expiresAt,
      nowIso,
      maxSessions = 5,
      replaceTokenHash = null,
    }) {
      if (replaceTokenHash) {
        stmts.deleteSessionByTokenHash.run(replaceTokenHash);
      }
      stmts.deleteExpiredSessionsForUser.run(userId, nowIso);
      const activeIds = stmts.listUserSessionIdsAsc.all(userId);
      const overflow = activeIds.length - (maxSessions - 1);
      for (let i = 0; i < overflow; i += 1) {
        stmts.deleteSessionById.run(activeIds[i].id);
      }
      stmts.insertSession.run(userId, tokenHash, expiresAt, nowIso);
    }

    // トランザクション実行ヘルパー（途中で例外が発生したら確実に ROLLBACK してDBを汚さない）
    function runInTransaction(workFn) {
      sqlite.exec('BEGIN IMMEDIATE;');
      try {
        const result = workFn();
        sqlite.exec('COMMIT;');
        return result;
      } catch (err) {
        try {
          sqlite.exec('ROLLBACK;');
        } catch {
          // 既に自動ロールバック済みの場合の二次エラーは無視
        }
        throw err;
      }
    }

    // -----------------------------------------------------------------
    // 3b. 管理MVP用の再認可（確定直前検査）＋秘密除去監査ログ記録ヘルパー
    // -----------------------------------------------------------------
    function assertActiveAdminInTx(adminAuth) {
      if (!adminAuth) {
        return null;
      }
      if (!adminAuth.sessionTokenHash) {
        throw new ValidationError('管理者ログインが必要です。', 401, 'UNAUTHORIZED');
      }
      const sess = stmts.getSessionAndUserByTokenHash.get(adminAuth.sessionTokenHash);
      const nowIso = String(adminAuth.nowIso || new Date().toISOString());
      if (!sess || String(sess.expires_at) <= nowIso) {
        throw new ValidationError('セッションが失効または期限切れです。再ログインしてください。', 401, 'SESSION_EXPIRED');
      }
      if (
        adminAuth.expectedUserId !== undefined &&
        Number(sess.user_id) !== Number(adminAuth.expectedUserId)
      ) {
        throw new ValidationError('アカウント状態が変更されたため再ログインが必要です。', 401, 'SESSION_EXPIRED');
      }
      if (
        adminAuth.expectedAuthVersion !== undefined &&
        Number(sess.auth_version) !== Number(adminAuth.expectedAuthVersion)
      ) {
        throw new ValidationError('認証状態が変更されたため再ログインが必要です。', 401, 'SESSION_EXPIRED');
      }
      if (sess.role !== 'admin') {
        throw new ValidationError('管理者権限が必要です。', 403, 'FORBIDDEN');
      }
      if (Boolean(sess.must_change_password)) {
        throw new ValidationError(
          '仮パスワードを変更して再ログインするまで管理操作はできません。',
          403,
          'PASSWORD_CHANGE_REQUIRED'
        );
      }
      return {
        actorType: 'admin_web',
        actorUserId: Number(sess.user_id),
        actorUsername: sess.username,
      };
    }

    const FORBIDDEN_AUDIT_KEY_RE =
      /^(?:password|pass|secret|token|cookie|auth|authorization|hash|bearer|signature|private_key|api_key)$|password|secret|token|cookie|hash|bearer|signature|private.?key|api.?key/i;

    function sanitizeAuditValue(val, depth = 0) {
      if (val === null || val === undefined) return null;
      if (typeof val === 'number' || typeof val === 'boolean') return val;
      if (typeof val === 'string') {
        return val.length > 200 ? `${val.slice(0, 200)}...` : val;
      }
      if (depth >= 3) return '[nested]';
      if (Array.isArray(val)) {
        return val.slice(0, 20).map((item) => sanitizeAuditValue(item, depth + 1));
      }
      if (typeof val === 'object') {
        const cleanObj = {};
        for (const [k, v] of Object.entries(val)) {
          if (FORBIDDEN_AUDIT_KEY_RE.test(k) || v === undefined) {
            continue;
          }
          cleanObj[k] = sanitizeAuditValue(v, depth + 1);
        }
        return cleanObj;
      }
      return String(val);
    }

    function buildSafeAuditDetailJson(detail) {
      const sanitized = sanitizeAuditValue(detail && typeof detail === 'object' ? detail : {});
      let jsonStr = JSON.stringify(sanitized);
      if (Buffer.byteLength(jsonStr, 'utf8') > 2048) {
        const compact = {
          truncated: true,
          keys: Object.keys(sanitized && typeof sanitized === 'object' ? sanitized : {}).slice(0, 12),
        };
        jsonStr = JSON.stringify(compact);
      }
      return jsonStr;
    }

    function resolveAuditActorInTx(adminAuth, audit) {
      const verifiedWebActor = assertActiveAdminInTx(adminAuth);
      if (verifiedWebActor) {
        return verifiedWebActor;
      }
      if (!audit) {
        return null;
      }
      const actorType = audit.actorType === 'admin_web' ? 'admin_web' : 'cli';
      const actorUserId =
        Number.isSafeInteger(audit.actorUserId) && audit.actorUserId >= 1 ? audit.actorUserId : null;
      const rawName = typeof audit.actorUsername === 'string' && audit.actorUsername.trim()
        ? audit.actorUsername.trim()
        : actorType === 'cli'
          ? 'cli'
          : 'admin';
      const actorUsername = Array.from(rawName).slice(0, 64).join('');
      return { actorType, actorUserId, actorUsername };
    }

    function recordAuditInTx(actor, { action, targetType, targetId, detail = {} }) {
      if (!actor) {
        return;
      }
      const detailJson = buildSafeAuditDetailJson(detail);
      stmts.insertAdminAuditLog.run(
        actor.actorType,
        actor.actorUserId,
        actor.actorUsername,
        String(action),
        String(targetType),
        String(targetId),
        detailJson
      );
    }

    function inspectRolePermissionsInDb(role) {
      if (role === 'admin') {
        return {
          permissions: { ...DEFAULT_ROLE_PERMISSIONS.admin },
          presentKeys: new Set(PERMISSION_KEYS),
          missingKeys: [],
        };
      }
      const cleanRole = validatePermissionRole(role);
      const permissions = {};
      for (const key of PERMISSION_KEYS) {
        permissions[key] = false;
      }
      const presentKeys = new Set();
      for (const row of stmts.listPermissionsByRole.all(cleanRole)) {
        if (PERMISSION_KEYS.includes(row.permission_key)) {
          presentKeys.add(row.permission_key);
          permissions[row.permission_key] = Number(row.allowed) === 1;
        }
      }
      const missingKeys = PERMISSION_KEYS.filter((key) => !presentKeys.has(key));
      return { permissions, presentKeys, missingKeys };
    }

    function readRolePermissionsMap(role) {
      return inspectRolePermissionsInDb(role).permissions;
    }

    function listMissingRolePermissions() {
      const missing = [];
      for (const role of ['user', 'guest']) {
        const { missingKeys } = inspectRolePermissionsInDb(role);
        for (const permissionKey of missingKeys) {
          missing.push({ role, permissionKey });
        }
      }
      return missing;
    }

    function applyUserRoleChangeInTx(actor, user, cleanRole) {
      if (!user) {
        return { found: false, unchanged: false, revokedSessions: 0, user: null, selfAffected: false };
      }
      const selfAffected = Boolean(actor && actor.actorUserId === Number(user.id));
      // R2: CLI・Web管理共用の最後の管理者保護（降格後の admin が 0 人になる操作を拒否）
      if (user.role === 'admin' && cleanRole !== 'admin') {
        const { cnt } = stmts.countAdminUsers.get();
        if (Number(cnt) <= 1) {
          throw new ValidationError(
            '最後の管理者（admin）を一般会員へ降格することはできません。',
            409,
            'LAST_ADMIN_PROTECTED'
          );
        }
      }
      if (user.role === cleanRole) {
        return {
          found: true,
          unchanged: true,
          revokedSessions: 0,
          user: toPublicUser(user),
          selfAffected,
        };
      }
      stmts.updateRoleAndBumpVersion.run(cleanRole, user.id);
      const deletedInfo = stmts.deleteAllSessionsForUser.run(user.id);
      const revokedSessions = Number(deletedInfo.changes ?? 0);
      const updated = stmts.getUserById.get(user.id);
      recordAuditInTx(actor, {
        action: 'user_role_change',
        targetType: 'user',
        targetId: String(user.id),
        detail: {
          username: user.username,
          beforeRole: user.role,
          afterRole: cleanRole,
          revokedSessions,
          selfChange: selfAffected,
        },
      });
      return {
        found: true,
        unchanged: false,
        revokedSessions,
        user: toPublicUser(updated),
        selfAffected,
      };
    }

    function applyRevokeUserSessionsInTx(actor, user) {
      if (!user) {
        return { found: false, revokedSessions: 0, user: null, selfAffected: false };
      }
      const selfAffected = Boolean(actor && actor.actorUserId === Number(user.id));
      stmts.bumpUserAuthVersion.run(user.id);
      const deletedInfo = stmts.deleteAllSessionsForUser.run(user.id);
      const revokedSessions = Number(deletedInfo.changes ?? 0);
      const updated = stmts.getUserById.get(user.id);
      recordAuditInTx(actor, {
        action: 'user_revoke_sessions',
        targetType: 'user',
        targetId: String(user.id),
        detail: {
          username: user.username,
          revokedSessions,
          selfRevoke: selfAffected,
        },
      });
      return {
        found: true,
        revokedSessions,
        user: toPublicUser(updated),
        selfAffected,
      };
    }

    // -----------------------------------------------------------------
    // 4. 外部へ公開する操作メソッド群
    // -----------------------------------------------------------------
    return {
      // 起動ログやテスト検証で実際の接続先・PRAGMA値を確認するためのステータス取得
      getStatus() {
        return {
          dbPath: targetPath,
          foreignKeys,
          journalMode,
          schemaVersion,
          maxPostsPerThread,
          maxReplyDepth,
          missingRolePermissions: listMissingRolePermissions(),
        };
      },

      // 左サイドバーと上部スレッド選択タブ用の「カテゴリ一覧＋配下スレッド概要」を取得
      listCategoriesWithThreads() {
        const categories = stmts.listCategories.all().map((c) => ({
          ...c,
          threads: [],
        }));
        const categoryMap = new Map(categories.map((c) => [c.id, c]));

        const threads = stmts.listAllThreadsSummary.all();
        for (const t of threads) {
          const parentCat = categoryMap.get(t.category_id);
          if (parentCat) {
            parentCat.threads.push({ ...t });
          }
        }
        return categories;
      },

      // 選択されたスレッドの詳細（タイトル・ピン留め文）とマスク済み投稿一覧を取得
      getThreadDetail(threadId) {
        const thread = toPlain(stmts.getThreadById.get(threadId));
        if (!thread) {
          return null;
        }
        const posts = stmts.listPublicPostsByThread
          .all(threadId, maxPostsPerThread)
          .map(toPublicPost);

        return {
          thread,
          posts,
          limits: {
            maxPostsPerThread,
            maxReplyDepth,
          },
        };
      },

      // 新規投稿または返信の登録（トランザクション内で権限・整合性・件数上限・階層上限を検査）
      createPost({ threadId, parentId = null, authorName, visitorId, content, createdBy = null, enforceRole = null }) {
        return runInTransaction(() => {
          // 0. Step 2: 書き込み確定時点でロールの投稿権限を再確認（TX外変更との競合を防止）
          if (enforceRole !== null && enforceRole !== undefined) {
            const perms = readRolePermissionsMap(enforceRole);
            if (!perms.create_post) {
              throw new ValidationError(
                enforceRole === 'guest'
                  ? '現在、未ログイン状態での新規投稿は停止されています。ログインしてから投稿してください。'
                  : '現在、一般会員による新規投稿は管理者により制限されています。',
                403,
                'PERMISSION_DENIED'
              );
            }
          }

          // ① 投稿先スレッドの実在確認
          const thread = stmts.getThreadById.get(threadId);
          if (!thread) {
            throw new ValidationError('指定されたスレッドが存在しません。', 404);
          }

          // ② スレッドあたりの件数上限検査（取得上限を超えて見えない投稿が貯まるのを防止）
          const { cnt } = stmts.countPostsInThread.get(threadId);
          if (cnt >= maxPostsPerThread) {
            throw new ValidationError(
              `このスレッドは投稿上限（${maxPostsPerThread}件）に達しているため、新しく書き込めません。`,
              400
            );
          }

          // ③ 返信（parentId 指定時）の親存在・同一スレッド一致・返信階層深さの検査
          if (parentId !== null) {
            let depth = 0;
            let cursorId = parentId;
            const visited = new Set();

            while (cursorId !== null) {
              if (visited.has(cursorId)) {
                throw new ValidationError('返信ツリーの親子関係が不正です。', 400);
              }
              visited.add(cursorId);

              const parentNode = stmts.getPostLineageNode.get(cursorId);
              if (!parentNode || parentNode.thread_id !== threadId) {
                throw new ValidationError(
                  '返信先の投稿が存在しないか、別のスレッドの投稿が指定されています。',
                  400
                );
              }

              depth += 1;
              if (depth > maxReplyDepth) {
                throw new ValidationError(
                  `返信の階層上限（${maxReplyDepth}段）を超えています。浅い階層の投稿へ返信してください。`,
                  400
                );
              }
              cursorId = parentNode.parent_id;
            }
          }

          // ④ 投稿行の挿入（DB側の複合外部キー・2引数trim CHECK制約でも二重に検証される）
          const info = stmts.insertPost.run(threadId, parentId, authorName, visitorId, content, createdBy);
          const newPostId = Number(info.lastInsertRowid);
          return toPublicPost(stmts.getPublicPostById.get(newPostId));
        });
      },

      // 管理者による論理削除（行と返信ツリー構造を残し、本文・名前を非表示化、ピン留めも解除する）
      softDeletePost(postId, { adminAuth = null, audit = null } = {}) {
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const existing = stmts.getPostDeleteState.get(postId);
          if (!existing) {
            return { found: false, alreadyDeleted: false };
          }
          if (existing.is_deleted === 1) {
            return { found: true, alreadyDeleted: true };
          }
          stmts.markPostDeleted.run(postId);
          recordAuditInTx(actor, {
            action: 'post_soft_delete',
            targetType: 'post',
            targetId: String(postId),
            detail: { previousPinned: Boolean(existing.is_pinned) },
          });
          return { found: true, alreadyDeleted: false };
        });
      },

      // 管理者による投稿ピン留め ON/OFF 設定（削除済み投稿のピン留めは拒否する）
      setPostPinned(postId, isPinned, { adminAuth = null, audit = null } = {}) {
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const existing = stmts.getPostDeleteState.get(postId);
          if (!existing) {
            return { found: false, isPinned: false };
          }
          if (existing.is_deleted === 1 && isPinned) {
            throw new ValidationError('論理削除済みの投稿はピン留めできません。', 400);
          }
          const nextVal = isPinned ? 1 : 0;
          if (existing.is_pinned !== nextVal) {
            stmts.updatePostPinned.run(nextVal, postId);
            recordAuditInTx(actor, {
              action: nextVal === 1 ? 'post_pin' : 'post_unpin',
              targetType: 'post',
              targetId: String(postId),
              detail: { previousPinned: Boolean(existing.is_pinned), nextPinned: Boolean(nextVal) },
            });
          }
          return { found: true, isPinned: Boolean(nextVal) };
        });
      },

      // 管理者による通常コメント（投稿）の本文・投稿者名変更
      // 返信ツリー（parent_id）・ピン留め・visitor_id・作成日時は維持し、論理削除済み投稿の編集は拒否する
      updatePost({ postId, content, authorName = undefined, adminAuth = null, audit = null }) {
        const validPostId = parsePositiveInt(postId, '投稿ID');
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const existing = toPlain(stmts.getPostWithThreadAndCategory.get(validPostId));
          if (!existing) {
            return { found: false, previousPost: null, post: null };
          }
          if (existing.is_deleted === 1) {
            throw new ValidationError('論理削除済みの投稿は編集できません。', 400);
          }
          if (
            existing.created_by !== null &&
            authorName !== undefined &&
            authorName !== null &&
            String(authorName) !== existing.author_name
          ) {
            throw new ValidationError(
              '会員アカウントに紐づく投稿の投稿者名は変更できません（本文のみ編集可能です）。',
              400
            );
          }

          const validated = validatePostInput({
            thread_id: existing.thread_id,
            parent_id: existing.parent_id,
            author_name: authorName !== undefined ? authorName : existing.author_name,
            content,
          });

          stmts.updatePostById.run(validated.content, validated.authorName, validPostId);
          recordAuditInTx(actor, {
            action: 'post_update',
            targetType: 'post',
            targetId: String(validPostId),
            detail: { threadId: existing.thread_id, previousAuthor: existing.author_name, nextAuthor: validated.authorName },
          });
          return {
            found: true,
            previousPost: existing,
            post: toPlain(stmts.getPostWithThreadAndCategory.get(validPostId)),
          };
        });
      },

      // 管理者による新規カテゴリ追加（同名重複・空欄・30文字超過を検査し、displayOrder未指定時は末尾順を自動採番）
      createCategory({ name, displayOrder = null, adminAuth = null, audit = null }) {
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const trimmed = validateCategoryName(name);
          const duplicate = stmts.findCategoryByName.get(trimmed);
          if (duplicate) {
            throw new ValidationError(
              `同名のカテゴリ「${trimmed}」が既に存在します（ID: ${duplicate.id}）。`,
              409,
              'CATEGORY_ALREADY_EXISTS'
            );
          }

          let orderVal;
          if (displayOrder === null || displayOrder === undefined) {
            const maxRow = stmts.getMaxCategoryOrder.get();
            orderVal = Number(maxRow?.max_order ?? 0) + 1;
          } else {
            orderVal = validateNonNegativeInt(displayOrder, '表示順');
          }

          const info = stmts.insertCategory.run(trimmed, orderVal);
          const created = toPlain(stmts.getCategoryById.get(Number(info.lastInsertRowid)));
          recordAuditInTx(actor, {
            action: 'category_create',
            targetType: 'category',
            targetId: String(created.id),
            detail: { name: created.name, displayOrder: created.display_order },
          });
          return created;
        });
      },

      // 管理者による既存カテゴリの名前・表示順変更（配下のスレッドや投稿は一切失われずそのまま維持される）
      updateCategory({ categoryId, name = undefined, displayOrder = undefined, adminAuth = null, audit = null }) {
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const existing = stmts.getCategoryById.get(categoryId);
          if (!existing) {
            return { found: false, category: null };
          }

          let nextName = existing.name;
          if (name !== undefined && name !== null) {
            const trimmed = validateCategoryName(name);
            const dup = stmts.findCategoryByName.get(trimmed);
            if (dup && Number(dup.id) !== Number(categoryId)) {
              throw new ValidationError(
                `同名のカテゴリ「${trimmed}」が既に存在します（ID: ${dup.id}）。`,
                409,
                'CATEGORY_ALREADY_EXISTS'
              );
            }
            nextName = trimmed;
          }

          let nextOrder = existing.display_order;
          if (displayOrder !== undefined && displayOrder !== null) {
            nextOrder = validateNonNegativeInt(displayOrder, '表示順');
          }

          stmts.updateCategoryById.run(nextName, nextOrder, categoryId);
          const updated = toPlain(stmts.getCategoryById.get(categoryId));
          recordAuditInTx(actor, {
            action: 'category_update',
            targetType: 'category',
            targetId: String(categoryId),
            detail: {
              beforeName: existing.name,
              afterName: updated.name,
              beforeOrder: existing.display_order,
              afterOrder: updated.display_order,
            },
          });
          return {
            found: true,
            category: updated,
          };
        });
      },

      // 管理者によるカテゴリ物理削除（配下にスレッドが残る場合 409 / 最後の1カテゴリ削除は 409 LAST_CATEGORY_PROTECTED）
      deleteCategory(categoryId, { adminAuth = null, audit = null } = {}) {
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const existing = toPlain(stmts.getCategoryById.get(categoryId));
          if (!existing) {
            return { found: false, deletedCategory: null };
          }
          const { cnt } = stmts.countThreadsInCategory.get(categoryId);
          if (Number(cnt) > 0) {
            throw new ValidationError(
              `カテゴリ「${existing.name}」には ${cnt} 件のスレッドが残っているため削除できません。先に配下のスレッドを削除してください。`,
              409,
              'CATEGORY_NOT_EMPTY',
              { threadsCount: Number(cnt) }
            );
          }
          const totalCategories = Number(stmts.countCategories.get()?.cnt ?? 0);
          if (totalCategories <= 1) {
            throw new ValidationError(
              '最後のカテゴリは削除できません。別カテゴリを追加するか、このカテゴリの名前を変更してください。',
              409,
              'LAST_CATEGORY_PROTECTED',
              { categoriesCount: totalCategories }
            );
          }
          stmts.deleteCategoryById.run(categoryId);
          recordAuditInTx(actor, {
            action: 'category_delete',
            targetType: 'category',
            targetId: String(categoryId),
            detail: { name: existing.name, displayOrder: existing.display_order },
          });
          return { found: true, deletedCategory: existing };
        });
      },

      // 管理者による新規スレッド追加（所属カテゴリの実在確認＋タイトル1〜100文字＋案内文500文字以内検査＋表示順採番）
      // ※ P2-2対応：案内文は threads.pinned_text を単一データソースとし、既定では posts へ複製しない
      createThread({
        categoryId,
        title,
        pinnedText = null,
        isPinned = false,
        displayOrder = null,
        createdBy = null,
        createPinnedPost = false,
        adminAuth = null,
        audit = null,
      }) {
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const category = stmts.getCategoryById.get(categoryId);
          if (!category) {
            throw new ValidationError(`カテゴリ #${categoryId} は存在しません。`, 404);
          }

          const trimmedTitle = validateThreadTitle(title);

          let orderVal;
          if (displayOrder === null || displayOrder === undefined) {
            const maxRow = stmts.getMaxThreadOrderInCategory.get(categoryId);
            orderVal = Number(maxRow?.max_order ?? 0) + 1;
          } else {
            orderVal = validateNonNegativeInt(displayOrder, '表示順');
          }

          const normalizedPinText = validateThreadPinnedText(pinnedText);
          if (typeof isPinned !== 'boolean') {
            throw new ValidationError('isPinned には true または false を指定してください。', 400);
          }

          const pinFlag = isPinned ? 1 : 0;
          const creatorUserId = createdBy ?? actor?.actorUserId ?? null;
          const info = stmts.insertThread.run(
            categoryId,
            trimmedTitle,
            normalizedPinText,
            pinFlag,
            orderVal,
            creatorUserId
          );
          const newThreadId = Number(info.lastInsertRowid);

          if (createPinnedPost && normalizedPinText !== null) {
            stmts.insertPostWithPin.run(
              newThreadId,
              null,
              '管理案内',
              'admin-init',
              normalizedPinText,
              1
            );
          }

          const created = toPlain(stmts.getThreadById.get(newThreadId));
          recordAuditInTx(actor, {
            action: 'thread_create',
            targetType: 'thread',
            targetId: String(created.id),
            detail: {
              categoryId,
              title: created.title,
              isPinned: Boolean(created.is_pinned),
              hasPinnedText: normalizedPinText !== null,
              displayOrder: created.display_order,
            },
          });
          return created;
        });
      },

      // 管理者による既存スレッドのタイトル・案内文・ピン留め・表示順変更（P2拡張：pinnedText / isPinned 対応）
      updateThread({
        threadId,
        title = undefined,
        pinnedText = undefined,
        isPinned = undefined,
        displayOrder = undefined,
        adminAuth = null,
        audit = null,
      }) {
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const existing = stmts.getThreadById.get(threadId);
          if (!existing) {
            return { found: false, thread: null };
          }

          let nextTitle = existing.title;
          if (title !== undefined && title !== null) {
            nextTitle = validateThreadTitle(title);
          }

          let nextPinnedText = existing.pinned_text ?? null;
          if (pinnedText !== undefined) {
            nextPinnedText = validateThreadPinnedText(pinnedText);
          }

          let nextIsPinned = existing.is_pinned ? 1 : 0;
          if (isPinned !== undefined) {
            if (typeof isPinned !== 'boolean') {
              throw new ValidationError('isPinned には true または false を指定してください。', 400);
            }
            nextIsPinned = isPinned ? 1 : 0;
          }

          let nextOrder = existing.display_order ?? 0;
          if (displayOrder !== undefined && displayOrder !== null) {
            nextOrder = validateNonNegativeInt(displayOrder, '表示順');
          }

          stmts.updateThreadById.run(nextTitle, nextPinnedText, nextIsPinned, nextOrder, threadId);
          const updated = toPlain(stmts.getThreadById.get(threadId));
          recordAuditInTx(actor, {
            action: 'thread_update',
            targetType: 'thread',
            targetId: String(threadId),
            detail: {
              beforeTitle: existing.title,
              afterTitle: updated.title,
              pinnedTextChanged: (existing.pinned_text ?? null) !== (updated.pinned_text ?? null),
              beforePinned: Boolean(existing.is_pinned),
              afterPinned: Boolean(updated.is_pinned),
              beforeOrder: existing.display_order,
              afterOrder: updated.display_order,
            },
          });
          return {
            found: true,
            thread: updated,
          };
        });
      },

      // 冪等な初期データ投入（空DBへの初回投入専用。スレッド改名後に再実行しても旧名スレッドが復活しないよう保護）
      seedInitialData(seedCategories) {
        return runInTransaction(() => {
          if (stmts.listCategories.all().length > 0) {
            return { createdCategories: 0, createdThreads: 0, createdPosts: 0 };
          }

          let createdCategories = 0;
          let createdThreads = 0;
          let createdPosts = 0;

          for (const catDef of seedCategories) {
            let catRow = stmts.findCategoryByName.get(catDef.name);
            if (!catRow) {
              const catInfo = stmts.insertCategory.run(catDef.name, catDef.displayOrder ?? 0);
              catRow = { id: Number(catInfo.lastInsertRowid), name: catDef.name };
              createdCategories += 1;
            }

            for (const threadDef of catDef.threads || []) {
              const existingThread = stmts.findThreadByCategoryAndTitle.get(
                catRow.id,
                threadDef.title
              );
              // 既に同名スレッドが存在する場合は一切触れずスキップする（重複作成・投稿破壊の防止）
              if (existingThread) {
                continue;
              }

              const threadInfo = stmts.insertThread.run(
                catRow.id,
                threadDef.title,
                threadDef.pinnedText ?? null,
                threadDef.isPinned ? 1 : 0,
                threadDef.displayOrder ?? 0,
                null
              );
              const newThreadId = Number(threadInfo.lastInsertRowid);
              createdThreads += 1;

              // 新規作成された初期スレッドに限り、サンプル投稿・返信ツリーを順番に投入する
              const refToIdMap = new Map();
              for (const postDef of threadDef.samplePosts || []) {
                const resolvedParentId = postDef.parentRef
                  ? refToIdMap.get(postDef.parentRef) ?? null
                  : null;
                const postInfo = stmts.insertPostWithPin.run(
                  newThreadId,
                  resolvedParentId,
                  postDef.authorName || '名無しさん',
                  postDef.visitorId || 'seed-guide',
                  postDef.content,
                  postDef.isPinned ? 1 : 0
                );
                if (postDef.ref) {
                  refToIdMap.set(postDef.ref, Number(postInfo.lastInsertRowid));
                }
                createdPosts += 1;
              }
            }
          }

          return { createdCategories, createdThreads, createdPosts };
        });
      },

      // ---------------------------------------------------------------
      // 物理削除プレビュー・実行（管理CLI: purge-tree / purge-thread）
      // 外部キー制約（ON DELETE RESTRICT）を維持したまま、
      // 再帰CTE（WITH RECURSIVE）で末端（孫）から親へ逆順に安全に完全削除する。
      // ---------------------------------------------------------------
      getPurgeTreePreview(postId) {
        const rootPost = toPlain(stmts.getPostWithThreadAndCategory.get(postId));
        if (!rootPost) {
          return { found: false };
        }
        const descendants = stmts.getPostDescendantsInLeafOrder.all(postId).map(toPlain);
        return {
          found: true,
          rootPost,
          thread: { id: rootPost.thread_id, title: rootPost.thread_title },
          category: { id: rootPost.category_id, name: rootPost.category_name },
          posts: descendants,
          postsCount: descendants.length,
          isSubtree: rootPost.parent_id !== null,
        };
      },

      purgePostTree(postId, { adminAuth = null, audit = null } = {}) {
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const rootPost = toPlain(stmts.getPostWithThreadAndCategory.get(postId));
          if (!rootPost) {
            return { found: false, deletedCount: 0, deletedIds: [] };
          }
          const descendants = stmts.getPostDescendantsInLeafOrder.all(postId).map(toPlain);
          const deletedIds = [];
          for (const p of descendants) {
            stmts.deletePostById.run(p.id);
            deletedIds.push(p.id);
          }
          recordAuditInTx(actor, {
            action: 'post_purge_tree',
            targetType: 'post',
            targetId: String(postId),
            detail: { threadId: rootPost.thread_id, deletedCount: deletedIds.length },
          });
          return {
            found: true,
            rootPost,
            thread: { id: rootPost.thread_id, title: rootPost.thread_title },
            category: { id: rootPost.category_id, name: rootPost.category_name },
            deletedCount: deletedIds.length,
            deletedIds,
            isSubtree: rootPost.parent_id !== null,
          };
        });
      },

      getPurgeThreadPreview(threadId) {
        const thread = toPlain(stmts.getThreadWithCategory.get(threadId));
        if (!thread) {
          return { found: false };
        }
        const posts = stmts.getThreadPostsInLeafOrder.all(threadId, threadId).map(toPlain);
        return {
          found: true,
          thread,
          category: { id: thread.category_id, name: thread.category_name },
          posts,
          postsCount: posts.length,
        };
      },

      purgeThread(threadId, options = {}) {
        const {
          requireConfirmation = false,
          confirmTitle = undefined,
          expectedPostCount = undefined,
          adminAuth = null,
          audit = null,
        } = options;
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const thread = toPlain(stmts.getThreadWithCategory.get(threadId));
          if (!thread) {
            return { found: false, deletedPostsCount: 0, deletedPostIds: [] };
          }
          const posts = stmts.getThreadPostsInLeafOrder.all(threadId, threadId).map(toPlain);

          if (requireConfirmation || confirmTitle !== undefined || expectedPostCount !== undefined) {
            if (typeof confirmTitle !== 'string' || confirmTitle.trim() !== thread.title) {
              throw new ValidationError(
                '確認用のスレッドタイトルが一致しません。対象スレッド名を正確に入力してください。',
                400,
                'CONFIRM_TITLE_MISMATCH'
              );
            }
            if (!Number.isSafeInteger(expectedPostCount) || expectedPostCount < 0) {
              throw new ValidationError('確認時の投稿件数（expectedPostCount）が不正です。', 400);
            }
            if (posts.length !== expectedPostCount) {
              throw new ValidationError(
                `確認画面を開いた後に投稿数が変化しました（確認時: ${expectedPostCount}件 / 最新: ${posts.length}件）。最新件数を確認してから再実行してください。`,
                409,
                'THREAD_POST_COUNT_CHANGED',
                { expectedPostCount, actualPostsCount: posts.length, threadTitle: thread.title }
              );
            }
          }

          const deletedPostIds = [];
          for (const p of posts) {
            stmts.deletePostById.run(p.id);
            deletedPostIds.push(p.id);
          }
          stmts.deleteThreadById.run(threadId);
          recordAuditInTx(actor, {
            action: 'thread_purge',
            targetType: 'thread',
            targetId: String(threadId),
            detail: {
              categoryId: thread.category_id,
              title: thread.title,
              deletedPostsCount: deletedPostIds.length,
            },
          });
          return {
            found: true,
            deletedThread: thread,
            category: { id: thread.category_id, name: thread.category_name },
            deletedPostsCount: deletedPostIds.length,
            deletedPostIds,
          };
        });
      },

      // バックアップファイル生成（F2対策：既存バックアップを先に消さず、一時ファイルへ生成・検証後に原子的置換する）
      backupTo(destinationPath, options = {}) {
        const dest = path.resolve(destinationPath);
        if (dest === targetPath) {
          throw new Error('バックアップ先に元のDBと同じパスは指定できません。');
        }
        return vacuumSqliteConnectionToFile(sqlite, dest, options);
      },

      // ---------------------------------------------------------------
      // ユーザー・セッション認証操作（すべて同期トランザクション内で完結させ、scrypt待機を持ち込まない）
      // ---------------------------------------------------------------
      createUserWithSession({
        username,
        passwordHash,
        role = 'user',
        tokenHash,
        expiresAt,
        nowIso,
        mustChangePassword = false,
      }) {
        const cleanUsername = validateUsername(username);
        const cleanRole = validateUserRole(role);
        return runInTransaction(() => {
          try {
            const info = stmts.insertUser.run(
              cleanUsername,
              passwordHash,
              cleanRole,
              mustChangePassword ? 1 : 0
            );
            const userId = Number(info.lastInsertRowid);
            stmts.insertSession.run(userId, tokenHash, expiresAt, nowIso);
            const created = stmts.getUserById.get(userId);
            return toPublicUser(created);
          } catch (err) {
            if (isUniqueConstraintError(err)) {
              throw new ValidationError('このユーザー名は既に使用されています。', 409);
            }
            throw err;
          }
        });
      },

      // ---------------------------------------------------------------
      // 管理MVP用 参照・一覧API（ページング＆最小DTO・秘密除外）
      // ---------------------------------------------------------------
      getAdminOverview() {
        const categories = stmts.listCategories.all().map((c) => ({
          ...c,
          threads: [],
        }));
        const categoryMap = new Map(categories.map((c) => [c.id, c]));
        const threads = stmts.listAdminThreadsSummary.all();
        for (const t of threads) {
          const parentCat = categoryMap.get(t.category_id);
          if (parentCat) {
            parentCat.threads.push({ ...t });
          }
        }
        return {
          summary: {
            categoriesCount: Number(stmts.countCategories.get()?.cnt ?? 0),
            threadsCount: Number(stmts.countThreads.get()?.cnt ?? 0),
            postsCount: Number(stmts.countPostsTotal.get()?.cnt ?? 0),
            usersCount: Number(stmts.countUsersTotal.get()?.cnt ?? 0),
            adminsCount: Number(stmts.countAdminUsers.get()?.cnt ?? 0),
          },
          categories,
        };
      },

      getAdminThreadPosts(threadId) {
        const thread = toPlain(stmts.getThreadWithCategory.get(threadId));
        if (!thread) {
          return null;
        }
        const posts = stmts.listPublicPostsByThread
          .all(threadId, maxPostsPerThread)
          .map(toPublicPost);
        return { thread, posts };
      },

      listAdminUsers({ limit = 50, offset = 0, nowIso = new Date().toISOString() } = {}) {
        const safeLimit = parsePaginationLimit(limit, { defaultLimit: 50, maxLimit: 100 });
        const safeOffset = parsePaginationOffset(offset);
        const total = Number(stmts.countUsersTotal.get()?.cnt ?? 0);
        const users = stmts.listAdminUsersPaged.all(nowIso, safeLimit, safeOffset).map((row) => ({
          id: Number(row.id),
          username: row.username,
          role: row.role,
          mustChangePassword: Boolean(row.must_change_password),
          activeSessions: Number(row.active_sessions),
          createdAt: row.created_at,
        }));
        return {
          users,
          total,
          limit: safeLimit,
          offset: safeOffset,
        };
      },

      listAdminAuditLogs({ limit = 50, beforeId = null } = {}) {
        const safeLimit = parsePaginationLimit(limit, { defaultLimit: 50, maxLimit: 100 });
        const parsedBefore =
          beforeId !== null && beforeId !== undefined && beforeId !== ''
            ? parsePositiveInt(beforeId, 'カーソルID(before_id)')
            : null;
        const rows = parsedBefore !== null
          ? stmts.listAdminAuditLogsBefore.all(parsedBefore, safeLimit + 1)
          : stmts.listAdminAuditLogsInitial.all(safeLimit + 1);
        const hasMore = rows.length > safeLimit;
        const slice = hasMore ? rows.slice(0, safeLimit) : rows;
        const logs = slice.map((row) => {
          let detail = {};
          try {
            detail = JSON.parse(row.detail_json);
          } catch {
            detail = {};
          }
          return {
            id: Number(row.id),
            actorType: row.actor_type,
            actorUserId: row.actor_user_id === null ? null : Number(row.actor_user_id),
            actorUsername: row.actor_username,
            action: row.action,
            targetType: row.target_type,
            targetId: row.target_id,
            detail,
            createdAt: row.created_at,
          };
        });
        return {
          logs,
          hasMore,
          nextBeforeId: logs.length > 0 ? logs[logs.length - 1].id : null,
          limit: safeLimit,
        };
      },

      createUser({ username, passwordHash, role = 'user', mustChangePassword = false, adminAuth = null, audit = null }) {
        const cleanUsername = validateUsername(username);
        const cleanRole = validateUserRole(role);
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          try {
            const info = stmts.insertUser.run(
              cleanUsername,
              passwordHash,
              cleanRole,
              mustChangePassword ? 1 : 0
            );
            const userId = Number(info.lastInsertRowid);
            const created = toPublicUser(stmts.getUserById.get(userId));
            recordAuditInTx(actor, {
              action: 'user_create',
              targetType: 'user',
              targetId: String(userId),
              detail: { username: cleanUsername, role: cleanRole },
            });
            return created;
          } catch (err) {
            if (isUniqueConstraintError(err)) {
              throw new ValidationError(`ユーザー名「${cleanUsername}」は既に登録されています。`, 409);
            }
            throw err;
          }
        });
      },

      getUserForAuthByUsername(username) {
        const cleanUsername = validateUsername(username);
        return toPlain(stmts.getUserByUsername.get(cleanUsername));
      },

      listUsers(nowIso = new Date().toISOString()) {
        return stmts.listUsersSummary.all(nowIso).map((row) => ({
          id: Number(row.id),
          username: row.username,
          role: row.role,
          auth_version: Number(row.auth_version),
          mustChangePassword: Boolean(row.must_change_password),
          active_sessions: Number(row.active_sessions),
          created_at: row.created_at,
        }));
      },

      // 非同期 scrypt 照合完了後に auth_version 一致を検証したうえでセッションを発行する
      issueSessionIfVersionMatches({
        userId,
        expectedAuthVersion,
        tokenHash,
        expiresAt,
        nowIso,
        maxSessions = 5,
        replaceTokenHash = null,
      }) {
        return runInTransaction(() => {
          const user = stmts.getUserById.get(userId);
          if (!user || Number(user.auth_version) !== Number(expectedAuthVersion)) {
            return { issued: false, reason: 'AUTH_VERSION_MISMATCH', user: null };
          }
          pruneAndInsertSession({
            userId: Number(user.id),
            tokenHash,
            expiresAt,
            nowIso,
            maxSessions,
            replaceTokenHash,
          });
          return { issued: true, user: toPublicUser(user) };
        });
      },

      getSessionAuthByTokenHash(tokenHash, nowIso) {
        const row = stmts.getSessionAndUserByTokenHash.get(tokenHash);
        if (!row) {
          return null;
        }
        if (String(row.expires_at) <= String(nowIso)) {
          return null;
        }
        return {
          sessionId: Number(row.session_id),
          tokenHash: row.token_hash,
          expiresAt: row.expires_at,
          authVersion: Number(row.auth_version),
          passwordHash: row.password_hash,
          user: {
            id: Number(row.user_id),
            username: row.username,
            role: row.role,
            mustChangePassword: Boolean(row.must_change_password),
          },
        };
      },

      deleteSessionByTokenHash(tokenHash) {
        const info = stmts.deleteSessionByTokenHash.run(tokenHash);
        return Number(info.changes ?? 0);
      },

      purgeExpiredSessions(nowIso, limit = 200) {
        const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
        const info = stmts.deleteExpiredSessionsBatch.run(nowIso, safeLimit);
        return Number(info.changes ?? 0);
      },

      // R1契約: ロック外での scrypt 完了後、確定時に世代一致かつ元セッションが現存・期限内かを再確認し全更新する
      changePasswordIfUnchanged({
        userId,
        expectedAuthVersion,
        sessionTokenHash,
        newPasswordHash,
        nowIso,
      }) {
        return runInTransaction(() => {
          const user = stmts.getUserById.get(userId);
          if (!user || Number(user.auth_version) !== Number(expectedAuthVersion)) {
            return { updated: false, reason: 'AUTH_VERSION_MISMATCH' };
          }
          const sess = stmts.getSessionAndUserByTokenHash.get(sessionTokenHash);
          if (!sess || Number(sess.user_id) !== Number(userId) || String(sess.expires_at) <= String(nowIso)) {
            return { updated: false, reason: 'SESSION_INVALID' };
          }
          stmts.updatePasswordAndBumpVersion.run(newPasswordHash, 0, userId);
          stmts.deleteAllSessionsForUser.run(userId);
          return { updated: true };
        });
      },

      resetPasswordByUsername({ username, newPasswordHash, reason = '', adminAuth = null, audit = null }) {
        const cleanUsername = validateUsername(username);
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const user = stmts.getUserByUsername.get(cleanUsername);
          if (!user) {
            return { found: false, user: null };
          }
          stmts.updatePasswordAndBumpVersion.run(newPasswordHash, 1, user.id);
          const deletedInfo = stmts.deleteAllSessionsForUser.run(user.id);
          const updated = stmts.getUserById.get(user.id);
          recordAuditInTx(actor, {
            action: 'user_reset_password',
            targetType: 'user',
            targetId: String(user.id),
            detail: {
              username: user.username,
              revokedSessions: Number(deletedInfo.changes ?? 0),
              ...(reason ? { reason } : {}),
            },
          });
          return {
            found: true,
            revokedSessions: Number(deletedInfo.changes ?? 0),
            user: toPublicUser(updated),
          };
        });
      },

      setUserRoleByUsername({ username, role, adminAuth = null, audit = null }) {
        const cleanUsername = validateUsername(username);
        const cleanRole = validateUserRole(role);
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const user = stmts.getUserByUsername.get(cleanUsername);
          return applyUserRoleChangeInTx(actor, user, cleanRole);
        });
      },

      setUserRoleById({ userId, role, adminAuth = null, audit = null }) {
        const cleanUserId = parsePositiveInt(userId, 'ユーザーID');
        const cleanRole = validateUserRole(role);
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const user = stmts.getUserById.get(cleanUserId);
          return applyUserRoleChangeInTx(actor, user, cleanRole);
        });
      },

      revokeAllSessionsByUsername(username, { adminAuth = null, audit = null } = {}) {
        const cleanUsername = validateUsername(username);
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const user = stmts.getUserByUsername.get(cleanUsername);
          return applyRevokeUserSessionsInTx(actor, user);
        });
      },

      revokeAllSessionsByUserId(userId, { adminAuth = null, audit = null } = {}) {
        const cleanUserId = parsePositiveInt(userId, 'ユーザーID');
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const user = stmts.getUserById.get(cleanUserId);
          return applyRevokeUserSessionsInTx(actor, user);
        });
      },

      getEffectivePermissionsForRole(role) {
        return readRolePermissionsMap(role === 'admin' ? 'admin' : role === 'user' ? 'user' : 'guest');
      },

      getMissingRolePermissions() {
        return listMissingRolePermissions();
      },

      getAllRolePermissions() {
        return {
          admin: readRolePermissionsMap('admin'),
          user: readRolePermissionsMap('user'),
          guest: readRolePermissionsMap('guest'),
        };
      },

      updateRolePermissions({ role, permissions, adminAuth = null, audit = null }) {
        const cleanRole = validatePermissionRole(role);
        const patch = validateRolePermissionsPayload(permissions);
        return runInTransaction(() => {
          const actor = resolveAuditActorInTx(adminAuth, audit);
          const { permissions: before, presentKeys } = inspectRolePermissionsInDb(cleanRole);
          const changedKeys = [];
          const repairedMissingKeys = [];
          for (const [key, nextVal] of Object.entries(patch)) {
            if (!presentKeys.has(key)) {
              repairedMissingKeys.push(key);
            }
            if (before[key] !== nextVal) {
              changedKeys.push(key);
            }
          }
          const keysToWrite = [...new Set([...changedKeys, ...repairedMissingKeys])];
          if (keysToWrite.length === 0) {
            return {
              role: cleanRole,
              permissions: before,
              unchanged: true,
              changedKeys: [],
              repairedMissingKeys: [],
            };
          }
          for (const key of keysToWrite) {
            stmts.upsertRolePermission.run(cleanRole, key, patch[key] ? 1 : 0);
          }
          const afterState = inspectRolePermissionsInDb(cleanRole);
          recordAuditInTx(actor, {
            action: 'role_permissions_update',
            targetType: 'role',
            targetId: cleanRole,
            detail: {
              role: cleanRole,
              before,
              after: afterState.permissions,
              changedKeys,
              ...(repairedMissingKeys.length > 0 ? { repairedMissingKeys } : {}),
              ...(afterState.missingKeys.length > 0 ? { remainingMissingKeys: afterState.missingKeys } : {}),
            },
          });
          return {
            role: cleanRole,
            permissions: afterState.permissions,
            unchanged: false,
            changedKeys,
            repairedMissingKeys,
          };
        });
      },

      clearAllSessions() {
        const info = stmts.deleteAllSessions.run();
        return Number(info.changes ?? 0);
      },

      // DB制約テスト（test/db.test.js）で直接異常SQLの拒否を検証するための限定実行ヘルパー
      execRawForTesting(sql, params = []) {
        const stmt = sqlite.prepare(sql);
        return stmt.run(...params);
      },

      // DB接続を安全に閉じる
      close() {
        sqlite.close();
      },
    };
  } catch (err) {
    try {
      sqlite.close();
    } catch {
      // 初期化失敗時のクローズエラーは無視
    }
    throw err;
  }
}

module.exports = {
  PROJECT_ROOT,
  DEFAULT_SCHEMA_PATH,
  TARGET_SCHEMA_VERSION,
  DEFAULT_MAX_POSTS_PER_THREAD,
  DEFAULT_MAX_REPLY_DEPTH,
  resolveProjectDbPath,
  vacuumSqliteConnectionToFile,
  createBoardDb,
};
