'use strict';

/**
 * =====================================================================
 * test/auth.test.js
 * 役割：scryptパラメータ検証・同時実行キュー・トークン・__Host- Cookie・Origin設定の単体テスト
 * =====================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HTTPS_SESSION_COOKIE_NAME,
  DEV_SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  AuthQueueFullError,
  parseStoredPasswordHash,
  createScryptQueue,
  generateSessionToken,
  isValidSessionTokenFormat,
  hashSessionToken,
  isSecureRequest,
  parseSessionCookie,
  buildSetSessionCookieHeader,
  buildClearSessionCookieHeader,
  normalizeAllowedOrigin,
} = require('../src/auth');

test('parseStoredPasswordHash: 正常形式を受理し、範囲外・非2冪・異常長を安全に拒否する', () => {
  const valid = `scrypt$v1$16384$8$5$64$${'ab'.repeat(16)}$${'cd'.repeat(64)}`;
  const parsed = parseStoredPasswordHash(valid);
  assert.deepEqual(parsed, {
    version: 'v1',
    N: 16384,
    r: 8,
    p: 5,
    keylen: 64,
    saltHex: 'ab'.repeat(16),
    derivedHex: 'cd'.repeat(64),
  });

  const badHashes = [
    '',
    null,
    'plain_password',
    `scrypt$v2$16384$8$5$64$${'ab'.repeat(16)}$${'cd'.repeat(64)}`,
    `scrypt$v1$12345$8$5$64$${'ab'.repeat(16)}$${'cd'.repeat(64)}`, // Nが2の冪でない
    `scrypt$v1$131072$8$5$64$${'ab'.repeat(16)}$${'cd'.repeat(64)}`, // N > maxN
    `scrypt$v1$65536$16$1$64$${'ab'.repeat(16)}$${'cd'.repeat(64)}`, // 推定メモリ 128MiB > 64MiB
    `scrypt$v1$16384$8$99$64$${'ab'.repeat(16)}$${'cd'.repeat(64)}`, // p > maxP
    `scrypt$v1$16384$8$5$32$${'ab'.repeat(16)}$${'cd'.repeat(32)}`, // keylen != 64
    `scrypt$v1$16384$8$5$64$${'ab'.repeat(8)}$${'cd'.repeat(64)}`, // salt短すぎ
    `scrypt$v1$16384$8$5$64$${'zz'.repeat(16)}$${'cd'.repeat(64)}`, // hex以外
    `scrypt$v1$16384$8$5$64$${'ab'.repeat(16)}$${'cd'.repeat(63)}`, // derived長さ不正
  ];
  for (const sample of badHashes) {
    assert.equal(parseStoredPasswordHash(sample), null, `不正値 ${sample} は null で拒否されるべき`);
  }
});

test('createScryptQueue: 実scryptによるハッシュ生成・照合とダミー照合・破損ハッシュ拒否', async () => {
  const queue = createScryptQueue();
  const hash = await queue.hashPassword('correct-horse-battery-staple');
  assert.ok(parseStoredPasswordHash(hash) !== null);

  assert.equal(await queue.verifyPassword('correct-horse-battery-staple', hash), true);
  assert.equal(await queue.verifyPassword('wrong-password', hash), false);
  assert.equal(await queue.verifyPassword('any-password', 'corrupted-hash'), false);
  assert.equal(await queue.verifyDummyPassword('any-password'), false);
  assert.equal(queue.getStats().active, 0);
  assert.equal(queue.getStats().waiting, 0);
});

test('createScryptQueue: 同時実行数(1)と待ち行列上限(4)を超過した計算要求を503エラーで即拒否する', async () => {
  const gates = [];
  const queue = createScryptQueue({
    maxConcurrency: 1,
    maxQueue: 4,
    scryptFn: () =>
      new Promise((resolve) => {
        gates.push(() => resolve(Buffer.alloc(64, 1)));
      }),
  });

  // 1件目（実行中） + 4件（待機中） = 計5件まで受理
  const tasks = [];
  for (let i = 0; i < 5; i += 1) {
    tasks.push(queue.hashPassword(`passphrase-${i}`));
  }
  await Promise.resolve();
  assert.equal(queue.getStats().active, 1);
  assert.equal(queue.getStats().waiting, 4);

  // 6件目は計算へ入らず即 AuthQueueFullError (503) になること
  await assert.rejects(
    () => queue.hashPassword('overflow-pass'),
    (err) => err instanceof AuthQueueFullError && err.statusCode === 503
  );
  assert.equal(queue.getStats().totalRejectedFull, 1);

  // キューを順次解放して残りが完了すること
  while (tasks.some(() => gates.length > 0)) {
    const release = gates.shift();
    if (release) release();
    await new Promise((r) => setTimeout(r, 5));
  }
  const results = await Promise.all(tasks);
  assert.equal(results.length, 5);
  assert.equal(queue.getStats().active, 0);
  assert.equal(queue.getStats().waiting, 0);
});

test('トークン・Cookie生成/パース・isSecureRequest・normalizeAllowedOrigin', () => {
  const token = generateSessionToken();
  assert.equal(token.length, 43);
  assert.equal(isValidSessionTokenFormat(token), true);
  assert.equal(isValidSessionTokenFormat('short'), false);
  assert.equal(hashSessionToken(token).length, 64);

  // HTTPSデフォルト時は __Host- プレフィックス＋Secure＋Domainなし
  const setHttps = buildSetSessionCookieHeader(token, { devInsecureCookie: false });
  assert.ok(setHttps.startsWith(`${HTTPS_SESSION_COOKIE_NAME}=${token};`));
  assert.ok(setHttps.includes('Path=/'));
  assert.ok(setHttps.includes('HttpOnly'));
  assert.ok(setHttps.includes('SameSite=Lax'));
  assert.ok(setHttps.includes('Secure'));
  assert.ok(setHttps.includes(`Max-Age=${SESSION_TTL_SECONDS}`));
  assert.equal(/domain=/i.test(setHttps), false);

  const clearHttps = buildClearSessionCookieHeader({ devInsecureCookie: false });
  assert.ok(clearHttps.startsWith(`${HTTPS_SESSION_COOKIE_NAME}=;`));
  assert.ok(clearHttps.includes('Path=/'));
  assert.ok(clearHttps.includes('Max-Age=0'));
  assert.ok(clearHttps.includes('Secure'));

  // 明示的開発モードでは別名Cookie（Secureなし）
  const setDev = buildSetSessionCookieHeader(token, { devInsecureCookie: true });
  assert.ok(setDev.startsWith(`${DEV_SESSION_COOKIE_NAME}=${token};`));
  assert.equal(setDev.includes('Secure'), false);

  // Cookieパース（正常・重複・形式不正・未設定）
  assert.deepEqual(parseSessionCookie({ headers: {} }), {
    present: false,
    token: null,
    invalid: false,
  });
  assert.deepEqual(
    parseSessionCookie({ headers: { cookie: `${HTTPS_SESSION_COOKIE_NAME}=${token}; other=1` } }),
    { present: true, token, invalid: false }
  );
  assert.deepEqual(
    parseSessionCookie({
      headers: { cookie: `${HTTPS_SESSION_COOKIE_NAME}=${token}; ${HTTPS_SESSION_COOKIE_NAME}=${token}` },
    }),
    { present: true, token: null, invalid: true }
  );
  assert.deepEqual(
    parseSessionCookie({ headers: { cookie: `${HTTPS_SESSION_COOKIE_NAME}=invalid_short` } }),
    { present: true, token: null, invalid: true }
  );

  // X-Forwarded-Proto 偽装防御
  assert.equal(
    isSecureRequest(
      { socket: { remoteAddress: '203.0.113.5' }, headers: { 'x-forwarded-proto': 'https' } },
      { trustProxy: true }
    ),
    false
  );
  assert.equal(
    isSecureRequest(
      { socket: { remoteAddress: '::1' }, headers: { 'x-forwarded-proto': 'https, http' } },
      { trustProxy: true }
    ),
    true
  );
  assert.equal(
    isSecureRequest(
      { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'https' } },
      { trustProxy: false }
    ),
    false
  );

  // ALLOWED_ORIGIN 検証
  assert.equal(normalizeAllowedOrigin('https://koo-hi.com'), 'https://koo-hi.com');
  assert.equal(normalizeAllowedOrigin(''), null);
  assert.throws(() => normalizeAllowedOrigin('https://koo-hi.com/board/'));
  assert.throws(() => normalizeAllowedOrigin('ftp://koo-hi.com'));
});
