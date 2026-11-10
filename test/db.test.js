'use strict';

/**
 * =====================================================================
 * test/db.test.js
 * 役割：schema.sql 正本のDB制約・論理削除マスク・seed冪等性・WAL永続化・復元の自動テスト
 * 方針：実データ data/board.db には一切接続せず、:memory: と OS専用一時フォルダのみを使用する。
 * =====================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBoardDb } = require('../src/db');
const { runSeed } = require('../src/seed');

test('createBoardDb: dbPath 未指定での暗黙接続を拒否すること', () => {
  assert.throws(() => createBoardDb(), /dbPath/);
  assert.throws(() => createBoardDb({ dbPath: '   ' }), /dbPath/);
});

test('メモリ内DB: 複合外部キー・自己参照拒否・2引数trim空白拒否・物理削除RESTRICTが機能すること (T-09, T-10)', (t) => {
  const db = createBoardDb({ dbPath: ':memory:' });
  t.after(() => db.close());

  const status = db.getStatus();
  assert.equal(status.foreignKeys, 1);
  // メモリ内DBでは journal_mode は wal ではなく memory になる仕様を正確に確認
  assert.equal(status.journalMode, 'memory');

  // 初期カテゴリ・スレッド投入
  runSeed(db);
  const cats = db.listCategoriesWithThreads();
  const threadA = cats[0].threads[0];
  const threadB = cats[0].threads[1];

  // 正常な親投稿と子返信
  const parent = db.createPost({
    threadId: threadA.id,
    parentId: null,
    authorName: '親テスト',
    visitorId: 'vis0000001',
    content: 'スレAの親投稿です',
  });
  const child = db.createPost({
    threadId: threadA.id,
    parentId: parent.id,
    authorName: '子テスト',
    visitorId: 'vis0000002',
    content: 'スレAの返信です',
  });
  assert.equal(child.parent_id, parent.id);

  const countBeforeInvalid = db.getThreadDetail(threadB.id).posts.length;

  // 1. 存在しない親IDへの返信 -> 拒否
  assert.throws(() =>
    db.createPost({
      threadId: threadA.id,
      parentId: 99999,
      authorName: '名無しさん',
      visitorId: 'vis0000003',
      content: '存在しない親',
    })
  );

  // 2. 別スレッド（threadAの投稿）を親にした threadB への返信 -> アプリ層でもDB直接SQLでも拒否
  assert.throws(() =>
    db.createPost({
      threadId: threadB.id,
      parentId: parent.id,
      authorName: '名無しさん',
      visitorId: 'vis0000003',
      content: '別スレへの不正返信',
    })
  );
  assert.throws(
    () =>
      db.execRawForTesting(
        'INSERT INTO posts (thread_id, parent_id, author_name, visitor_id, content) VALUES (?, ?, ?, ?, ?)',
        [threadB.id, parent.id, '直SQL', 'vis0000003', 'DB層突破試行']
      ),
    /FOREIGN KEY constraint failed/
  );
  assert.equal(db.getThreadDetail(threadB.id).posts.length, countBeforeInvalid);

  // 3. 自分自身への返信（id === parent_id） -> DB CHECK制約で拒否
  assert.throws(
    () =>
      db.execRawForTesting(
        'INSERT INTO posts (id, thread_id, parent_id, author_name, visitor_id, content) VALUES (?, ?, ?, ?, ?, ?)',
        [500, threadA.id, 500, '直SQL', 'vis0000003', '自己返信']
      ),
    /CHECK constraint failed/
  );

  // 4. 全角空白・改行・タブのみの本文 -> DB 2引数trim CHECK制約でも拒否
  assert.throws(
    () =>
      db.execRawForTesting(
        'INSERT INTO posts (thread_id, parent_id, author_name, visitor_id, content) VALUES (?, ?, ?, ?, ?)',
        [threadA.id, null, '名無しさん', 'vis0000003', ' \u3000\t\r\n']
      ),
    /CHECK constraint failed/
  );

  // 5. 返信がついている親投稿の物理DELETE -> ON DELETE RESTRICT により拒否
  assert.throws(
    () => db.execRawForTesting('DELETE FROM posts WHERE id = ?', [parent.id]),
    /FOREIGN KEY constraint failed/
  );
});

test('論理削除と上限検査: 親を論理削除しても子返信が残り、削除済み本文は取得データに含まれないこと (T-11)', (t) => {
  const db = createBoardDb({
    dbPath: ':memory:',
    maxPostsPerThread: 4,
    maxReplyDepth: 2,
  });
  t.after(() => db.close());

  db.execRawForTesting('INSERT INTO categories (name, display_order) VALUES (?, ?)', ['検証', 1]);
  db.execRawForTesting('INSERT INTO threads (category_id, title) VALUES (?, ?)', [1, '制限検証スレ']);

  const secretText = '削除されるべき個人情報テキスト_SECRET_999';
  const p1 = db.createPost({
    threadId: 1,
    parentId: null,
    authorName: '元投稿者名_SECRET',
    visitorId: 'vis_secret',
    content: secretText,
  });
  const p2 = db.createPost({
    threadId: 1,
    parentId: p1.id,
    authorName: '返信者1',
    visitorId: 'vis_child1',
    content: '1段目の返信（残るべき）',
  });
  const p3 = db.createPost({
    threadId: 1,
    parentId: p2.id,
    authorName: '返信者2',
    visitorId: 'vis_child2',
    content: '2段目の孫返信（上限ちょうど）',
  });

  // 返信階層上限（maxReplyDepth=2 を超える3段目）は拒否されること
  assert.throws(
    () =>
      db.createPost({
        threadId: 1,
        parentId: p3.id,
        authorName: '返信者3',
        visitorId: 'vis_child3',
        content: '3段目の返信（拒否されるべき）',
      }),
    /階層上限/
  );

  // 4件目（ルート投稿）は上限4件以内なので成功し、5件目は拒否されること
  db.createPost({
    threadId: 1,
    parentId: null,
    authorName: '4件目',
    visitorId: 'vis_four04',
    content: '上限4件目',
  });
  assert.throws(
    () =>
      db.createPost({
        threadId: 1,
        parentId: null,
        authorName: '5件目',
        visitorId: 'vis_five05',
        content: '上限超過5件目',
      }),
    /投稿上限/
  );

  // 親投稿 p1 を論理削除
  const delRes = db.softDeletePost(p1.id);
  assert.equal(delRes.found, true);

  const detail = db.getThreadDetail(1);
  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes(secretText), false, '削除前の本文が一切含まれないこと');
  assert.equal(serialized.includes('元投稿者名_SECRET'), false, '削除前の投稿者名が含まれないこと');
  assert.equal(serialized.includes('vis_secret'), false, '削除前のvisitor_idが含まれないこと');

  const deletedNode = detail.posts.find((p) => p.id === p1.id);
  const childNode = detail.posts.find((p) => p.id === p2.id);
  assert.equal(deletedNode.is_deleted, 1);
  assert.equal(childNode.parent_id, p1.id, '子返信の親子リンクが維持されていること');
  assert.equal(childNode.content, '1段目の返信（残るべき）');
});

test('一時ファイルDB: WAL有効化・seed再実行の非破壊性・再起動永続化・バックアップ復元を確認 (T-16)', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-board-dbtest-'));
  const openDbs = [];

  // Windows では開いている SQLite ファイルの削除が EPERM になるため、
  // 必ず全DB接続を close してから一時ディレクトリを削除する。
  t.after(() => {
    while (openDbs.length > 0) {
      const handle = openDbs.pop();
      try {
        handle.close();
      } catch {
        // 既に閉じている場合は無視
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const fileDbPath = path.join(tmpDir, 'test-board.db');
  const backupDbPath = path.join(tmpDir, 'backup-board.db');

  // 1. ファイルDBを起動し、journal_mode が実際に 'wal' になることを確認
  const db1 = createBoardDb({ dbPath: fileDbPath });
  openDbs.push(db1);
  assert.equal(db1.getStatus().journalMode, 'wal');

  // 2. 初回 seed 実行と利用者投稿の追加
  const firstSeed = runSeed(db1);
  assert.equal(firstSeed.createdCategories, 2);
  assert.equal(firstSeed.createdThreads, 4);

  const userPost = db1.createPost({
    threadId: 1,
    parentId: null,
    authorName: '実利用者',
    visitorId: 'user_vis01',
    content: '再実行や再起動でも消えてはいけない大切な投稿',
  });

  // 3. seed を再実行してもカテゴリ・スレッドが増えず、利用者投稿も消えないこと
  const secondSeed = runSeed(db1);
  assert.equal(secondSeed.createdCategories, 0);
  assert.equal(secondSeed.createdThreads, 0);
  assert.equal(secondSeed.createdPosts, 0);

  // 4. バックアップを取得してから db1 を閉じる（停止シミュレーション）
  db1.backupTo(backupDbPath);
  db1.close();

  // 5. 再起動シミュレーション（同じファイルを開き直して投稿が残っているか確認）
  const dbReopened = createBoardDb({ dbPath: fileDbPath });
  openDbs.push(dbReopened);
  const postsAfterRestart = dbReopened.getThreadDetail(1).posts;
  assert.ok(postsAfterRestart.some((p) => p.id === userPost.id && p.content.includes('大切な投稿')));

  // 6. バックアップファイルから別接続で復元確認
  const dbRestored = createBoardDb({ dbPath: backupDbPath });
  openDbs.push(dbRestored);
  const restoredPosts = dbRestored.getThreadDetail(1).posts;
  assert.ok(restoredPosts.some((p) => p.id === userPost.id && p.content.includes('大切な投稿')));

  // 7. F2回帰検証：バックアップ更新が失敗した際、直前の正常なバックアップファイルが消えずに維持されること
  const hashBeforeFail = fs.readFileSync(backupDbPath);
  dbReopened.execRawForTesting('BEGIN'); // トランザクション内では VACUUM INTO が失敗する性質を利用
  assert.throws(
    () => dbReopened.backupTo(backupDbPath),
    /cannot VACUUM from within a transaction/
  );
  dbReopened.execRawForTesting('ROLLBACK');

  assert.equal(fs.existsSync(backupDbPath), true, 'VACUUM失敗時も既存の正常バックアップが消えないこと');
  assert.deepEqual(fs.readFileSync(backupDbPath), hashBeforeFail, '既存バックアップの中身が1バイトも壊れていないこと');
});

test('投稿ピン留めと旧DBからの非破壊自動マイグレーション: is_pinned 切替・削除時自動解除・旧スキーマ移行が機能すること', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-board-pintest-'));
  const openDbs = [];

  t.after(() => {
    while (openDbs.length > 0) {
      const handle = openDbs.pop();
      try {
        handle.close();
      } catch {
        // 既に閉じている場合は無視
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. 旧スキーマ（posts.is_pinned 列が無い状態）のSQLiteファイルを模擬作成し、既存データを1件入れる
  const legacyDbPath = path.join(tmpDir, 'legacy.db');
  const { DatabaseSync } = require('node:sqlite');
  const rawLegacy = new DatabaseSync(legacyDbPath);
  rawLegacy.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      pinned_text TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      parent_id INTEGER,
      author_name TEXT NOT NULL DEFAULT '名無しさん',
      visitor_id TEXT NOT NULL,
      content TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      UNIQUE (id, thread_id)
    );
    INSERT INTO categories (name, display_order) VALUES ('旧カテゴリ', 1);
    INSERT INTO threads (category_id, title) VALUES (1, '旧スレッド');
    INSERT INTO posts (thread_id, parent_id, author_name, visitor_id, content)
    VALUES (1, NULL, '既存ユーザー', 'legacy0001', '移行前から存在する大事な投稿');
  `);
  rawLegacy.close();

  // 2. createBoardDb で開くと非破壊で is_pinned 列が追加され、既存投稿が is_pinned=0 で読めること
  const db = createBoardDb({ dbPath: legacyDbPath });
  openDbs.push(db);

  let posts = db.getThreadDetail(1).posts;
  assert.equal(posts.length, 1);
  assert.equal(posts[0].content, '移行前から存在する大事な投稿');
  assert.equal(posts[0].is_pinned, 0);

  // 3. ピン留め ON -> OFF -> ON の切り替え確認
  const pinRes = db.setPostPinned(posts[0].id, true);
  assert.deepEqual(pinRes, { found: true, isPinned: true });
  assert.equal(db.getThreadDetail(1).posts[0].is_pinned, 1);

  const unpinRes = db.setPostPinned(posts[0].id, false);
  assert.deepEqual(unpinRes, { found: true, isPinned: false });
  assert.equal(db.getThreadDetail(1).posts[0].is_pinned, 0);

  // 4. ピン留め中の投稿を論理削除すると自動で is_pinned = 0 に戻り、削除済み投稿の再ピン留めは拒否されること
  db.setPostPinned(posts[0].id, true);
  db.softDeletePost(posts[0].id);
  posts = db.getThreadDetail(1).posts;
  assert.equal(posts[0].is_deleted, 1);
  assert.equal(posts[0].is_pinned, 0);

  assert.throws(() => db.setPostPinned(posts[0].id, true), /論理削除済み/);

  // 5. カテゴリ追加・名前変更・スレッド追加・タイトル変更が既存データを壊さず動作すること
  const addedCat = db.createCategory({ name: '攻略・編成' });
  assert.equal(addedCat.name, '攻略・編成');
  assert.equal(addedCat.display_order, 2);

  assert.throws(() => db.createCategory({ name: '攻略・編成' }), /同名のカテゴリ/);

  const renamedCat = db.updateCategory({
    categoryId: addedCat.id,
    name: '攻略・編成相談',
    displayOrder: 5,
  });
  assert.equal(renamedCat.found, true);
  assert.equal(renamedCat.category.name, '攻略・編成相談');
  assert.equal(renamedCat.category.display_order, 5);

  const addedThread = db.createThread({
    categoryId: addedCat.id,
    title: 'おすすめ編成スレッド',
    pinnedText: '編成相談用の案内文です。',
  });
  assert.equal(addedThread.category_id, addedCat.id);
  assert.equal(addedThread.title, 'おすすめ編成スレッド');
  assert.equal(addedThread.is_pinned, 1);

  const renamedThread = db.updateThread({
    threadId: addedThread.id,
    title: '総合編成相談スレッド',
  });
  assert.equal(renamedThread.found, true);
  assert.equal(renamedThread.thread.title, '総合編成相談スレッド');
});
