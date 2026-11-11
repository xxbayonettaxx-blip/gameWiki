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
// 1. v0.5 固定シードデータ定義（カテゴリ3つ × 各スレッド指定）
//   - 雑談: 雑談 / 質問、初心者質問 / あいさつ・自己紹介
//   - 攻略: 育成 / 塵煙前線 / 開拓征途 / 他
//   - イベント: 今期のイベント / 時期イベント / 先行サーバー情報
// ---------------------------------------------------------------------
const SEED_CATEGORIES = [
  {
    name: '雑談',
    displayOrder: 1,
    threads: [
      {
        title: '雑談',
        isPinned: true,
        pinnedText:
          'ここは誰でも気軽に書き込める雑談スレッドです。\n誹謗中傷や個人情報の書き込みは控え、互いに配慮した交流をお願いします。',
        samplePosts: [
          {
            ref: 'p1',
            authorName: '管理案内',
            visitorId: 'admin-init',
            isPinned: true,
            content:
              '雑談スレッドを開設しました！\nネタバレを含む話題は最初にひと言添えて、お互いを尊重しながら気軽にお話しください。',
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
        title: '質問、初心者質問',
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
        title: 'あいさつ・自己紹介',
        isPinned: false,
        pinnedText: null,
        samplePosts: [
          {
            ref: 'g1',
            authorName: '名無しさん',
            visitorId: 'sample0003',
            content: '新しく参加された方はこちらで一言どうぞ！',
          },
        ],
      },
    ],
  },
  {
    name: '攻略',
    displayOrder: 2,
    threads: [
      {
        title: '育成',
        isPinned: true,
        pinnedText: 'キャラクターや装備の育成・強化に関する情報共有スレッドです。',
        samplePosts: [],
      },
      {
        title: '塵煙前線',
        isPinned: true,
        pinnedText: '塵煙前線の攻略・編成相談スレッドです。',
        samplePosts: [],
      },
      {
        title: '開拓征途',
        isPinned: true,
        pinnedText: '開拓征途の攻略・マップ情報共有スレッドです。',
        samplePosts: [],
      },
      {
        title: '他',
        isPinned: false,
        pinnedText: null,
        samplePosts: [],
      },
    ],
  },
  {
    name: 'イベント',
    displayOrder: 3,
    threads: [
      {
        title: '今期のイベント',
        isPinned: true,
        pinnedText: '現在開催中の最新イベントに関する攻略・情報交換スレッドです。',
        samplePosts: [],
      },
      {
        title: '時期イベント',
        isPinned: false,
        pinnedText: null,
        samplePosts: [],
      },
      {
        title: '先行サーバー情報',
        isPinned: false,
        pinnedText: '先行サーバー（CN/海外版等）の情報や先行実装要素に関するスレッドです。ネタバレに配慮してご活用ください。',
        samplePosts: [],
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
