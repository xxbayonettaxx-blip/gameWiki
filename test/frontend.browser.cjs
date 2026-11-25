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
  const server = createApp({
    db,
    idSecret: 'frontend_browser_test_secret_32chars',
    devInsecureCookie: true,
    authRateLimitMaxPerIp: 100,
    quiet: true,
  });
  let holdPostResponse = false;
  let finishPost = null;
  let failThread = null;
  let bootstrapDelayMs = 0;
  let holdBootstrap = false;
  let finishBootstrap = null;
  let failBootstrapStatus = 0;
  let seenBootApiCalls = [];
  server.prependListener('request', (req, res) => {
    if (
      req.url.startsWith('/board/api/bootstrap') ||
      req.url.startsWith('/board/api/categories') ||
      req.url.startsWith('/board/api/threads/') ||
      req.url.startsWith('/board/api/auth/me')
    ) {
      seenBootApiCalls.push(req.url);
    }
    if (req.url.startsWith('/board/api/bootstrap')) {
      if (holdBootstrap) {
        const savedEnd = res.end;
        res.end = function (...args) {
          finishBootstrap = () => savedEnd.apply(res, args);
          return res;
        };
      }
      if (failBootstrapStatus) {
        const statusToSend = failBootstrapStatus;
        const origWriteHead = res.writeHead;
        res.writeHead = function (status, ...args) {
          return origWriteHead.call(res, statusToSend, ...args);
        };
      }
      if (bootstrapDelayMs > 0) {
        const delayMs = bootstrapDelayMs;
        const origEnd = res.end;
        res.end = function (...args) {
          setTimeout(() => origEnd.apply(res, args), delayMs);
          return res;
        };
      }
    }
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
    finishBootstrap?.();
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
      const closeLabel = document.querySelector('.composer-close-label');
      return {
        width: drawer.clientWidth,
        scrollWidth: drawer.scrollWidth,
        height: drawer.clientHeight,
        scrollHeight: drawer.scrollHeight,
        top: button.top,
        bottom: button.bottom,
        drawerTop: bounds.top,
        drawerBottom: bounds.bottom,
        closeLabelDisplay: closeLabel ? getComputedStyle(closeLabel).display : null,
      };
    })()`);
    assert.ok(metrics.scrollWidth <= metrics.width, JSON.stringify(metrics));
    assert.ok(metrics.scrollHeight > metrics.height, JSON.stringify(metrics));
    assert.ok(metrics.top >= metrics.drawerTop && metrics.bottom <= metrics.drawerBottom, JSON.stringify(metrics));
    assert.equal(metrics.closeLabelDisplay, 'none', JSON.stringify(metrics));
    await click('#composer-close');
    await waitFor("!document.querySelector('#composer-drawer').classList.contains('is-open')");
    await switchThread(2, '質問、初心者質問');
    await click('#write-comment');
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), '同じ本文でも別の下書き');
    await click('#composer-close');
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

  await t.test('✕ボタンおよび外側（バックドロップ）・Escキーで入力欄が隠れること', async () => {
    // 1. PC幅（1024px）では非モーダル（aria-modal="false"・バックドロップ非表示・背景操作可）で開く
    await click('#write-comment');
    await waitFor("document.querySelector('#composer-drawer').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#composer-drawer').getAttribute('aria-modal')"), 'false');
    assert.equal(await evaluate("document.querySelector('#composer-backdrop').hidden"), true);
    assert.equal(await evaluate("Boolean(document.querySelector('.site-shell').inert)"), false);

    // 2. ✕ボタン（#composer-close）を押すと閉じ、元のボタンへフォーカスが戻る
    await click('#composer-close');
    await waitFor("!document.querySelector('#composer-drawer').classList.contains('is-open')");
    assert.equal(await evaluate("document.activeElement?.id"), 'write-comment');

    // 3. PC幅では Esc キーでも閉じられること
    await click('#write-comment');
    await waitFor("document.querySelector('#composer-drawer').classList.contains('is-open')");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor("!document.querySelector('#composer-drawer').classList.contains('is-open')");

    // 4. モバイル幅（390px）ではモーダル（aria-modal="true"・背景inert）になり、外側クリックで閉じる
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await click('#write-comment');
    await waitFor("document.querySelector('#composer-drawer').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#composer-drawer').getAttribute('aria-modal')"), 'true');
    assert.equal(await evaluate("document.querySelector('#composer-backdrop').hidden"), false);
    assert.equal(await evaluate("Boolean(document.querySelector('.site-shell').inert)"), true);

    await click('#composer-backdrop');
    await waitFor("!document.querySelector('#composer-drawer').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#composer-backdrop').hidden"), true);
    assert.equal(await evaluate("Boolean(document.querySelector('.site-shell').inert)"), false);
    await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
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

  await t.test('Phase 1(T1/T2): bootstrap 1往復・遅延ローディング・503復旧・privacy.html導線と狭幅表示', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    // 1. 通常速度の初回表示では api/bootstrap のみ1往復で完了し、#initial-loading-status は出ない
    seenBootApiCalls = [];
    bootstrapDelayMs = 0;
    failBootstrapStatus = 0;
    await send('Page.navigate', { url: url + '?phase1Fast=1#thread-1' });
    await waitFor("document.querySelector('#thread-title')?.textContent === '雑談'");
    assert.deepEqual(seenBootApiCalls, ['/board/api/bootstrap?threadId=1']);
    assert.equal(await evaluate("document.querySelector('#initial-loading-status')?.hidden"), true);

    // 2. フッター・登録フォーム・投稿フォームにプライバシーポリシー導線が存在すること
    const linkState = await evaluate(`({
      footer: document.querySelector('.page-footer a[href="privacy.html"]')?.getAttribute('href') || null,
      register: document.querySelector('#register-form a[href="privacy.html"]')?.getAttribute('href') || null,
      composer: document.querySelector('#comment-form a[href="privacy.html"]')?.getAttribute('href') || null,
    })`);
    assert.deepEqual(linkState, {
      footer: 'privacy.html',
      register: 'privacy.html',
      composer: 'privacy.html',
    });

    // 3. 180ms超の遅延発生時のみ #initial-loading-status が表示され、完了後に非表示へ戻ること
    bootstrapDelayMs = 450;
    await send('Page.navigate', { url: url + '?phase1Slow=1#thread-1' });
    await waitFor("document.querySelector('#initial-loading-status') && document.querySelector('#initial-loading-status').hidden === false");
    bootstrapDelayMs = 0;
    await waitFor("document.querySelector('#thread-title')?.textContent === '雑談' && document.querySelector('#initial-loading-status').hidden === true");

    // 4. 初回 503 失敗時に「読み込み中」のまま残らず、更新ボタンで正常復旧すること
    failBootstrapStatus = 503;
    await send('Page.navigate', { url: url + '?phase1Fail=1#thread-1' });
    await waitFor("document.querySelector('#error-banner')?.hidden === false");
    const errState = await evaluate(`({
      cat: document.querySelector('#category-title')?.textContent,
      thread: document.querySelector('#thread-title')?.textContent,
      loadingHidden: document.querySelector('#initial-loading-status')?.hidden,
    })`);
    assert.equal(errState.cat, '掲示板を読み込めませんでした');
    assert.equal(errState.loadingHidden, true);
    assert.ok(!String(errState.thread || '').includes('読み込み中'));

    failBootstrapStatus = 0;
    await click('#reload-thread');
    await waitFor("document.querySelector('#thread-title')?.textContent === '雑談' && document.querySelector('#error-banner')?.hidden === true");

    // 5. dark テーマ保存状態で privacy.html を開き、テーマ継承と 1280px/320px で横はみ出しゼロを確認
    await evaluate(`localStorage.setItem('community-board-prefs-v1', JSON.stringify({ theme: 'dark', font: 18, background: true }))`);
    await send('Page.navigate', { url: url + 'privacy.html' });
    await waitFor("document.readyState === 'complete' && document.querySelector('h1')?.textContent.includes('プライバシーポリシー')");
    const desktopPrivacy = await evaluate(`({
      theme: document.documentElement.dataset.theme,
      font: document.documentElement.dataset.font,
      clientW: document.documentElement.clientWidth,
      scrollW: document.documentElement.scrollWidth,
    })`);
    assert.equal(desktopPrivacy.theme, 'dark');
    assert.equal(desktopPrivacy.font, '18');
    assert.ok(desktopPrivacy.scrollW <= desktopPrivacy.clientW, JSON.stringify(desktopPrivacy));

    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 480, deviceScaleFactor: 1, mobile: true });
    const mobilePrivacy = await evaluate(`({
      clientW: document.documentElement.clientWidth,
      scrollW: document.documentElement.scrollWidth,
    })`);
    assert.ok(mobilePrivacy.scrollW <= mobilePrivacy.clientW, JSON.stringify(mobilePrivacy));
  });

  await t.test('Phase 2(R1〜R7): 320/390pxヘッダー・5テーマコントラスト・認証タブ矢印・モーダル/非モーダル・減モーション', async () => {
    const setField = async (selector, value) => {
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)};` +
          `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('input', { bubbles: true }));`
      );
    };

    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: url + '?phase2Init=1#thread-1' });
    await waitFor("document.querySelector('#thread-title')?.textContent === '雑談'");
    await evaluate(`localStorage.removeItem('community-board-prefs-v1'); document.documentElement.dataset.theme = 'light';`);

    // R1: 320px / 390px とも匿名・長い会員名・要変更表示で横はみ出しゼロ＆両ボタンが画面内に収まること
    async function assertHeaderFits(label) {
      for (const vp of [
        { width: 320, height: 480, deviceScaleFactor: 1, mobile: true },
        { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
      ]) {
        await send('Emulation.setDeviceMetricsOverride', vp);
        const m = await evaluate(`(() => {
          const auth = document.querySelector('#auth-open').getBoundingClientRect();
          const settings = document.querySelector('#settings-open').getBoundingClientRect();
          return {
            clientW: document.documentElement.clientWidth,
            scrollW: document.documentElement.scrollWidth,
            authLeft: auth.left,
            authRight: auth.right,
            authWidth: auth.width,
            settingsLeft: settings.left,
            settingsRight: settings.right,
            settingsWidth: settings.width,
          };
        })()`);
        assert.ok(m.scrollW <= m.clientW, `${label} ${vp.width}px scroll: ${JSON.stringify(m)}`);
        assert.ok(m.authLeft >= 0 && m.authRight <= m.clientW, `${label} ${vp.width}px auth bounds: ${JSON.stringify(m)}`);
        assert.ok(m.settingsRight <= m.clientW && m.settingsWidth >= 40, `${label} ${vp.width}px settings hidden: ${JSON.stringify(m)}`);
        assert.ok(m.authRight <= m.settingsLeft + 0.5, `${label} ${vp.width}px overlap: ${JSON.stringify(m)}`);
      }
    }

    await assertHeaderFits('guest');

    // 長い20文字会員名を登録して 320px/390px を計測
    const longMember = '長い表示テスト用会員名です1234567';
    assert.equal(Array.from(longMember).length, 20);
    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#auth-tab-register');
    await setField('#register-username', longMember);
    await setField('#register-password', 'long-member-pass-1234');
    await setField('#register-password-confirm', 'long-member-pass-1234');
    await evaluate("document.querySelector('#register-form').requestSubmit()");
    await waitFor(`document.querySelector('#auth-open-label')?.textContent === ${JSON.stringify(longMember)} && !document.querySelector('#auth-sheet').classList.contains('is-open')`);
    await assertHeaderFits('longMember');

    // 仮パスワード(要変更)表示で 320px/390px を計測
    const tempHash = await createScryptQueue().hashPassword('temp-phase2-1234');
    db.resetPasswordByUsername({ username: longMember, newPasswordHash: tempHash });
    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#logout-button');
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'ログイン' && !document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await setField('#login-username', longMember);
    await setField('#login-password', 'temp-phase2-1234');
    await evaluate("document.querySelector('#login-form').requestSubmit()");
    await waitFor(`document.querySelector('#auth-open-label')?.textContent.includes('(要変更)')`);
    await click('#auth-close');
    await waitFor("!document.querySelector('#auth-sheet').classList.contains('is-open')");
    await assertHeaderFits('mustChange');

    // テスト終了後の未ログイン状態を復元
    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#logout-button');
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'ログイン' && !document.querySelector('#auth-sheet').classList.contains('is-open')");

    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    // R4 & R5: 認証モーダルの役割・背景inert・タブ矢印キー・Esc復帰
    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    const authModalState = await evaluate(`({
      role: document.querySelector('#auth-sheet').getAttribute('role'),
      modal: document.querySelector('#auth-sheet').getAttribute('aria-modal'),
      shellInert: Boolean(document.querySelector('.site-shell').inert),
      headerInert: Boolean(document.querySelector('header.masthead').inert),
      loginTabIdx: document.querySelector('#auth-tab-login').tabIndex,
      regTabIdx: document.querySelector('#auth-tab-register').tabIndex,
    })`);
    assert.deepEqual(authModalState, {
      role: 'dialog',
      modal: 'true',
      shellInert: true,
      headerInert: true,
      loginTabIdx: 0,
      regTabIdx: -1,
    });

    await evaluate("document.querySelector('#auth-tab-login').focus()");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await waitFor("document.querySelector('#auth-tab-register').getAttribute('aria-selected') === 'true'");
    const arrowRightState = await evaluate(`({
      activeId: document.activeElement?.id,
      loginIdx: document.querySelector('#auth-tab-login').tabIndex,
      regIdx: document.querySelector('#auth-tab-register').tabIndex,
      regFormHidden: document.querySelector('#register-form').hidden,
    })`);
    assert.deepEqual(arrowRightState, {
      activeId: 'auth-tab-register',
      loginIdx: -1,
      regIdx: 0,
      regFormHidden: false,
    });

    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await waitFor("document.querySelector('#auth-tab-login').getAttribute('aria-selected') === 'true'");
    assert.equal(await evaluate("document.activeElement?.id"), 'auth-tab-login');

    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor("!document.querySelector('#auth-sheet').classList.contains('is-open')");
    assert.equal(await evaluate("Boolean(document.querySelector('.site-shell').inert)"), false);
    assert.equal(await evaluate("document.activeElement?.id"), 'auth-open');

    // R5: 表示設定モーダルの役割・背景inert・Esc復帰
    await click('#settings-open');
    await waitFor("document.querySelector('#settings-sheet').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#settings-sheet').getAttribute('role')"), 'dialog');
    assert.equal(await evaluate("document.querySelector('#settings-sheet').getAttribute('aria-modal')"), 'true');
    assert.equal(await evaluate("Boolean(document.querySelector('.site-shell').inert)"), true);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor("!document.querySelector('#settings-sheet').classList.contains('is-open')");
    assert.equal(await evaluate("document.activeElement?.id"), 'settings-open');

    // R5: 投稿パネルはPC非モーダル <-> モバイルモーダルへ画面幅追従すること
    await click('#write-comment');
    await waitFor("document.querySelector('#composer-drawer').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#composer-drawer').getAttribute('aria-modal')"), 'false');
    assert.equal(await evaluate("Boolean(document.querySelector('.site-shell').inert)"), false);

    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await waitFor("document.querySelector('#composer-drawer').getAttribute('aria-modal') === 'true'");
    assert.equal(await evaluate("Boolean(document.querySelector('.site-shell').inert)"), true);
    assert.equal(await evaluate("document.querySelector('#composer-backdrop').hidden"), false);

    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await waitFor("document.querySelector('#composer-drawer').getAttribute('aria-modal') === 'false'");
    assert.equal(await evaluate("Boolean(document.querySelector('.site-shell').inert)"), false);

    // R2/R3/R6: 全5テーマで計算済みコントラスト・入力枠・ヘッダーテーマ追従を実測検証
    // トランジション途中の色を拾わないよう reduced-motion で即時確定させる
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const themeReport = await evaluate(`(() => {
      function parseColor(raw) {
        const s = String(raw || '').trim();
        if (s.startsWith('#')) {
          const h = s.slice(1);
          return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
        }
        const m = s.match(/rgba?\\(\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)/);
        if (!m) throw new Error('Unparseable color: ' + s);
        return [Number(m[1]), Number(m[2]), Number(m[3])];
      }
      function relLum([r, g, b]) {
        const f = (c) => {
          const v = c / 255;
          return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      }
      function ratio(c1, c2) {
        const l1 = relLum(parseColor(c1));
        const l2 = relLum(parseColor(c2));
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }

      const out = {};
      for (const theme of ['light', 'dark', 'paper', 'ud-light', 'ud-dark']) {
        document.documentElement.dataset.theme = theme;
        const rootCs = getComputedStyle(document.documentElement);
        const newBadge = document.querySelector('.thread-card .new-badge');
        const activeThread = document.querySelector('.thread-card[aria-pressed="true"]');
        const activeSmall = activeThread?.querySelector('small');
        const pinLabel = document.querySelector('.pin-label');
        const bodyInput = document.querySelector('#comment-body');
        const drawer = document.querySelector('#composer-drawer');
        const drawerHeader = document.querySelector('.drawer-header');
        const closeBtn = document.querySelector('#composer-close');
        const closeLabel = document.querySelector('.composer-close-label');
        const header = document.querySelector('.masthead');

        const newCs = getComputedStyle(newBadge);
        const activeCs = getComputedStyle(activeThread);
        const smallCs = getComputedStyle(activeSmall);
        const bodyCs = getComputedStyle(bodyInput);
        const phCs = getComputedStyle(bodyInput, '::placeholder');
        const drawerCs = getComputedStyle(drawer);
        const closeCs = getComputedStyle(closeBtn);
        const headerCs = getComputedStyle(header);

        out[theme] = {
          newRatio: ratio(newCs.color, newCs.backgroundColor),
          smallRatio: ratio(smallCs.color, activeCs.backgroundColor),
          pinOpacity: pinLabel ? getComputedStyle(pinLabel).opacity : 'missing',
          placeholderRatio: ratio(phCs.color, bodyCs.backgroundColor),
          borderRatio: ratio(bodyCs.borderTopColor, drawerCs.backgroundColor),
          closeTextRatio: ratio(closeCs.color, closeCs.backgroundColor),
          closeBorderRatio: ratio(closeCs.borderTopColor, drawerCs.backgroundColor),
          closeBgDistinct: closeCs.backgroundColor !== bodyCs.backgroundColor,
          closeLabelDisplay: closeLabel ? getComputedStyle(closeLabel).display : null,
          drawerHeaderFits: Boolean(drawerHeader && drawerHeader.scrollWidth <= drawerHeader.clientWidth),
          btnHoverRatio: ratio(rootCs.getPropertyValue('--accent-fg'), rootCs.getPropertyValue('--accent-hover')),
          headerBorderTop: headerCs.borderTopColor,
        };
      }
      document.documentElement.dataset.theme = 'light';
      return out;
    })()`);
    await send('Emulation.setEmulatedMedia', { features: [] });

    for (const [theme, metrics] of Object.entries(themeReport)) {
      assert.ok(metrics.newRatio >= 4.5, `${theme} newRatio=${metrics.newRatio}`);
      assert.ok(metrics.smallRatio >= 4.5, `${theme} smallRatio=${metrics.smallRatio}`);
      assert.equal(metrics.pinOpacity, '1', `${theme} pinOpacity=${metrics.pinOpacity}`);
      assert.ok(metrics.placeholderRatio >= 4.5, `${theme} placeholderRatio=${metrics.placeholderRatio}`);
      assert.ok(metrics.borderRatio >= 3.0, `${theme} borderRatio=${metrics.borderRatio}`);
      assert.ok(metrics.closeTextRatio >= 7.0, `${theme} closeTextRatio=${metrics.closeTextRatio}`);
      assert.ok(metrics.closeBorderRatio >= 4.5, `${theme} closeBorderRatio=${metrics.closeBorderRatio}`);
      assert.equal(metrics.closeBgDistinct, true, `${theme} closeBgDistinct`);
      assert.notEqual(metrics.closeLabelDisplay, 'none', `${theme} closeLabelDisplay=${metrics.closeLabelDisplay}`);
      assert.equal(metrics.drawerHeaderFits, true, `${theme} drawerHeaderFits`);
      assert.ok(metrics.btnHoverRatio >= 4.5, `${theme} btnHoverRatio=${metrics.btnHoverRatio}`);
    }
    // R6: paper と ud-light のヘッダー上線が light 固定紫と異なりテーマへ追従していること
    assert.notEqual(themeReport.paper.headerBorderTop, themeReport.light.headerBorderTop);
    assert.notEqual(themeReport['ud-light'].headerBorderTop, themeReport.light.headerBorderTop);

    await click('#composer-close');
    await waitFor("!document.querySelector('#composer-drawer').classList.contains('is-open')");

    // R7: 通常時は .new-dot アニメーションが有効で、prefers-reduced-motion: reduce 時に停止すること
    const normalDot = await evaluate(`(() => {
      const dot = document.querySelector('.new-dot');
      return dot ? getComputedStyle(dot).animationName : null;
    })()`);
    assert.equal(normalDot, 'pulse-dot');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const reducedDot = await evaluate(`(() => {
      const dot = document.querySelector('.new-dot');
      return dot ? getComputedStyle(dot).animationName : null;
    })()`);
    assert.equal(reducedDot, 'none');
    await send('Emulation.setEmulatedMedia', { features: [] });
  });

  await t.test('Phase 3(T4-1/認証UI改善3点): 3段階ソート永続化・パスワード変更折りたたみ・仮PW認知補助・再ログイン引継ぎ', async () => {
    const setField = async (selector, value) => {
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)};` +
          `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('input', { bubbles: true }));`
      );
    };
    const selectSort = async (value) => {
      await evaluate(
        `(() => { const el = document.querySelector('#sort'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`
      );
    };

    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate(`localStorage.removeItem('community-board-prefs-v1')`);

    // 1. #thread-3 に親投稿2件(P1, P2)と P1 への返信2件(R1, R2)を明示日時付きで作成
    const p1 = db.createPost({ threadId: 3, authorName: '順序親P1', visitorId: 'SORTP1AAAA', content: 'Phase3ソート親P1' });
    const p2 = db.createPost({ threadId: 3, authorName: '順序親P2', visitorId: 'SORTP2BBBB', content: 'Phase3ソート親P2' });
    const r1 = db.createPost({ threadId: 3, parentId: p1.id, authorName: '順序子R1', visitorId: 'SORTR1CCCC', content: 'Phase3ソート返信R1' });
    const r2 = db.createPost({ threadId: 3, parentId: p1.id, authorName: '順序子R2', visitorId: 'SORTR2DDDD', content: 'Phase3ソート返信R2' });
    db.execRawForTesting('UPDATE posts SET created_at = ? WHERE id = ?', ['2026-11-24T01:00:00.000Z', p1.id]);
    db.execRawForTesting('UPDATE posts SET created_at = ? WHERE id = ?', ['2026-11-24T02:00:00.000Z', p2.id]);
    db.execRawForTesting('UPDATE posts SET created_at = ? WHERE id = ?', ['2026-11-24T03:00:00.000Z', r1.id]);
    db.execRawForTesting('UPDATE posts SET created_at = ? WHERE id = ?', ['2026-11-24T04:00:00.000Z', r2.id]);

    await send('Page.navigate', { url: url + '?phase3Sort=1#thread-3' });
    await waitFor("document.querySelector('#thread-title')?.textContent === 'あいさつ・自己紹介'");

    const getRootOrder = () => evaluate(`[...document.querySelectorAll('#comments > article.comment-root')].map((el) => el.id)`);
    const getP1ReplyOrder = () => evaluate(`[...document.querySelectorAll('#post-${p1.id} .reply-entry')].map((el) => el.id)`);

    // 既定は 'new'（P2 が P1 より先、P1 の返信は時系列 R1 -> R2）
    assert.equal(await evaluate("document.querySelector('#sort').value"), 'new');
    let order = await getRootOrder();
    assert.ok(order.indexOf(`post-${p2.id}`) < order.indexOf(`post-${p1.id}`), JSON.stringify(order));
    assert.deepEqual(await getP1ReplyOrder(), [`post-${r1.id}`, `post-${r2.id}`]);

    // 'activity' へ変更（最新返信 R2 を持つ P1 が先頭側へ移動）＆ 320px 幅で横はみ出しゼロ
    await selectSort('activity');
    order = await getRootOrder();
    assert.ok(order.indexOf(`post-${p1.id}`) < order.indexOf(`post-${p2.id}`), JSON.stringify(order));
    assert.deepEqual(await getP1ReplyOrder(), [`post-${r1.id}`, `post-${r2.id}`]);

    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 480, deviceScaleFactor: 1, mobile: true });
    const mobileSortBox = await evaluate('({ w: document.documentElement.clientWidth, s: document.documentElement.scrollWidth })');
    assert.ok(mobileSortBox.s <= mobileSortBox.w, JSON.stringify(mobileSortBox));
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    // 'old' へ変更・localStorage 保存・リロード維持確認
    await selectSort('old');
    order = await getRootOrder();
    assert.ok(order.indexOf(`post-${p1.id}`) < order.indexOf(`post-${p2.id}`), JSON.stringify(order));
    assert.equal(await evaluate("JSON.parse(localStorage.getItem('community-board-prefs-v1')).sort"), 'old');

    await send('Page.navigate', { url: url + '?phase3SortOldReload=1#thread-3' });
    await waitFor("document.querySelector('#thread-title')?.textContent === 'あいさつ・自己紹介'");
    assert.equal(await evaluate("document.querySelector('#sort').value"), 'old');
    order = await getRootOrder();
    assert.ok(order.indexOf(`post-${p1.id}`) < order.indexOf(`post-${p2.id}`), JSON.stringify(order));

    // 'activity' のリロード永続化も確認後、既定へ戻す
    await selectSort('activity');
    await send('Page.navigate', { url: url + '?phase3SortActivityReload=1#thread-3' });
    await waitFor("document.querySelector('#thread-title')?.textContent === 'あいさつ・自己紹介'");
    assert.equal(await evaluate("document.querySelector('#sort').value"), 'activity');
    order = await getRootOrder();
    assert.ok(order.indexOf(`post-${p1.id}`) < order.indexOf(`post-${p2.id}`), JSON.stringify(order));
    await evaluate(`localStorage.removeItem('community-board-prefs-v1')`);

    // 2. 通常会員登録 -> #auth-open を開くとパスワード変更は折りたたみ＆#auth-close フォーカス
    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#auth-tab-register');
    await setField('#register-username', 'phase3_member');
    await setField('#register-password', 'phase3-pass-1234');
    await setField('#register-password-confirm', 'phase3-pass-1234');
    await evaluate("document.querySelector('#register-form').requestSubmit()");
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'phase3_member' && !document.querySelector('#auth-sheet').classList.contains('is-open')");

    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#password-section').open"), false);
    assert.equal(await evaluate("document.activeElement?.id"), 'auth-close');
    assert.equal(await evaluate("document.querySelector('#current-password-label').textContent"), '現在のパスワード');
    assert.equal(await evaluate("document.querySelector('#current-password-hint').hidden"), true);

    // 閉じた <details> 内が Tab 循環に混入せず、summary クリックで開閉できること
    await evaluate("document.querySelector('#logout-button').focus()");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    const afterLogoutFocusId = await evaluate("document.activeElement?.id");
    assert.equal(afterLogoutFocusId, 'password-section-summary');
    await click('#password-section-summary');
    assert.equal(await evaluate("document.querySelector('#password-section').open"), true);
    await click('#password-section-summary');
    assert.equal(await evaluate("document.querySelector('#password-section').open"), false);

    // 3. 仮パスワードでログイン -> 自動展開・閉じロック・仮パスワード認知補助ラベル/ヒント表示
    const tempHash = await createScryptQueue().hashPassword('temp-phase3-1234');
    db.resetPasswordByUsername({ username: 'phase3_member', newPasswordHash: tempHash });
    await click('#logout-button');
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'ログイン' && !document.querySelector('#auth-sheet').classList.contains('is-open')");

    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await setField('#login-username', 'phase3_member');
    await setField('#login-password', 'temp-phase3-1234');
    await evaluate("document.querySelector('#login-form').requestSubmit()");
    await waitFor("!document.querySelector('#auth-member-panel').hidden && !document.querySelector('#must-change-banner').hidden");

    const mustUi = await evaluate(`({
      open: document.querySelector('#password-section').open,
      requiredClass: document.querySelector('#password-section').classList.contains('is-required'),
      curLabel: document.querySelector('#current-password-label').textContent,
      curHintHidden: document.querySelector('#current-password-hint').hidden,
      bannerText: document.querySelector('#must-change-banner').textContent,
      activeId: document.activeElement?.id,
    })`);
    assert.equal(mustUi.open, true);
    assert.equal(mustUi.requiredClass, true);
    assert.ok(mustUi.curLabel.includes('仮パスワード'), mustUi.curLabel);
    assert.equal(mustUi.curHintHidden, false);
    assert.ok(mustUi.bannerText.includes('再ログイン'), mustUi.bannerText);
    assert.equal(mustUi.activeId, 'current-password');

    await click('#password-section-summary');
    assert.equal(await evaluate("document.querySelector('#password-section').open"), true);

    // 4. 新パスワードへ変更 -> ログイン画面切替・完了バナー・ユーザー名引継ぎ・パスワード欄フォーカス・そのまま再ログイン成功
    await setField('#current-password', 'temp-phase3-1234');
    await setField('#new-password', 'new-phase3-5678');
    await setField('#new-password-confirm', 'new-phase3-5678');
    await evaluate("document.querySelector('#password-form').requestSubmit()");
    await waitFor("!document.querySelector('#auth-guest-panel').hidden && document.querySelector('#auth-open-label').textContent === 'ログイン'");

    const postChangeUi = await evaluate(`({
      noticeHidden: document.querySelector('#login-notice').hidden,
      noticeText: document.querySelector('#login-notice').textContent,
      usernameVal: document.querySelector('#login-username').value,
      activeId: document.activeElement?.id,
    })`);
    assert.equal(postChangeUi.noticeHidden, false);
    assert.ok(postChangeUi.noticeText.includes('パスワードを変更しました'), postChangeUi.noticeText);
    assert.equal(postChangeUi.usernameVal, 'phase3_member');
    assert.equal(postChangeUi.activeId, 'login-password');

    // 5. 全5テーマで .password-disclosure-summary と .auth-info-banner の文字コントラスト >= 4.5:1 を検証
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const phase3ThemeRatios = await evaluate(`(() => {
      function parseColor(raw) {
        const m = String(raw || '').match(/rgba?\\(\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)/);
        if (!m) throw new Error('Unparseable color: ' + raw);
        return [Number(m[1]), Number(m[2]), Number(m[3])];
      }
      function relLum([r, g, b]) {
        const f = (c) => {
          const v = c / 255;
          return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      }
      function ratio(c1, c2) {
        const l1 = relLum(parseColor(c1));
        const l2 = relLum(parseColor(c2));
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }
      const out = {};
      for (const theme of ['light', 'dark', 'paper', 'ud-light', 'ud-dark']) {
        document.documentElement.dataset.theme = theme;
        const notice = document.querySelector('#login-notice');
        const disclosure = document.querySelector('#password-section');
        const summary = document.querySelector('#password-section-summary');
        const nCs = getComputedStyle(notice);
        const dCs = getComputedStyle(disclosure);
        const sCs = getComputedStyle(summary);
        out[theme] = {
          noticeRatio: ratio(nCs.color, nCs.backgroundColor),
          summaryRatio: ratio(sCs.color, dCs.backgroundColor),
        };
      }
      document.documentElement.dataset.theme = 'light';
      return out;
    })()`);
    await send('Emulation.setEmulatedMedia', { features: [] });
    for (const [theme, ratios] of Object.entries(phase3ThemeRatios)) {
      assert.ok(ratios.noticeRatio >= 4.5, `${theme} noticeRatio=${ratios.noticeRatio}`);
      assert.ok(ratios.summaryRatio >= 4.5, `${theme} summaryRatio=${ratios.summaryRatio}`);
    }

    // 引き継がれたユーザー名に触らずパスワードだけ入力して再ログイン成功
    await setField('#login-password', 'new-phase3-5678');
    await evaluate("document.querySelector('#login-form').requestSubmit()");
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'phase3_member' && !document.querySelector('#auth-sheet').classList.contains('is-open')");

    // ログアウト後は完了案内バナーが消えていること
    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#logout-button');
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'ログイン' && !document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#login-notice').hidden"), true);
    await click('#auth-close');
    await waitFor("!document.querySelector('#auth-sheet').classList.contains('is-open')");
  });

  await t.test('レビュー回帰(R1): 古いbootstrap応答が登録・ログアウト後の認証表示を上書きしないこと・版表示v1.0.1確認', async () => {
    const setField = async (selector, value) => {
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)};` +
          `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('input', { bubbles: true }));`
      );
    };

    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    // 1. 順方向: 未ログイン状態の bootstrap 応答を遅延させ、その間に会員登録を完了しても「ログイン」へ戻らないこと
    finishBootstrap = null;
    holdBootstrap = true;
    await send('Page.navigate', { url: url + '?bootstrapRaceRegister=1#thread-1' });
    for (let attempt = 0; !finishBootstrap && attempt < 100; attempt += 1) await delay(30);
    assert.ok(finishBootstrap);

    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#auth-tab-register');
    await setField('#register-username', 'race_reg_user');
    await setField('#register-password', 'race-reg-pass-1234');
    await setField('#register-password-confirm', 'race-reg-pass-1234');
    await evaluate("document.querySelector('#register-form').requestSubmit()");
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'race_reg_user' && !document.querySelector('#auth-sheet').classList.contains('is-open')");

    holdBootstrap = false;
    finishBootstrap();
    finishBootstrap = null;
    await waitFor("document.querySelector('#thread-title')?.textContent === '雑談'");

    assert.equal(await evaluate("document.querySelector('#auth-open-label').textContent"), 'race_reg_user');
    assert.equal(await evaluate("fetch('api/auth/me').then((r) => r.json()).then((d) => d.user?.username || null)"), 'race_reg_user');
    await click('#write-comment');
    await waitFor("document.querySelector('#composer-drawer').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#author-name').value"), 'race_reg_user');
    assert.equal(await evaluate("document.querySelector('#author-name').readOnly"), true);
    await click('#composer-close');
    await waitFor("!document.querySelector('#composer-drawer').classList.contains('is-open')");

    // 2. 逆方向: ログイン済み状態の bootstrap 応答を遅延させ、その間にログアウト完了しても会員表示へ巻き戻らないこと
    holdBootstrap = true;
    await send('Page.navigate', { url: url + '?bootstrapRaceLogout=1#thread-1' });
    for (let attempt = 0; !finishBootstrap && attempt < 100; attempt += 1) await delay(30);
    assert.ok(finishBootstrap);

    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await setField('#login-username', 'race_reg_user');
    await setField('#login-password', 'race-reg-pass-1234');
    await evaluate("document.querySelector('#login-form').requestSubmit()");
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'race_reg_user' && !document.querySelector('#auth-sheet').classList.contains('is-open')");

    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#logout-button');
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'ログイン' && !document.querySelector('#auth-sheet').classList.contains('is-open')");

    holdBootstrap = false;
    finishBootstrap();
    finishBootstrap = null;
    await waitFor("document.querySelector('#thread-title')?.textContent === '雑談'");

    assert.equal(await evaluate("document.querySelector('#auth-open-label').textContent"), 'ログイン');
    assert.equal(await evaluate("fetch('api/auth/me').then((r) => r.json()).then((d) => d.user)"), null);

    // 3. 版表示が v1.0.1 に統一され v0.5 が残っていないこと
    const versionText = await evaluate(`({
      sidebar: document.querySelector('.sidebar-bottom')?.textContent || '',
      footer: document.querySelector('.page-footer')?.textContent || '',
      badge: document.querySelector('.footer-version')?.textContent || '',
    })`);
    assert.ok(versionText.sidebar.includes('v1.0.1') && !versionText.sidebar.includes('v0.5'), JSON.stringify(versionText));
    assert.ok(versionText.footer.includes('v1.0.1') && !versionText.footer.includes('v0.5'), JSON.stringify(versionText));
    assert.ok(versionText.badge.includes('v1.0.1') && !versionText.badge.includes('v0.5'), JSON.stringify(versionText));
  });

  await t.test('実機回帰(ID14): 別タブログアウトでCookie消失後の送信が暗黙匿名化されず下書き保持→再ログイン継続できること', async () => {
    const setField = async (selector, value) => {
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)};` +
          `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('input', { bubbles: true }));`
      );
    };

    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await setField('#login-username', 'race_reg_user');
    await setField('#login-password', 'race-reg-pass-1234');
    await evaluate("document.querySelector('#login-form').requestSubmit()");
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'race_reg_user' && !document.querySelector('#auth-sheet').classList.contains('is-open')");

    await click('#write-comment');
    await waitFor("document.querySelector('#composer-drawer').classList.contains('is-open')");
    await write('別タブログアウト後も消えない下書き');

    // 別タブからのログアウトを模擬：このタブのUI状態は変えずCookieのみ消滅させる
    const bgLogoutStatus = await evaluate(
      "fetch('api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}' }).then((r) => r.status)"
    );
    assert.equal(bgLogoutStatus, 200);

    await evaluate("document.querySelector('#comment-form').requestSubmit()");
    await waitFor("!document.querySelector('#session-expired-box').hidden");
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), '別タブログアウト後も消えない下書き');
    assert.equal(await evaluate("document.querySelector('#auth-open-label').textContent"), 'ログイン');
    assert.equal(db.getThreadDetail(1).posts.some((p) => p.content === '別タブログアウト後も消えない下書き'), false);

    // 再ログインして下書きを会員としてそのまま送信完了できること
    await click('#expired-relogin-btn');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await setField('#login-username', 'race_reg_user');
    await setField('#login-password', 'race-reg-pass-1234');
    await evaluate("document.querySelector('#login-form').requestSubmit()");
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'race_reg_user' && document.querySelector('#composer-drawer').classList.contains('is-open')");
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), '別タブログアウト後も消えない下書き');
    assert.equal(await evaluate("document.querySelector('#author-name').value"), 'race_reg_user');
    assert.equal(await evaluate("document.querySelector('#author-name').readOnly"), true);

    await evaluate("document.querySelector('#comment-form').requestSubmit()");
    await waitFor("!document.querySelector('#submit-button').disabled && document.querySelector('#comment-body').value === ''");
    const saved = db.getThreadDetail(1).posts.find((p) => p.content === '別タブログアウト後も消えない下書き');
    assert.ok(saved);
    assert.equal(saved.is_member, true);
    assert.equal(saved.author_name, 'race_reg_user');

    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#logout-button');
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'ログイン' && !document.querySelector('#auth-sheet').classList.contains('is-open')");
  });

  await t.test('昇格前レビュー回帰(R1): 別タブアカウント切替(会員A→B／匿名→会員A)で意図せぬ投稿を防ぎ下書き保持で切替・ログアウト継続できること', async () => {
    const setField = async (selector, value) => {
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)};` +
          `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('input', { bubbles: true }));`
      );
    };

    // 経路1 (PC幅): 会員Aで下書き作成 → 別タブで会員Bへ切替 → 409阻止＆表示更新 → 会員Bで継続送信
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await setField('#login-username', 'race_reg_user');
    await setField('#login-password', 'race-reg-pass-1234');
    await evaluate("document.querySelector('#login-form').requestSubmit()");
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'race_reg_user' && !document.querySelector('#auth-sheet').classList.contains('is-open')");

    await click('#write-comment');
    await waitFor("document.querySelector('#composer-drawer').classList.contains('is-open')");
    await setField('#comment-body', '会員A→B切替テスト本文');

    // 別タブでの新規登録（別アカウントBへのセッション上書き）を模擬
    const regBStatus = await evaluate(
      "fetch('api/auth/register', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ username: 'r1_tab2_user', password: 'r1-tab2-pass-1234' }) }).then((r) => r.status)"
    );
    assert.equal(regBStatus, 201);

    await evaluate("document.querySelector('#comment-form').requestSubmit()");
    await waitFor("!document.querySelector('#auth-changed-box').hidden");
    assert.equal(db.getThreadDetail(1).posts.some((p) => p.content === '会員A→B切替テスト本文'), false);
    assert.equal(await evaluate("document.querySelector('#auth-open-label').textContent"), 'r1_tab2_user');
    assert.equal(await evaluate("document.querySelector('#author-name').value"), 'r1_tab2_user');
    assert.equal(await evaluate("document.querySelector('#author-name').readOnly"), true);
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), '会員A→B切替テスト本文');
    assert.equal(await evaluate("document.activeElement?.id"), 'auth-changed-open-account-btn');

    // 切替後アカウント(r1_tab2_user)を確認した上で再送信すると保存され警告が閉じること
    await evaluate("document.querySelector('#comment-form').requestSubmit()");
    await waitFor("!document.querySelector('#submit-button').disabled && document.querySelector('#comment-body').value === ''");
    assert.equal(await evaluate("document.querySelector('#auth-changed-box').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#form-error').textContent"), '');
    const postAsB = db.getThreadDetail(1).posts.find((p) => p.content === '会員A→B切替テスト本文');
    assert.ok(postAsB);
    assert.equal(postAsB.is_member, true);
    assert.equal(postAsB.author_name, 'r1_tab2_user');

    await waitFor("!document.querySelector('#composer-drawer').classList.contains('is-open')");
    await click('#auth-open');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#logout-button');
    await waitFor("document.querySelector('#auth-open-label')?.textContent === 'ログイン' && !document.querySelector('#auth-sheet').classList.contains('is-open')");

    // 経路2 (モバイル幅): 匿名＋ペンネーム下書き → 別タブで会員Aログイン → 409阻止＆匿名名退避 → 案内ボタンからログアウトしドロワー再オープン＆匿名再送完了
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await click('#write-comment');
    await waitFor("document.querySelector('#composer-drawer').classList.contains('is-open')");
    await setField('#author-name', '匿名ペンネームR1');
    await setField('#comment-body', '匿名→会員切替テスト本文');

    const bgLoginAStatus = await evaluate(
      "fetch('api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ username: 'race_reg_user', password: 'race-reg-pass-1234' }) }).then((r) => r.status)"
    );
    assert.equal(bgLoginAStatus, 200);

    await evaluate("document.querySelector('#comment-form').requestSubmit()");
    await waitFor("!document.querySelector('#auth-changed-box').hidden");
    assert.equal(db.getThreadDetail(1).posts.some((p) => p.content === '匿名→会員切替テスト本文'), false);
    assert.equal(await evaluate("document.querySelector('#auth-open-label').textContent"), 'race_reg_user');
    assert.equal(await evaluate("document.querySelector('#author-name').value"), 'race_reg_user');
    assert.equal(await evaluate("document.querySelector('#author-name').readOnly"), true);
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), '匿名→会員切替テスト本文');
    assert.equal(await evaluate("document.activeElement?.id"), 'auth-changed-open-account-btn');

    await click('#auth-changed-open-account-btn');
    await waitFor("document.querySelector('#auth-sheet').classList.contains('is-open')");
    await click('#logout-button');
    await waitFor(
      "document.querySelector('#auth-open-label')?.textContent === 'ログイン' && " +
        "!document.querySelector('#auth-sheet').classList.contains('is-open') && " +
        "document.querySelector('#composer-drawer').classList.contains('is-open')"
    );
    assert.equal(await evaluate("document.querySelector('#auth-changed-box').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#form-error').textContent"), '');
    assert.equal(await evaluate("document.querySelector('#author-name').readOnly"), false);
    assert.equal(await evaluate("document.querySelector('#author-name').value"), '匿名ペンネームR1');
    assert.equal(await evaluate("document.querySelector('#comment-body').value"), '匿名→会員切替テスト本文');

    await evaluate("document.querySelector('#comment-form').requestSubmit()");
    await waitFor("!document.querySelector('#submit-button').disabled && document.querySelector('#comment-body').value === ''");
    const postAsAnon = db.getThreadDetail(1).posts.find((p) => p.content === '匿名→会員切替テスト本文');
    assert.ok(postAsAnon);
    assert.equal(postAsAnon.is_member, false);
    assert.equal(postAsAnon.author_name, '匿名ペンネームR1');

    await waitFor("!document.querySelector('#composer-drawer').classList.contains('is-open')");
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  });

  if (process.env.FRONTEND_ARTIFACT_DIR) {
    fs.mkdirSync(process.env.FRONTEND_ARTIFACT_DIR, { recursive: true });
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.FRONTEND_ARTIFACT_DIR, 'mobile-composer.png'), Buffer.from(screenshot.data, 'base64'));
  }
  assert.deepEqual(errors, []);
});
