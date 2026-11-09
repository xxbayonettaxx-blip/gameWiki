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
const { ValidationError } = require('./validators');

// プロジェクトルートおよびスキーマ正本のパス（カレントディレクトリに依存しない __dirname 基準）
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCHEMA_PATH = path.join(__dirname, 'schema.sql');

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
    // 同時アクセス時の即時ロックエラー（SQLITE_BUSY）を緩和するため最大5秒待機
    sqlite.exec('PRAGMA busy_timeout = 5000;');

    // スキーマ正本（PRAGMA foreign_keys = ON, WAL, 4テーブル, インデックス）を読み込んで適用
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    sqlite.exec(schemaSql);

    // 既存DBからの非破壊アップグレード：posts テーブルに is_pinned 列が無い場合は自動追加する
    // （CREATE TABLE IF NOT EXISTS は既存テーブルの列を増やさないため、実データを消さずに移行する処理）
    const postColumns = sqlite.prepare('PRAGMA table_info(posts);').all();
    const hasIsPinned = postColumns.some((col) => col.name === 'is_pinned');
    if (!hasIsPinned) {
      sqlite.exec(
        'ALTER TABLE posts ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1));'
      );
    }

    // 接続ごとに必須の外部キー制約を再度明示ONにし、実際に有効化されたか戻り値を検証する
    sqlite.exec('PRAGMA foreign_keys = ON;');
    const fkRow = sqlite.prepare('PRAGMA foreign_keys;').get();
    const foreignKeys = fkRow ? fkRow.foreign_keys : 0;
    if (foreignKeys !== 1) {
      throw new Error(`SQLite の PRAGMA foreign_keys が有効化できませんでした（値: ${foreignKeys}）。`);
    }

    // 実際の journal_mode を取得（ファイルDBなら 'wal'、:memory: なら 'memory' になる）
    const jmRow = sqlite.prepare('PRAGMA journal_mode;').get();
    const journalMode = jmRow ? String(jmRow.journal_mode).toLowerCase() : 'unknown';

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
          t.created_at,
          COUNT(p.id) AS post_count
        FROM threads t
        LEFT JOIN posts p ON p.thread_id = t.id
        GROUP BY t.id
        ORDER BY t.category_id ASC, t.is_pinned DESC, t.id ASC
      `),

      getThreadById: sqlite.prepare(`
        SELECT id, category_id, title, pinned_text, is_pinned, created_at
        FROM threads
        WHERE id = ?
      `),

      // ★重要：論理削除（is_deleted = 1）の行はSQL段階で本文・名前・日替わりIDをマスクし、
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
        INSERT INTO posts (thread_id, parent_id, author_name, visitor_id, content)
        VALUES (?, ?, ?, ?, ?)
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

      // 以下は seed.js（冪等な初期データ投入）専用の内部ステートメント
      findCategoryByName: sqlite.prepare(`
        SELECT id, name FROM categories WHERE name = ?
      `),
      insertCategory: sqlite.prepare(`
        INSERT INTO categories (name, display_order) VALUES (?, ?)
      `),
      findThreadByCategoryAndTitle: sqlite.prepare(`
        SELECT id, title FROM threads WHERE category_id = ? AND title = ?
      `),
      insertThread: sqlite.prepare(`
        INSERT INTO threads (category_id, title, pinned_text, is_pinned)
        VALUES (?, ?, ?, ?)
      `),
    };

    // node:sqlite が返す null prototype オブジェクトを通常のプレーンオブジェクトへ変換する補助関数
    const toPlain = (row) => (row ? { ...row } : null);

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
    // 4. 外部へ公開する操作メソッド群
    // -----------------------------------------------------------------
    return {
      // 起動ログやテスト検証で実際の接続先・PRAGMA値を確認するためのステータス取得
      getStatus() {
        return {
          dbPath: targetPath,
          foreignKeys,
          journalMode,
          maxPostsPerThread,
          maxReplyDepth,
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
          .map(toPlain);

        return {
          thread,
          posts,
          limits: {
            maxPostsPerThread,
            maxReplyDepth,
          },
        };
      },

      // 新規投稿または返信の登録（トランザクション内で整合性・件数上限・階層上限を検査）
      createPost({ threadId, parentId = null, authorName, visitorId, content }) {
        return runInTransaction(() => {
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
          const info = stmts.insertPost.run(threadId, parentId, authorName, visitorId, content);
          const newPostId = Number(info.lastInsertRowid);
          return toPlain(stmts.getPublicPostById.get(newPostId));
        });
      },

      // 管理者による論理削除（行と返信ツリー構造を残し、本文・名前を非表示化、ピン留めも解除する）
      softDeletePost(postId) {
        return runInTransaction(() => {
          const existing = stmts.getPostDeleteState.get(postId);
          if (!existing) {
            return { found: false, alreadyDeleted: false };
          }
          if (existing.is_deleted === 1) {
            return { found: true, alreadyDeleted: true };
          }
          stmts.markPostDeleted.run(postId);
          return { found: true, alreadyDeleted: false };
        });
      },

      // 管理者による投稿ピン留め ON/OFF 設定（削除済み投稿のピン留めは拒否する）
      setPostPinned(postId, isPinned) {
        return runInTransaction(() => {
          const existing = stmts.getPostDeleteState.get(postId);
          if (!existing) {
            return { found: false, isPinned: false };
          }
          if (existing.is_deleted === 1 && isPinned) {
            throw new ValidationError('論理削除済みの投稿はピン留めできません。', 400);
          }
          const nextVal = isPinned ? 1 : 0;
          stmts.updatePostPinned.run(nextVal, postId);
          return { found: true, isPinned: Boolean(nextVal) };
        });
      },

      // 冪等な初期データ投入（src/seed.js から呼び出される専用処理）
      seedInitialData(seedCategories) {
        return runInTransaction(() => {
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
                threadDef.isPinned ? 1 : 0
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

      // バックアップファイル生成（F2対策：既存バックアップを先に消さず、一時ファイルへ生成・検証後に原子的置換する）
      backupTo(destinationPath) {
        const dest = path.resolve(destinationPath);
        if (dest === targetPath) {
          throw new Error('バックアップ先に元のDBと同じパスは指定できません。');
        }
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
            checkDb.prepare('SELECT COUNT(*) AS c FROM categories;').get();
            checkDb.prepare('SELECT COUNT(*) AS c FROM threads;').get();
            checkDb.prepare('SELECT COUNT(*) AS c FROM posts;').get();
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
  DEFAULT_MAX_POSTS_PER_THREAD,
  DEFAULT_MAX_REPLY_DEPTH,
  resolveProjectDbPath,
  createBoardDb,
};
