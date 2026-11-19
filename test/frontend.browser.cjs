'use strict';

// 実際のフロントを専用Chromeプロファイルで動かす。DBはメモリ内、通信先はループバックだけ。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createBoardDb } = require('../src/db');
const { runSeed } = require('../src/seed');
const { createApp } = require('../src/app');
const { createScryptQueue } = require('../src/auth');

test('実ブラウザで下書き・遅延応答・入力シートを検証する', { timeout: 60000 }, async (t) => {
  const browserPath = process.env.CHROME_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((candidate) => fs.existsSync(candidate));
  assert.ok(browserPath, 'Chrome/Edgeが必要です。CHROME_PATHに実行ファイルを指定してください。');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'board-browser-test-'));
  const db = createBoardDb({ dbPath: ':memory:' });
  runSeed(db);
  const server = createApp({ db, idSecret: 'frontend_browser_test_secret_32chars', devInsecureCookie: true, quiet: true });
  let holdPostResponse = false;
  let finishPost = null;
  let failThread = null;
  server.prependListener('request', (req, res) => {
    if (req.url === '/board/api/posts' && holdPostResponse) {
      const originalEnd = res.end;
      res.end = function (...args) {
        finishPost = () => originalEnd.apply(res, args);
        return res;
      };
    }
    if (req.url === '/board/api/threads/' + failThread) {
      const originalWriteHead = res.writeHead;
      res.writeHead = function (status, ...args) {
        return originalWriteHead.call(res, 503, ...args);
      };
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/board/';
  const browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--user-data-dir=' + profile, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  let socket;
  t.after(async () => {
    finishPost?.();
    socket?.close();
    if (browser.exitCode === null) {
      const exited = once(browser, 'exit');
      browser.kill();
      await Promise.race([exited, delay(2000)]);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    // mkdtempで作った対象だけを削除する。実ユーザーのブラウザプロファイルには接続しない。
    if (path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
  });

  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; !fs.existsSync(portFile) && attempt < 100; attempt += 1) {
    await delay(100);
  }
  assert.ok(fs.existsSync(portFile), 'ブラウザの起動に失敗しました。');
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  let commandId = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    const command = pending.get(message.id);
    if (!command) return;
    pending.delete(message.id);
    clearTimeout(command.timer);
    if (message.error) command.reject(new Error(JSON.stringify(message.error)));
    else command.resolve(message.result);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++commandId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function waitFor(expression) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await evaluate(expression)) return;
      await delay(30);
    }
    assert.fail('条件が成立しません: ' + expression);
  }
  const click = (selector) => evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
  async function write(value) {
    await evaluate("document.querySelector('#comment-body').value = " + JSON.stringify(value) +
      "; document.querySelector('#comment-body').dispatchEvent(new Event('input', { bubbles: true }))");
  }
  async function switchThread(id, title) {
    await click('button[data-thread-id="' + id + '"]');
    await waitFor("document.querySelector('#thread-title').textContent === " + JSON.stringify(title));
  }
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await waitFor("document.querySelector('#thread-title')?.textContent === '雑談'");
  await evaluate("document.documentElement.style.scrollBehavior = 'auto'");

  await t.test('別スレッドの下書きと返信先を保持し、再開する', async () => {
    await click('button[data-reply-id="1"]');
    await write('Aの返信下書き');
    await switchThread(2, '質問、初心者質問');
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), '');
    await write('Bの下書き');
    await switchThread(1, '雑談');
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), 'Aの返信下書き');
    assert.match(await evaluate("document.querySelector('#composer-mode-badge').textContent"), /#1/);
    await click('#composer-close');
    await click('#write-comment');
    assert.match(await evaluate("document.querySelector('#composer-mode-badge').textContent"), /#1/);
    await switchThread(2, '質問、初心者質問');
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), 'Bの下書き');
  });

  await t.test('取得失敗で下書きを失わず送信停止し、再取得で別の下書きへ切り替わる', async () => {
    failThread = 3;
    await click('button[data-thread-id="3"]');
    await waitFor("document.querySelector('#submit-button').disabled");
    await waitFor("document.querySelector('#composer-thread-target').textContent.includes('取得失敗')");
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), 'Bの下書き');
    failThread = null;
    await click('#reload-thread');
    await waitFor("document.querySelector('#thread-title').textContent === 'あいさつ・自己紹介'");
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), '');
  });

  await t.test('送信完了が遅れても移動先の同一本文を消さず、送信元の保存済み下書きだけ消す', async () => {
    await switchThread(1, '雑談');
    await write('同じ本文でも別の下書き');
    holdPostResponse = true;
    await evaluate("document.querySelector('#comment-form').requestSubmit()");
    for (let i = 0; !finishPost && i < 100; i += 1) await delay(30);
    assert.ok(finishPost);
    await switchThread(2, '質問、初心者質問');
    await write('同じ本文でも別の下書き');
    finishPost();
    finishPost = null;
    holdPostResponse = false;
    await waitFor("!document.querySelector('#submit-button').disabled");
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), '同じ本文でも別の下書き');
    await switchThread(1, '雑談');
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), '');
    assert.ok(db.getThreadDetail(1).posts.some((post) => post.content === '同じ本文でも別の下書き' && post.parent_id === 1));
    assert.equal(db.getThreadDetail(2).posts.some((post) => post.content === '同じ本文でも別の下書き'), false);
  });

  await t.test('同じ本文でも送信中に返信先を変えた下書きを保持し、削除された返信先は通知する', async () => {
    await click('button[data-reply-id="1"]');
    await write('返信先を変える下書き');
    holdPostResponse = true;
    await evaluate("document.querySelector('#comment-form').requestSubmit()");
    for (let i = 0; !finishPost && i < 100; i += 1) await delay(30);
    assert.ok(finishPost);
    await click('button[data-reply-id="2"]');
    finishPost();
    finishPost = null;
    holdPostResponse = false;
    await waitFor("!document.querySelector('#submit-button').disabled");
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), '返信先を変える下書き');
    assert.match(await evaluate("document.querySelector('#composer-mode-badge').textContent"), /#2/);
    await switchThread(2, '質問、初心者質問');
    db.softDeletePost(2);
    await switchThread(1, '雑談');
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), '返信先を変える下書き');
    assert.match(await evaluate("document.querySelector('#form-error').textContent"), /返信先が見つからない/);
    assert.match(await evaluate("document.querySelector('#composer-mode-badge').textContent"), /新規投稿/);
  });

  await t.test('320pxでも横にはみ出さず、入力シートをスクロールしても送信ボタンが残る', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 240, deviceScaleFactor: 1, mobile: true });
    await click('#write-comment');
    await delay(350);
    const metrics = await evaluate(`(() => {
      const drawer = document.querySelector('#composer-drawer');
      drawer.scrollTop = drawer.scrollHeight;
      const bounds = drawer.getBoundingClientRect();
      const button = document.querySelector('#submit-button').getBoundingClientRect();
      return { width: drawer.clientWidth, scrollWidth: drawer.scrollWidth, height: drawer.clientHeight, scrollHeight: drawer.scrollHeight, top: button.top, bottom: button.bottom, drawerTop: bounds.top, drawerBottom: bounds.bottom };
    })()`);
    assert.ok(metrics.scrollWidth <= metrics.width, JSON.stringify(metrics));
    assert.ok(metrics.scrollHeight > metrics.height, JSON.stringify(metrics));
    assert.ok(metrics.top >= metrics.drawerTop && metrics.bottom <= metrics.drawerBottom, JSON.stringify(metrics));
    await switchThread(2, '質問、初心者質問');
    await click('#write-comment');
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), '同じ本文でも別の下書き');
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 480, deviceScaleFactor: 1, mobile: true });
  });

  await t.test('URLハッシュ(#thread-X)およびリロードで選択中スレッドが復元されること', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: url + '#thread-2' });
    await waitFor("document.querySelector('#thread-title')?.textContent === '質問、初心者質問'");
    assert.equal(await evaluate("document.querySelector('#thread-title')?.textContent"), '質問、初心者質問');
    assert.equal(await evaluate("location.hash"), '#thread-2');

    // サイドバーの独立スクロール設定 (max-height, overflow-y: auto) が反映されていること
    const sidebarStyle = await evaluate(`(() => {
      const sb = document.querySelector('.sidebar');
      const cs = window.getComputedStyle(sb);
      return { overflowY: cs.overflowY, position: cs.position };
    })()`);
    assert.equal(sidebarStyle.overflowY, 'auto');
    assert.equal(sidebarStyle.position, 'sticky');
  });

  await t.test('✕ボタンおよび外側（バックドロップ）クリックで入力欄が隠れること', async () => {
    // 1. 新規投稿を開く
    await click('#write-comment');
    await waitFor("document.querySelector('#composer-drawer').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#composer-drawer').classList.contains('is-open')"), true);
    assert.equal(await evaluate("document.querySelector('#composer-backdrop').hidden"), false);

    // 2. ✕ボタン（#composer-close）を押すと閉じる
    await click('#composer-close');
    await waitFor("!document.querySelector('#composer-drawer').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#composer-drawer').classList.contains('is-open')"), false);
    assert.equal(await evaluate("document.querySelector('#composer-backdrop').hidden"), true);

    // 3. 再び開き、外側（#composer-backdrop）をクリックすると閉じる
    await click('#write-comment');
    await waitFor("document.querySelector('#composer-drawer').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#composer-drawer').classList.contains('is-open')"), true);

    await click('#composer-backdrop');
    await waitFor("!document.querySelector('#composer-drawer').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#composer-drawer').classList.contains('is-open')"), false);
    assert.equal(await evaluate("document.querySelector('#composer-backdrop').hidden"), true);
  });

  await t.test('24時間以内の新着スレッドにNEWバッジが表示され、サイドバーに説明があること', async () => {
    // 1. スレッド一覧に .new-badge が存在すること（テスト用seedデータは直近生成）
    const badgeCount = await evaluate("document.querySelectorAll('.thread-card .new-badge').length");
    assert.ok(badgeCount > 0);

    // 2. サイドバーの「はじめての方へ」にNEWの説明があり、3層ツリーの文言が消えていること
    const noteText = await evaluate("document.querySelector('.sidebar-note')?.textContent || ''");
    assert.ok(noteText.includes('NEW'));
    assert.ok(!noteText.includes('3層'));

    // 3. フッターに著作権表記が表示されていること
    const footerText = await evaluate("document.querySelector('.page-footer')?.textContent || ''");
    assert.ok(footerText.includes('© 2026 KoohiQK'));
  });

  await t.test('古いスレッドへの投稿直後・更新ボタン押下直後にF5なしでNEWバッジが即時点灯すること', async () => {
    // 全スレッド・全投稿を2020年に戻してNEWがない状態を作る
    db.execRawForTesting("UPDATE posts SET created_at = '2020-01-01T00:00:00.000Z'");
    db.execRawForTesting("UPDATE threads SET created_at = '2020-01-01T00:00:00.000Z'");
    await send('Page.navigate', { url: url + '?testNewSync=1#thread-1' });
    await waitFor("document.querySelector('#thread-title')?.textContent === '雑談' && document.querySelectorAll('.thread-card .new-badge').length === 0");
    assert.equal(await evaluate("document.querySelectorAll('.category-button .new-dot').length"), 0);

    // 1. 投稿直後にF5なしでNEWバッジとカテゴリドットが即時表示されること
    await click('#write-comment');
    await write('NEW_IMMEDIATE_TEST');
    await evaluate("document.querySelector('#comment-form').requestSubmit()");
    await waitFor("!document.querySelector('#submit-button').disabled && document.querySelector('#comment-body').value === ''");
    assert.equal(await evaluate("!!document.querySelector('.thread-card[data-thread-id=\"1\"] .new-badge')"), true);
    assert.equal(await evaluate("!!document.querySelector('.category-button[aria-current=\"true\"] .new-dot')"), true);

    // 2. 別スレッドに切り替えた状態でDBに直接別ユーザーの投稿を追加し、更新ボタン(#reload-thread)でNEWが点灯すること
    const otherThreadId = await evaluate("Number(document.querySelectorAll('.thread-card')[1]?.dataset.threadId)");
    assert.ok(otherThreadId > 1);
    await click(`.thread-card[data-thread-id="${otherThreadId}"]`);
    await waitFor(`document.querySelector('.thread-card[data-thread-id="${otherThreadId}"]')?.getAttribute('aria-pressed') === 'true'`);
    assert.equal(await evaluate(`!!document.querySelector('.thread-card[data-thread-id="${otherThreadId}"] .new-badge')`), false);

    db.createPost({ threadId: otherThreadId, authorName: '他ユーザー', visitorId: 'OTHERUSER1', content: 'OTHER_USER_POST' });
    await click('#reload-thread');
    await waitFor(`!!document.querySelector('.thread-card[data-thread-id="${otherThreadId}"] .new-badge')`);
    assert.equal(await evaluate(`!!document.querySelector('.thread-card[data-thread-id="${otherThreadId}"] .new-badge')`), true);
  });

  await t.test('会員登録・会員投稿・リロード維持・セッション切れ下書き保護・仮パスワード変更・ログアウトを実ブラウザで検証する', async () => {
    const setField = async (selector, value) => {
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)};` +
          `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('input', { bubbles: true }));`
      );
    };

    await send('Page.navigate', { url: url + '?authTest=1#thread-1' });
    await waitFor("document.querySelector('#thread-title')?.textContent === '雑談'");

    // 1. 新規登録してログイン状態になり、パスワード欄がクリアされること
    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#auth-tab-register');
    await setField('#register-username', 'ブラウザ会員');
    await setField('#register-password', 'browser-pass-1234');
    await setField('#register-password-confirm', 'browser-pass-1234');
    await evaluate("document.querySelector('#register-form').requestSubmit()");
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'ブラウザ会員' && !document.querySelector('#auth-sheet').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#register-password').value"), '');
    assert.equal(await evaluate("document.querySelector('#register-password-confirm').value"), '');

    // 2. 会員として投稿すると名前欄が固定され、会員バッジ付きで表示され、リロード後も維持されること
    await click('#write-comment');
    await waitFor("document.querySelector('#composer-drawer').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#author-name').value"), 'ブラウザ会員');
    assert.equal(await evaluate("document.querySelector('#author-name').readOnly"), true);

    await write('会員投稿テスト本文');
    await evaluate("document.querySelector('#comment-form').requestSubmit()");
    await waitFor("!document.querySelector('#submit-button').disabled && document.querySelector('#comment-body').value === ''");
    assert.ok(await evaluate("document.querySelectorAll('.member-badge').length >= 1"));
    assert.ok(await evaluate("document.body.textContent.includes('会員投稿テスト本文')"));

    await send('Page.navigate', { url: url + '?authReload=1#thread-1' });
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'ブラウザ会員' && document.querySelectorAll('.member-badge').length >= 1");

    // 3. 投稿前にセッションが切れた場合：401 SESSION_EXPIRED で下書きを保持し、選択後に匿名投稿できること
    await click('#write-comment');
    await waitFor("document.querySelector('#composer-drawer').classList.contains('is-open')");
    await write('セッション切れでも消えない下書き');
    db.revokeAllSessionsByUsername('ブラウザ会員');
    await evaluate("document.querySelector('#comment-form').requestSubmit()");

    await waitFor("!document.querySelector('#session-expired-box').hidden");
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), 'セッション切れでも消えない下書き');
    assert.equal(await evaluate("document.querySelector('#auth-open-label').textContent"), 'ログイン');
    assert.equal(db.getThreadDetail(1).posts.some((p) => p.content === 'セッション切れでも消えない下書き'), false);

    await click('#expired-anon-btn');
    await waitFor("document.querySelector('#session-expired-box').hidden && document.querySelector('#comment-body').value === ''");
    const anonRecovered = db.getThreadDetail(1).posts.find((p) => p.content === 'セッション切れでも消えない下書き');
    assert.ok(anonRecovered);
    assert.equal(anonRecovered.is_member, false);

    // 4. 管理者仮パスワード設定後の強制変更UI・投稿ブロック・変更完了後の再ログイン＆ログアウト
    const tempHash = await createScryptQueue().hashPassword('temp-browser-1234');
    db.resetPasswordByUsername({ username: 'ブラウザ会員', newPasswordHash: tempHash });

    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#auth-tab-login');
    await setField('#login-username', 'ブラウザ会員');
    await setField('#login-password', 'temp-browser-1234');
    await evaluate("document.querySelector('#login-form').requestSubmit()");

    await waitFor("!document.querySelector('#auth-member-panel').hidden && !document.querySelector('#must-change-banner').hidden");
    assert.equal(await evaluate("document.querySelector('#logout-button').disabled"), false);

    await click('#auth-close');
    await waitFor("!document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#write-comment');
    await waitFor("!document.querySelector('#composer-must-change-box').hidden");
    assert.equal(await evaluate("document.querySelector('#submit-button').disabled"), true);

    await click('#composer-open-password-btn');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await setField('#current-password', 'temp-browser-1234');
    await setField('#new-password', 'final-browser-5678');
    await setField('#new-password-confirm', 'final-browser-5678');
    await evaluate("document.querySelector('#password-form').requestSubmit()");

    await waitFor("!document.querySelector('#auth-guest-panel').hidden && document.querySelector('#auth-open-label').textContent === 'ログイン'");
    assert.equal(await evaluate("document.querySelector('#current-password').value"), '');
    assert.equal(await evaluate("document.querySelector('#new-password').value"), '');
    assert.equal(await evaluate("document.querySelector('#new-password-confirm').value"), '');

    await setField('#login-username', 'ブラウザ会員');
    await setField('#login-password', 'final-browser-5678');
    await evaluate("document.querySelector('#login-form').requestSubmit()");
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'ブラウザ会員' && !document.querySelector('#auth-sheet').classList.contains('is-open')");

    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#logout-button');
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'ログイン' && !document.querySelector('#auth-sheet').classList.contains('is-open')");
  });

  await t.test('レビュー回帰(F1/F3): ログアウト失敗時に成功誤表示しないこと・非BMP会員名での登録と投稿', async () => {
    const setField = async (selector, value) => {
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)};` +
          `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('input', { bubbles: true }));`
      );
    };

    await send('Page.navigate', { url: url + '?reviewRegression=1#thread-1' });
    await waitFor("document.querySelector('#thread-title')?.textContent === '雑談'");

    // F1-1: ログアウト用アカウント登録 -> 503失敗時に「ログアウトしました。」にならずログイン維持されること
    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#auth-tab-register');
    await setField('#register-username', 'f1_logout_user');
    await setField('#register-password', 'logout-pass-1234');
    await setField('#register-password-confirm', 'logout-pass-1234');
    await evaluate("document.querySelector('#register-form').requestSubmit()");
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'f1_logout_user' && !document.querySelector('#auth-sheet').classList.contains('is-open')");

    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await setField('#current-password', 'unsent-secret-pass');
    await evaluate(`
      window.__origFetch = window.fetch.bind(window);
      window.fetch = (input, options) =>
        String(input).includes('api/auth/logout')
          ? Promise.resolve(new Response(JSON.stringify({ error: '一時的な過負荷です' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            }))
          : window.__origFetch(input, options);
    `);
    await click('#logout-button');
    await waitFor("document.querySelector('#logout-error').textContent.length > 0 && !document.querySelector('#logout-button').disabled");

    const f1State503 = await evaluate(`(async () => ({
      label: document.querySelector('#auth-open-label').textContent,
      toast: document.querySelector('#toast').textContent,
      logoutError: document.querySelector('#logout-error').textContent,
      sheetOpen: document.querySelector('#auth-sheet').classList.contains('is-open'),
      currentPw: document.querySelector('#current-password').value,
      meUser: (await (await window.__origFetch('api/auth/me')).json()).user?.username || null,
    }))()`);
    assert.notEqual(f1State503.toast, 'ログアウトしました。');
    assert.equal(f1State503.label, 'f1_logout_user');
    assert.equal(f1State503.meUser, 'f1_logout_user');
    assert.equal(f1State503.sheetOpen, true);
    assert.equal(f1State503.currentPw, '');
    assert.ok(f1State503.logoutError.includes('過負荷'));

    // F1-2: 通信全断（logoutもmeも通信エラー）で状態不明のときは匿名状態へ降格させないこと
    await evaluate(`
      window.fetch = (input) =>
        (String(input).includes('api/auth/logout') || String(input).includes('api/auth/me'))
          ? Promise.reject(new TypeError('Failed to fetch'))
          : window.__origFetch(input);
    `);
    await click('#logout-button');
    await waitFor("document.querySelector('#logout-error').textContent.includes('通信エラー') && !document.querySelector('#logout-button').disabled");
    assert.equal(await evaluate("document.querySelector('#auth-open-label').textContent"), 'f1_logout_user');
    assert.equal(await evaluate("document.querySelector('#auth-sheet').classList.contains('is-open')"), true);
    assert.notEqual(await evaluate("document.querySelector('#toast').textContent"), 'ログアウトしました。');

    // F1-3: サーバー側ではセッション失効済み＋logout応答だけロストした場合は me 再照会で正しく未ログインへ同期すること
    db.revokeAllSessionsByUsername('f1_logout_user');
    await evaluate(`
      window.fetch = (input, options) =>
        String(input).includes('api/auth/logout')
          ? Promise.reject(new TypeError('Failed to fetch'))
          : window.__origFetch(input, options);
    `);
    await click('#logout-button');
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'ログイン' && !document.querySelector('#auth-sheet').classList.contains('is-open')");
    await evaluate('window.fetch = window.__origFetch');

    // F3: 非BMP Unicode（絵文字16個 = UTF-16 32単位）で画面登録 -> 投稿 -> リロード維持できること
    const emojiUser = '😀'.repeat(16);
    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#auth-tab-register');
    await setField('#register-username', emojiUser);
    await setField('#register-password', 'emoji-pass-1234');
    await setField('#register-password-confirm', 'emoji-pass-1234');
    assert.equal(await evaluate("document.querySelector('#register-username').value"), emojiUser);
    await evaluate("document.querySelector('#register-form').requestSubmit()");
    await waitFor(`document.querySelector('#auth-open-label')?.textContent === ${JSON.stringify(emojiUser)} && !document.querySelector('#auth-sheet').classList.contains('is-open')`);

    await click('#write-comment');
    await waitFor("document.querySelector('#composer-drawer').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#author-name').value"), emojiUser);
    await write('絵文字名での会員投稿本文');
    await evaluate("document.querySelector('#comment-form').requestSubmit()");
    await waitFor("!document.querySelector('#submit-button').disabled && document.querySelector('#comment-body').value === ''");

    await send('Page.navigate', { url: url + '?reviewEmojiReload=1#thread-1' });
    await waitFor(`document.querySelector('#auth-open-label')?.textContent === ${JSON.stringify(emojiUser)} && document.body.textContent.includes('絵文字名での会員投稿本文')`);
    assert.ok(await evaluate("document.querySelectorAll('.member-badge').length >= 1"));
  });

  if (process.env.FRONTEND_ARTIFACT_DIR) {
    fs.mkdirSync(process.env.FRONTEND_ARTIFACT_DIR, { recursive: true });
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.FRONTEND_ARTIFACT_DIR, 'mobile-composer.png'), Buffer.from(screenshot.data, 'base64'));
  }
  assert.deepEqual(errors, []);
});
