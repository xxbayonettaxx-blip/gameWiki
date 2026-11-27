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
const { execFileSync } = require('node:child_process');
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
  assert.equal(firstSeed.createdCategories, 3);
  assert.equal(firstSeed.createdThreads, 10);

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

  // 3b. 初期シード由来のカテゴリ(#1)・スレッド(#1)を改名した後に seed を再実行しても旧名が復活しないこと
  db1.updateCategory({ categoryId: 1, name: '総合交流広場' });
  db1.updateThread({ threadId: 1, title: 'メイン雑談スレッド' });
  const thirdSeed = runSeed(db1);
  assert.equal(thirdSeed.createdCategories, 0);
  assert.equal(thirdSeed.createdThreads, 0);
  assert.equal(thirdSeed.createdPosts, 0);
  const catsAfterRenameSeed = db1.listCategoriesWithThreads();
  assert.equal(catsAfterRenameSeed.some((c) => c.name === '雑談'), false);
  assert.equal(
    catsAfterRenameSeed.flatMap((c) => c.threads).some((th) => th.title === '雑談'),
    false
  );

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
    isPinned: true,
  });
  assert.equal(addedThread.category_id, addedCat.id);
  assert.equal(addedThread.title, 'おすすめ編成スレッド');
  assert.equal(addedThread.pinned_text, '編成相談用の案内文です。');
  assert.equal(addedThread.is_pinned, 1);

  const renamedThread = db.updateThread({
    threadId: addedThread.id,
    title: '総合編成相談スレッド',
  });
  assert.equal(renamedThread.found, true);
  assert.equal(renamedThread.thread.title, '総合編成相談スレッド');

  // P2-2単一ソース検証：案内文は threads.pinned_text のみに保持され、posts へ重複投稿を自動生成しないこと
  let addedThreadDetail = db.getThreadDetail(addedThread.id);
  assert.equal(addedThreadDetail.thread.pinned_text, '編成相談用の案内文です。');
  assert.equal(addedThreadDetail.posts.length, 0);

  // 通常投稿のピン留めを作成した上でスレッド案内文を更新・消去しても、通常ピン投稿に影響しないこと
  const normalPinPost = db.createPost({
    threadId: addedThread.id,
    authorName: '常連投稿者',
    visitorId: 'guide_test1',
    content: '通常のピン留め対象投稿',
  });
  db.setPostPinned(normalPinPost.id, true);
  db.updateThread({ threadId: addedThread.id, pinnedText: '改訂後の案内文です。' });
  addedThreadDetail = db.getThreadDetail(addedThread.id);
  assert.equal(addedThreadDetail.thread.pinned_text, '改訂後の案内文です。');
  assert.equal(addedThreadDetail.posts.length, 1);
  assert.equal(addedThreadDetail.posts[0].is_pinned, 1);
  assert.equal(addedThreadDetail.posts[0].content, '通常のピン留め対象投稿');

  db.updateThread({ threadId: addedThread.id, pinnedText: null });
  addedThreadDetail = db.getThreadDetail(addedThread.id);
  assert.equal(addedThreadDetail.thread.pinned_text, null);
  assert.equal(addedThreadDetail.posts[0].is_pinned, 1);

  // スレッド・カテゴリ改名後に seed を再実行しても、旧名スレッドや重複データが一切作られないこと
  const reSeedAfterRename = runSeed(db);
  assert.equal(reSeedAfterRename.createdCategories, 0);
  assert.equal(reSeedAfterRename.createdThreads, 0);
  assert.equal(reSeedAfterRename.createdPosts, 0);
});

test('物理削除（purge-tree / purge-thread）: 再帰CTEによる末端先行削除・他ツリー保持・整合性検証', (t) => {
  const db = createBoardDb({ dbPath: ':memory:' });
  t.after(() => db.close());
  runSeed(db);

  // 1. ツリー構成のテストデータを作成（スレッド 1）
  // 親 (P1)
  //  ├─ 子1 (C1)
  //  │   └─ 孫1 (G1)
  //  └─ 子2 (C2)
  // 独立した親 (P2)
  const p1 = db.createPost({ threadId: 1, authorName: '親1', content: '親1本文', visitorId: 'visP1' });
  const c1 = db.createPost({ threadId: 1, parentId: p1.id, authorName: '子1', content: '子1本文', visitorId: 'visC1' });
  const g1 = db.createPost({ threadId: 1, parentId: c1.id, authorName: '孫1', content: '孫1本文', visitorId: 'visG1' });
  const c2 = db.createPost({ threadId: 1, parentId: p1.id, authorName: '子2', content: '子2本文', visitorId: 'visC2' });
  const p2 = db.createPost({ threadId: 1, authorName: '親2', content: '親2本文（残るはず）', visitorId: 'visP2' });

  // 2. プレビュー（Dry-Run）の検証
  const preview = db.getPurgeTreePreview(p1.id);
  assert.equal(preview.found, true);
  assert.equal(preview.postsCount, 4);
  assert.equal(preview.isSubtree, false);
  // 深い順（孫1 -> 子 -> 親1）で取得されていること
  assert.equal(preview.posts[0].id, g1.id);
  assert.equal(preview.posts[preview.posts.length - 1].id, p1.id);

  // プレビュー時点ではDBに一切変更がないこと
  const threadDetailBefore = db.getThreadDetail(1);
  const postIdsBefore = threadDetailBefore.posts.map((p) => p.id);
  assert.ok(postIdsBefore.includes(p1.id));
  assert.ok(postIdsBefore.includes(g1.id));

  // 3. 物理削除の実行（purgePostTree）
  const purgeRes = db.purgePostTree(p1.id);
  assert.equal(purgeRes.found, true);
  assert.equal(purgeRes.deletedCount, 4);
  assert.deepEqual(purgeRes.deletedIds, [g1.id, c2.id, c1.id, p1.id]);

  // 4. 削除後の検証：P1ツリーが完全に消え、P2および他スレッドは無傷で残っていること
  const threadDetailAfter = db.getThreadDetail(1);
  const postIdsAfter = threadDetailAfter.posts.map((p) => p.id);
  assert.ok(!postIdsAfter.includes(p1.id));
  assert.ok(!postIdsAfter.includes(c1.id));
  assert.ok(!postIdsAfter.includes(g1.id));
  assert.ok(!postIdsAfter.includes(c2.id));
  assert.ok(postIdsAfter.includes(p2.id));

  // 5. 部分ツリー削除（サブツリー削除）の検証
  // P3 -> C3 -> G3 の構造を作り、C3 だけを削除した時に P3 は残り、C3 と G3 だけが消えること
  const p3 = db.createPost({ threadId: 1, authorName: '親3', content: '親3本文', visitorId: 'visP3' });
  const c3 = db.createPost({ threadId: 1, parentId: p3.id, authorName: '子3', content: '子3本文', visitorId: 'visC3' });
  const g3 = db.createPost({ threadId: 1, parentId: c3.id, authorName: '孫3', content: '孫3本文', visitorId: 'visG3' });

  const subPreview = db.getPurgeTreePreview(c3.id);
  assert.equal(subPreview.isSubtree, true);
  assert.equal(subPreview.postsCount, 2);

  const subPurge = db.purgePostTree(c3.id);
  assert.equal(subPurge.deletedCount, 2);
  assert.deepEqual(subPurge.deletedIds, [g3.id, c3.id]);

  const p3Check = db.getThreadDetail(1).posts.find((p) => p.id === p3.id);
  assert.ok(p3Check, '親3は残っていること');

  // 6. スレッド全体の物理削除（purgeThread）
  const newThread = db.createThread({ categoryId: 1, title: '一時スレッド' });
  const thPost1 = db.createPost({ threadId: newThread.id, authorName: 'テスト', content: 'スレ内投稿1', visitorId: 'v1' });
  db.createPost({ threadId: newThread.id, parentId: thPost1.id, authorName: 'テスト', content: 'スレ内返信1', visitorId: 'v2' });

  const thPreview = db.getPurgeThreadPreview(newThread.id);
  assert.equal(thPreview.found, true);
  assert.equal(thPreview.postsCount, 2); // 投稿1 + 返信1

  const thPurge = db.purgeThread(newThread.id);
  assert.equal(thPurge.found, true);
  assert.equal(thPurge.deletedPostsCount, 2);

  // スレッド一覧から完全に消滅していること
  assert.equal(db.getThreadDetail(newThread.id), null);
});

test('安全バックアップ（runBackup）: 元DB欠落・0バイト・未初期化を拒否し、正常時は原子的作成すること', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const { runBackup } = require('../src/backup');

  const validDbPath = path.join(tmpDir, 'valid.db');
  const backupDestPath = path.join(tmpDir, 'backup.db');

  // 1. 正常なDBを作成してseed投入
  const validDb = createBoardDb({ dbPath: validDbPath });
  runSeed(validDb);
  validDb.close();

  // 正常バックアップの成功
  const res = runBackup({ srcPath: validDbPath, destPath: backupDestPath });
  assert.equal(res.success, true);
  assert.ok(fs.existsSync(backupDestPath));
  assert.ok(res.sizeBytes > 0);

  const initialBackupMtime = fs.statSync(backupDestPath).mtimeMs;

  // 2. 元DBが存在しない場合 -> エラーになり、既存バックアップを上書き・破壊しないこと
  assert.throws(
    () => runBackup({ srcPath: path.join(tmpDir, 'non_existent.db'), destPath: backupDestPath }),
    /存在しません/
  );
  assert.equal(fs.statSync(backupDestPath).mtimeMs, initialBackupMtime);

  // 3. 元DBが0バイトの場合 -> エラーになり、既存バックアップを保護すること
  const emptyFilePath = path.join(tmpDir, 'empty.db');
  fs.writeFileSync(emptyFilePath, '');
  assert.throws(
    () => runBackup({ srcPath: emptyFilePath, destPath: backupDestPath }),
    /0バイトです/
  );
  assert.equal(fs.statSync(backupDestPath).mtimeMs, initialBackupMtime);

  // 4. 元DBが空スキーマ（カテゴリ0件）の場合 -> エラーになり、既存バックアップを保護すること
  const zeroCatDbPath = path.join(tmpDir, 'zerocat.db');
  const zeroCatDb = createBoardDb({ dbPath: zeroCatDbPath }); // schema適用のみでseed未投入
  zeroCatDb.close();
  assert.throws(
    () => runBackup({ srcPath: zeroCatDbPath, destPath: backupDestPath }),
    /カテゴリ件数が0件/
  );
  assert.equal(fs.statSync(backupDestPath).mtimeMs, initialBackupMtime);
});

test('スレッド表示順（display_order）と並び替え: 作成時の自動採番・明示指定・updateThreadによる順序変更・ピン留め優先ソート', () => {
  const db = createBoardDb({ dbPath: ':memory:' });
  try {
    const cat = db.createCategory({ name: '順序テストカテゴリ', displayOrder: 1 });

    // 1. displayOrder未指定で順次作成した場合、1, 2, 3 と自動採番されること
    const th1 = db.createThread({ categoryId: cat.id, title: 'スレッド1' });
    const th2 = db.createThread({ categoryId: cat.id, title: 'スレッド2' });
    const th3 = db.createThread({ categoryId: cat.id, title: 'スレッド3' });
    assert.equal(th1.display_order, 1);
    assert.equal(th2.display_order, 2);
    assert.equal(th3.display_order, 3);

    // 2. 表示順の並び順確認（通常時は display_order ASC, id ASC）
    let list = db.listCategoriesWithThreads();
    let threadTitles = list[0].threads.map((t) => t.title);
    assert.deepEqual(threadTitles, ['スレッド1', 'スレッド2', 'スレッド3']);

    // 3. updateThread でスレッド3の表示順を 0（最前）に変更
    const updatedTh3 = db.updateThread({ threadId: th3.id, displayOrder: 0 });
    assert.equal(updatedTh3.found, true);
    assert.equal(updatedTh3.thread.display_order, 0);

    list = db.listCategoriesWithThreads();
    threadTitles = list[0].threads.map((t) => t.title);
    assert.deepEqual(threadTitles, ['スレッド3', 'スレッド1', 'スレッド2']);

    // 4. ピン留めスレッドは display_order に関係なく最優先で先頭に来ること
    const thPinned = db.createThread({
      categoryId: cat.id,
      title: 'ピン留めスレッド',
      pinnedText: 'お知らせ',
      isPinned: true,
      displayOrder: 99,
    });
    assert.equal(thPinned.is_pinned, 1);
    assert.equal(thPinned.display_order, 99);

    list = db.listCategoriesWithThreads();
    threadTitles = list[0].threads.map((t) => t.title);
    assert.deepEqual(threadTitles, ['ピン留めスレッド', 'スレッド3', 'スレッド1', 'スレッド2']);

    // 5. 不正な表示順の拒否
    assert.throws(
      () => db.createThread({ categoryId: cat.id, title: '不正スレッド', displayOrder: -1 }),
      /0以上の整数/
    );
    assert.throws(
      () => db.updateThread({ threadId: th1.id, displayOrder: 3.5 }),
      /0以上の整数/
    );
  } finally {
    db.close();
  }
});

test('スレッド最新活動日時（latest_post_at）: スレッド作成日時または最新の未削除投稿日時が取得できること', () => {
  const db = createBoardDb({ dbPath: ':memory:' });
  try {
    const cat = db.createCategory({ name: '新着テストカテゴリ' });
    const th = db.createThread({ categoryId: cat.id, title: '新着スレッド' });

    // 投稿がない時はスレッド作成日時と一致
    let list = db.listCategoriesWithThreads();
    let thread = list[0].threads[0];
    assert.ok(thread.latest_post_at);
    assert.equal(thread.latest_post_at, th.created_at);

    // 新規投稿を追加すると latest_post_at がその投稿の日時に更新されること
    const p1 = db.createPost({
      threadId: th.id,
      authorName: 'テスト投稿者',
      visitorId: 'visitor-new',
      content: '新着投稿のテストです',
    });

    list = db.listCategoriesWithThreads();
    thread = list[0].threads[0];
    assert.equal(thread.latest_post_at, p1.created_at);
  } finally {
    db.close();
  }
});

test('投稿の編集（updatePost）および管理CLI（edit-post）: 本文・投稿者名変更、ツリー/ピン維持、異常系拒否を確認', (t) => {
  const db = createBoardDb({ dbPath: ':memory:' });
  t.after(() => db.close());

  const cat = db.createCategory({ name: '編集テストカテゴリ' });
  const th = db.createThread({ categoryId: cat.id, title: '編集テストスレッド' });
  const parent = db.createPost({
    threadId: th.id,
    authorName: '元の投稿者',
    visitorId: 'vis-orig',
    content: '修正前の本文です',
  });
  db.setPostPinned(parent.id, true);
  const reply = db.createPost({
    threadId: th.id,
    parentId: parent.id,
    authorName: '返信者',
    visitorId: 'vis-reply',
    content: '返信本文です',
  });

  // 1. 本文のみ更新（投稿者名・parent_id・is_pinned・visitor_id・created_atが維持されること）
  const edit1 = db.updatePost({ postId: parent.id, content: '修正後の\r\n本文です  ' });
  assert.equal(edit1.found, true);
  assert.equal(edit1.post.content, '修正後の\n本文です');
  assert.equal(edit1.post.author_name, '元の投稿者');
  assert.equal(edit1.post.is_pinned, 1);
  assert.equal(edit1.post.visitor_id, 'vis-orig');
  assert.equal(edit1.post.created_at, parent.created_at);

  // 返信ツリーが維持されていること
  const editReply = db.updatePost({ postId: reply.id, content: '返信の修正後本文', authorName: '変更後返信者' });
  assert.equal(editReply.found, true);
  assert.equal(editReply.post.parent_id, parent.id);
  assert.equal(editReply.post.author_name, '変更後返信者');

  // 2. 存在しないID・不正ID・論理削除済み・不正本文の拒否
  assert.equal(db.updatePost({ postId: 99999, content: '存在しない' }).found, false);
  assert.throws(() => db.updatePost({ postId: 'abc', content: '不正ID' }), /1以上の整数/);
  assert.throws(() => db.updatePost({ postId: parent.id, content: '   \u3000\n ' }), /空白や改行のみ/);
  assert.throws(() => db.updatePost({ postId: parent.id, content: 'あ'.repeat(2001) }), /2000文字以内/);
  assert.throws(() => db.updatePost({ postId: parent.id, content: '不正\x00文字' }), /制御文字/);

  db.softDeletePost(reply.id);
  assert.throws(() => db.updatePost({ postId: reply.id, content: '削除済み編集' }), /論理削除済み/);

  // 3. 一時DBに対する管理CLI (src/moderate.js edit-post) の子プロセス実行検証
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moderate-edit-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const cliDbPath = path.join(tmpDir, 'cli_edit.db');
  const cliDb = createBoardDb({ dbPath: cliDbPath });
  const cliCat = cliDb.createCategory({ name: 'CLIカテゴリ' });
  const cliTh = cliDb.createThread({ categoryId: cliCat.id, title: 'CLIスレッド' });
  const cliPost = cliDb.createPost({
    threadId: cliTh.id,
    authorName: 'CLI初期名',
    visitorId: 'vis-cli',
    content: 'CLI初期本文',
  });
  cliDb.close();

  const moderateScript = path.resolve(__dirname, '../src/moderate.js');
  const stdout = execFileSync(
    process.execPath,
    [moderateScript, 'edit-post', String(cliPost.id), 'CLI更新本文', 'CLI更新名'],
    { env: { ...process.env, DB_PATH: cliDbPath }, encoding: 'utf8' }
  );
  assert.match(stdout, /更新しました/);

  const verifyDb = createBoardDb({ dbPath: cliDbPath });
  try {
    const detail = verifyDb.getThreadDetail(cliTh.id);
    assert.equal(detail.posts[0].content, 'CLI更新本文');
    assert.equal(detail.posts[0].author_name, 'CLI更新名');
  } finally {
    verifyDb.close();
  }

  // 未存在DBに対して edit-post を実行した場合は空DBを自動作成せず拒否すること
  const missingDbPath = path.join(tmpDir, 'missing.db');
  assert.throws(
    () =>
      execFileSync(process.execPath, [moderateScript, 'edit-post', '1', '誤爆防止'], {
        env: { ...process.env, DB_PATH: missingDbPath },
        stdio: 'pipe',
      })
  );
  assert.equal(fs.existsSync(missingDbPath), false);
});

test('認証DB移行・トランザクション・世代検証(R1)・セッション上限・会員投稿保護・復元安全', (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-board-auth-db-'));
  let db = null;
  t.after(() => {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  // 1. 既存 v0.5 DB（auth_version / must_change_password / sessions 無し）からの移行
  const v05DbPath = path.join(tmpDir, 'v05.db');
  const legacyRaw = new DatabaseSync(v05DbPath);
  legacyRaw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
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
      display_order INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      parent_id INTEGER,
      author_name TEXT NOT NULL DEFAULT '名無しさん',
      visitor_id TEXT NOT NULL,
      content TEXT NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      UNIQUE (id, thread_id),
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE RESTRICT,
      FOREIGN KEY (parent_id, thread_id) REFERENCES posts(id, thread_id) ON DELETE RESTRICT,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
    INSERT INTO categories (name, display_order) VALUES ('v05カテゴリ', 1);
    INSERT INTO threads (category_id, title) VALUES (1, 'v05スレッド');
    INSERT INTO posts (thread_id, author_name, visitor_id, content) VALUES (1, '旧住民', 'legacy01', '既存投稿を維持');
  `);
  legacyRaw.close();

  db = createBoardDb({ dbPath: v05DbPath });

  assert.equal(db.getStatus().schemaVersion, 4);
  const migratedPosts = db.getThreadDetail(1).posts;
  assert.equal(migratedPosts.length, 1);
  assert.equal(migratedPosts[0].content, '既存投稿を維持');
  assert.equal(migratedPosts[0].is_member, false);

  // 2. 登録＋初回セッションの1トランザクション・重複409・途中失敗ロールバック確認
  const nowIso = '2026-11-19T10:00:00.000Z';
  const expIso = '2026-11-26T10:00:00.000Z';
  const tHash1 = 'a'.repeat(64);
  const createdUser = db.createUserWithSession({
    username: 'alice',
    passwordHash: 'hash-v1',
    role: 'user',
    tokenHash: tHash1,
    expiresAt: expIso,
    nowIso,
  });
  assert.equal(createdUser.username, 'alice');
  assert.equal(createdUser.role, 'user');
  assert.equal(createdUser.mustChangePassword, false);

  // 重複登録 -> 409
  assert.throws(
    () =>
      db.createUserWithSession({
        username: 'alice',
        passwordHash: 'hash-v1',
        tokenHash: 'b'.repeat(64),
        expiresAt: expIso,
        nowIso,
      }),
    (err) => err.statusCode === 409
  );

  // セッション挿入がチェック制約等で失敗した場合にユーザーだけ中途半端に残らないこと
  assert.throws(() =>
    db.createUserWithSession({
      username: 'bob_partial',
      passwordHash: 'hash-v1',
      tokenHash: 'short_invalid',
      expiresAt: expIso,
      nowIso,
    })
  );
  assert.equal(db.getUserForAuthByUsername('bob_partial'), null);

  // 3. 最大5セッション制御（6件目で最古セッションが自動削除されること）＋世代不一致拒否
  for (let i = 2; i <= 6; i += 1) {
    const res = db.issueSessionIfVersionMatches({
      userId: createdUser.id,
      expectedAuthVersion: 0,
      tokenHash: String(i).repeat(64),
      expiresAt: expIso,
      nowIso: `2026-11-19T10:00:0${i}.000Z`,
      maxSessions: 5,
    });
    assert.equal(res.issued, true);
  }
  // 1件目('a'.repeat(64))が押し出されて消え、2..6件目が残ること
  assert.equal(db.getSessionAuthByTokenHash(tHash1, nowIso), null);
  assert.ok(db.getSessionAuthByTokenHash('2'.repeat(64), nowIso) !== null);
  assert.ok(db.getSessionAuthByTokenHash('6'.repeat(64), nowIso) !== null);

  // 世代不一致ではセッション発行を拒否すること
  const staleIssue = db.issueSessionIfVersionMatches({
    userId: createdUser.id,
    expectedAuthVersion: 99,
    tokenHash: 'c'.repeat(64),
    expiresAt: expIso,
    nowIso,
  });
  assert.equal(staleIssue.issued, false);
  assert.equal(db.getSessionAuthByTokenHash('c'.repeat(64), nowIso), null);

  // 4. R1: changePasswordIfUnchanged は世代不一致や単独logout後に更新を拒否すること
  db.deleteSessionByTokenHash('2'.repeat(64));
  const revokedChange = db.changePasswordIfUnchanged({
    userId: createdUser.id,
    expectedAuthVersion: 0,
    sessionTokenHash: '2'.repeat(64),
    newPasswordHash: 'hash-stolen-override',
    nowIso,
  });
  assert.deepEqual(revokedChange, { updated: false, reason: 'SESSION_INVALID' });

  const mismatchChange = db.changePasswordIfUnchanged({
    userId: createdUser.id,
    expectedAuthVersion: 99,
    sessionTokenHash: '6'.repeat(64),
    newPasswordHash: 'hash-stale-override',
    nowIso,
  });
  assert.deepEqual(mismatchChange, { updated: false, reason: 'AUTH_VERSION_MISMATCH' });

  // 正常な変更はハッシュ更新・must_change_password=0・世代加算・全セッション削除を一括実施
  const okChange = db.changePasswordIfUnchanged({
    userId: createdUser.id,
    expectedAuthVersion: 0,
    sessionTokenHash: '6'.repeat(64),
    newPasswordHash: 'hash-v2',
    nowIso,
  });
  assert.deepEqual(okChange, { updated: true });
  assert.equal(db.getSessionAuthByTokenHash('6'.repeat(64), nowIso), null);
  assert.equal(db.getSessionAuthByTokenHash('5'.repeat(64), nowIso), null);
  assert.equal(db.getUserForAuthByUsername('alice').auth_version, 1);

  // 5. 会員投稿作成・一覧と単体取得の両方で is_member 一致・updatePost会員名変更禁止
  const memberPost = db.createPost({
    threadId: 1,
    authorName: 'alice',
    visitorId: 'mem_vis_01',
    content: '会員の投稿です',
    createdBy: createdUser.id,
  });
  assert.equal(memberPost.is_member, true);
  const threadMemberPost = db.getThreadDetail(1).posts.find((p) => p.id === memberPost.id);
  assert.equal(threadMemberPost.is_member, true);

  // 本文のみ編集は通るが、会員投稿の名前変更は拒否されること
  const editedContent = db.updatePost({ postId: memberPost.id, content: '会員投稿の本文修正' });
  assert.equal(editedContent.post.content, '会員投稿の本文修正');
  assert.throws(
    () => db.updatePost({ postId: memberPost.id, content: '偽装', authorName: 'bob' }),
    /変更できません/
  );

  // 6. resetPassword / setUserRole / clearAllSessions（バックアップ復元時想定）
  const resetRes = db.resetPasswordByUsername({ username: 'alice', newPasswordHash: 'hash-temp' });
  assert.equal(resetRes.found, true);
  assert.equal(resetRes.user.mustChangePassword, true);
  const roleRes = db.setUserRoleByUsername({ username: 'alice', role: 'admin' });
  assert.equal(roleRes.user.role, 'admin');

  // セッションを再作成してから clearAllSessions で全消去できること
  const authAlice = db.getUserForAuthByUsername('alice');
  db.issueSessionIfVersionMatches({
    userId: authAlice.id,
    expectedAuthVersion: authAlice.auth_version,
    tokenHash: 'd'.repeat(64),
    expiresAt: expIso,
    nowIso,
  });
  assert.ok(db.getSessionAuthByTokenHash('d'.repeat(64), nowIso) !== null);
  assert.equal(db.clearAllSessions() >= 1, true);
  assert.equal(db.getSessionAuthByTokenHash('d'.repeat(64), nowIso), null);
});

test('v1.1管理MVP(DB): v2→v3移行・監査失敗ロールバック・F1復元再適用・最後の管理者保護・updateThread/purgeThread拡張', () => {
  const { DatabaseSync } = require('node:sqlite');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-board-v11-db-'));
  let migrated = null;
  let db = null;
  let restoredDb = null;

  try {
    // 1. 実v2スキーマ相当の隔離DBを作成し v2 -> v3 移行の非破壊性と再起動冪等性を検証
    const v2Path = path.join(tmpDir, 'v2_to_v3.db');
    const v2Raw = new DatabaseSync(v2Path);
    v2Raw.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
        auth_version INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        pinned_text TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
        parent_id INTEGER,
        author_name TEXT NOT NULL DEFAULT '名無しさん',
        visitor_id TEXT NOT NULL,
        content TEXT NOT NULL,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (id, thread_id),
        FOREIGN KEY (parent_id, thread_id) REFERENCES posts(id, thread_id) ON DELETE RESTRICT
      );
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      PRAGMA user_version = 2;
      INSERT INTO users (username, password_hash, role) VALUES ('root_admin', 'scrypt$v1$16384$8$1$abc$def', 'admin');
      INSERT INTO users (username, password_hash, role) VALUES ('plain_user', 'scrypt$v1$16384$8$1$abc$def', 'user');
      INSERT INTO categories (name, display_order) VALUES ('v2既存カテゴリ', 1);
      INSERT INTO threads (category_id, title, pinned_text, is_pinned, display_order, created_by)
        VALUES (1, 'v2既存スレッド', '初期案内文', 1, 1, 1);
      INSERT INTO posts (thread_id, parent_id, author_name, visitor_id, content, created_by)
        VALUES (1, NULL, 'root_admin', 'v2id01', 'v2親投稿', 1);
      INSERT INTO posts (thread_id, parent_id, author_name, visitor_id, content, created_by)
        VALUES (1, 1, 'plain_user', 'v2id02', 'v2返信投稿', 2);
    `);
    v2Raw.close();

    migrated = createBoardDb({ dbPath: v2Path });
    assert.equal(migrated.getStatus().schemaVersion, 4);
    assert.equal(migrated.listCategoriesWithThreads()[0].threads[0].title, 'v2既存スレッド');
    assert.equal(migrated.getThreadDetail(1).posts.length, 2);
    migrated.close();
    migrated = null;

    // 再起動（再オープン）でもデータ不変・冪等であること
    db = createBoardDb({ dbPath: v2Path });
    assert.equal(db.getStatus().schemaVersion, 4);
    assert.equal(db.getThreadDetail(1).posts.length, 2);

    // 2. updateThread による pinned_text / is_pinned 更新・クリア・制御文字拒否
    const updatedTh = db.updateThread({
      threadId: 1,
      title: 'v3改訂スレッド',
      pinnedText: '更新後の案内文\n2行目',
      isPinned: false,
      displayOrder: 5,
      audit: { actorType: 'admin_web', actorUserId: 1, actorUsername: 'root_admin' },
    });
    assert.equal(updatedTh.thread.title, 'v3改訂スレッド');
    assert.equal(updatedTh.thread.pinned_text, '更新後の案内文\n2行目');
    assert.equal(updatedTh.thread.is_pinned, 0);
    assert.equal(updatedTh.thread.display_order, 5);

    const clearedPin = db.updateThread({
      threadId: 1,
      pinnedText: '   ',
      isPinned: true,
      audit: { actorType: 'admin_web', actorUserId: 1, actorUsername: 'root_admin' },
    });
    assert.equal(clearedPin.thread.pinned_text, null);
    assert.equal(clearedPin.thread.is_pinned, 1);

    assert.throws(
      () => db.updateThread({ threadId: 1, pinnedText: '不正\u0000文字' }),
      /制御文字/
    );

    // 3. deleteCategory: 配下あり 409 CATEGORY_NOT_EMPTY / 空なら削除成功
    assert.throws(
      () => db.deleteCategory(1),
      (err) => err.statusCode === 409 && err.code === 'CATEGORY_NOT_EMPTY'
    );
    const emptyCat = db.createCategory({
      name: '空カテゴリ',
      audit: { actorType: 'admin_web', actorUserId: 1, actorUsername: 'root_admin' },
    });
    const delCatRes = db.deleteCategory(emptyCat.id, {
      audit: { actorType: 'admin_web', actorUserId: 1, actorUsername: 'root_admin' },
    });
    assert.equal(delCatRes.found, true);
    assert.equal(delCatRes.deletedCategory.name, '空カテゴリ');

    // 4. purgeThread の直前確認照合 (CONFIRM_TITLE_MISMATCH / THREAD_POST_COUNT_CHANGED)
    const tempTh = db.createThread({ categoryId: 1, title: '削除確認対象スレ' });
    db.createPost({ threadId: tempTh.id, authorName: '名無しさん', visitorId: 'v1', content: '削除前投稿' });
    assert.throws(
      () => db.purgeThread(tempTh.id, { requireConfirmation: true, confirmTitle: '別タイトル', expectedPostCount: 1 }),
      (err) => err.statusCode === 400 && err.code === 'CONFIRM_TITLE_MISMATCH'
    );
    assert.throws(
      () => db.purgeThread(tempTh.id, { requireConfirmation: true, confirmTitle: '削除確認対象スレ', expectedPostCount: 0 }),
      (err) => err.statusCode === 409 && err.code === 'THREAD_POST_COUNT_CHANGED' && err.details.actualPostsCount === 1
    );
    const purgeOk = db.purgeThread(tempTh.id, {
      requireConfirmation: true,
      confirmTitle: '削除確認対象スレ',
      expectedPostCount: 1,
      audit: { actorType: 'admin_web', actorUserId: 1, actorUsername: 'root_admin' },
    });
    assert.equal(purgeOk.found, true);
    assert.equal(purgeOk.deletedPostsCount, 1);

    // 5. 最後の管理者保護 (1->0 拒否 / 2->1 許可) と秘密キー除去付き監査ログ
    assert.throws(
      () => db.setUserRoleByUsername({
        username: 'root_admin',
        role: 'user',
        audit: { actorType: 'cli', actorUsername: 'cli' },
      }),
      (err) => err.statusCode === 409 && err.code === 'LAST_ADMIN_PROTECTED'
    );
    db.setUserRoleByUsername({
      username: 'plain_user',
      role: 'admin',
      audit: { actorType: 'cli', actorUsername: 'cli' },
    });
    const demoteFirst = db.setUserRoleByUsername({
      username: 'root_admin',
      role: 'user',
      audit: { actorType: 'cli', actorUsername: 'cli' },
    });
    assert.equal(demoteFirst.user.role, 'user');
    assert.equal(db.getAdminOverview().summary.adminsCount, 1);

    db.resetPasswordByUsername({
      username: 'root_admin',
      newPasswordHash: 'hash-hidden-secret',
      reason: '本人確認メモOK',
      audit: { actorType: 'cli', actorUsername: 'cli' },
    });
    const recentAudits = db.listAdminAuditLogs({ limit: 10 });
    const resetLog = recentAudits.logs.find((l) => l.action === 'user_reset_password');
    assert.ok(resetLog);
    assert.equal(JSON.stringify(resetLog).includes('hash-hidden-secret'), false);
    assert.equal(resetLog.detail.reason, '本人確認メモOK');

    // 6. 監査書込失敗時に親の状態変更も同一TXで確実にROLLBACKされること
    db.execRawForTesting(`
      CREATE TRIGGER trg_fail_audit_test
      BEFORE INSERT ON admin_audit_logs
      BEGIN
        SELECT RAISE(ABORT, 'simulated audit insert failure');
      END;
    `);
    assert.throws(
      () =>
        db.createCategory({
          name: '監査失敗ロールバックカテゴリ',
          audit: { actorType: 'admin_web', actorUserId: 2, actorUsername: 'plain_user' },
        }),
      /simulated audit insert failure/
    );
    assert.equal(
      db.listCategoriesWithThreads().some((c) => c.name === '監査失敗ロールバックカテゴリ'),
      false
    );
    assert.throws(
      () =>
        db.softDeletePost(2, {
          audit: { actorType: 'admin_web', actorUserId: 2, actorUsername: 'plain_user' },
        }),
      /simulated audit insert failure/
    );
    assert.equal(db.getThreadDetail(1).posts.find((p) => p.id === 2).is_deleted, 0);
    db.execRawForTesting('DROP TRIGGER trg_fail_audit_test;');

    // 7. F1: 復元時（バックアップ作成後に実施された削除・セッション失効の再適用）手順検証
    const preActionBackupPath = path.join(tmpDir, 'pre_action_backup.db');
    db.backupTo(preActionBackupPath, { requireNonEmptyCategories: true });
    db.softDeletePost(2, { audit: { actorType: 'cli', actorUsername: 'cli' } });
    assert.equal(db.getThreadDetail(1).posts.find((p) => p.id === 2).is_deleted, 1);

    // バックアップを別先へ復元して確認 → 復元先では未削除のため、削除＆全セッション失効を再適用する
    const restoredPath = path.join(tmpDir, 'restored_f1.db');
    fs.copyFileSync(preActionBackupPath, restoredPath);
    restoredDb = createBoardDb({ dbPath: restoredPath });
    assert.equal(restoredDb.getThreadDetail(1).posts.find((p) => p.id === 2).is_deleted, 0);
    restoredDb.softDeletePost(2, { audit: { actorType: 'cli', actorUsername: 'cli' } });
    restoredDb.clearAllSessions();
    assert.equal(restoredDb.getThreadDetail(1).posts.find((p) => p.id === 2).is_deleted, 1);
  } finally {
    try { migrated?.close(); } catch {}
    try { db?.close(); } catch {}
    try { restoredDb?.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('P1-1回帰: 新版runBackupは合成v2 DBをv3へ移行せず元DB・複製ともv2のまま完全一致させること', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { runBackup } = require('../src/backup');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-board-p1-backup-v2-'));
  let liveV2 = null;
  let inspectSrc = null;
  let inspectBak = null;
  try {
    const srcV2Path = path.join(tmpDir, 'source_v2.db');
    const destBakPath = path.join(tmpDir, 'backup_v2.db');

    liveV2 = new DatabaseSync(srcV2Path);
    liveV2.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        auth_version INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        pinned_text TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
        parent_id INTEGER,
        author_name TEXT NOT NULL DEFAULT '名無しさん',
        visitor_id TEXT NOT NULL,
        content TEXT NOT NULL,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (id, thread_id),
        FOREIGN KEY (parent_id, thread_id) REFERENCES posts(id, thread_id) ON DELETE RESTRICT
      );
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      PRAGMA user_version = 2;
      INSERT INTO users (username, password_hash, role) VALUES ('v2_admin', 'scrypt$v1$16384$8$1$abc$def', 'admin');
      INSERT INTO categories (name, display_order) VALUES ('v2保護カテゴリ', 1);
      INSERT INTO threads (category_id, title, pinned_text, is_pinned, display_order, created_by)
        VALUES (1, 'v2保護スレッド', 'v2案内', 1, 1, 1);
      INSERT INTO posts (thread_id, author_name, visitor_id, content, created_by)
        VALUES (1, 'v2_admin', 'v2vis01', 'v2のまま維持される投稿', 1);
    `);
    // WAL上に未チェックポイント行も残した状態でバックアップCLIを実行する
    liveV2.exec(`INSERT INTO posts (thread_id, author_name, visitor_id, content) VALUES (1, 'WAL住民', 'walvis2', 'WAL未チェックポイント投稿');`);

    const bakRes = runBackup({ srcPath: srcV2Path, destPath: destBakPath });
    assert.equal(bakRes.success, true);

    liveV2.close();
    liveV2 = null;

    inspectSrc = new DatabaseSync(srcV2Path, { readOnly: true });
    inspectBak = new DatabaseSync(destBakPath, { readOnly: true });

    assert.equal(Number(inspectSrc.prepare('PRAGMA user_version;').get().user_version), 2);
    assert.equal(Number(inspectBak.prepare('PRAGMA user_version;').get().user_version), 2);

    const getTables = (conn) =>
      conn
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
        .all()
        .map((r) => ({ name: r.name, sql: r.sql }));

    const srcTables = getTables(inspectSrc);
    const bakTables = getTables(inspectBak);
    assert.deepEqual(srcTables, bakTables);
    assert.equal(srcTables.some((t) => t.name === 'admin_audit_logs'), false);

    assert.deepEqual(
      inspectBak.prepare('SELECT id, author_name, content FROM posts ORDER BY id ASC').all(),
      inspectSrc.prepare('SELECT id, author_name, content FROM posts ORDER BY id ASC').all()
    );
    assert.equal(inspectBak.prepare('SELECT COUNT(*) AS c FROM posts').get().c, 2);
  } finally {
    try { liveV2?.close(); } catch {}
    try { inspectSrc?.close(); } catch {}
    try { inspectBak?.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('P1-2 & 配備前確認回帰: 最後の1カテゴリ削除409保護＋バックアップ維持・v2→v3途中失敗時完全ROLLBACK', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { runBackup } = require('../src/backup');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-board-p1-lastcat-rollback-'));
  let db = null;
  let failDb = null;
  let rawCheck = null;
  let cleanDb = null;
  try {
    // 1. 最後の1カテゴリ保護 (409 LAST_CATEGORY_PROTECTED) と、スレッド0件・カテゴリ1件状態でのバックアップ成功
    const livePath = path.join(tmpDir, 'lastcat.db');
    const bakPath = path.join(tmpDir, 'lastcat_bak.db');
    db = createBoardDb({ dbPath: livePath });
    const c1 = db.createCategory({ name: '残すカテゴリ', audit: { actorType: 'cli', actorUsername: 'cli' } });
    const c2 = db.createCategory({ name: '消すカテゴリ', audit: { actorType: 'cli', actorUsername: 'cli' } });
    const th1 = db.createThread({ categoryId: c1.id, title: '仮スレッド', audit: { actorType: 'cli', actorUsername: 'cli' } });
    db.deleteCategory(c2.id, { audit: { actorType: 'cli', actorUsername: 'cli' } });
    db.purgeThread(th1.id, { audit: { actorType: 'cli', actorUsername: 'cli' } });

    assert.throws(
      () => db.deleteCategory(c1.id, { audit: { actorType: 'cli', actorUsername: 'cli' } }),
      (err) => err.statusCode === 409 && err.code === 'LAST_CATEGORY_PROTECTED'
    );
    assert.equal(db.getAdminOverview().summary.categoriesCount, 1);
    db.close();
    db = null;

    const bak = runBackup({ srcPath: livePath, destPath: bakPath });
    assert.equal(bak.success, true);

    // 2. v2→v3 単一トランザクション移行：途中失敗時に admin_audit_logs と user_version=3 が残らないこと
    const v2RollbackPath = path.join(tmpDir, 'rollback_v2.db');
    const rawV2 = new DatabaseSync(v2RollbackPath);
    rawV2.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        auth_version INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        pinned_text TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
        parent_id INTEGER,
        author_name TEXT NOT NULL DEFAULT '名無しさん',
        visitor_id TEXT NOT NULL,
        content TEXT NOT NULL,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (id, thread_id),
        FOREIGN KEY (parent_id, thread_id) REFERENCES posts(id, thread_id) ON DELETE RESTRICT
      );
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      PRAGMA user_version = 2;
      INSERT INTO categories (name, display_order) VALUES ('移行前カテゴリ', 1);
      INSERT INTO threads (category_id, title) VALUES (1, '移行前スレッド');
      INSERT INTO posts (thread_id, author_name, visitor_id, content) VALUES (1, '旧住民', 'rb01', 'ロールバック保護投稿');
    `);
    rawV2.close();

    const baseSchemaSql = fs.readFileSync(path.join(__dirname, '../src/schema.sql'), 'utf8');
    const brokenSchemaPath = path.join(tmpDir, 'broken_schema.sql');
    fs.writeFileSync(
      brokenSchemaPath,
      `${baseSchemaSql}\nCREATE INDEX idx_intentional_failure ON nonexistent_table(id);\n`,
      'utf8'
    );

    assert.throws(
      () => createBoardDb({ dbPath: v2RollbackPath, schemaPath: brokenSchemaPath }),
      /nonexistent_table/
    );

    rawCheck = new DatabaseSync(v2RollbackPath, { readOnly: true });
    assert.equal(Number(rawCheck.prepare('PRAGMA user_version;').get().user_version), 2);
    assert.equal(
      rawCheck.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_audit_logs'").get(),
      undefined
    );
    assert.equal(
      rawCheck.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_permissions'").get(),
      undefined
    );
    assert.equal(
      rawCheck.prepare('SELECT content FROM posts WHERE id = 1').get().content,
      'ロールバック保護投稿'
    );
    rawCheck.close();
    rawCheck = null;

    // 正常スキーマで開き直せば安全に v4 へ移行し、既存データも残ること
    cleanDb = createBoardDb({ dbPath: v2RollbackPath });
    assert.equal(cleanDb.getStatus().schemaVersion, 4);
    assert.equal(cleanDb.getThreadDetail(1).posts[0].content, 'ロールバック保護投稿');
  } finally {
    try { db?.close(); } catch {}
    try { failDb?.close(); } catch {}
    try { rawCheck?.close(); } catch {}
    try { cleanDb?.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('v1.2 ロール・権限管理(DB): v3→v4移行・権限冪等保持・runBackup非移行・ロール変更/最後の管理者保護/強制失効/投稿権限強制', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { runBackup } = require('../src/backup');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-board-v12-db-'));
  let rawV3 = null;
  let inspectSrc = null;
  let inspectBak = null;
  let rawRollback = null;
  let db = null;
  let reopened = null;

  try {
    // 1. 合成 v3 DB を構築し、runBackup が v3 のまま無移行で複製することを確認
    const v3Path = path.join(tmpDir, 'v3_to_v4.db');
    const v3BakPath = path.join(tmpDir, 'v3_backup.db');
    rawV3 = new DatabaseSync(v3Path);
    rawV3.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
        auth_version INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        pinned_text TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
        parent_id INTEGER,
        author_name TEXT NOT NULL DEFAULT '名無しさん',
        visitor_id TEXT NOT NULL,
        content TEXT NOT NULL,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        UNIQUE (id, thread_id),
        FOREIGN KEY (parent_id, thread_id) REFERENCES posts(id, thread_id) ON DELETE RESTRICT
      );
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE admin_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('admin_web', 'cli')),
        actor_user_id INTEGER,
        actor_username TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
      );
      PRAGMA user_version = 3;
      INSERT INTO users (username, password_hash, role) VALUES ('root_admin', 'scrypt$v1$16384$8$1$abc$def', 'admin');
      INSERT INTO users (username, password_hash, role) VALUES ('member_a', 'scrypt$v1$16384$8$1$abc$def', 'user');
      INSERT INTO categories (name, display_order) VALUES ('v3カテゴリ', 1);
      INSERT INTO threads (category_id, title, created_by) VALUES (1, 'v3スレッド', 1);
      INSERT INTO posts (thread_id, author_name, visitor_id, content, created_by) VALUES (1, 'root_admin', 'v301', 'v3既存投稿', 1);
    `);
    rawV3.close();
    rawV3 = null;

    const bakRes = runBackup({ srcPath: v3Path, destPath: v3BakPath });
    assert.equal(bakRes.success, true);

    inspectSrc = new DatabaseSync(v3Path, { readOnly: true });
    inspectBak = new DatabaseSync(v3BakPath, { readOnly: true });
    assert.equal(Number(inspectSrc.prepare('PRAGMA user_version;').get().user_version), 3);
    assert.equal(Number(inspectBak.prepare('PRAGMA user_version;').get().user_version), 3);
    assert.equal(
      inspectSrc.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_permissions'").get(),
      undefined
    );
    assert.equal(
      inspectBak.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_permissions'").get(),
      undefined
    );
    inspectSrc.close();
    inspectSrc = null;
    inspectBak.close();
    inspectBak = null;

    // 2. v3 → v4 途中失敗時の単一トランザクション完全ロールバック確認
    const v3RollbackPath = path.join(tmpDir, 'v3_rollback.db');
    fs.copyFileSync(v3Path, v3RollbackPath);
    const baseSchemaSql = fs.readFileSync(path.join(__dirname, '../src/schema.sql'), 'utf8');
    const brokenSchemaPath = path.join(tmpDir, 'broken_v4_schema.sql');
    fs.writeFileSync(
      brokenSchemaPath,
      `${baseSchemaSql}\nCREATE INDEX idx_v4_fail ON nonexistent_table(id);\n`,
      'utf8'
    );
    assert.throws(
      () => createBoardDb({ dbPath: v3RollbackPath, schemaPath: brokenSchemaPath }),
      /nonexistent_table/
    );
    rawRollback = new DatabaseSync(v3RollbackPath, { readOnly: true });
    assert.equal(Number(rawRollback.prepare('PRAGMA user_version;').get().user_version), 3);
    assert.equal(
      rawRollback.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_permissions'").get(),
      undefined
    );
    rawRollback.close();
    rawRollback = null;

    // 3. 正常スキーマで v3 → v4 移行、8行初期シード、設定カスタマイズ後の再オープン冪等保持確認
    db = createBoardDb({ dbPath: v3Path });
    assert.equal(db.getStatus().schemaVersion, 4);
    assert.equal(db.getThreadDetail(1).posts[0].content, 'v3既存投稿');

    assert.deepEqual(db.getAllRolePermissions(), {
      admin: { create_post: true, create_thread: true, pin_post: true, upload_image: true },
      user: { create_post: true, create_thread: false, pin_post: false, upload_image: true },
      guest: { create_post: true, create_thread: false, pin_post: false, upload_image: false },
    });

    // admin 変更と未知キーは 400 拒否
    assert.throws(
      () => db.updateRolePermissions({ role: 'admin', permissions: { create_post: false } }),
      (err) => err.statusCode === 400
    );
    assert.throws(
      () => db.updateRolePermissions({ role: 'guest', permissions: { unknown_perm: false } }),
      (err) => err.statusCode === 400 && err.code === 'UNKNOWN_PERMISSION_KEY'
    );

    const permUpd = db.updateRolePermissions({
      role: 'guest',
      permissions: { create_post: false },
      audit: { actorType: 'admin_web', actorUserId: 1, actorUsername: 'root_admin' },
    });
    assert.equal(permUpd.unchanged, false);
    assert.equal(permUpd.permissions.create_post, false);

    // 同一値再保存は unchanged: true で追加監査を出さない
    const permNoop = db.updateRolePermissions({
      role: 'guest',
      permissions: { create_post: false },
      audit: { actorType: 'admin_web', actorUserId: 1, actorUsername: 'root_admin' },
    });
    assert.equal(permNoop.unchanged, true);
    assert.equal(
      db.listAdminAuditLogs({ limit: 20 }).logs.filter((l) => l.action === 'role_permissions_update').length,
      1
    );

    // DBを再オープンしてもカスタマイズした guest.create_post = false が上書きされないこと
    db.close();
    db = null;
    reopened = createBoardDb({ dbPath: v3Path });
    assert.equal(reopened.getStatus().schemaVersion, 4);
    assert.equal(reopened.getEffectivePermissionsForRole('guest').create_post, false);
    assert.equal(reopened.getEffectivePermissionsForRole('user').upload_image, true);

    // 4. createPost の enforceRole 権限検査（guest は 403 PERMISSION_DENIED、admin は許可）
    assert.throws(
      () =>
        reopened.createPost({
          threadId: 1,
          authorName: '匿名テスト',
          visitorId: 'vis-perm-1',
          content: '制限時投稿',
          enforceRole: 'guest',
        }),
      (err) => err.statusCode === 403 && err.code === 'PERMISSION_DENIED'
    );
    const adminAllowedPost = reopened.createPost({
      threadId: 1,
      authorName: 'root_admin',
      visitorId: 'vis-perm-2',
      content: '管理者許可投稿',
      createdBy: 1,
      enforceRole: 'admin',
    });
    assert.equal(adminAllowedPost.content, '管理者許可投稿');

    // 5. setUserRoleById / revokeAllSessionsByUserId（最後の管理者409保護・同ロールno-op・同一TX監査＆ロールバック）
    const nowIso = '2026-11-27T05:00:00.000Z';
    const expIso = '2026-12-04T05:00:00.000Z';
    const rootTokenHash = '1'.repeat(64);
    const memberTokenHash = '2'.repeat(64);
    reopened.issueSessionIfVersionMatches({
      userId: 1,
      expectedAuthVersion: 0,
      tokenHash: rootTokenHash,
      expiresAt: expIso,
      nowIso,
    });
    reopened.issueSessionIfVersionMatches({
      userId: 2,
      expectedAuthVersion: 0,
      tokenHash: memberTokenHash,
      expiresAt: expIso,
      nowIso,
    });

    // 最後の1名降格は 409 LAST_ADMIN_PROTECTED、セッション維持
    assert.throws(
      () =>
        reopened.setUserRoleById({
          userId: 1,
          role: 'user',
          audit: { actorType: 'admin_web', actorUserId: 1, actorUsername: 'root_admin' },
        }),
      (err) => err.statusCode === 409 && err.code === 'LAST_ADMIN_PROTECTED'
    );
    assert.ok(reopened.getSessionAuthByTokenHash(rootTokenHash, nowIso) !== null);

    // 同一ロール更新は unchanged: true で auth_version・セッション・監査を変更しない
    const sameRoleRes = reopened.setUserRoleById({
      userId: 2,
      role: 'user',
      audit: { actorType: 'admin_web', actorUserId: 1, actorUsername: 'root_admin' },
    });
    assert.equal(sameRoleRes.unchanged, true);
    assert.equal(sameRoleRes.revokedSessions, 0);
    assert.equal(reopened.getUserForAuthByUsername('member_a').auth_version, 0);
    assert.ok(reopened.getSessionAuthByTokenHash(memberTokenHash, nowIso) !== null);

    // 監査失敗時は昇格・auth_version加算・セッション失効もすべてロールバックされること
    reopened.execRawForTesting(`
      CREATE TRIGGER trg_v12_fail_audit
      BEFORE INSERT ON admin_audit_logs
      BEGIN
        SELECT RAISE(ABORT, 'v12 audit rollback test');
      END;
    `);
    assert.throws(
      () =>
        reopened.setUserRoleById({
          userId: 2,
          role: 'admin',
          audit: { actorType: 'admin_web', actorUserId: 1, actorUsername: 'root_admin' },
        }),
      /v12 audit rollback test/
    );
    assert.equal(reopened.getUserForAuthByUsername('member_a').role, 'user');
    assert.equal(reopened.getUserForAuthByUsername('member_a').auth_version, 0);
    assert.ok(reopened.getSessionAuthByTokenHash(memberTokenHash, nowIso) !== null);
    reopened.execRawForTesting('DROP TRIGGER trg_v12_fail_audit;');

    // 正常昇格：role更新＋auth_version加算＋対象セッション失効＋監査記録
    const promoteRes = reopened.setUserRoleById({
      userId: 2,
      role: 'admin',
      audit: { actorType: 'admin_web', actorUserId: 1, actorUsername: 'root_admin' },
    });
    assert.equal(promoteRes.found, true);
    assert.equal(promoteRes.unchanged, false);
    assert.equal(promoteRes.user.role, 'admin');
    assert.equal(promoteRes.revokedSessions, 1);
    assert.equal(reopened.getUserForAuthByUsername('member_a').auth_version, 1);
    assert.equal(reopened.getSessionAuthByTokenHash(memberTokenHash, nowIso), null);

    // 管理者2名の状態から1名降格は成功し、監査ログにも残る
    const demoteRes = reopened.setUserRoleById({
      userId: 1,
      role: 'user',
      audit: { actorType: 'admin_web', actorUserId: 2, actorUsername: 'member_a' },
    });
    assert.equal(demoteRes.found, true);
    assert.equal(demoteRes.user.role, 'user');
    assert.equal(demoteRes.revokedSessions, 1);
    assert.equal(reopened.getUserForAuthByUsername('root_admin').auth_version, 1);

    // revokeAllSessionsByUserId：セッション削除＋auth_version加算＋user_revoke_sessions監査
    const memberTokenHash2 = '3'.repeat(64);
    reopened.issueSessionIfVersionMatches({
      userId: 2,
      expectedAuthVersion: 1,
      tokenHash: memberTokenHash2,
      expiresAt: expIso,
      nowIso,
    });
    const revokeRes = reopened.revokeAllSessionsByUserId(2, {
      audit: { actorType: 'admin_web', actorUserId: 2, actorUsername: 'member_a' },
    });
    assert.equal(revokeRes.found, true);
    assert.equal(revokeRes.revokedSessions, 1);
    assert.equal(revokeRes.selfAffected, true);
    assert.equal(reopened.getUserForAuthByUsername('member_a').auth_version, 2);
    assert.equal(reopened.getSessionAuthByTokenHash(memberTokenHash2, nowIso), null);

    const actions = reopened.listAdminAuditLogs({ limit: 20 }).logs.map((l) => l.action);
    assert.ok(actions.includes('role_permissions_update'));
    assert.ok(actions.includes('user_role_change'));
    assert.ok(actions.includes('user_revoke_sessions'));
  } finally {
    try { rawV3?.close(); } catch {}
    try { inspectSrc?.close(); } catch {}
    try { inspectBak?.close(); } catch {}
    try { rawRollback?.close(); } catch {}
    try { db?.close(); } catch {}
    try { reopened?.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
