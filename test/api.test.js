'use strict';

/**
 * =====================================================================
 * test/api.test.js
 * 役割：HTTP経由での保存・拒否・論理削除マスク・容量上限・CSRF防御・非公開ファイル遮断の統合テスト
 * 方針：空きポート(0)＋メモリ内DBで起動し、開発中のポート3001や実DBに一切影響を与えない。
 * =====================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBoardDb } = require('../src/db');
const { runSeed } = require('../src/seed');
const { createApp } = require('../src/app');
const {
  createScryptQueue,
  generateSessionToken,
  hashSessionToken,
  HTTPS_SESSION_COOKIE_NAME,
  DEV_SESSION_COOKIE_NAME,
} = require('../src/auth');

const TEST_ID_SECRET = 'test_secret_key_for_api_suite_32chars!';

function makeFastScryptFn() {
  const crypto = require('node:crypto');
  return async (password, salt, keylen) =>
    crypto.createHmac('sha256', salt).update(String(password)).digest().subarray(0, keylen).length === keylen
      ? crypto.createHmac('sha256', salt).update(String(password)).digest()
      : Buffer.concat([
          crypto.createHmac('sha256', salt).update(String(password)).digest(),
          crypto.createHmac('sha256', salt).update(`ext:${password}`).digest(),
        ]);
}

function extractSetCookiePair(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  const firstPart = raw.split(';')[0];
  return firstPart;
}

async function startTestServer(customOptions = {}) {
  const db = createBoardDb({ dbPath: ':memory:', ...customOptions.dbOptions });
  runSeed(db);
  const devInsecureCookie = customOptions.devInsecureCookie ?? false;

  const server = createApp({
    db,
    idSecret: TEST_ID_SECRET,
    trustProxy: customOptions.trustProxy ?? false,
    allowedOrigin: customOptions.allowedOrigin ?? null,
    allowSignup: customOptions.allowSignup ?? true,
    devInsecureCookie,
    maxBodyBytes: customOptions.maxBodyBytes ?? 4096,
    authMaxBodyBytes: customOptions.authMaxBodyBytes ?? 4096,
    rateLimitMaxPosts: customOptions.rateLimitMaxPosts ?? 30,
    authRateLimitMaxPerIp: customOptions.authRateLimitMaxPerIp ?? 50,
    authRateLimitMaxPerAccount: customOptions.authRateLimitMaxPerAccount ?? 50,
    scryptQueue: customOptions.scryptQueue ?? null,
    scryptOptions: customOptions.scryptOptions ?? {},
    ...(customOptions.sessionTtlSeconds !== undefined
      ? { sessionTtlSeconds: customOptions.sessionTtlSeconds }
      : {}),
    nowFn: customOptions.nowFn ?? (() => new Date()),
    publicDir: customOptions.publicDir,
    quiet: true,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const cookieName = devInsecureCookie ? DEV_SESSION_COOKIE_NAME : HTTPS_SESSION_COOKIE_NAME;

  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }

  return { db, server, baseUrl, cookieName, stop };
}

function createDirectUserSessionCookie(ctx, { username, role = 'user', mustChangePassword = false }) {
  const rawToken = generateSessionToken();
  const tokenHash = hashSessionToken(rawToken);
  const nowIso = new Date().toISOString();
  const expiresAt = '2099-01-01T00:00:00.000Z';
  const user = ctx.db.createUserWithSession({
    username,
    passwordHash: `scrypt$v1$16384$8$5$64$${'11'.repeat(16)}$${'22'.repeat(64)}`,
    role,
    tokenHash,
    expiresAt,
    nowIso,
    mustChangePassword,
  });
  return { user, cookie: `${ctx.cookieName}=${rawToken}`, rawToken, tokenHash };
}

test('HTTP統合: スレッド一覧・切替・投稿・返信・XSS文字列の無害保持・論理削除マスク (T-01, T-07, T-11, T-12)', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.stop());

  // 1. カテゴリとスレッド一覧の取得
  const catRes = await fetch(`${ctx.baseUrl}/api/categories`);
  assert.equal(catRes.status, 200);
  const { categories } = await catRes.json();
  assert.equal(categories.length, 3);

  const threadWithPin = categories[0].threads[0];
  const threadWithoutPin = categories[0].threads[2];

  // 2. スレッド切替時のタイトル・ピン留め文同期確認
  const t1Res = await fetch(`${ctx.baseUrl}/api/threads/${threadWithPin.id}`);
  const t1Data = await t1Res.json();
  assert.equal(t1Data.thread.title, '雑談');
  assert.ok(t1Data.thread.pinned_text.includes('雑談スレッド'));

  const t2Res = await fetch(`${ctx.baseUrl}/api/threads/${threadWithoutPin.id}`);
  const t2Data = await t2Res.json();
  assert.equal(t2Data.thread.title, 'あいさつ・自己紹介');
  assert.equal(t2Data.thread.pinned_text, null);

  // 3. XSS攻撃文字列を含む親投稿と、それに対する子返信の登録
  const xssPayload = '<script>alert("XSS")</script><img src=x onerror=alert(1)>';
  const postRes = await fetch(`${ctx.baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      thread_id: threadWithPin.id,
      parent_id: null,
      author_name: '<b>太字テスト</b>',
      content: `削除予定の秘密本文 ${xssPayload}`,
    }),
  });
  assert.equal(postRes.status, 201);
  assert.ok(postRes.headers.get('content-security-policy')?.includes("script-src 'self'"));
  const { post: createdParent } = await postRes.json();
  assert.ok(createdParent.content.includes(xssPayload));

  const replyRes = await fetch(`${ctx.baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      thread_id: threadWithPin.id,
      parent_id: createdParent.id,
      author_name: '',
      content: '親が消えても読める子返信です',
    }),
  });
  assert.equal(replyRes.status, 201);
  const { post: createdChild } = await replyRes.json();
  assert.equal(createdChild.author_name, '名無しさん');
  assert.equal(createdChild.parent_id, createdParent.id);

  // 4. 未認証・旧Bearer認証での管理削除API直叩きは 401 で拒絶されること (T-07 / v1.1 Bearer廃止)
  const unauthDel = await fetch(`${ctx.baseUrl}/api/admin/posts/${createdParent.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.baseUrl },
    body: '{}',
  });
  assert.equal(unauthDel.status, 401);

  const legacyBearerDel = await fetch(`${ctx.baseUrl}/api/admin/posts/${createdParent.id}/delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ctx.baseUrl,
      Authorization: 'Bearer legacy_admin_token_should_not_work_32c',
    },
    body: '{}',
  });
  assert.equal(legacyBearerDel.status, 401);

  // 5. 管理者セッションでの論理削除後はAPIのJSONから元本文が消え、子返信は残ること (T-11)
  const { cookie: adminCookie } = createDirectUserSessionCookie(ctx, {
    username: 'test_admin_del',
    role: 'admin',
  });
  const authDel = await fetch(`${ctx.baseUrl}/api/admin/posts/${createdParent.id}/delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ctx.baseUrl,
      Cookie: adminCookie,
    },
    body: '{}',
  });
  assert.equal(authDel.status, 200);

  const afterDelRes = await fetch(`${ctx.baseUrl}/api/threads/${threadWithPin.id}`);
  const rawJsonText = await afterDelRes.text();
  assert.equal(rawJsonText.includes('削除予定の秘密本文'), false, 'JSON通信上に削除前の本文が漏洩しないこと');

  const afterDelData = JSON.parse(rawJsonText);
  const maskedParent = afterDelData.posts.find((p) => p.id === createdParent.id);
  const intactChild = afterDelData.posts.find((p) => p.id === createdChild.id);
  assert.equal(maskedParent.is_deleted, 1);
  assert.equal(intactChild.content, '親が消えても読める子返信です');
});

test('HTTP異常系: 不正入力・壊れたJSON・別スレ返信・容量超過・CSRFヘッダー違反ですべてDB不変かつサーバー稼働継続 (T-02, T-03, T-08, T-10, T-15)', async (t) => {
  const ctx = await startTestServer({ maxBodyBytes: 512, rateLimitMaxPosts: 5 });
  t.after(() => ctx.stop());

  const beforePosts = (await (await fetch(`${ctx.baseUrl}/api/threads/2`)).json()).posts.length;

  // GET での更新試行 -> 405
  const getPostRes = await fetch(`${ctx.baseUrl}/api/posts`);
  assert.equal(getPostRes.status, 405);

  // Content-Type 違反（フォーム単純リクエスト相当） -> 415
  const wrongCtRes = await fetch(`${ctx.baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{"thread_id":2,"content":"hello"}',
  });
  assert.equal(wrongCtRes.status, 415);

  // 別 Origin からの要求 -> 403
  const crossOriginRes = await fetch(`${ctx.baseUrl}/api/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://attacker.example.com',
    },
    body: '{"thread_id":2,"content":"csrf"}',
  });
  assert.equal(crossOriginRes.status, 403);

  // 壊れたJSONボディ -> 400（プロセスが落ちないこと）
  const badJsonRes = await fetch(`${ctx.baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"thread_id": 2, broken_json',
  });
  assert.equal(badJsonRes.status, 400);

  // 物理バイト上限超過（512バイト超） -> 413 Payload Too Large
  const hugeRes = await fetch(`${ctx.baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: 2, content: 'あ'.repeat(300) }),
  });
  assert.equal(hugeRes.status, 413);

  // 別スレッド(スレ1の投稿#1)を親にしたスレ2への返信 -> 400
  const crossThreadRes = await fetch(`${ctx.baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: 2, parent_id: 1, content: '別スレ返信' }),
  });
  assert.equal(crossThreadRes.status, 400);

  // 失敗したすべての操作の後も DB 行数が 1ミリも変わっておらず、サーバーが正常応答すること
  const afterPosts = (await (await fetch(`${ctx.baseUrl}/api/threads/2`)).json()).posts.length;
  assert.equal(afterPosts, beforePosts);
});

test('静的配信と公開境界: 非公開ファイル・パストラバーサル遮断とフロントコードの innerHTML 不使用確認 (T-01, T-13)', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.stop());

  // 公開ファイルは正常取得できること
  const indexRes = await fetch(`${ctx.baseUrl}/`);
  assert.equal(indexRes.status, 200);
  const html = await indexRes.text();
  assert.ok(html.includes('COMMUNITY BOARD'));
  assert.equal(html.includes('SANDBOX:'), false, '本番 public/ に SANDBOX 表記が残っていないこと');

  const cssRes = await fetch(`${ctx.baseUrl}/style.css`);
  assert.equal(cssRes.status, 200);
  const jsRes = await fetch(`${ctx.baseUrl}/app.js`);
  assert.equal(jsRes.status, 200);

  // サブパス `/board/` 配備時のルーティング・リダイレクト検証
  const boardNoSlash = await fetch(`${ctx.baseUrl}/board`, { redirect: 'manual' });
  assert.equal(boardNoSlash.status, 301);
  assert.equal(boardNoSlash.headers.get('location'), '/board/');

  const boardIndexRes = await fetch(`${ctx.baseUrl}/board/`);
  assert.equal(boardIndexRes.status, 200);
  const boardCssRes = await fetch(`${ctx.baseUrl}/board/style.css`);
  assert.equal(boardCssRes.status, 200);
  const boardApiRes = await fetch(`${ctx.baseUrl}/board/api/categories`);
  assert.equal(boardApiRes.status, 200);

  // フロントJS内に危険な innerHTML 代入および button/html 属性名衝突が存在しないことを静的検査
  const appJsPath = path.join(__dirname, '..', 'public', 'app.js');
  const appJsSource = fs.readFileSync(appJsPath, 'utf8');
  assert.equal(/\.innerHTML\s*=/.test(appJsSource), false, 'app.js 内で innerHTML 代入を使用しないこと');
  const adminJsPath = path.join(__dirname, '..', 'public', 'admin.js');
  const adminJsSource = fs.readFileSync(adminJsPath, 'utf8');
  assert.equal(/\.innerHTML\s*=/.test(adminJsSource), false, 'admin.js 内で innerHTML 代入を使用しないこと');
  const adminHtmlRes = await fetch(`${ctx.baseUrl}/admin.html`);
  assert.equal(adminHtmlRes.status, 200);
  assert.equal(adminHtmlRes.headers.get('cache-control'), 'no-store');
  const adminJsRes = await fetch(`${ctx.baseUrl}/admin.js`);
  assert.equal(adminJsRes.status, 200);
  assert.equal(adminJsRes.headers.get('cache-control'), 'no-store');
  const adminCssRes = await fetch(`${ctx.baseUrl}/admin.css`);
  assert.equal(adminCssRes.status, 200);
  assert.equal(adminCssRes.headers.get('cache-control'), 'no-store');
  assert.equal(
    appJsSource.includes("querySelectorAll('[data-font]')"),
    false,
    'html[data-font] と衝突する未限定セレクタを使用しないこと'
  );
  assert.equal(
    appJsSource.includes('shouldKeepTriggerFocus'),
    true,
    '通信待ち中に開いた設定パネル等からフォーカスを奪わない保護関数が存在すること (F4再検証対策)'
  );

  // 非公開ファイル・親ディレクトリ参照の直接要求がすべて 403 または 404 で遮断されること
  const forbiddenPaths = [
    '/.env',
    '/.env.example',
    '/data/board.db',
    '/src/schema.sql',
    '/server.js',
    '/package.json',
    '/../package.json',
    '/%2e%2e/package.json',
    '/..%5c.env',
    '/%2e%2e%5c.env',
  ];

  for (const target of forbiddenPaths) {
    const res = await fetch(`${ctx.baseUrl}${target}`);
    assert.ok(
      res.status === 403 || res.status === 404,
      `パス ${target} は 403/404 で拒否されるべき (実際: ${res.status})`
    );
    const body = await res.text();
    assert.equal(body.includes('ID_SECRET'), false);
    assert.equal(body.includes('CREATE TABLE'), false);
  }
});

test('デザイン実験モード (publicDir 切替): 別フォルダのフロントを配信しつつ実API接続と境界防御を維持できること', async (t) => {
  const tmpSandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-board-sandbox-'));
  t.after(() => fs.rmSync(tmpSandboxDir, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(tmpSandboxDir, 'index.html'),
    '<!doctype html><title>SANDBOX_UI_VARIANT_TEST</title>',
    'utf8'
  );

  const ctx = await startTestServer({ publicDir: tmpSandboxDir });
  t.after(() => ctx.stop());

  const rootRes = await fetch(`${ctx.baseUrl}/`);
  assert.equal(rootRes.status, 200);
  assert.ok((await rootRes.text()).includes('SANDBOX_UI_VARIANT_TEST'));

  const apiRes = await fetch(`${ctx.baseUrl}/api/categories`);
  assert.equal(apiRes.status, 200);

  const traversalRes = await fetch(`${ctx.baseUrl}/../package.json`);
  assert.ok(traversalRes.status === 403 || traversalRes.status === 404);
});

test('管理ピン留めAPIとデザイン実験2案（sample-base / slide-drawer）の静的・HTTP検証', async (t) => {
  // 1. 実験用案すべての app.js にも危険な innerHTML 代入が一切存在しないことを検査
  const variantNames = ['initial-v0.5', 'sample-base', 'slide-drawer', 'compact-top-sheet'];
  for (const name of variantNames) {
    const variantJsPath = path.join(__dirname, '..', 'ui-sandbox', name, 'app.js');
    if (fs.existsSync(variantJsPath)) {
      const src = fs.readFileSync(variantJsPath, 'utf8');
      assert.equal(
        /\.innerHTML\s*=/.test(src),
        false,
        `ui-sandbox/${name}/app.js 内で innerHTML 代入を使用しないこと`
      );
    }
  }

  // 2. 管理ピン留めAPIの認証・型検証・ON/OFF反映を確認
  const slideDrawerDir = path.join(__dirname, '..', 'ui-sandbox', 'slide-drawer');
  const ctx = await startTestServer({
    publicDir: fs.existsSync(slideDrawerDir) ? slideDrawerDir : undefined,
  });
  t.after(() => ctx.stop());

  // 新規投稿を1件作成（既定では is_pinned = 0）
  const createRes = await fetch(`${ctx.baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      thread_id: 2,
      parent_id: null,
      author_name: 'ピン検証者',
      content: '後からピン留めされる通常投稿です',
    }),
  });
  assert.equal(createRes.status, 201);
  const { post } = await createRes.json();
  assert.equal(post.is_pinned, 0);

  // 未認証でのピン留め要求は 401（旧Bearerでも401）
  const unauthPin = await fetch(`${ctx.baseUrl}/api/admin/posts/${post.id}/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.baseUrl },
    body: JSON.stringify({ pinned: true }),
  });
  assert.equal(unauthPin.status, 401);

  const { cookie: adminPinCookie } = createDirectUserSessionCookie(ctx, {
    username: 'test_admin_pin',
    role: 'admin',
  });

  // 不正な型（文字列 "false" 等）は 400 で拒否
  const badTypePin = await fetch(`${ctx.baseUrl}/api/admin/posts/${post.id}/pin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ctx.baseUrl,
      Cookie: adminPinCookie,
    },
    body: JSON.stringify({ pinned: 'false' }),
  });
  assert.equal(badTypePin.status, 400);

  // 管理者セッションでピン留め ON -> GET /api/threads/2 で is_pinned === 1 になること
  const pinOn = await fetch(`${ctx.baseUrl}/api/admin/posts/${post.id}/pin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ctx.baseUrl,
      Cookie: adminPinCookie,
    },
    body: JSON.stringify({ pinned: true }),
  });
  assert.equal(pinOn.status, 200);

  const afterPinThread = await (await fetch(`${ctx.baseUrl}/api/threads/2`)).json();
  assert.equal(afterPinThread.posts.find((p) => p.id === post.id).is_pinned, 1);

  // 管理者セッションでピン留め OFF -> is_pinned === 0 に戻ること
  const pinOff = await fetch(`${ctx.baseUrl}/api/admin/posts/${post.id}/pin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ctx.baseUrl,
      Cookie: adminPinCookie,
    },
    body: JSON.stringify({ pinned: false }),
  });
  assert.equal(pinOff.status, 200);

  const afterUnpinThread = await (await fetch(`${ctx.baseUrl}/api/threads/2`)).json();
  assert.equal(afterUnpinThread.posts.find((p) => p.id === post.id).is_pinned, 0);
});

test('F3・F5・F6回帰検証: ジャンクション脱出遮断・送信途中の早期413応答・sandbox引数制限', async (t) => {
  const http = require('node:http');
  const { spawnSync } = require('node:child_process');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-board-f3f5-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const pubDir = path.join(tmpRoot, 'public');
  const outsideDir = path.join(tmpRoot, 'outside');
  fs.mkdirSync(pubDir);
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(pubDir, 'index.html'), '<!doctype html><title>OK</title>', 'utf8');
  fs.writeFileSync(
    path.join(outsideDir, 'secret.json'),
    JSON.stringify({ marker: 'OUTSIDE_SECRET_MARKER' }),
    'utf8'
  );

  // 1. F3: public 内に外部フォルダへのジャンクションがあっても realpath 検査で 403/404 遮断されること
  fs.symlinkSync(outsideDir, path.join(pubDir, 'linked'), 'junction');

  const ctx = await startTestServer({ publicDir: pubDir, maxBodyBytes: 64 });
  t.after(() => ctx.stop());

  const juncRes = await fetch(`${ctx.baseUrl}/linked/secret.json`);
  assert.ok(juncRes.status === 403 || juncRes.status === 404);
  const juncText = await juncRes.text();
  assert.equal(juncText.includes('OUTSIDE_SECRET_MARKER'), false);

  // 2. F5: ボディ上限超過時、クライアントが end() を送る前に早期 413 を返すこと
  const earlyResult = await new Promise((resolve, reject) => {
    let requestEnded = false;
    let responseBeforeEnd = false;
    let timer = null;
    const req = http.request(
      `${ctx.baseUrl}/api/posts`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        responseBeforeEnd = !requestEnded;
        res.resume();
        res.on('end', () => {
          clearTimeout(timer);
          req.destroy();
          resolve({ responseBeforeEnd, status: res.statusCode });
        });
      }
    );
    req.on('error', (err) => {
      if (!responseBeforeEnd) reject(err);
    });
    req.write('x'.repeat(128));
    timer = setTimeout(() => {
      requestEnded = true;
      req.end();
    }, 200);
  });
  assert.equal(earlyResult.responseBeforeEnd, true, '送信完了(end)を待たずに413応答が返ること');
  assert.equal(earlyResult.status, 413);

  // 早期413の後もサーバーが健全に応答すること
  const healthRes = await fetch(`${ctx.baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);

  // 3. F6: sandbox.js に '..' を渡した際に起動拒否（終了コード 1）されること
  const sbProc = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'src', 'sandbox.js'), '..'],
    { encoding: 'utf8' }
  );
  assert.equal(sbProc.status, 1);

  // 4. moderate.js CLI: カテゴリ追加・変更、スレッド追加・変更、一覧表示が正常動作すること
  const cliDbPath = path.join(tmpRoot, 'cli-test.db');
  const modScript = path.join(__dirname, '..', 'src', 'moderate.js');
  const runMod = (cliArgs) =>
    spawnSync(process.execPath, [modScript, ...cliArgs], {
      encoding: 'utf8',
      env: { ...process.env, DB_PATH: cliDbPath },
    });

  const addCatOut = runMod(['add-category', 'CLI追加カテゴリ']);
  assert.equal(addCatOut.status, 0);
  assert.ok(addCatOut.stdout.includes('CLI追加カテゴリ'));

  const renCatOut = runMod(['rename-category', '1', 'CLI変更後カテゴリ', '3']);
  assert.equal(renCatOut.status, 0);
  assert.ok(renCatOut.stdout.includes('CLI変更後カテゴリ'));

  const addThOut = runMod(['add-thread', '1', 'CLI追加スレッド', '案内テスト']);
  assert.equal(addThOut.status, 0);
  assert.ok(addThOut.stdout.includes('CLI追加スレッド'));

  const renThOut = runMod(['rename-thread', '1', 'CLI変更後スレッド']);
  assert.equal(renThOut.status, 0);
  assert.ok(renThOut.stdout.includes('CLI変更後スレッド'));

  const listOut = runMod(['list']);
  assert.equal(listOut.status, 0);
  assert.ok(listOut.stdout.includes('CLI変更後カテゴリ'));
  assert.ok(listOut.stdout.includes('CLI変更後スレッド'));

  // 不正ID (12abc) の指定は parsePositiveInt により確実に拒否されること (Codex P1 回帰テスト)
  const invalidIdOut = runMod(['purge-tree', '12abc']);
  assert.equal(invalidIdOut.status, 1);
  assert.ok(invalidIdOut.stderr.includes('投稿ID'));

  // 物理削除対象の投稿を1件作成（スレッド案内文は posts へ自動複製されない仕様のため明示投入）
  const cliPostDb = createBoardDb({ dbPath: cliDbPath });
  try {
    cliPostDb.createPost({
      threadId: 1,
      authorName: 'CLI検証投稿者',
      visitorId: 'cli0001',
      content: 'purge-tree検証用の親投稿',
    });
  } finally {
    cliPostDb.close();
  }

  // 物理削除プレビュー (Dry-Run): --force なしではDB変更されずプレビュー情報が出力されること
  const dryRunOut = runMod(['purge-tree', '1']);
  assert.equal(dryRunOut.status, 0);
  assert.ok(dryRunOut.stdout.includes('Dry-Run'));

  // 物理削除実行 (--force): 投稿ツリーが完全削除されること
  const forceTreeOut = runMod(['purge-tree', '1', '--force']);
  assert.equal(forceTreeOut.status, 0);
  assert.ok(forceTreeOut.stdout.includes('SUCCESS'));

  // スレッド物理削除実行 (--force): スレッドと配下投稿が完全削除されること
  const forceThreadOut = runMod(['purge-thread', '1', '--force']);
  assert.equal(forceThreadOut.status, 0);
  assert.ok(forceThreadOut.stdout.includes('SUCCESS'));
});

test('認証フロー統合（実scrypt）: 登録・重複409・改ざん無視・会員投稿バッジ・/と/board/両立・2端末独立logout', async (t) => {
  // 本テストは実際の node:crypto scrypt をそのまま使用する
  const ctx = await startTestServer({ devInsecureCookie: true });
  t.after(() => ctx.stop());
  const origin = ctx.baseUrl;

  // 1. role='admin' や created_by 改ざんを送っても常に 'user' として登録されること
  const regRes = await fetch(`${ctx.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({
      username: 'テスト太郎',
      password: 'strong-passphrase-1234',
      role: 'admin',
      created_by: 999,
    }),
  });
  assert.equal(regRes.status, 201);
  const regCookie = extractSetCookiePair(regRes);
  assert.ok(regCookie.startsWith(`${DEV_SESSION_COOKIE_NAME}=`));
  const regData = await regRes.json();
  assert.deepEqual(regData.user, {
    id: 1,
    username: 'テスト太郎',
    role: 'user',
    mustChangePassword: false,
  });

  // 2. 重複ユーザー名は 409 Conflict
  const dupRes = await fetch(`${ctx.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'テスト太郎', password: 'another-password-1234' }),
  });
  assert.equal(dupRes.status, 409);

  // 3. '/' と '/board/' 両方で /api/auth/me および会員投稿が一致動作すること
  const meBoardRes = await fetch(`${ctx.baseUrl}/board/api/auth/me`, {
    headers: { Cookie: regCookie },
  });
  assert.equal(meBoardRes.status, 200);
  assert.equal((await meBoardRes.json()).user.username, 'テスト太郎');

  const postRes = await fetch(`${ctx.baseUrl}/board/api/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Cookie: regCookie,
    },
    body: JSON.stringify({
      thread_id: 1,
      author_name: '偽装したい他人名',
      content: '会員として投稿した本文',
    }),
  });
  assert.equal(postRes.status, 201);
  const createdPost = (await postRes.json()).post;
  assert.equal(createdPost.author_name, 'テスト太郎');
  assert.equal(createdPost.is_member, true);

  // スレッド取得JSONに password_hash や生トークンが含まれないこと + is_member が一致すること
  const threadRaw = await (await fetch(`${ctx.baseUrl}/api/threads/1`)).text();
  assert.equal(threadRaw.includes('scrypt$v1$'), false);
  assert.equal(threadRaw.includes(regCookie.split('=')[1]), false);
  const threadPosts = JSON.parse(threadRaw).posts;
  assert.equal(threadPosts.find((p) => p.id === createdPost.id).is_member, true);

  // 4. 未登録ユーザーと誤パスワードがともに同じ 401 応答になること
  const wrongPwRes = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'テスト太郎', password: 'wrong-password-1234' }),
  });
  const missingUserRes = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'nonexistent_user', password: 'wrong-password-1234' }),
  });
  assert.equal(wrongPwRes.status, 401);
  assert.equal(missingUserRes.status, 401);
  assert.deepEqual(await wrongPwRes.json(), await missingUserRes.json());

  // 5. 2つ目の独立セッション（Cookie jar 2）でログインし、1つ目だけ logout しても2つ目が生きること
  const login2Res = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'テスト太郎', password: 'strong-passphrase-1234' }),
  });
  assert.equal(login2Res.status, 200);
  const cookie2 = extractSetCookiePair(login2Res);
  assert.notEqual(cookie2, regCookie);

  const logout1Res = await fetch(`${ctx.baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: regCookie },
    body: '{}',
  });
  assert.equal(logout1Res.status, 200);
  assert.ok(logout1Res.headers.get('set-cookie').includes('Max-Age=0'));

  // 1つ目のCookieは無効化されているが、2つ目は有効のまま
  assert.equal((await (await fetch(`${ctx.baseUrl}/api/auth/me`, { headers: { Cookie: regCookie } })).json()).user, null);
  assert.equal((await (await fetch(`${ctx.baseUrl}/api/auth/me`, { headers: { Cookie: cookie2 } })).json()).user.username, 'テスト太郎');
});

test('R1競合制御: 非同期scrypt待機中のリセット・失効・logout・別端末変更による古い処理の上書き阻止', async (t) => {
  const crypto = require('node:crypto');
  let holdGates = [];
  let holdNext = false;

  const customScrypt = async (password, salt, keylen) => {
    if (holdNext) {
      await new Promise((resolve) => holdGates.push(resolve));
    }
    const d1 = crypto.createHmac('sha256', salt).update(String(password)).digest();
    const d2 = crypto.createHmac('sha256', salt).update(`ext:${password}`).digest();
    return Buffer.concat([d1, d2]).subarray(0, keylen);
  };

  const queue = createScryptQueue({ maxConcurrency: 2, maxQueue: 8, scryptFn: customScrypt });
  const ctx = await startTestServer({ devInsecureCookie: true, scryptQueue: queue });
  t.after(() => ctx.stop());
  const origin = ctx.baseUrl;

  const reg = await fetch(`${ctx.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'race_user', password: 'initial-password-123' }),
  });
  assert.equal(reg.status, 201);
  const sessCookie1 = extractSetCookiePair(reg);

  const login2 = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'race_user', password: 'initial-password-123' }),
  });
  const sessCookie2 = extractSetCookiePair(login2);

  // ケース1: ログイン照合待機中に revokeAllSessions が完了 -> 古いログインは発行せず401
  holdNext = true;
  const inflightLogin = fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'race_user', password: 'initial-password-123' }),
  });
  while (holdGates.length < 1) await new Promise((r) => setTimeout(r, 5));
  ctx.db.revokeAllSessionsByUsername('race_user');
  holdNext = false;
  holdGates.shift()();
  const res1 = await inflightLogin;
  assert.equal(res1.status, 401);
  assert.equal(res1.headers.get('set-cookie'), null);

  // 再ログインしてセッションを取り直す
  const reLogin = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'race_user', password: 'initial-password-123' }),
  });
  const activeCookieA = extractSetCookiePair(reLogin);

  // ケース2: 本人のパスワード変更(scrypt)待機中に現セッションlogoutが完了 -> 変更確定せず401
  holdNext = true;
  const inflightChangeA = fetch(`${ctx.baseUrl}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: activeCookieA },
    body: JSON.stringify({ currentPassword: 'initial-password-123', newPassword: 'attacker-password-999' }),
  });
  while (holdGates.length < 1) await new Promise((r) => setTimeout(r, 5));
  await fetch(`${ctx.baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: activeCookieA },
    body: '{}',
  });
  holdNext = false;
  while (holdGates.length > 0) holdGates.shift()();
  const res2 = await inflightChangeA;
  assert.equal(res2.status, 401);

  // 元のパスワードが維持されており、attacker-password-999 では入れないこと
  const failAttacker = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'race_user', password: 'attacker-password-999' }),
  });
  assert.equal(failAttacker.status, 401);

  // ケース3: 本人パスワード変更待機中に管理者reset-passwordが完了 -> 管理者設定を上書きしないこと
  const reLoginB = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'race_user', password: 'initial-password-123' }),
  });
  const activeCookieB = extractSetCookiePair(reLoginB);

  holdNext = true;
  const inflightChangeB = fetch(`${ctx.baseUrl}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: activeCookieB },
    body: JSON.stringify({ currentPassword: 'initial-password-123', newPassword: 'stale-user-pass-777' }),
  });
  while (holdGates.length < 1) await new Promise((r) => setTimeout(r, 5));
  const adminSalt = Buffer.alloc(16, 7);
  const adminHash = await makeFastScryptFn()('admin-temp-pass-123', adminSalt, 64);
  const adminFormatted = `scrypt$v1$16384$8$5$64$${adminSalt.toString('hex')}$${adminHash.toString('hex')}`;
  ctx.db.resetPasswordByUsername({ username: 'race_user', newPasswordHash: adminFormatted });
  holdNext = false;
  while (holdGates.length > 0) holdGates.shift()();
  const res3 = await inflightChangeB;
  assert.equal(res3.status, 401);

  // 仮パスワード(admin-temp-pass-123)のみが生きていること
  const tempLogin = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'race_user', password: 'admin-temp-pass-123' }),
  });
  assert.equal(tempLogin.status, 200);
  const tempData = await tempLogin.json();
  assert.equal(tempData.user.mustChangePassword, true);
  const tempCookie3 = extractSetCookiePair(tempLogin);
  assert.equal(sessCookie1 !== sessCookie2, true);

  // ケース4: 端末Xのパスワード変更待機中に別端末Yがパスワード変更を完了 -> Xの古い変更が401で拒否されること
  const prepChange = await fetch(`${ctx.baseUrl}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: tempCookie3 },
    body: JSON.stringify({ currentPassword: 'admin-temp-pass-123', newPassword: 'normal-pass-1234' }),
  });
  assert.equal(prepChange.status, 200);

  const loginX = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'race_user', password: 'normal-pass-1234' }),
  });
  assert.equal(loginX.status, 200);
  const sessX = extractSetCookiePair(loginX);

  const loginY = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'race_user', password: 'normal-pass-1234' }),
  });
  assert.equal(loginY.status, 200);
  const sessY = extractSetCookiePair(loginY);

  holdNext = true;
  const inflightChangeX = fetch(`${ctx.baseUrl}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: sessX },
    body: JSON.stringify({ currentPassword: 'normal-pass-1234', newPassword: 'stale-x-pass-111' }),
  });
  while (holdGates.length < 1) await new Promise((r) => setTimeout(r, 5));

  holdNext = false;
  const winnerY = await fetch(`${ctx.baseUrl}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: sessY },
    body: JSON.stringify({ currentPassword: 'normal-pass-1234', newPassword: 'winner-y-pass-222' }),
  });
  assert.equal(winnerY.status, 200);

  while (holdGates.length > 0) holdGates.shift()();
  const staleResX = await inflightChangeX;
  assert.equal(staleResX.status, 401);

  const checkWinner = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'race_user', password: 'winner-y-pass-222' }),
  });
  assert.equal(checkWinner.status, 200);

  const checkStale = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'race_user', password: 'stale-x-pass-111' }),
  });
  assert.equal(checkStale.status, 401);
});

test('R2仮パスワード制限・7日有効期限・期限切れ401契約・ALLOW_SIGNUP・4KB/429/503過負荷保護', async (t) => {
  let fakeNowMs = Date.parse('2026-11-19T00:00:00.000Z');
  const queue = createScryptQueue({ maxConcurrency: 1, maxQueue: 2, scryptFn: makeFastScryptFn() });
  const ctx = await startTestServer({
    devInsecureCookie: true,
    scryptQueue: queue,
    authRateLimitMaxPerIp: 25,
    nowFn: () => new Date(fakeNowMs),
  });
  t.after(() => ctx.stop());
  const origin = ctx.baseUrl;

  await fetch(`${ctx.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'temp_tester', password: 'password-one-123' }),
  });

  // 1. 管理者リセット後：仮パスワードログイン -> 投稿403, meはmustChangePassword:true, logoutは200成功
  const tempHash = await queue.hashPassword('temp-pass-9876');
  ctx.db.resetPasswordByUsername({ username: 'temp_tester', newPasswordHash: tempHash });

  const tempLogin = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'temp_tester', password: 'temp-pass-9876' }),
  });
  assert.equal(tempLogin.status, 200);
  const tempCookie = extractSetCookiePair(tempLogin);
  assert.equal((await tempLogin.json()).user.mustChangePassword, true);

  const blockedPost = await fetch(`${ctx.baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: tempCookie },
    body: JSON.stringify({ thread_id: 1, content: '仮パスワード中の投稿阻止' }),
  });
  assert.equal(blockedPost.status, 403);
  assert.equal((await blockedPost.json()).code, 'PASSWORD_CHANGE_REQUIRED');

  const meTemp = await fetch(`${ctx.baseUrl}/api/auth/me`, { headers: { Cookie: tempCookie } });
  assert.equal((await meTemp.json()).user.mustChangePassword, true);

  // R2: 仮パスワード中でも logout は常に200で成功し、そのCookieが無効になる
  const logoutTemp = await fetch(`${ctx.baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: tempCookie },
    body: '{}',
  });
  assert.equal(logoutTemp.status, 200);
  assert.equal((await (await fetch(`${ctx.baseUrl}/api/auth/me`, { headers: { Cookie: tempCookie } })).json()).user, null);

  // 再度ログインしてパスワード変更完了 -> 再ログイン後に通常投稿できること
  const tempLogin2 = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'temp_tester', password: 'temp-pass-9876' }),
  });
  const tempCookie2 = extractSetCookiePair(tempLogin2);

  const chgRes = await fetch(`${ctx.baseUrl}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: tempCookie2 },
    body: JSON.stringify({ currentPassword: 'temp-pass-9876', newPassword: 'brand-new-pass-456' }),
  });
  assert.equal(chgRes.status, 200);
  assert.equal((await (await fetch(`${ctx.baseUrl}/api/auth/me`, { headers: { Cookie: tempCookie2 } })).json()).user, null);

  const finalLogin = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'temp_tester', password: 'brand-new-pass-456' }),
  });
  const finalCookie = extractSetCookiePair(finalLogin);
  assert.equal((await finalLogin.json()).user.mustChangePassword, false);

  // 2. 時刻注入でちょうど7日後に失効し、無効Cookie付きPOSTは黙って匿名化せず 401 SESSION_EXPIRED を返す
  fakeNowMs += 7 * 24 * 60 * 60 * 1000;
  const expiredPost = await fetch(`${ctx.baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: finalCookie },
    body: JSON.stringify({ thread_id: 1, content: '失効後に匿名化されては困る投稿' }),
  });
  assert.equal(expiredPost.status, 401);
  assert.equal((await expiredPost.json()).code, 'SESSION_EXPIRED');
  assert.ok(expiredPost.headers.get('set-cookie').includes('Max-Age=0'));

  // 3. ALLOW_SIGNUP=false 時、新規登録は403で止まるがログインや匿名投稿は維持される
  const closedCtx = await startTestServer({
    devInsecureCookie: true,
    allowSignup: false,
    scryptOptions: { scryptFn: makeFastScryptFn() },
    authRateLimitMaxPerIp: 2,
    authMaxBodyBytes: 256,
  });
  t.after(() => closedCtx.stop());

  const closedReg = await fetch(`${closedCtx.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: closedCtx.baseUrl },
    body: JSON.stringify({ username: 'newcomer', password: 'password-1234' }),
  });
  assert.equal(closedReg.status, 403);

  // 4KB（ここでは256B）超過で 413、IPレート制限超過で 429
  const bigAuth = await fetch(`${closedCtx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: closedCtx.baseUrl },
    body: JSON.stringify({ username: 'alice', password: 'x'.repeat(300) }),
  });
  assert.equal(bigAuth.status, 413);

  const limitedAuth = await fetch(`${closedCtx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: closedCtx.baseUrl },
    body: JSON.stringify({ username: 'alice', password: 'password123' }),
  });
  assert.equal(limitedAuth.status, 429);
  // /api/health は影響を受けず 200
  assert.equal((await fetch(`${closedCtx.baseUrl}/api/health`)).status, 200);
});

test('HTTPS本番プロキシ模擬: __Host- Cookie・Secure・Origin完全一致・スキーム違い拒否・非HTTPS拒否', async (t) => {
  const ctx = await startTestServer({
    trustProxy: true,
    devInsecureCookie: false,
    allowedOrigin: 'https://testserver.koo-hi.com',
    scryptOptions: { scryptFn: makeFastScryptFn() },
  });
  t.after(() => ctx.stop());

  // 1. 非HTTPS（X-Forwarded-Proto なし）のままだと Cookie を発行しない
  const plainProto = await fetch(`${ctx.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://testserver.koo-hi.com',
    },
    body: JSON.stringify({ username: 'https_user', password: 'secure-password-123' }),
  });
  assert.equal(plainProto.status, 403);
  assert.equal(plainProto.headers.get('set-cookie'), null);

  // 2. Origin 欠落 / Origin: null / スキーム違い / 兄弟サブドメイン / cross-site をすべて 403 拒否
  const badHeadersList = [
    { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, // Origin欠落
    { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', Origin: 'null' },
    { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', Origin: 'http://testserver.koo-hi.com' },
    { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', Origin: 'https://koo-hi.com' },
    {
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
      Origin: 'https://testserver.koo-hi.com',
      'Sec-Fetch-Site': 'cross-site',
    },
  ];
  for (const h of badHeadersList) {
    const r = await fetch(`${ctx.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ username: 'https_user', password: 'secure-password-123' }),
    });
    assert.equal(r.status, 403);
  }

  // 3. 正規プロキシヘッダー＋完全一致 Origin で __Host-board_session + Secure 発行
  const okReg = await fetch(`${ctx.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
      Origin: 'https://testserver.koo-hi.com',
    },
    body: JSON.stringify({ username: 'https_user', password: 'secure-password-123' }),
  });
  assert.equal(okReg.status, 201);
  const rawSetCookie = okReg.headers.get('set-cookie');
  assert.ok(rawSetCookie.startsWith(`${HTTPS_SESSION_COOKIE_NAME}=`));
  assert.ok(rawSetCookie.includes('Secure'));
  assert.ok(rawSetCookie.includes('HttpOnly'));
  assert.ok(rawSetCookie.includes('SameSite=Lax'));
  assert.ok(rawSetCookie.includes('Path=/'));
  assert.equal(/domain=/i.test(rawSetCookie), false);
});

test('管理CLI認証管理コマンド: 引数パスワード拒否・非TTY拒否・list-users / set-role / revoke-sessions', (t) => {
  const { spawnSync } = require('node:child_process');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-board-auth-cli-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const cliDbPath = path.join(tmpRoot, 'auth-cli.db');
  const db = createBoardDb({ dbPath: cliDbPath });
  db.createUserWithSession({
    username: 'cli_alice',
    passwordHash: `scrypt$v1$16384$8$5$64$${'11'.repeat(16)}$${'22'.repeat(64)}`,
    tokenHash: 'e'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    nowIso: '2026-11-19T00:00:00.000Z',
  });
  db.close();

  const modScript = path.join(__dirname, '..', 'src', 'moderate.js');
  const runMod = (cliArgs) =>
    spawnSync(process.execPath, [modScript, ...cliArgs], {
      encoding: 'utf8',
      input: 'piped-secret-password\npiped-secret-password\n',
      env: { ...process.env, DB_PATH: cliDbPath },
    });

  // 引数にパスワードを入れた場合は拒否されること
  const argPw = runMod(['create-user', 'bob', 'secret-password-arg']);
  assert.equal(argPw.status, 1);

  // 非TTY（パイプ入力）では自動フォールバックせず拒否されること
  const nonTtyReset = runMod(['reset-password', 'cli_alice']);
  assert.equal(nonTtyReset.status, 1);
  assert.match(nonTtyReset.stderr, /TTY/);

  // list-users / set-role / revoke-sessions が正常動作すること（ハッシュ・生トークン非表示）
  const listOut = runMod(['list-users']);
  assert.equal(listOut.status, 0);
  assert.ok(listOut.stdout.includes('cli_alice'));
  assert.equal(listOut.stdout.includes('scrypt$'), false);

  const roleOut = runMod(['set-role', 'cli_alice', 'admin']);
  assert.equal(roleOut.status, 0);
  assert.match(roleOut.stdout, /role=admin/);

  // CLI でも最後の管理者降格は拒否されること
  const lastAdminDemote = runMod(['set-role', 'cli_alice', 'user']);
  assert.equal(lastAdminDemote.status, 1);
  assert.match(lastAdminDemote.stderr, /最後の管理者/);

  const verifyDb = createBoardDb({ dbPath: cliDbPath });
  try {
    const u = verifyDb.getUserForAuthByUsername('cli_alice');
    assert.equal(u.role, 'admin');
    // set-role 時点で全セッションが失効されていること
    assert.equal(verifyDb.getSessionAuthByTokenHash('e'.repeat(64), '2026-11-19T01:00:00.000Z'), null);
    // CLI 操作が admin_audit_logs へ actor_type='cli' で記録されていること
    const audits = verifyDb.listAdminAuditLogs({ limit: 10 });
    assert.ok(audits.logs.some((a) => a.actorType === 'cli' && a.action === 'user_role_change'));
  } finally {
    verifyDb.close();
  }
});

test('HTTP過負荷とDB障害時契約: scryptキュー溢れで503+Retry-After返し/api/healthは200・セッションDB障害時は500で匿名化しない', async (t) => {
  const fastFn = makeFastScryptFn();
  let gateEnabled = false;
  const gates = [];

  const gatedScrypt = async (password, salt, keylen) => {
    if (gateEnabled) {
      await new Promise((resolve) => gates.push(resolve));
    }
    return fastFn(password, salt, keylen);
  };

  const queue = createScryptQueue({ maxConcurrency: 1, maxQueue: 1, scryptFn: gatedScrypt });
  const ctx = await startTestServer({ devInsecureCookie: true, scryptQueue: queue });
  t.after(async () => {
    gateEnabled = false;
    while (gates.length > 0) gates.shift()();
    await ctx.stop();
  });
  const origin = ctx.baseUrl;

  const reg = await fetch(`${ctx.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'overload_user', password: 'overload-password-123' }),
  });
  assert.equal(reg.status, 201);
  const validCookie = extractSetCookiePair(reg);

  // 1. scryptキュー (active=1, queue=1) を満たしてから3件目を投げると 503 + Retry-After: 2 になる
  gateEnabled = true;
  const req1 = fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'overload_user', password: 'overload-password-123' }),
  });
  while (gates.length < 1) await new Promise((r) => setTimeout(r, 5));

  const req2 = fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'overload_user', password: 'overload-password-123' }),
  });
  while (queue.getStats().waiting < 1) await new Promise((r) => setTimeout(r, 5));

  const res3 = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'overload_user', password: 'overload-password-123' }),
  });
  assert.equal(res3.status, 503);
  assert.equal(res3.headers.get('retry-after'), '2');
  await res3.text();
  assert.ok(ctx.server.getAuthMetrics().queueRejected503 >= 1);

  // 認証キューが満杯の間でも /api/health は影響を受けず 200 を返すこと
  const healthRes = await fetch(`${ctx.baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  await healthRes.text();

  gateEnabled = false;
  while (gates.length > 0 || queue.getStats().active > 0 || queue.getStats().waiting > 0) {
    while (gates.length > 0) gates.shift()();
    await new Promise((r) => setTimeout(r, 5));
  }
  const [r1, r2] = await Promise.all([req1, req2]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  await r1.text();
  await r2.text();

  // 2. Cookie付き POST /api/posts 時にセッション参照でDB障害が起きた場合は500を返し、黙って匿名投稿しないこと
  const origGetSession = ctx.db.getSessionAuthByTokenHash;
  ctx.db.getSessionAuthByTokenHash = () => {
    throw new Error('SQLITE_BUSY: database is locked');
  };
  let dbErrRes;
  try {
    dbErrRes = await fetch(`${ctx.baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: validCookie },
      body: JSON.stringify({ thread_id: 1, content: 'DB障害時に匿名投稿されてはいけない本文' }),
    });
  } finally {
    ctx.db.getSessionAuthByTokenHash = origGetSession;
  }
  assert.equal(dbErrRes.status, 500);
  const detail = ctx.db.getThreadDetail(1);
  assert.equal(detail.posts.some((p) => p.content === 'DB障害時に匿名投稿されてはいけない本文'), false);
});

test('レビュー回帰(F2/F3/F4): CLI秘密候補非エコー・非BMP会員名投稿＆編集・本文読取中期限切れ拒否', async (t) => {
  const http = require('node:http');
  const { spawnSync } = require('node:child_process');

  // 1. F2: create-user / reset-password でパスワード候補を誤って引数へ渡しても stderr/stdout に再掲しないこと
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-board-f2-cli-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }));
  const cliDbPath = path.join(tmpDir, 'f2.db');
  const modScript = path.join(__dirname, '..', 'src', 'moderate.js');
  const dummySecret = 'REVIEW_SECRET_CANDIDATE_XYZ_999';

  for (const action of ['create-user', 'reset-password']) {
    const cliRes = spawnSync(process.execPath, [modScript, action, 'f2_target', dummySecret], {
      encoding: 'utf8',
      env: { ...process.env, DB_PATH: cliDbPath },
      windowsHide: true,
    });
    assert.equal(cliRes.status, 1);
    assert.equal((cliRes.stdout + cliRes.stderr).includes(dummySecret), false);
  }

  // 2. F3 & F4 用サーバー起動
  let clock = Date.parse('2026-11-19T12:00:00.000Z');
  const ctx = await startTestServer({
    devInsecureCookie: true,
    scryptOptions: { scryptFn: makeFastScryptFn() },
    nowFn: () => new Date(clock),
    sessionTtlSeconds: 1,
  });
  t.after(async () => {
    ctx.server.closeAllConnections?.();
    await ctx.stop();
  });
  const origin = ctx.baseUrl;

  // F3: 非BMP Unicode（😀×16 = 16コードポイント / UTF-16で32単位）で登録・会員投稿・過剰author_name無視・本文編集・匿名30超拒否
  const emoji16 = '😀'.repeat(16);
  const regEmoji = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: emoji16, password: 'emoji-password-123' }),
  });
  assert.equal(regEmoji.status, 201);
  const emojiCookie = extractSetCookiePair(regEmoji);

  const memberEmojiPost = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: emojiCookie },
    body: JSON.stringify({ thread_id: 1, author_name: emoji16, content: '非BMP会員投稿' }),
  });
  assert.equal(memberEmojiPost.status, 201);
  const createdEmoji = (await memberEmojiPost.json()).post;
  assert.equal(createdEmoji.is_member, true);
  assert.equal(createdEmoji.author_name, emoji16);

  // クライアント側が異常に長い author_name を送っても会員投稿はサーバー確定名で通ること
  const bogusMemberPost = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: emojiCookie },
    body: JSON.stringify({ thread_id: 1, author_name: 'z'.repeat(120), content: '会員名無視テスト' }),
  });
  assert.equal(bogusMemberPost.status, 201);
  assert.equal((await bogusMemberPost.json()).post.author_name, emoji16);

  // 管理編集で会員本文更新は通る（author_nameはコードポイント一致）
  const editedEmoji = ctx.db.updatePost({ postId: createdEmoji.id, content: '非BMP会員投稿(編集済)' });
  assert.equal(editedEmoji.post.content, '非BMP会員投稿(編集済)');

  // 匿名投稿でも16コードポイントは通り、31コードポイントは400で拒否される
  const anonOk = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ thread_id: 1, author_name: emoji16, content: '非BMP匿名16' }),
  });
  assert.equal(anonOk.status, 201);
  const anonTooLong = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ thread_id: 1, author_name: '😀'.repeat(31), content: '非BMP匿名31' }),
  });
  assert.equal(anonTooLong.status, 400);

  // 3. F4: 分割送信の本文読取中にセッション有効期限を過ぎた場合は 401 で拒否すること（投稿 / パスワード変更）
  const regExp = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'f4_expiry_user', password: 'expiry-password-123' }),
  });
  assert.equal(regExp.status, 201);
  const expCookie = extractSetCookiePair(regExp);

  const sendSplitDuringClockJump = (route, cookie, firstChunk, secondChunk, advanceMs) =>
    new Promise((resolve, reject) => {
      const reqPromise = new Promise((resReq) => ctx.server.once('request', resReq));
      const req = http.request(
        `${origin}${route}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: origin,
            Cookie: cookie,
            Connection: 'close',
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (part) => {
            body += part;
          });
          res.on('end', () => {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          });
        }
      );
      req.on('error', reject);
      req.write(firstChunk);
      reqPromise
        .then(() => new Promise((r) => setTimeout(r, 10)))
        .then(() => {
          clock += advanceMs;
          req.end(secondChunk);
        })
        .catch(reject);
    });

  const expiredPostRes = await sendSplitDuringClockJump(
    '/api/posts',
    expCookie,
    '{"thread_id":1,',
    '"content":"読取中期限切れ本文"}',
    2000
  );
  assert.equal(expiredPostRes.status, 401);
  assert.equal(expiredPostRes.body.code, 'SESSION_EXPIRED');
  assert.equal(ctx.db.getThreadDetail(1).posts.some((p) => p.content === '読取中期限切れ本文'), false);

  // パスワード変更エンドポイントも同様に読取中の期限切れを通さないこと
  const loginPw = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'f4_expiry_user', password: 'expiry-password-123' }),
  });
  assert.equal(loginPw.status, 200);
  const expCookie2 = extractSetCookiePair(loginPw);

  const expiredPwRes = await sendSplitDuringClockJump(
    '/api/auth/password',
    expCookie2,
    '{"currentPassword":"expiry-password-123",',
    '"newPassword":"should-not-apply-456"}',
    2000
  );
  assert.equal(expiredPwRes.status, 401);
});

test('Phase 1(T1-1/T1-2/T2-1): /api/bootstrap まとめ取得・静的ETag(304)・privacy.html配信と非公開保護', async (t) => {
  const fastScryptQueue = createScryptQueue({ scryptFn: makeFastScryptFn() });
  const nowRef = { value: new Date('2026-11-24T05:00:00.000Z') };
  const ctx = await startTestServer({
    scryptQueue: fastScryptQueue,
    devInsecureCookie: true,
    nowFn: () => nowRef.value,
  });
  t.after(() => ctx.stop());

  // 1. 初回 GET /api/bootstrap（デフォルト先頭スレッド）
  const bootDefault = await fetch(`${ctx.baseUrl}/api/bootstrap`);
  assert.equal(bootDefault.status, 200);
  assert.equal(bootDefault.headers.get('cache-control'), 'no-store');
  assert.equal(bootDefault.headers.get('etag'), null);
  const bootData = await bootDefault.json();
  assert.equal(bootData.user, null);
  assert.equal(bootData.categories.length, 3);
  assert.equal(bootData.initialThread.thread.id, 1);
  assert.ok(Array.isArray(bootData.initialThread.posts) && bootData.initialThread.posts.length >= 1);

  // 2. ?threadId=2 指定および /board/ サブパス互換
  const bootT2 = await fetch(`${ctx.baseUrl}/board/api/bootstrap?threadId=2`);
  assert.equal(bootT2.status, 200);
  const bootT2Data = await bootT2.json();
  assert.equal(bootT2Data.initialThread.thread.id, 2);
  assert.equal(bootT2Data.initialThread.thread.title, '質問、初心者質問');

  // 3. 存在しない正の threadId は先頭スレッドへフォールバック、不正形式は 400、POST は 405
  const bootFallback = await fetch(`${ctx.baseUrl}/api/bootstrap?threadId=999999`);
  assert.equal(bootFallback.status, 200);
  assert.equal((await bootFallback.json()).initialThread.thread.id, 1);

  assert.equal((await fetch(`${ctx.baseUrl}/api/bootstrap?threadId=abc`)).status, 400);
  assert.equal((await fetch(`${ctx.baseUrl}/api/bootstrap?threadId=0`)).status, 400);

  const bootPost = await fetch(`${ctx.baseUrl}/api/bootstrap`, { method: 'POST' });
  assert.equal(bootPost.status, 405);
  assert.ok(bootPost.headers.get('allow')?.includes('GET'));

  // 4. 有効Cookie時は user を返し、無効Cookie時は Clear-Cookie と user:null を返す
  const regRes = await fetch(`${ctx.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.baseUrl },
    body: JSON.stringify({ username: 'boot_member', password: 'boot-pass-1234' }),
  });
  assert.equal(regRes.status, 201);
  const cookiePair = extractSetCookiePair(regRes);

  const bootAuthed = await fetch(`${ctx.baseUrl}/api/bootstrap`, {
    headers: { Cookie: cookiePair },
  });
  assert.equal(bootAuthed.status, 200);
  const bootAuthedData = await bootAuthed.json();
  assert.equal(bootAuthedData.user.username, 'boot_member');
  assert.equal(bootAuthedData.initialThread.thread.id, 1);

  const bootInvalidCookie = await fetch(`${ctx.baseUrl}/api/bootstrap`, {
    headers: { Cookie: `${DEV_SESSION_COOKIE_NAME}=invalid-token-format` },
  });
  assert.equal(bootInvalidCookie.status, 200);
  assert.ok(bootInvalidCookie.headers.get('set-cookie')?.includes('Max-Age=0'));
  assert.equal((await bootInvalidCookie.json()).user, null);

  // 5. 静的ファイル ETag / 304 Not Modified と privacy.html 公開境界
  for (const staticPath of ['/style.css', '/app.js', '/privacy.html', '/privacy.js']) {
    const first = await fetch(`${ctx.baseUrl}${staticPath}`);
    assert.equal(first.status, 200, `${staticPath} should return 200`);
    const etag = first.headers.get('etag');
    assert.ok(etag && etag.startsWith('"'), `${staticPath} should return ETag`);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    assert.ok(first.headers.get('content-security-policy')?.includes("script-src 'self'"));

    const cached = await fetch(`${ctx.baseUrl}${staticPath}`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.headers.get('etag'), etag);
    assert.equal(cached.headers.get('cache-control'), 'no-cache');
    assert.equal(await cached.text(), '');

    const weakMatch = await fetch(`${ctx.baseUrl}${staticPath}`, {
      headers: { 'If-None-Match': `"other", W/${etag}` },
    });
    assert.equal(weakMatch.status, 304);

    const stale = await fetch(`${ctx.baseUrl}${staticPath}`, {
      headers: { 'If-None-Match': '"stale-etag-value"' },
    });
    assert.equal(stale.status, 200);
  }

  const privacyHtml = await (await fetch(`${ctx.baseUrl}/privacy.html`)).text();
  assert.ok(privacyHtml.includes('UNLOCKの掲示板'));
  assert.ok(privacyHtml.includes('KoohiQK'));
  for (const forbidden of ['/var/www', '/etc/', 'board_backup.db', 'access_stats.db', '【']) {
    assert.equal(privacyHtml.includes(forbidden), false, `privacy.html must not contain ${forbidden}`);
  }
});

test('別タブログアウト相当(expect_auth: true + Cookieなし)で暗黙匿名化せず401 SESSION_EXPIREDを返すこと', async (t) => {
  const fastScryptQueue = createScryptQueue({ scryptFn: makeFastScryptFn() });
  const ctx = await startTestServer({
    scryptQueue: fastScryptQueue,
    devInsecureCookie: true,
  });
  t.after(() => ctx.stop());

  const beforeCount = ctx.db.getThreadDetail(1).posts.length;

  // 1. Cookieなし + expect_auth: true -> 401 SESSION_EXPIRED（匿名保存しない）
  const expiredNoCookie = await fetch(`${ctx.baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.baseUrl },
    body: JSON.stringify({
      thread_id: 1,
      parent_id: null,
      author_name: '元の会員',
      content: '別タブログアウト後の保護対象本文',
      expect_auth: true,
    }),
  });
  assert.equal(expiredNoCookie.status, 401);
  assert.equal((await expiredNoCookie.json()).code, 'SESSION_EXPIRED');
  assert.equal(ctx.db.getThreadDetail(1).posts.length, beforeCount);

  // 2. expect_auth に真偽値以外を指定 -> 400
  const invalidFlagRes = await fetch(`${ctx.baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.baseUrl },
    body: JSON.stringify({
      thread_id: 1,
      parent_id: null,
      author_name: '名無しさん',
      content: '不正型テスト',
      expect_auth: 'yes',
    }),
  });
  assert.equal(invalidFlagRes.status, 400);
  assert.equal(ctx.db.getThreadDetail(1).posts.length, beforeCount);

  // 3. Cookieなし + expect_auth: false -> 通常の匿名投稿として 201
  const explicitAnonRes = await fetch(`${ctx.baseUrl}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.baseUrl },
    body: JSON.stringify({
      thread_id: 1,
      parent_id: null,
      author_name: '匿名希望',
      content: '明示的な匿名投稿本文',
      expect_auth: false,
    }),
  });
  assert.equal(explicitAnonRes.status, 201);
  const anonBody = await explicitAnonRes.json();
  assert.equal(anonBody.post.is_member, false);
  assert.equal(ctx.db.getThreadDetail(1).posts.length, beforeCount + 1);

  // 4. 有効Cookie + expect_auth: true -> 会員投稿として 201
  const regRes = await fetch(`${ctx.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.baseUrl },
    body: JSON.stringify({ username: 'expect_auth_user', password: 'expect-pass-1234' }),
  });
  assert.equal(regRes.status, 201);
  const cookiePair = extractSetCookiePair(regRes);

  const memberRes = await fetch(`${ctx.baseUrl}/api/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ctx.baseUrl,
      Cookie: cookiePair,
    },
    body: JSON.stringify({
      thread_id: 1,
      parent_id: null,
      author_name: '偽装名',
      content: '有効セッションでの会員投稿',
      expect_auth: true,
    }),
  });
  assert.equal(memberRes.status, 201);
  const memberBody = await memberRes.json();
  assert.equal(memberBody.post.is_member, true);
  assert.equal(memberBody.post.author_name, 'expect_auth_user');
  assert.equal(ctx.db.getThreadDetail(1).posts.length, beforeCount + 2);
});

test('昇格前レビュー回帰(R1): POST /api/posts は expected_user_id で別タブアカウント切替(会員A→B／匿名→会員A)を409で阻止すること', async (t) => {
  const http = require('node:http');
  const fastScryptQueue = createScryptQueue({ scryptFn: makeFastScryptFn() });
  const ctx = await startTestServer({
    scryptQueue: fastScryptQueue,
    devInsecureCookie: true,
  });
  t.after(() => ctx.stop());

  const origin = ctx.baseUrl;
  const regA = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'r1_member_a', password: 'r1-password-aaa' }),
  });
  assert.equal(regA.status, 201);
  const cookieA = extractSetCookiePair(regA);
  const userA = (await regA.json()).user;

  const regB = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'r1_member_b', password: 'r1-password-bbb' }),
  });
  assert.equal(regB.status, 201);
  const cookieB = extractSetCookiePair(regB);
  const userB = (await regB.json()).user;

  const beforeCount = ctx.db.getThreadDetail(1).posts.length;

  // 1. 不正な型・範囲・矛盾指定は400で拒否しDB不変
  for (const invalidBody of [
    { thread_id: 1, content: 'bad_type', expect_auth: false, expected_user_id: '1' },
    { thread_id: 1, content: 'bad_zero', expect_auth: true, expected_user_id: 0 },
    { thread_id: 1, content: 'bad_neg', expect_auth: true, expected_user_id: -5 },
    { thread_id: 1, content: 'bad_float', expect_auth: true, expected_user_id: 1.5 },
    { thread_id: 1, content: 'conflict_1', expect_auth: true, expected_user_id: null },
    { thread_id: 1, content: 'conflict_2', expect_auth: false, expected_user_id: userA.id },
  ]) {
    const res = await fetch(`${origin}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookieA },
      body: JSON.stringify(invalidBody),
    });
    assert.equal(res.status, 400);
  }

  // 2. expected_user_id だけ正整数でセッションなし -> 401 SESSION_EXPIRED
  const missingSessRes = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({
      thread_id: 1,
      content: 'missing_session_expected_id',
      expected_user_id: userA.id,
    }),
  });
  assert.equal(missingSessRes.status, 401);
  assert.equal((await missingSessRes.json()).code, 'SESSION_EXPIRED');

  // 3. 無効Cookie付きで expected_user_id: null -> 401 SESSION_EXPIRED (Set-Cookie削除付き)
  const invalidCookieAnonRes = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Cookie: 'board_session_dev=invalid_stale_token_1234',
    },
    body: JSON.stringify({
      thread_id: 1,
      content: 'invalid_cookie_anon_expected',
      expect_auth: false,
      expected_user_id: null,
    }),
  });
  assert.equal(invalidCookieAnonRes.status, 401);
  assert.ok(invalidCookieAnonRes.headers.get('set-cookie')?.includes('Max-Age=0'));
  assert.equal((await invalidCookieAnonRes.json()).code, 'SESSION_EXPIRED');

  // 4. 会員A想定で別タブが会員Bへ切替済み -> 409 AUTH_USER_MISMATCH + currentUser=B
  const aToBRes = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookieB },
    body: JSON.stringify({
      thread_id: 1,
      content: 'member_a_switched_to_b',
      expect_auth: true,
      expected_user_id: userA.id,
    }),
  });
  assert.equal(aToBRes.status, 409);
  const aToBBody = await aToBRes.json();
  assert.equal(aToBBody.code, 'AUTH_USER_MISMATCH');
  assert.deepEqual(aToBBody.currentUser, {
    id: userB.id,
    username: 'r1_member_b',
    role: 'user',
    mustChangePassword: false,
  });

  // 5. 匿名想定で別タブが会員Aへログイン済み -> 409 AUTH_USER_MISMATCH + currentUser=A
  const anonToARes = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookieA },
    body: JSON.stringify({
      thread_id: 1,
      author_name: 'ペンネーム維持',
      content: 'anon_switched_to_member_a',
      expect_auth: false,
      expected_user_id: null,
    }),
  });
  assert.equal(anonToARes.status, 409);
  const anonToABody = await anonToARes.json();
  assert.equal(anonToABody.code, 'AUTH_USER_MISMATCH');
  assert.deepEqual(anonToABody.currentUser, {
    id: userA.id,
    username: 'r1_member_a',
    role: 'user',
    mustChangePassword: false,
  });

  // いずれの拒否でも投稿は一切保存されていないこと
  assert.equal(ctx.db.getThreadDetail(1).posts.length, beforeCount);

  // 6. 本文ストリーム読取中にセッションが失効された場合も完了後時刻・状態で401拒否されること
  const sendChunkedDuringRevoke = () =>
    new Promise((resolve, reject) => {
      const reqPromise = new Promise((resReq) => ctx.server.once('request', resReq));
      const req = http.request(
        `${origin}/api/posts`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: origin,
            Cookie: cookieA,
            Connection: 'close',
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (part) => {
            body += part;
          });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }
      );
      req.on('error', reject);
      req.write(`{"thread_id":1,"expect_auth":true,"expected_user_id":${userA.id},`);
      reqPromise
        .then(() => new Promise((r) => setTimeout(r, 10)))
        .then(() => {
          ctx.db.revokeAllSessionsByUsername('r1_member_a');
          req.end('"content":"chunked_revoked_post"}');
        })
        .catch(reject);
    });
  const chunkedRevoked = await sendChunkedDuringRevoke();
  assert.equal(chunkedRevoked.status, 401);
  assert.equal(chunkedRevoked.body.code, 'SESSION_EXPIRED');
  assert.equal(ctx.db.getThreadDetail(1).posts.length, beforeCount);

  // 7. 一致時（会員B / 匿名 / expected_user_id 省略の後方互換）は正常に201保存されること
  const matchBRes = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookieB },
    body: JSON.stringify({
      thread_id: 1,
      content: 'match_member_b',
      expect_auth: true,
      expected_user_id: userB.id,
    }),
  });
  assert.equal(matchBRes.status, 201);
  const matchBBody = await matchBRes.json();
  assert.equal(matchBBody.post.is_member, true);
  assert.equal(matchBBody.post.author_name, 'r1_member_b');

  const matchAnonRes = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({
      thread_id: 1,
      author_name: '意図通りの匿名',
      content: 'match_anon',
      expect_auth: false,
      expected_user_id: null,
    }),
  });
  assert.equal(matchAnonRes.status, 201);
  const matchAnonBody = await matchAnonRes.json();
  assert.equal(matchAnonBody.post.is_member, false);
  assert.equal(matchAnonBody.post.author_name, '意図通りの匿名');

  const legacyClientRes = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookieB },
    body: JSON.stringify({
      thread_id: 1,
      content: 'legacy_client_without_expected_id',
      expect_auth: true,
    }),
  });
  assert.equal(legacyClientRes.status, 201);
  assert.equal(ctx.db.getThreadDetail(1).posts.length, beforeCount + 3);
});

test('v1.1管理MVP(API): 全/api/admin/*認可マトリクス・旧Bearer拒否・Origin強制・no-store・ページング・秘密非露出', async (t) => {
  const ctx = await startTestServer({ devInsecureCookie: true });
  t.after(() => ctx.stop());
  const origin = ctx.baseUrl;

  const { cookie: memberCookie } = createDirectUserSessionCookie(ctx, {
    username: 'matrix_user',
    role: 'user',
  });
  const { cookie: tempAdminCookie } = createDirectUserSessionCookie(ctx, {
    username: 'matrix_temp_admin',
    role: 'admin',
    mustChangePassword: true,
  });
  const { cookie: adminCookie } = createDirectUserSessionCookie(ctx, {
    username: 'matrix_admin',
    role: 'admin',
    mustChangePassword: false,
  });

  // 1. GET 系と更新系を含む主要管理ルートでの 4段階アクセス制御
  const targets = [
    { path: '/api/admin/overview', method: 'GET' },
    { path: '/api/admin/users', method: 'GET' },
    { path: '/api/admin/audit-logs', method: 'GET' },
    { path: '/api/admin/threads/1/posts', method: 'GET' },
    { path: '/api/admin/threads/1/delete-preview', method: 'GET' },
    { path: '/api/admin/categories', method: 'POST', body: { name: '無許可テスト' } },
    { path: '/api/admin/categories/1', method: 'PATCH', body: { name: '無許可更新' } },
    { path: '/api/admin/categories/1', method: 'DELETE', body: {} },
    { path: '/api/admin/threads', method: 'POST', body: { categoryId: 1, title: '無許可スレ' } },
    { path: '/api/admin/threads/1', method: 'PATCH', body: { title: '無許可スレ変更' } },
    {
      path: '/api/admin/threads/1',
      method: 'DELETE',
      body: { confirmTitle: '雑談', expectedPostCount: 0 },
    },
    { path: '/api/admin/posts/1/delete', method: 'POST', body: {} },
    { path: '/api/admin/posts/1/pin', method: 'POST', body: { pinned: true } },
  ];

  for (const tgt of targets) {
    const isMut = tgt.method !== 'GET';
    const makeHeaders = (extra = {}) => ({
      ...(isMut ? { 'Content-Type': 'application/json', Origin: origin } : {}),
      ...extra,
    });

    // guest (Cookieなし) -> 401
    const guestRes = await fetch(`${origin}${tgt.path}`, {
      method: tgt.method,
      headers: makeHeaders(),
      ...(isMut ? { body: JSON.stringify(tgt.body) } : {}),
    });
    assert.equal(guestRes.status, 401, `guest rejected at ${tgt.method} ${tgt.path}`);
    assert.equal(guestRes.headers.get('cache-control'), 'no-store');

    // user (一般会員) -> 403
    const userRes = await fetch(`${origin}${tgt.path}`, {
      method: tgt.method,
      headers: makeHeaders({ Cookie: memberCookie }),
      ...(isMut ? { body: JSON.stringify(tgt.body) } : {}),
    });
    assert.equal(userRes.status, 403, `user rejected at ${tgt.method} ${tgt.path}`);

    // admin + mustChangePassword=1 -> 403 PASSWORD_CHANGE_REQUIRED
    const tempRes = await fetch(`${origin}${tgt.path}`, {
      method: tgt.method,
      headers: makeHeaders({ Cookie: tempAdminCookie }),
      ...(isMut ? { body: JSON.stringify(tgt.body) } : {}),
    });
    assert.equal(tempRes.status, 403, `temp admin rejected at ${tgt.method} ${tgt.path}`);
    const tempJson = await tempRes.json();
    assert.equal(tempJson.code, 'PASSWORD_CHANGE_REQUIRED');

    if (isMut) {
      // Origin 欠落 -> 403 / 別Origin -> 403 / 旧Bearer -> 401
      const noOriginRes = await fetch(`${origin}${tgt.path}`, {
        method: tgt.method,
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify(tgt.body),
      });
      assert.equal(noOriginRes.status, 403, `missing Origin rejected at ${tgt.method} ${tgt.path}`);

      const wrongOriginRes = await fetch(`${origin}${tgt.path}`, {
        method: tgt.method,
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: adminCookie },
        body: JSON.stringify(tgt.body),
      });
      assert.equal(wrongOriginRes.status, 403, `cross Origin rejected at ${tgt.method} ${tgt.path}`);

      const bearerRes = await fetch(`${origin}${tgt.path}`, {
        method: tgt.method,
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          Authorization: 'Bearer legacy_admin_token_should_fail_1234',
        },
        body: JSON.stringify(tgt.body),
      });
      assert.equal(bearerRes.status, 401, `legacy Bearer rejected at ${tgt.method} ${tgt.path}`);
    }
  }

  // 2. 正規管理者 GET /api/admin/overview, users, audit-logs の no-store / ページング / 秘密非露出
  const ovRes = await fetch(`${origin}/board/api/admin/overview`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(ovRes.status, 200);
  assert.equal(ovRes.headers.get('cache-control'), 'no-store');
  const ovData = await ovRes.json();
  assert.equal(ovData.user.username, 'matrix_admin');
  assert.ok(ovData.summary.categoriesCount >= 3);
  assert.equal(ovData.users, undefined);

  const usersRes = await fetch(`${origin}/board/api/admin/users?limit=2&offset=1`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(usersRes.status, 200);
  const usersText = await usersRes.text();
  assert.equal(usersText.includes('scrypt$'), false, 'password_hash が DTO に出ないこと');
  const usersData = JSON.parse(usersText);
  assert.equal(usersData.limit, 2);
  assert.equal(usersData.offset, 1);
  assert.equal(usersData.users.length, 2);
  for (const u of usersData.users) {
    assert.equal('password_hash' in u, false);
    assert.equal('passwordHash' in u, false);
    assert.equal('token_hash' in u, false);
    assert.equal('tokenHash' in u, false);
  }

  // limit > 100 は 400 で拒否
  const badLimitRes = await fetch(`${origin}/api/admin/users?limit=101`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(badLimitRes.status, 400);
  const badAuditLimitRes = await fetch(`${origin}/api/admin/audit-logs?limit=101`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(badAuditLimitRes.status, 400);
});

test('v1.1管理MVP(CRUD・競合): カテゴリ/スレッドCRUD・削除直前件数変化409・受信中降格/失効で確定阻止・監査一致', async (t) => {
  const http = require('node:http');
  const ctx = await startTestServer({ devInsecureCookie: true });
  t.after(() => ctx.stop());
  const origin = ctx.baseUrl;

  const { user: admin1, cookie: adminCookie1 } = createDirectUserSessionCookie(ctx, {
    username: 'crud_admin_1',
    role: 'admin',
  });
  const { cookie: adminCookie2, tokenHash: admin2TokenHash } = createDirectUserSessionCookie(ctx, {
    username: 'crud_admin_2',
    role: 'admin',
  });

  // 1. カテゴリ作成 → 同名409 → 更新 → 配下あり削除409 → スレッド作成/編集 → 直前投稿増加で409 → 再確認で物理削除 → 空カテゴリ削除
  const createCatRes = await fetch(`${origin}/board/api/admin/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie1 },
    body: JSON.stringify({ name: '検証カテゴリ', displayOrder: 9 }),
  });
  assert.equal(createCatRes.status, 201);
  const { category: createdCat } = await createCatRes.json();

  const dupCatRes = await fetch(`${origin}/board/api/admin/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie1 },
    body: JSON.stringify({ name: '検証カテゴリ' }),
  });
  assert.equal(dupCatRes.status, 409);

  const patchCatRes = await fetch(`${origin}/board/api/admin/categories/${createdCat.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie1 },
    body: JSON.stringify({ name: '改訂カテゴリ', displayOrder: 2 }),
  });
  assert.equal(patchCatRes.status, 200);
  assert.equal((await patchCatRes.json()).category.name, '改訂カテゴリ');

  const createThRes = await fetch(`${origin}/board/api/admin/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie1 },
    body: JSON.stringify({
      categoryId: createdCat.id,
      title: '管理スレ1',
      pinnedText: '初期ピン文',
      isPinned: true,
    }),
  });
  assert.equal(createThRes.status, 201);
  const { thread: createdTh } = await createThRes.json();
  assert.equal(createdTh.pinned_text, '初期ピン文');
  assert.equal(createdTh.is_pinned, 1);

  const patchThRes = await fetch(`${origin}/board/api/admin/threads/${createdTh.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie1 },
    body: JSON.stringify({ title: '管理スレ改訂', pinnedText: '改訂ピン文', isPinned: false, displayOrder: 3 }),
  });
  assert.equal(patchThRes.status, 200);
  const patchedTh = (await patchThRes.json()).thread;
  assert.equal(patchedTh.title, '管理スレ改訂');
  assert.equal(patchedTh.pinned_text, '改訂ピン文');
  assert.equal(patchedTh.is_pinned, 0);

  // 配下にスレッドが残るカテゴリ削除 -> 409 CATEGORY_NOT_EMPTY
  const nonEmptyCatDel = await fetch(`${origin}/board/api/admin/categories/${createdCat.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie1 },
    body: '{}',
  });
  assert.equal(nonEmptyCatDel.status, 409);
  assert.equal((await nonEmptyCatDel.json()).code, 'CATEGORY_NOT_EMPTY');

  // P2-2単一ソース検証：スレッド案内文は posts に複製されず、スレッド詳細の pinned_text のみで保持されること
  const thDetailBeforeRace = await (await fetch(`${origin}/board/api/threads/${createdTh.id}`)).json();
  assert.equal(thDetailBeforeRace.thread.pinned_text, '改訂ピン文');
  assert.equal(thDetailBeforeRace.posts.length, 0);

  // 削除プレビュー取得後に新投稿が増えた場合の 409 THREAD_POST_COUNT_CHANGED と再確認成功
  const previewData = await (
    await fetch(`${origin}/board/api/admin/threads/${createdTh.id}/delete-preview`, {
      headers: { Cookie: adminCookie1 },
    })
  ).json();
  assert.equal(previewData.postsCount, 0);

  ctx.db.createPost({
    threadId: createdTh.id,
    authorName: '割り込み',
    visitorId: 'race01',
    content: 'プレビュー後の新規投稿',
  });

  const stalePurgeRes = await fetch(`${origin}/board/api/admin/threads/${createdTh.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie1 },
    body: JSON.stringify({ confirmTitle: '管理スレ改訂', expectedPostCount: 0 }),
  });
  assert.equal(stalePurgeRes.status, 409);
  const stalePurgeJson = await stalePurgeRes.json();
  assert.equal(stalePurgeJson.code, 'THREAD_POST_COUNT_CHANGED');
  assert.equal(stalePurgeJson.details.actualPostsCount, 1);

  const okPurgeRes = await fetch(`${origin}/board/api/admin/threads/${createdTh.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie1 },
    body: JSON.stringify({ confirmTitle: '管理スレ改訂', expectedPostCount: 1 }),
  });
  assert.equal(okPurgeRes.status, 200);
  assert.equal((await okPurgeRes.json()).deletedPostsCount, 1);

  const emptyCatDel = await fetch(`${origin}/board/api/admin/categories/${createdCat.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie1 },
    body: '{}',
  });
  assert.equal(emptyCatDel.status, 200);

  // P1-2: 最後の1カテゴリを残して他をすべて空・削除したとき、最後の1件は 409 LAST_CATEGORY_PROTECTED で拒否されること
  const catsForLastGuard = ctx.db.listCategoriesWithThreads();
  for (let i = 1; i < catsForLastGuard.length; i += 1) {
    const c = catsForLastGuard[i];
    for (const th of c.threads) {
      ctx.db.purgeThread(th.id);
    }
    const delOther = await fetch(`${origin}/board/api/admin/categories/${c.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie1 },
      body: '{}',
    });
    assert.equal(delOther.status, 200);
  }
  const finalRemainingCat = ctx.db.listCategoriesWithThreads()[0];
  for (const th of finalRemainingCat.threads) {
    ctx.db.purgeThread(th.id);
  }
  const delLastCatRes = await fetch(`${origin}/board/api/admin/categories/${finalRemainingCat.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie1 },
    body: '{}',
  });
  assert.equal(delLastCatRes.status, 409);
  assert.equal((await delLastCatRes.json()).code, 'LAST_CATEGORY_PROTECTED');

  // 2. ボディ受信中に降格された管理者2のリクエストが確定直前検査で 403 FORBIDDEN になること
  const sendAdminChunkedDuringDemotion = () =>
    new Promise((resolve, reject) => {
      const reqPromise = new Promise((resReq) => ctx.server.once('request', resReq));
      const req = http.request(
        `${origin}/api/admin/categories`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: origin,
            Cookie: adminCookie2,
            Connection: 'close',
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }
      );
      req.on('error', reject);
      req.write('{"name":');
      reqPromise
        .then(() => new Promise((r) => setTimeout(r, 10)))
        .then(() => {
          // 受信中に管理者2を一般会員へ降格（セッションは別手段で残存しても最新roleで拒否、さらに失効も別テストで確認）
          ctx.db.execRawForTesting("UPDATE users SET role = 'user' WHERE username = 'crud_admin_2'");
          req.end('"受信中降格カテゴリ"}');
        })
        .catch(reject);
    });
  const demotedDuringBody = await sendAdminChunkedDuringDemotion();
  assert.equal(demotedDuringBody.status, 403);
  assert.equal(demotedDuringBody.body.code, 'FORBIDDEN');
  assert.equal(
    ctx.db.listCategoriesWithThreads().some((c) => c.name === '受信中降格カテゴリ'),
    false
  );

  // 別操作でセッション失効させた場合（adminCookie1 をボディ受信中に revoke） -> 401 SESSION_EXPIRED
  const sendChunkedDuringRevoke = () =>
    new Promise((resolve, reject) => {
      const reqPromise = new Promise((resReq) => ctx.server.once('request', resReq));
      const req = http.request(
        `${origin}/api/admin/categories`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: origin,
            Cookie: adminCookie1,
            Connection: 'close',
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }
      );
      req.on('error', reject);
      req.write('{"name":');
      reqPromise
        .then(() => new Promise((r) => setTimeout(r, 10)))
        .then(() => {
          ctx.db.revokeAllSessionsByUsername('crud_admin_1');
          req.end('"受信中失効カテゴリ"}');
        })
        .catch(reject);
    });
  const revokedDuringBody = await sendChunkedDuringRevoke();
  assert.equal(revokedDuringBody.status, 401);
  assert.equal(revokedDuringBody.body.code, 'SESSION_EXPIRED');
  assert.equal(
    ctx.db.listCategoriesWithThreads().some((c) => c.name === '受信中失効カテゴリ'),
    false
  );

  // 3. 新しい管理者セッションで監査ログに Web 操作が一通り記録され、秘密を含まないことを確認
  const freshAdmin = createDirectUserSessionCookie(ctx, { username: 'audit_reader', role: 'admin' });
  const auditRes = await fetch(`${origin}/board/api/admin/audit-logs?limit=20`, {
    headers: { Cookie: freshAdmin.cookie },
  });
  assert.equal(auditRes.status, 200);
  const auditRaw = await auditRes.text();
  assert.equal(auditRaw.includes(admin2TokenHash), false);
  const auditData = JSON.parse(auditRaw);
  const actions = auditData.logs.map((l) => l.action);
  assert.ok(actions.includes('category_create'));
  assert.ok(actions.includes('category_update'));
  assert.ok(actions.includes('thread_create'));
  assert.ok(actions.includes('thread_update'));
  assert.ok(actions.includes('thread_purge'));
  assert.ok(actions.includes('category_delete'));
  const adminWebLog = auditData.logs.find((l) => l.actorUsername === admin1.username);
  assert.equal(adminWebLog.actorType, 'admin_web');
});

test('v1.2 ロール・権限管理(API・競合・投稿制限)', async (t) => {
  const http = require('node:http');
  const fastScryptQueue = createScryptQueue({ scryptFn: makeFastScryptFn() });
  const ctx = await startTestServer({
    scryptQueue: fastScryptQueue,
    devInsecureCookie: true,
    rateLimitMaxPosts: 100,
    authRateLimitMaxPerIp: 100,
    authRateLimitMaxPerAccount: 100,
  });
  t.after(() => ctx.stop());
  const origin = ctx.baseUrl;

  const { user: normalUser, cookie: normalCookie, tokenHash: normalTokenHash } = createDirectUserSessionCookie(ctx, {
    username: 'v12_normal_user',
    role: 'user',
  });
  const { cookie: tempAdminCookie } = createDirectUserSessionCookie(ctx, {
    username: 'v12_temp_admin',
    role: 'admin',
    mustChangePassword: true,
  });
  const { user: adminUser, cookie: adminCookie } = createDirectUserSessionCookie(ctx, {
    username: 'v12_root_admin',
    role: 'admin',
    mustChangePassword: false,
  });

  // 1. 新規4管理APIの認可マトリクス (guest 401 / user 403 / 仮PW admin 403 / Origin 403 / no-store)
  const newAdminTargets = [
    { path: '/api/admin/permissions', method: 'GET' },
    { path: '/api/admin/permissions/guest', method: 'PUT', body: { permissions: { create_post: true } } },
    { path: `/api/admin/users/${normalUser.id}/role`, method: 'PATCH', body: { role: 'user' } },
    { path: `/api/admin/users/${normalUser.id}/revoke-sessions`, method: 'POST', body: {} },
  ];

  for (const tgt of newAdminTargets) {
    const isMut = tgt.method !== 'GET';
    const makeHeaders = (extra = {}) => ({
      ...(isMut ? { 'Content-Type': 'application/json', Origin: origin } : {}),
      ...extra,
    });

    const guestRes = await fetch(`${origin}${tgt.path}`, {
      method: tgt.method,
      headers: makeHeaders(),
      ...(isMut ? { body: JSON.stringify(tgt.body) } : {}),
    });
    assert.equal(guestRes.status, 401, `guest rejected at ${tgt.method} ${tgt.path}`);
    assert.equal(guestRes.headers.get('cache-control'), 'no-store');

    const userRes = await fetch(`${origin}${tgt.path}`, {
      method: tgt.method,
      headers: makeHeaders({ Cookie: normalCookie }),
      ...(isMut ? { body: JSON.stringify(tgt.body) } : {}),
    });
    assert.equal(userRes.status, 403, `user rejected at ${tgt.method} ${tgt.path}`);
    assert.equal(userRes.headers.get('cache-control'), 'no-store');

    const tempRes = await fetch(`${origin}${tgt.path}`, {
      method: tgt.method,
      headers: makeHeaders({ Cookie: tempAdminCookie }),
      ...(isMut ? { body: JSON.stringify(tgt.body) } : {}),
    });
    assert.equal(tempRes.status, 403, `temp admin rejected at ${tgt.method} ${tgt.path}`);
    assert.equal((await tempRes.json()).code, 'PASSWORD_CHANGE_REQUIRED');

    if (isMut) {
      const noOriginRes = await fetch(`${origin}${tgt.path}`, {
        method: tgt.method,
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify(tgt.body),
      });
      assert.equal(noOriginRes.status, 403, `missing Origin rejected at ${tgt.method} ${tgt.path}`);

      const wrongOriginRes = await fetch(`${origin}${tgt.path}`, {
        method: tgt.method,
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: adminCookie },
        body: JSON.stringify(tgt.body),
      });
      assert.equal(wrongOriginRes.status, 403, `cross Origin rejected at ${tgt.method} ${tgt.path}`);
    }
  }

  // 2. GET / PUT /api/admin/permissions 異常系・伝播・POST /api/posts 強制
  const getPermsRes = await fetch(`${origin}/board/api/admin/permissions`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(getPermsRes.status, 200);
  const getPermsData = await getPermsRes.json();
  assert.equal(getPermsData.permissions.admin.create_post, true);
  assert.equal(getPermsData.permissions.guest.create_post, true);

  const editAdminPermRes = await fetch(`${origin}/api/admin/permissions/admin`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie },
    body: JSON.stringify({ permissions: { create_post: false } }),
  });
  assert.equal(editAdminPermRes.status, 400);

  const unknownKeyRes = await fetch(`${origin}/api/admin/permissions/guest`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie },
    body: JSON.stringify({ permissions: { bad_perm: false } }),
  });
  assert.equal(unknownKeyRes.status, 400);
  assert.equal((await unknownKeyRes.json()).code, 'UNKNOWN_PERMISSION_KEY');

  // guest の create_post を false にする → bootstrap / me / POST /api/posts に即時反映
  const disableGuestRes = await fetch(`${origin}/board/api/admin/permissions/guest`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie },
    body: JSON.stringify({ permissions: { create_post: false } }),
  });
  assert.equal(disableGuestRes.status, 200);
  const disableGuestJson = await disableGuestRes.json();
  assert.equal(disableGuestJson.allPermissions.guest.create_post, false);

  const guestBoot = await (await fetch(`${origin}/api/bootstrap`)).json();
  assert.equal(guestBoot.permissions.create_post, false);
  const guestMe = await (await fetch(`${origin}/api/auth/me`)).json();
  assert.equal(guestMe.permissions.create_post, false);

  const guestPostDenied = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ thread_id: 1, author_name: 'ゲスト', content: '停止中投稿' }),
  });
  assert.equal(guestPostDenied.status, 403);
  assert.equal((await guestPostDenied.json()).code, 'PERMISSION_DENIED');

  // user / admin は引き続き 201 投稿可能
  const userPostAllowed = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: normalCookie },
    body: JSON.stringify({
      thread_id: 1,
      content: 'guest停止中の会員投稿',
      expect_auth: true,
      expected_user_id: normalUser.id,
    }),
  });
  assert.equal(userPostAllowed.status, 201);

  const adminPostAllowed = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie },
    body: JSON.stringify({
      thread_id: 1,
      content: 'guest停止中の管理者投稿',
      expect_auth: true,
      expected_user_id: adminUser.id,
    }),
  });
  assert.equal(adminPostAllowed.status, 201);

  // user の create_post を false にする → user 403 / admin 201
  const disableUserRes = await fetch(`${origin}/api/admin/permissions/user`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie },
    body: JSON.stringify({ permissions: { create_post: false } }),
  });
  assert.equal(disableUserRes.status, 200);

  const userPostDenied = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: normalCookie },
    body: JSON.stringify({
      thread_id: 1,
      content: 'user停止中投稿',
      expect_auth: true,
      expected_user_id: normalUser.id,
    }),
  });
  assert.equal(userPostDenied.status, 403);
  assert.equal((await userPostDenied.json()).code, 'PERMISSION_DENIED');

  const adminStillAllowed = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie },
    body: JSON.stringify({
      thread_id: 1,
      content: 'admin常時許可投稿',
      expect_auth: true,
      expected_user_id: adminUser.id,
    }),
  });
  assert.equal(adminStillAllowed.status, 201);

  // パスワード変更(強制ログアウト)と通常ログアウトが guest permissions を返すこと
  const regPwRes = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'v12_pw_sync_user', password: 'pw-sync-pass-123' }),
  });
  assert.equal(regPwRes.status, 201);
  const regPwCookie = extractSetCookiePair(regPwRes);
  const regPwJson = await regPwRes.json();
  assert.equal(regPwJson.permissions.create_post, false);

  const pwChangeRes = await fetch(`${origin}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: regPwCookie },
    body: JSON.stringify({ currentPassword: 'pw-sync-pass-123', newPassword: 'pw-sync-pass-456' }),
  });
  assert.equal(pwChangeRes.status, 200);
  assert.ok(pwChangeRes.headers.get('set-cookie')?.includes('Max-Age=0'));
  const pwChangeJson = await pwChangeRes.json();
  assert.deepEqual(pwChangeJson.permissions, {
    create_post: false,
    create_thread: false,
    pin_post: false,
    upload_image: false,
  });

  // 元に戻す (user/guest create_post: true)
  await fetch(`${origin}/api/admin/permissions/guest`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie },
    body: JSON.stringify({ permissions: { create_post: true } }),
  });
  await fetch(`${origin}/api/admin/permissions/user`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie },
    body: JSON.stringify({ permissions: { create_post: true } }),
  });

  // 3. ロール変更・同一ロール no-op・2管理者同時降格競合・自己降格・強制失効・受信中失効
  const promoteRes = await fetch(`${origin}/board/api/admin/users/${normalUser.id}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie },
    body: JSON.stringify({ role: 'admin' }),
  });
  assert.equal(promoteRes.status, 200);
  const promoteJson = await promoteRes.json();
  assert.equal(promoteJson.unchanged, false);
  assert.equal(promoteJson.user.role, 'admin');
  assert.equal(promoteJson.revokedSessions, 1);
  assert.equal(promoteJson.selfSessionRevoked, false);

  // 旧 Cookie は /api/auth/me で user:null + Clear-Cookie となり、認証必須 API は即座に 401
  const staleMemberMe = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: normalCookie } });
  assert.equal(staleMemberMe.status, 200);
  assert.ok(staleMemberMe.headers.get('set-cookie')?.includes('Max-Age=0'));
  assert.equal((await staleMemberMe.json()).user, null);
  const staleMemberAdmin = await fetch(`${origin}/api/admin/overview`, { headers: { Cookie: normalCookie } });
  assert.equal(staleMemberAdmin.status, 401);

  // 昇格した v12_normal_user に新しい管理者セッションを発行
  const normalFreshToken = generateSessionToken();
  const normalFreshCookie = `${ctx.cookieName}=${normalFreshToken}`;
  ctx.db.issueSessionIfVersionMatches({
    userId: normalUser.id,
    expectedAuthVersion: ctx.db.getUserForAuthByUsername('v12_normal_user').auth_version,
    tokenHash: hashSessionToken(normalFreshToken),
    expiresAt: '2099-01-01T00:00:00.000Z',
    nowIso: new Date().toISOString(),
  });

  // 同一ロール PATCH は unchanged: true・revokedSessions: 0・セッション維持
  const noopRoleRes = await fetch(`${origin}/api/admin/users/${normalUser.id}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie },
    body: JSON.stringify({ role: 'admin' }),
  });
  assert.equal(noopRoleRes.status, 200);
  const noopRoleJson = await noopRoleRes.json();
  assert.equal(noopRoleJson.unchanged, true);
  assert.equal(noopRoleJson.revokedSessions, 0);
  assert.equal((await fetch(`${origin}/api/auth/me`, { headers: { Cookie: normalFreshCookie } })).status, 200);

  // v12_temp_admin を仮PW解除前に一旦降格（残り2管理者: adminUser, normalUser 状態にするため）
  const clearTempRole = await fetch(`${origin}/api/admin/users/${ctx.db.getUserForAuthByUsername('v12_temp_admin').id}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie },
    body: JSON.stringify({ role: 'user' }),
  });
  assert.equal(clearTempRole.status, 200);
  assert.equal(ctx.db.getAdminOverview().summary.adminsCount, 2);

  // 2管理者による同時自己降格レース: 一方のみ 200 (selfSessionRevoked: true)、もう一方は 409 LAST_ADMIN_PROTECTED で adminsCount >= 1 を守る
  const [raceA, raceB] = await Promise.all([
    fetch(`${origin}/api/admin/users/${normalUser.id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: normalFreshCookie },
      body: JSON.stringify({ role: 'user' }),
    }),
    fetch(`${origin}/api/admin/users/${adminUser.id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: adminCookie },
      body: JSON.stringify({ role: 'user' }),
    }),
  ]);
  const statuses = [raceA.status, raceB.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  const winnerRes = raceA.status === 200 ? raceA : raceB;
  const loserRes = raceA.status === 409 ? raceA : raceB;
  assert.ok(winnerRes.headers.get('set-cookie')?.includes('Max-Age=0'));
  assert.equal((await winnerRes.json()).selfSessionRevoked, true);
  assert.equal((await loserRes.json()).code, 'LAST_ADMIN_PROTECTED');
  assert.equal(ctx.db.getAdminOverview().summary.adminsCount, 1);

  // 残った1名の管理者を特定してセッション再発行（self-revoke / chunked revoke 検証用）
  const survivingAdmin =
    ctx.db.getUserForAuthByUsername('v12_root_admin').role === 'admin'
      ? ctx.db.getUserForAuthByUsername('v12_root_admin')
      : ctx.db.getUserForAuthByUsername('v12_normal_user');
  const otherUser =
    survivingAdmin.id === adminUser.id ? normalUser : adminUser;
  const makeFreshCookieFor = (userRow) => {
    const tok = generateSessionToken();
    ctx.db.issueSessionIfVersionMatches({
      userId: userRow.id,
      expectedAuthVersion: userRow.auth_version,
      tokenHash: hashSessionToken(tok),
      expiresAt: '2099-01-01T00:00:00.000Z',
      nowIso: new Date().toISOString(),
    });
    return { cookie: `${ctx.cookieName}=${tok}`, rawTok: tok };
  };
  const { cookie: freshAdminCookie } = makeFreshCookieFor(survivingAdmin);
  const { cookie: targetCookie } = makeFreshCookieFor(
    ctx.db.getUserForAuthByUsername(otherUser.username)
  );

  // 他ユーザーへの強制ログアウト（POST revoke-sessions）
  const revokeOtherRes = await fetch(`${origin}/board/api/admin/users/${otherUser.id}/revoke-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: freshAdminCookie },
    body: '{}',
  });
  assert.equal(revokeOtherRes.status, 200);
  const revokeOtherJson = await revokeOtherRes.json();
  assert.equal(revokeOtherJson.revokedSessions, 1);
  assert.equal(revokeOtherJson.selfSessionRevoked, false);
  const targetAfterRevokeMe = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: targetCookie } });
  assert.equal(targetAfterRevokeMe.status, 200);
  assert.ok(targetAfterRevokeMe.headers.get('set-cookie')?.includes('Max-Age=0'));
  assert.equal((await targetAfterRevokeMe.json()).user, null);
  const targetAfterRevokePost = await fetch(`${origin}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: targetCookie },
    body: JSON.stringify({ thread_id: 1, content: '失効後投稿拒否', expect_auth: true, expected_user_id: otherUser.id }),
  });
  assert.equal(targetAfterRevokePost.status, 401);

  // ボディ受信中のセッション失効が PATCH role と PUT permissions の両方を 401 SESSION_EXPIRED で阻止すること
  const sendChunkedRevoked = (reqPath, method, bodyStart, bodyEnd, sessionCookie) =>
    new Promise((resolve, reject) => {
      const reqPromise = new Promise((resReq) => ctx.server.once('request', resReq));
      const req = http.request(
        `${origin}${reqPath}`,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            Origin: origin,
            Cookie: sessionCookie,
            Connection: 'close',
          },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        }
      );
      req.on('error', reject);
      req.write(bodyStart);
      reqPromise
        .then(() => new Promise((r) => setTimeout(r, 10)))
        .then(() => {
          ctx.db.revokeAllSessionsByUsername(survivingAdmin.username);
          req.end(bodyEnd);
        })
        .catch(reject);
    });

  const revokedChunkRole = await sendChunkedRevoked(
    `/api/admin/users/${otherUser.id}/role`,
    'PATCH',
    '{"role":',
    '"admin"}',
    freshAdminCookie
  );
  assert.equal(revokedChunkRole.status, 401);
  assert.equal(revokedChunkRole.body.code, 'SESSION_EXPIRED');
  assert.equal(ctx.db.getUserForAuthByUsername(otherUser.username).role, 'user');

  const { cookie: freshAdminCookie2, rawTok: rawTok2 } = makeFreshCookieFor(
    ctx.db.getUserForAuthByUsername(survivingAdmin.username)
  );
  const revokedChunkPerm = await sendChunkedRevoked(
    '/api/admin/permissions/guest',
    'PUT',
    '{"permissions":',
    '{"create_post":false}}',
    freshAdminCookie2
  );
  assert.equal(revokedChunkPerm.status, 401);
  assert.equal(revokedChunkPerm.body.code, 'SESSION_EXPIRED');
  assert.equal(ctx.db.getEffectivePermissionsForRole('guest').create_post, true);

  // 自己強制ログアウト (selfSessionRevoked: true + Set-Cookie 削除)
  const { cookie: freshAdminCookie3, rawTok: rawTok3 } = makeFreshCookieFor(
    ctx.db.getUserForAuthByUsername(survivingAdmin.username)
  );
  const selfRevokeRes = await fetch(`${origin}/api/admin/users/${survivingAdmin.id}/revoke-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: freshAdminCookie3 },
    body: '{}',
  });
  assert.equal(selfRevokeRes.status, 200);
  assert.ok(selfRevokeRes.headers.get('set-cookie')?.includes('Max-Age=0'));
  assert.equal((await selfRevokeRes.json()).selfSessionRevoked, true);

  // 4. 秘密情報非露出検査（管理API一覧・権限・監査ログ）
  const { cookie: inspectCookie } = makeFreshCookieFor(
    ctx.db.getUserForAuthByUsername(survivingAdmin.username)
  );
  for (const inspectPath of ['/api/admin/permissions', '/api/admin/users?limit=20', '/api/admin/audit-logs?limit=50']) {
    const raw = await (await fetch(`${origin}${inspectPath}`, { headers: { Cookie: inspectCookie } })).text();
    for (const secretSubstr of ['scrypt$', normalTokenHash, rawTok2, rawTok3]) {
      assert.equal(raw.includes(secretSubstr), false, `${inspectPath} must not expose secrets`);
    }
  }
});
