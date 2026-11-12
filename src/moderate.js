'use strict';

/**
 * =====================================================================
 * src/moderate.js
 * 役割：【管理CLI】テスト・運用中の投稿管理およびカテゴリ・スレッドの追加・変更コマンド
 * 使い方：
 *   npm run moderate -- list
 *   npm run moderate -- add-category "<カテゴリ名>" [表示順]
 *   npm run moderate -- rename-category <カテゴリID> "<新しいカテゴリ名>" [表示順]
 *   npm run moderate -- add-thread <カテゴリID> "<スレッドタイトル>" ["案内文"] [表示順]
 *   npm run moderate -- rename-thread <スレッドID> "<新しいスレッドタイトル>" [表示順]
 *   npm run moderate -- reorder-thread <スレッドID> <表示順>
 *   npm run moderate -- delete <投稿ID>   # 投稿を論理削除（返信は維持、ピン留めも自動解除）
 *   npm run moderate -- pin <投稿ID>      # 投稿（＋返信ツリー）をスレッド上部にピン留め
 *   npm run moderate -- unpin <投稿ID>    # 投稿のピン留めを解除
 *   npm run moderate -- purge-tree <投稿ID> [--force]    # 投稿ツリー物理削除（Dry-run確認 / --forceで実行）
 *   npm run moderate -- purge-thread <スレッドID> [--force] # スレッド物理削除（全投稿・スレッド行完全削除）
 * =====================================================================
 */

const fs = require('node:fs');
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
  console.error('  npm run moderate -- add-thread <カテゴリID> "<スレッドタイトル>" ["案内文"] [表示順]');
  console.error('  npm run moderate -- rename-thread <スレッドID> "<新しいスレッドタイトル>" [表示順]');
  console.error('  npm run moderate -- reorder-thread <スレッドID> <表示順>');
  console.error('  npm run moderate -- delete <投稿ID>');
  console.error('  npm run moderate -- pin <投稿ID>');
  console.error('  npm run moderate -- unpin <投稿ID>');
  console.error('  npm run moderate -- purge-tree <投稿ID> [--force]');
  console.error('  npm run moderate -- purge-thread <スレッドID> [--force]');
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
    'reorder-thread',
    'delete',
    'pin',
    'unpin',
    'purge-tree',
    'purge-thread',
  ];

  if (!validActions.includes(action)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const rawDbPath = process.env.DB_PATH || './data/board.db';
  const dbPath = resolveProjectDbPath(rawDbPath);

  // 削除系操作（purge-tree, purge-thread, delete）では、
  // DBファイルが存在しない・0バイトの際に createBoardDb が空DBを新規作成してしまう事故を防ぐ
  const destructiveActions = ['purge-tree', 'purge-thread', 'delete'];
  if (destructiveActions.includes(action) && dbPath !== ':memory:') {
    if (!fs.existsSync(dbPath)) {
      console.error(`[MODERATE] エラー: 指定されたDBファイルが見つかりません (${dbPath})`);
      process.exitCode = 1;
      return;
    }
    const stat = fs.statSync(dbPath);
    if (stat.size === 0) {
      console.error(`[MODERATE] エラー: 指定されたDBファイルは空（0バイト）です (${dbPath})`);
      process.exitCode = 1;
      return;
    }
  }

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
            console.log(`   └ [スレッド #${th.id}] ${th.title}${pinMark} (表示順: ${th.display_order ?? 0}, 投稿数: ${th.post_count})`);
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
      const rawOrder = args[4];
      if (!rawCatId || !title) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      const categoryId = parsePositiveInt(rawCatId, 'カテゴリID');
      const displayOrder = rawOrder !== undefined ? parseNonNegativeInt(rawOrder, '表示順') : null;
      const created = db.createThread({
        categoryId,
        title,
        pinnedText,
        isPinned: Boolean(pinnedText && String(pinnedText).trim() !== ''),
        displayOrder,
      });
      console.log(
        `[MODERATE] カテゴリ #${created.category_id} にスレッド #${created.id}「${created.title}」（表示順: ${created.display_order}）を追加しました。`
      );
      return;
    }

    // 5. 既存スレッドのタイトル・表示順変更
    if (action === 'rename-thread') {
      const rawThreadId = args[1];
      const newTitle = args[2];
      const rawOrder = args[3];
      if (!rawThreadId || !newTitle) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      const threadId = parsePositiveInt(rawThreadId, 'スレッドID');
      const displayOrder = rawOrder !== undefined ? parseNonNegativeInt(rawOrder, '表示順') : undefined;
      const res = db.updateThread({ threadId, title: newTitle, displayOrder });
      if (!res.found) {
        console.error(`[MODERATE] スレッド #${threadId} は見つかりませんでした。`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `[MODERATE] スレッド #${res.thread.id} を「${res.thread.title}」（表示順: ${res.thread.display_order}）へ更新しました。`
      );
      return;
    }

    // 6. 既存スレッドの表示順変更（タイトル変更なし）
    if (action === 'reorder-thread') {
      const rawThreadId = args[1];
      const rawOrder = args[2];
      if (!rawThreadId || rawOrder === undefined) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      const threadId = parsePositiveInt(rawThreadId, 'スレッドID');
      const displayOrder = parseNonNegativeInt(rawOrder, '表示順');
      const res = db.updateThread({ threadId, displayOrder });
      if (!res.found) {
        console.error(`[MODERATE] スレッド #${threadId} は見つかりませんでした。`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `[MODERATE] スレッド #${res.thread.id}「${res.thread.title}」の表示順を ${res.thread.display_order} へ変更しました。`
      );
      return;
    }

    // 6. 投稿ツリーの物理削除（purge-tree: 親から孫まで完全削除）
    if (action === 'purge-tree') {
      const rawPostId = args[1];
      if (!rawPostId) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      const postId = parsePositiveInt(rawPostId, '投稿ID');
      const isForce = args.includes('--force');

      if (!isForce) {
        const preview = db.getPurgeTreePreview(postId);
        if (!preview.found) {
          console.error(`[MODERATE] 投稿 #${postId} は見つかりませんでした。`);
          process.exitCode = 1;
          return;
        }
        console.log('=== [MODERATE] 投稿ツリー物理削除プレビュー (Dry-Run: DBは変更されていません) ===');
        console.log(`対象DB      : ${dbPath}`);
        console.log(`カテゴリ    : ${preview.category.name} (ID: ${preview.category.id})`);
        console.log(`スレッド    : ${preview.thread.title} (ID: ${preview.thread.id})`);
        console.log(`対象投稿    : #${preview.rootPost.id} [${preview.rootPost.author_name}] (${preview.rootPost.created_at})`);
        const snippet = preview.rootPost.content.length > 60
          ? `${preview.rootPost.content.slice(0, 60)}...`
          : preview.rootPost.content;
        console.log(`本文抜粋    : "${snippet.replace(/\r?\n/g, ' ')}"`);
        if (preview.isSubtree) {
          console.log(`※ 警告: この投稿は親投稿ではなく返信です。この投稿および配下のツリーのみが削除され、親投稿は残ります。`);
        }
        console.log(`削除対象件数: 合計 ${preview.postsCount} 件（この投稿およびすべての子孫返信）`);
        console.log(`削除順序    : ${preview.posts.map((p) => `#${p.id} (深さ: ${p.depth})`).join(' -> ')}`);
        console.log('');
        console.log(`※ 実際に物理削除を実行するには、末尾に --force を付けて実行してください:`);
        console.log(`   npm run moderate -- purge-tree ${postId} --force`);
        return;
      }

      // --force 指定時の本実行
      const result = db.purgePostTree(postId);
      if (!result.found) {
        console.error(`[MODERATE] 投稿 #${postId} は見つかりませんでした。`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `[MODERATE] [SUCCESS] 投稿 #${postId} および配下の投稿 合計 ${result.deletedCount} 件を物理削除しました。`
      );
      console.log(`削除された投稿ID (末端順): ${result.deletedIds.map((id) => `#${id}`).join(', ')}`);
      console.log(`対象スレッド: ${result.thread.title} (ID: ${result.thread.id})`);
      return;
    }

    // 7. スレッドの物理削除（purge-thread: スレッド内の全投稿およびスレッド行を完全削除）
    if (action === 'purge-thread') {
      const rawThreadId = args[1];
      if (!rawThreadId) {
        printUsage();
        process.exitCode = 1;
        return;
      }
      const threadId = parsePositiveInt(rawThreadId, 'スレッドID');
      const isForce = args.includes('--force');

      if (!isForce) {
        const preview = db.getPurgeThreadPreview(threadId);
        if (!preview.found) {
          console.error(`[MODERATE] スレッド #${threadId} は見つかりませんでした。`);
          process.exitCode = 1;
          return;
        }
        console.log('=== [MODERATE] スレッド物理削除プレビュー (Dry-Run: DBは変更されていません) ===');
        console.log(`対象DB      : ${dbPath}`);
        console.log(`カテゴリ    : ${preview.category.name} (ID: ${preview.category.id})`);
        console.log(`対象スレッド: #${preview.thread.id}「${preview.thread.title}」`);
        console.log(`配下の投稿  : 合計 ${preview.postsCount} 件`);
        if (preview.postsCount > 0) {
          console.log(`削除順序    : ${preview.posts.map((p) => `#${p.id}`).join(' -> ')} -> スレッド #${preview.thread.id}`);
        }
        console.log('');
        console.log(`※ 実際に物理削除を実行するには、末尾に --force を付けて実行してください:`);
        console.log(`   npm run moderate -- purge-thread ${threadId} --force`);
        return;
      }

      // --force 指定時の本実行
      const result = db.purgeThread(threadId);
      if (!result.found) {
        console.error(`[MODERATE] スレッド #${threadId} は見つかりませんでした。`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `[MODERATE] [SUCCESS] スレッド #${threadId}「${result.deletedThread.title}」および配下の投稿 ${result.deletedPostsCount} 件を物理削除しました。`
      );
      return;
    }

    // 8. 投稿の論理削除・ピン留め切替（既存機能）
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
