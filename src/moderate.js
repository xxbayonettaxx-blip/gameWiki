'use strict';

/**
 * =====================================================================
 * src/moderate.js
 * 役割：【管理CLI】テスト・運用中の投稿管理およびカテゴリ・スレッドの追加・変更コマンド
 * 使い方：
 *   npm run moderate -- list
 *   npm run moderate -- add-category "<カテゴリ名>" [表示順]
 *   npm run moderate -- rename-category <カテゴリID> "<新しいカテゴリ名>" [表示順]
 *   npm run moderate -- add-thread <カテゴリID> "<スレッドタイトル>" ["案内文"]
 *   npm run moderate -- rename-thread <スレッドID> "<新しいスレッドタイトル>"
 *   npm run moderate -- delete <投稿ID>   # 投稿を論理削除（返信は維持、ピン留めも自動解除）
 *   npm run moderate -- pin <投稿ID>      # 投稿（＋返信ツリー）をスレッド上部にピン留め
 *   npm run moderate -- unpin <投稿ID>    # 投稿のピン留めを解除
 * =====================================================================
 */

const { createBoardDb, resolveProjectDbPath } = require('./db');
const { parsePositiveInt } = require('./validators');

function parseNonNegativeInt(rawValue, label = '表示順') {
  if (typeof rawValue === 'string' && /^\d+$/.test(rawValue.trim())) {
    const parsed = Number(rawValue.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  throw new Error(`${label}は0以上の整数で指定してください。`);
}

function printUsage() {
  console.error('使い方:');
  console.error('  npm run moderate -- list');
  console.error('  npm run moderate -- add-category "<カテゴリ名>" [表示順]');
  console.error('  npm run moderate -- rename-category <カテゴリID> "<新しいカテゴリ名>" [表示順]');
  console.error('  npm run moderate -- add-thread <カテゴリID> "<スレッドタイトル>" ["案内文"]');
  console.error('  npm run moderate -- rename-thread <スレッドID> "<新しいスレッドタイトル>"');
  console.error('  npm run moderate -- delete <投稿ID>');
  console.error('  npm run moderate -- pin <投稿ID>');
  console.error('  npm run moderate -- unpin <投稿ID>');
}

function main() {
  const args = process.argv.slice(2);
  const action = args[0];

  const validActions = [
    'list',
    'add-category',
    'rename-category',
    'add-thread',
    'rename-thread',
    'delete',
    'pin',
    'unpin',
  ];

  if (!validActions.includes(action)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const dbPath = resolveProjectDbPath(process.env.DB_PATH || './data/board.db');
  const db = createBoardDb({ dbPath });

  try {
    // 1. カテゴリ・スレッド一覧の表示
    if (action === 'list') {
      const categories = db.listCategoriesWithThreads();
      if (categories.length === 0) {
        console.log('[MODERATE] カテゴリがまだ登録されていません。');
        return;
      }
      console.log('=== カテゴリ・スレッド一覧 ===');
      for (const cat of categories) {
        console.log(`[カテゴリ #${cat.id}] ${cat.name} (表示順: ${cat.display_order})`);
        if (!cat.threads || cat.threads.length === 0) {
          console.log('   └ (スレッドなし)');
        } else {
          for (const th of cat.threads) {
            const pinMark = th.is_pinned ? ' [固定]' : '';
            console.log(`   └ [スレッド #${th.id}] ${th.title}${pinMark} (投稿数: ${th.post_count})`);
          }
        }
      }
      return;
    }

    // 2. 新規カテゴリの追加
    if (action === 'add-category') {
      const name = args[1];
      const rawOrder = args[2];
      if (!name) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      const displayOrder = rawOrder !== undefined ? parseNonNegativeInt(rawOrder, '表示順') : null;
      const created = db.createCategory({ name, displayOrder });
      console.log(
        `[MODERATE] カテゴリ #${created.id}「${created.name}」（表示順: ${created.display_order}）を追加しました。`
      );
      return;
    }

    // 3. 既存カテゴリの名前・表示順変更
    if (action === 'rename-category') {
      const rawCatId = args[1];
      const newName = args[2];
      const rawOrder = args[3];
      if (!rawCatId || !newName) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      const categoryId = parsePositiveInt(rawCatId, 'カテゴリID');
      const displayOrder = rawOrder !== undefined ? parseNonNegativeInt(rawOrder, '表示順') : undefined;
      const res = db.updateCategory({ categoryId, name: newName, displayOrder });
      if (!res.found) {
        console.error(`[MODERATE] カテゴリ #${categoryId} は見つかりませんでした。`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `[MODERATE] カテゴリ #${res.category.id} を「${res.category.name}」（表示順: ${res.category.display_order}）へ更新しました。`
      );
      return;
    }

    // 4. 新規スレッドの追加
    if (action === 'add-thread') {
      const rawCatId = args[1];
      const title = args[2];
      const pinnedText = args[3] ?? null;
      if (!rawCatId || !title) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      const categoryId = parsePositiveInt(rawCatId, 'カテゴリID');
      const created = db.createThread({
        categoryId,
        title,
        pinnedText,
        isPinned: Boolean(pinnedText && String(pinnedText).trim() !== ''),
      });
      console.log(
        `[MODERATE] カテゴリ #${created.category_id} にスレッド #${created.id}「${created.title}」を追加しました。`
      );
      return;
    }

    // 5. 既存スレッドのタイトル変更
    if (action === 'rename-thread') {
      const rawThreadId = args[1];
      const newTitle = args[2];
      if (!rawThreadId || !newTitle) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      const threadId = parsePositiveInt(rawThreadId, 'スレッドID');
      const res = db.updateThread({ threadId, title: newTitle });
      if (!res.found) {
        console.error(`[MODERATE] スレッド #${threadId} は見つかりませんでした。`);
        process.exitCode = 1;
        return;
      }
      console.log(`[MODERATE] スレッド #${res.thread.id} のタイトルを「${res.thread.title}」へ更新しました。`);
      return;
    }

    // 6. 投稿の論理削除・ピン留め切替（既存機能）
    const rawPostId = args[1];
    if (!rawPostId) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    const postId = parsePositiveInt(rawPostId, '投稿ID');

    if (action === 'delete') {
      const res = db.softDeletePost(postId);
      if (!res.found) {
        console.error(`[MODERATE] 投稿 #${postId} は見つかりませんでした。`);
        process.exitCode = 1;
        return;
      }
      if (res.alreadyDeleted) {
        console.log(`[MODERATE] 投稿 #${postId} は既に論理削除済みです。`);
        return;
      }
      console.log(`[MODERATE] 投稿 #${postId} を論理削除（非表示マスク化）しました。子返信は維持されます。`);
      return;
    }

    const shouldPin = action === 'pin';
    const res = db.setPostPinned(postId, shouldPin);
    if (!res.found) {
      console.error(`[MODERATE] 投稿 #${postId} は見つかりませんでした。`);
      process.exitCode = 1;
      return;
    }
    console.log(
      shouldPin
        ? `[MODERATE] 投稿 #${postId}（および返信ツリー）をピン留め設定しました。`
        : `[MODERATE] 投稿 #${postId} のピン留めを解除しました。`
    );
  } catch (err) {
    console.error(`[MODERATE] エラー: ${err.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}
