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

const TEST_ID_SECRET = 'test_secret_key_for_api_suite_32chars!';
const TEST_ADMIN_TOKEN = 'test_admin_token_for_api_suite_32chars!';

async function startTestServer(customOptions = {}) {
  const db = createBoardDb({ dbPath: ':memory:', ...customOptions.dbOptions });
  runSeed(db);

  const server = createApp({
    db,
    idSecret: TEST_ID_SECRET,
    adminToken: TEST_ADMIN_TOKEN,
    maxBodyBytes: customOptions.maxBodyBytes ?? 4096,
    rateLimitMaxPosts: customOptions.rateLimitMaxPosts ?? 30,
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
  assert.equal(categories.length, 2);

  const threadWithPin = categories[0].threads[0];
  const threadWithoutPin = categories[0].threads[1];

  // 2. スレッド切替時のタイトル・ピン留め文同期確認
  const t1Res = await fetch(`${ctx.baseUrl}/api/threads/${threadWithPin.id}`);
  const t1Data = await t1Res.json();
  assert.equal(t1Data.thread.title, '総合雑談スレッド');
  assert.ok(t1Data.thread.pinned_text.includes('総合雑談スレッド'));

  const t2Res = await fetch(`${ctx.baseUrl}/api/threads/${threadWithoutPin.id}`);
  const t2Data = await t2Res.json();
  assert.equal(t2Data.thread.title, '動作確認・フリートーク');
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
  const variantNames = ['initial-v0.5', 'sample-base', 'slide-drawer'];
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
});
