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

  // 案内文付きで追加したスレッドには初期ピン留め投稿（is_pinned = 1）が自動作成されUIに表示されること
  const addedThreadDetail = db.getThreadDetail(addedThread.id);
  assert.equal(addedThreadDetail.posts.length, 1);
  assert.equal(addedThreadDetail.posts[0].is_pinned, 1);
  assert.equal(addedThreadDetail.posts[0].content, '編成相談用の案内文です。');

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
