'use strict';

/**
 * =====================================================================
 * src/moderate.js
 * 役割：【管理CLI】v0.5 テスト期間中の投稿論理削除・ピン留め切替コマンド
 * 使い方：
 *   npm run moderate -- delete <投稿ID>   # 投稿を論理削除（返信は維持、ピン留めも自動解除）
 *   npm run moderate -- pin <投稿ID>      # 投稿（＋返信ツリー）をスレッド上部にピン留め
 *   npm run moderate -- unpin <投稿ID>    # 投稿のピン留めを解除
 * =====================================================================
 */

const { createBoardDb, resolveProjectDbPath } = require('./db');
const { parsePositiveInt } = require('./validators');

function printUsage() {
  console.error('使い方:');
  console.error('  npm run moderate -- delete <投稿ID>');
  console.error('  npm run moderate -- pin <投稿ID>');
  console.error('  npm run moderate -- unpin <投稿ID>');
}

function main() {
  const [, , action, rawPostId] = process.argv;
  if (!['delete', 'pin', 'unpin'].includes(action) || !rawPostId) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  let postId;
  try {
    postId = parsePositiveInt(rawPostId, '投稿ID');
  } catch (err) {
    console.error(`[MODERATE] 入力エラー: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const dbPath = resolveProjectDbPath(process.env.DB_PATH || './data/board.db');
  const db = createBoardDb({ dbPath });
  try {
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
