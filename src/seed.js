'use strict';

/**
 * =====================================================================
 * src/seed.js
 * 役割：【初期データ投入】v0.5 少人数テスト用の固定カテゴリ・スレッド・返信例を投入
 * 方針：
 *   - 冪等（べきとう）設計：何回再実行してもカテゴリ・スレッドが重複せず、
 *     すでに入っている利用者の投稿を1件も消さない。
 *   - 「初期データ投入」と「DBリセット（削除）」は完全に別操作であり、削除処理は一切含まない。
 * =====================================================================
 */

const { createBoardDb, resolveProjectDbPath } = require('./db');

// ---------------------------------------------------------------------
// 1. v0.5 固定シードデータ定義（カテゴリ2つ × 各スレッド2つ）
// - ピン留め案内文（pinnedText）があるスレッドと null のスレッドの両方を用意し、
//   画面切替時に「案内枠の表示／非表示」が正しく切り替わることを確認できるようにする。
// ---------------------------------------------------------------------
const SEED_CATEGORIES = [
  {
    name: '雑談・交流',
    displayOrder: 1,
    threads: [
      {
        title: '総合雑談スレッド',
        isPinned: true,
        pinnedText:
          'ここは誰でも気軽に書き込める総合雑談スレッドです。\n誹謗中傷や個人情報の書き込みは控え、互いに配慮した交流をお願いします。',
        samplePosts: [
          {
            ref: 'p1',
            authorName: '管理案内',
            visitorId: 'admin-init',
            isPinned: true,
            content:
              'スレッドを開設しました！\nネタバレを含む話題は最初にひと言添えて、お互いを尊重しながら気軽にお話しください。',
          },
          {
            ref: 'p2',
            parentRef: 'p1',
            authorName: 'テスト参加者A',
            visitorId: 'sample0001',
            content: '返信ツリーのテストです。親投稿の下にインデントされて表示されます。',
          },
          {
            ref: 'p3',
            parentRef: 'p2',
            authorName: 'テスト参加者B',
            visitorId: 'sample0002',
            content: 'さらに返信（孫返信）を繋げた表示例です。',
          },
        ],
      },
      {
        title: '動作確認・フリートーク',
        isPinned: false,
        pinnedText: null, // ピン留め文なし（画面上で案内枠自体が非表示になることを確認する用）
        samplePosts: [
          {
            ref: 't2p1',
            authorName: '名無しさん',
            visitorId: 'sample0003',
            content: 'このスレッドにはピン留め案内文が設定されていません（案内枠が表示されないことを確認できます）。',
          },
        ],
      },
    ],
  },
  {
    name: '質問・検証',
    displayOrder: 2,
    threads: [
      {
        title: '初心者質問スレッド',
        isPinned: true,
        pinnedText:
          '質問する際は「どの場面で困っているか」「試したこと」を添えると回答がつきやすくなります。\n回答は該当の質問投稿の「返信」ボタンから繋げてください。',
        samplePosts: [
          {
            ref: 'q1',
            authorName: '質問者',
            visitorId: 'sample0010',
            isPinned: true,
            content: '文字サイズやカラーテーマの設定は、ブラウザを閉じても維持されますか？',
          },
          {
            ref: 'q2',
            parentRef: 'q1',
            authorName: '回答者',
            visitorId: 'sample0011',
            content: 'はい、ブラウザの localStorage に保存されるため、再読込みしても設定が維持されます。',
          },
        ],
      },
      {
        title: 'データ・仕様検証スレッド',
        isPinned: false,
        pinnedText: '検証結果や気づいた挙動を共有するスレッドです。',
        samplePosts: [
          {
            ref: 'v1',
            authorName: '検証班',
            visitorId: 'sample0020',
            content: 'スレッドを切り替えた際に、タイトル・ピン留め文・投稿ツリーが同時に切り替わるか確認してください。',
          },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------
// 2. 外部（テストコード等）からも呼び出せるシード実行関数
// ---------------------------------------------------------------------
function runSeed(db) {
  return db.seedInitialData(SEED_CATEGORIES);
}

// ---------------------------------------------------------------------
// 3. CLI直接実行時（npm run seed）のエントリポイント
// ---------------------------------------------------------------------
if (require.main === module) {
  const dbPath = resolveProjectDbPath(process.env.DB_PATH || './data/board.db');
  const db = createBoardDb({ dbPath });
  try {
    const status = db.getStatus();
    const result = runSeed(db);
    console.log(
      `[SEED] 完了 (DB: ${status.dbPath}, FK=${status.foreignKeys}, journal_mode=${status.journalMode})`
    );
    console.log(
      `[SEED] 新規追加件数 -> カテゴリ: ${result.createdCategories}, スレッド: ${result.createdThreads}, サンプル投稿: ${result.createdPosts}`
    );
  } finally {
    db.close();
  }
}

module.exports = {
  SEED_CATEGORIES,
  runSeed,
};
