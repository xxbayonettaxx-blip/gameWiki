'use strict';

/**
 * =====================================================================
 * test/validators.test.js
 * 役割：入力値検証（型強制防止・空白除去・文字数境界）と日替わりID計算の単体テスト
 * 実行：node --test test/validators.test.js
 * =====================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ValidationError,
  parsePositiveInt,
  validatePostInput,
  validateIdSecret,
  getJstDateString,
  generateVisitorId,
  extractClientIp,
} = require('../src/validators');

const TEST_SECRET = '0123456789abcdef0123456789abcdef';

test('parsePositiveInt: 正の整数のみ許可し、null・空文字・真偽値・0・小数を拒否する (T-02)', () => {
  assert.equal(parsePositiveInt(1), 1);
  assert.equal(parsePositiveInt('25'), 25);

  const invalidSamples = [0, -1, 1.5, NaN, Infinity, null, undefined, '', ' ', '0', '-3', '12a', true, false, [], {}];
  for (const bad of invalidSamples) {
    assert.throws(
      () => parsePositiveInt(bad, 'テストID'),
      (err) => err instanceof ValidationError && err.statusCode === 400,
      `値 ${JSON.stringify(bad)} が拒否されるべき`
    );
  }
});

test('validatePostInput: 正常な投稿と返信を受理し、空の表示名は「名無しさん」へ補完する', () => {
  const rootPost = validatePostInput({
    thread_id: 1,
    parent_id: null,
    author_name: '   　 ',
    content: 'こんにちは！\r\nテスト投稿です。  ',
  });
  assert.deepEqual(rootPost, {
    threadId: 1,
    parentId: null,
    authorName: '名無しさん',
    content: 'こんにちは！\nテスト投稿です。',
  });

  const replyPost = validatePostInput({
    thread_id: '2',
    parent_id: '10',
    author_name: '検証ユーザー',
    content: '返信テスト',
  });
  assert.deepEqual(replyPost, {
    threadId: 2,
    parentId: 10,
    authorName: '検証ユーザー',
    content: '返信テスト',
  });
});

test('validatePostInput: 半角空白・全角空白・改行・タブ・ゼロ幅空白のみの本文をすべて拒否する (T-09)', () => {
  const blankContents = [
    '',
    '    ',
    '\u3000\u3000',
    ' \u3000\t\r\n ',
    '\u200B\uFEFF',
  ];

  for (const content of blankContents) {
    assert.throws(
      () => validatePostInput({ thread_id: 1, content }),
      (err) => err instanceof ValidationError && err.statusCode === 400
    );
  }
});

test('validatePostInput: 文字数上限（名前30文字・本文2000文字）および制御文字を検査する', () => {
  // 境界値ちょうど（30文字・2000文字）は通過
  const exact = validatePostInput({
    thread_id: 1,
    author_name: 'あ'.repeat(30),
    content: 'い'.repeat(2000),
  });
  assert.equal(exact.authorName.length, 30);
  assert.equal(exact.content.length, 2000);

  // 31文字の名前は拒否
  assert.throws(
    () => validatePostInput({ thread_id: 1, author_name: 'あ'.repeat(31), content: 'ok' }),
    ValidationError
  );

  // 2001文字の本文は拒否
  assert.throws(
    () => validatePostInput({ thread_id: 1, content: 'い'.repeat(2001) }),
    ValidationError
  );

  // NULL文字混入は拒否
  assert.throws(
    () => validatePostInput({ thread_id: 1, content: '不正\x00文字' }),
    ValidationError
  );
});

test('generateVisitorId: 日本時間(JST) 00:00 を境にIDが切り替わること (T-06)', () => {
  // UTC 14:59:59 = JST 23:59:59 (11月5日)
  const beforeMidnightJst = new Date('2026-11-05T14:59:59Z');
  // UTC 15:00:00 = JST 00:00:00 (11月6日)
  const afterMidnightJst = new Date('2026-11-05T15:00:00Z');

  assert.equal(getJstDateString(beforeMidnightJst), '2026-11-05');
  assert.equal(getJstDateString(afterMidnightJst), '2026-11-06');

  const idDay1A = generateVisitorId({ ip: '203.0.113.10', secret: TEST_SECRET, now: beforeMidnightJst });
  const idDay1B = generateVisitorId({ ip: '::ffff:203.0.113.10', secret: TEST_SECRET, now: beforeMidnightJst });
  const idDay2 = generateVisitorId({ ip: '203.0.113.10', secret: TEST_SECRET, now: afterMidnightJst });

  assert.equal(idDay1A.length, 10);
  assert.equal(idDay1A, idDay1B, 'IPv4射影アドレス表記揺れでも同日同IPなら同じIDになること');
  assert.notEqual(idDay1A, idDay2, 'JST 00:00 を跨ぐと別のIDに変わること');
});

test('validateIdSecret & extractClientIp: 見本秘密鍵の拒否と転送ヘッダー偽装防止', () => {
  assert.throws(() => validateIdSecret(''));
  assert.throws(() => validateIdSecret('short'));
  assert.throws(() => validateIdSecret('CHANGE_ME_TO_RANDOM_SECRET_AT_LEAST_32_CHARS'));

  // trustProxy=false のときは偽装 X-Forwarded-For を無視する
  const spoofReq = {
    socket: { remoteAddress: '198.51.100.5' },
    headers: { 'x-forwarded-for': '1.2.3.4' },
  };
  assert.equal(extractClientIp(spoofReq, { trustProxy: false }), '198.51.100.5');
  assert.equal(extractClientIp(spoofReq, { trustProxy: true }), '198.51.100.5');

  // ローカルプロキシ(127.0.0.1)経由かつ trustProxy=true のときのみ転送IPを採用する
  const proxyReq = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-real-ip': '203.0.113.99' },
  };
  assert.equal(extractClientIp(proxyReq, { trustProxy: true }), '203.0.113.99');
});
