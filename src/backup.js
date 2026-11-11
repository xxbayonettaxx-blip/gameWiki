'use strict';

/**
 * =====================================================================
 * src/backup.js
 * 役割：【日次/安全バックアップCLI】
 *       元DBの欠落・0バイト・不正状態・空スキーマを厳格に検査し、
 *       安全性が完全に検証された場合のみ既存バックアップを原子的（atomic）に更新する。
 * 使い方：
 *   node src/backup.js
 *   DB_PATH=./data/board.db BACKUP_PATH=./data/board_backup.db node src/backup.js
 * =====================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createBoardDb, resolveProjectDbPath } = require('./db');

function runBackup(options = {}) {
  const rawSrcPath = options.srcPath || process.env.DB_PATH || './data/board.db';
  const rawDestPath = options.destPath || process.env.BACKUP_PATH || './data/board_backup.db';

  const srcPath = resolveProjectDbPath(rawSrcPath);
  const destPath = resolveProjectDbPath(rawDestPath);

  if (srcPath === destPath) {
    throw new Error(`バックアップ元とバックアップ先に同一のパスは指定できません (${srcPath})`);
  }

  // 1. 元DBの存在確認（欠落時に空DBを新規作成して上書きする事故を防止）
  if (srcPath !== ':memory:') {
    if (!fs.existsSync(srcPath)) {
      throw new Error(`バックアップ元のDBファイルが存在しません (${srcPath})。バックアップを中断します。`);
    }

    const stat = fs.statSync(srcPath);
    if (stat.size === 0) {
      throw new Error(`バックアップ元のDBファイルが0バイトです (${srcPath})。バックアップを中断します。`);
    }
  }

  // 2. 元DBの整合性と非空検査（読み取り専用で事前検証）
  if (srcPath !== ':memory:') {
    const probe = new DatabaseSync(srcPath, { readOnly: true });
    try {
      const qc = probe.prepare('PRAGMA quick_check;').get();
      if (!qc || String(qc.quick_check).toLowerCase() !== 'ok') {
        throw new Error(`元DBの整合性検査（quick_check）に失敗しました: ${qc?.quick_check}`);
      }
      const fk = probe.prepare('PRAGMA foreign_key_check;').all();
      if (fk && fk.length > 0) {
        throw new Error(`元DBで外部キー制約違反（foreign_key_check）が ${fk.length} 件検出されました。`);
      }
      const catCount = probe.prepare('SELECT COUNT(*) AS c FROM categories;').get();
      if (!catCount || Number(catCount.c) === 0) {
        throw new Error('元DBのカテゴリ件数が0件（未初期化または空）です。既存バックアップを保護するため中断します。');
      }
    } finally {
      probe.close();
    }
  }

  // 3. 安全性が確認できたため、createBoardDb と backupTo で原子的バックアップを実行
  const db = createBoardDb({ dbPath: srcPath });
  try {
    const finalPath = db.backupTo(destPath, { requireNonEmptyCategories: true });
    const backupStat = fs.statSync(finalPath);
    return {
      success: true,
      srcPath,
      destPath: finalPath,
      sizeBytes: backupStat.size,
      timestamp: new Date().toISOString(),
    };
  } finally {
    db.close();
  }
}

function main() {
  try {
    const result = runBackup();
    console.log(`[BACKUP] [SUCCESS] バックアップが正常に完了しました。`);
    console.log(`  元DBパス    : ${result.srcPath}`);
    console.log(`  バックアップ: ${result.destPath}`);
    console.log(`  サイズ      : ${result.sizeBytes.toLocaleString('ja-JP')} bytes`);
    console.log(`  完了時刻    : ${result.timestamp}`);
  } catch (err) {
    console.error(`[BACKUP] [ERROR] バックアップに失敗しました: ${err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { runBackup };
