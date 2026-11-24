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
const { createScryptQueue, HTTPS_SESSION_COOKIE_NAME, DEV_SESSION_COOKIE_NAME } = require('../src/auth');

const TEST_ID_SECRET = 'test_secret_key_for_api_suite_32chars!';
const TEST_ADMIN_TOKEN = 'test_admin_token_for_api_suite_32chars!';

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

  const server = createApp({
    db,
    idSecret: TEST_ID_SECRET,
    adminToken: TEST_ADMIN_TOKEN,
    trustProxy: customOptions.trustProxy ?? false,
    allowedOrigin: customOptions.allowedOrigin ?? null,
    allowSignup: customOptions.allowSignup ?? true,
    devInsecureCookie: customOptions.devInsecureCookie ?? false,
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

  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }

  return { db, server, baseUrl, stop };
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

  // 4. 未認証での管理削除API直叩きは 401 で拒絶されること (T-07)
  const unauthDel = await fetch(`${ctx.baseUrl}/api/admin/posts/${createdParent.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauthDel.status, 401);

  // 5. 正規トークンでの論理削除後はAPIのJSONから元本文が消え、子返信は残ること (T-11)
  const authDel = await fetch(`${ctx.baseUrl}/api/admin/posts/${createdParent.id}/delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
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

  // 未認証でのピン留め要求は 401
  const unauthPin = await fetch(`${ctx.baseUrl}/api/admin/posts/${post.id}/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: true }),
  });
  assert.equal(unauthPin.status, 401);

  // 不正な型（文字列 "false" 等）は 400 で拒否
  const badTypePin = await fetch(`${ctx.baseUrl}/api/admin/posts/${post.id}/pin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ pinned: 'false' }),
  });
  assert.equal(badTypePin.status, 400);

  // 正規トークンでピン留め ON -> GET /api/threads/2 で is_pinned === 1 になること
  const pinOn = await fetch(`${ctx.baseUrl}/api/admin/posts/${post.id}/pin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ pinned: true }),
  });
  assert.equal(pinOn.status, 200);

  const afterPinThread = await (await fetch(`${ctx.baseUrl}/api/threads/2`)).json();
  assert.equal(afterPinThread.posts.find((p) => p.id === post.id).is_pinned, 1);

  // 正規トークンでピン留め OFF -> is_pinned === 0 に戻ること
  const pinOff = await fetch(`${ctx.baseUrl}/api/admin/posts/${post.id}/pin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
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

  const verifyDb = createBoardDb({ dbPath: cliDbPath });
  try {
    const u = verifyDb.getUserForAuthByUsername('cli_alice');
    assert.equal(u.role, 'admin');
    // set-role 時点で全セッションが失効されていること
    assert.equal(verifyDb.getSessionAuthByTokenHash('e'.repeat(64), '2026-11-19T01:00:00.000Z'), null);
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
