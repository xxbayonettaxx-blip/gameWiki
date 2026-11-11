'use strict';

/**
 * =====================================================================
 * src/sync_structure.js
 * 役割：【構造同期】掲示板のカテゴリ・スレッドを新仕様（雑談・攻略・イベント）へ同期する
 * 方針：
 *   - 既存の投稿データを1件も消さずに安全に移行。
 *   - 旧カテゴリ名・スレッド名を自動で新名へマイグレーション。
 *   - 存在しないカテゴリ・スレッドを自動作成。
 * 使い方：
 *   node --env-file-if-exists=.env src/sync_structure.js
 * =====================================================================
 */

const { createBoardDb, resolveProjectDbPath } = require('./db');
const { SEED_CATEGORIES } = require('./seed');

function syncStructure(db) {
  const currentCategories = db.listCategoriesWithThreads();
  const summary = {
    renamedCategories: [],
    createdCategories: [],
    renamedThreads: [],
    movedThreads: [],
    createdThreads: [],
    cleanedThreads: [],
  };

  // 1. カテゴリの同期（名前と表示順）
  const categoryMap = new Map(); // name -> categoryId

  for (const catDef of SEED_CATEGORIES) {
    let cat = currentCategories.find((c) => c.name === catDef.name);

    if (!cat) {
      // 旧名のカテゴリがあれば改名
      let legacyCat = null;
      if (catDef.name === '雑談') {
        legacyCat = currentCategories.find((c) => c.name === '雑談・交流');
      } else if (catDef.name === '攻略') {
        legacyCat = currentCategories.find((c) => c.name === '質問・検証');
      }

      if (legacyCat) {
        db.updateCategory({ categoryId: legacyCat.id, name: catDef.name, displayOrder: catDef.displayOrder });
        summary.renamedCategories.push(`「${legacyCat.name}」→「${catDef.name}」(#${legacyCat.id})`);
        categoryMap.set(catDef.name, legacyCat.id);
      } else {
        const created = db.createCategory({ name: catDef.name, displayOrder: catDef.displayOrder });
        summary.createdCategories.push(`「${created.name}」(#${created.id})`);
        categoryMap.set(catDef.name, created.id);
      }
    } else {
      if (cat.display_order !== catDef.displayOrder) {
        db.updateCategory({ categoryId: cat.id, name: cat.name, displayOrder: catDef.displayOrder });
      }
      categoryMap.set(catDef.name, cat.id);
    }
  }

  // カテゴリ再読込
  const refreshedCategories = db.listCategoriesWithThreads();

  // 2. スレッドの同期
  for (const catDef of SEED_CATEGORIES) {
    const targetCatId = categoryMap.get(catDef.name);
    const catData = refreshedCategories.find((c) => c.id === targetCatId) || { threads: [] };

    for (const threadDef of catDef.threads) {
      // すでに同名スレッドが存在するか確認
      let thread = catData.threads.find((t) => t.title === threadDef.title);

      if (!thread) {
        // 旧スレッドからの改名・移動マッピング
        let legacyThread = null;

        if (catDef.name === '雑談' && threadDef.title === '雑談') {
          legacyThread = catData.threads.find((t) => t.title === '総合雑談スレッド');
        } else if (catDef.name === '雑談' && threadDef.title === '質問、初心者質問') {
          // 初心者質問スレッドが別カテゴリや同カテゴリにあれば移動・改名
          const allThreads = refreshedCategories.flatMap((c) => c.threads.map((t) => ({ ...t, catId: c.id })));
          legacyThread = allThreads.find((t) => t.title === '初心者質問スレッド');
        } else if (catDef.name === '攻略' && threadDef.title === '他') {
          legacyThread = catData.threads.find((t) => t.title === 'データ・仕様検証スレッド');
        }

        if (legacyThread) {
          if (legacyThread.catId && legacyThread.catId !== targetCatId) {
            // カテゴリ移動が必要な場合（DB直接更新）
            db.execRawForTesting(
              `UPDATE threads SET category_id = ${targetCatId}, title = '${threadDef.title.replace(/'/g, "''")}' WHERE id = ${legacyThread.id}`
            );
            summary.movedThreads.push(`「${legacyThread.title}」→ カテゴリ「${catDef.name}」の「${threadDef.title}」(#${legacyThread.id})`);
          } else {
            db.updateThread({ threadId: legacyThread.id, title: threadDef.title });
            summary.renamedThreads.push(`「${legacyThread.title}」→「${threadDef.title}」(#${legacyThread.id})`);
          }
        } else {
          // 新規作成
          const created = db.createThread({
            categoryId: targetCatId,
            title: threadDef.title,
            pinnedText: threadDef.pinnedText,
            isPinned: Boolean(threadDef.isPinned),
          });
          summary.createdThreads.push(`カテゴリ「${catDef.name}」に「${created.title}」(#${created.id})`);
        }
      }
    }
  }

  // 3. 意図しない空のスレッド（投稿数0件のみ）があればクリーンアップ
  // ※ 投稿が1件でもあるスレッドは一切自動削除せず安全に保持する（不要な場合は moderate purge-thread を使用）
  const afterCategories = db.listCategoriesWithThreads();
  const allowedMap = new Map(SEED_CATEGORIES.map((c) => [c.name, new Set(c.threads.map((t) => t.title))]));

  for (const cat of afterCategories) {
    const allowedTitles = allowedMap.get(cat.name);
    if (!allowedTitles) continue;

    for (const th of cat.threads) {
      if (!allowedTitles.has(th.title)) {
        if (th.post_count === 0) {
          try {
            db.execRawForTesting(`DELETE FROM threads WHERE id = ${th.id}`);
            summary.cleanedThreads.push(`空の不要スレッド「${th.title}」(#${th.id}, 投稿数: 0) を整理・削除`);
          } catch {
            // 万が一FK違反等の場合は保持
          }
        } else {
          summary.cleanedThreads.push(
            `※ 投稿が存在するスレッド「${th.title}」(#${th.id}, 投稿数: ${th.post_count}) は削除せず安全に保持しました`
          );
        }
      }
    }
  }

  return summary;
}

function main() {
  const dbPath = resolveProjectDbPath(process.env.DB_PATH || './data/board.db');
  console.log(`[SYNC] データベース構造同期を開始します: ${dbPath}`);
  const db = createBoardDb({ dbPath });

  try {
    const summary = syncStructure(db);

    console.log('=== 同期結果 ===');
    if (summary.renamedCategories.length > 0) {
      console.log('カテゴリ改名:', summary.renamedCategories.join(', '));
    }
    if (summary.createdCategories.length > 0) {
      console.log('カテゴリ新設:', summary.createdCategories.join(', '));
    }
    if (summary.renamedThreads.length > 0) {
      console.log('スレッド改名:', summary.renamedThreads.join(', '));
    }
    if (summary.movedThreads.length > 0) {
      console.log('スレッド移動:', summary.movedThreads.join(', '));
    }
    if (summary.createdThreads.length > 0) {
      console.log('スレッド新設:', summary.createdThreads.join(', '));
    }
    if (summary.cleanedThreads.length > 0) {
      console.log('不要スレッド削除:', summary.cleanedThreads.join(', '));
    }

    console.log('\n=== 更新後のカテゴリ・スレッド一覧 ===');
    const finalCats = db.listCategoriesWithThreads();
    for (const c of finalCats) {
      console.log(`[カテゴリ #${c.id}] ${c.name} (表示順: ${c.display_order})`);
      for (const t of c.threads) {
        const pin = t.is_pinned ? ' [固定]' : '';
        console.log(`   └ [スレッド #${t.id}] ${t.title}${pin} (投稿数: ${t.post_count})`);
      }
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { syncStructure };
