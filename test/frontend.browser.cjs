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
  const server = createApp({ db, idSecret: 'frontend_browser_test_secret_32chars', quiet: true });
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
  });

  if (process.env.FRONTEND_ARTIFACT_DIR) {
    fs.mkdirSync(process.env.FRONTEND_ARTIFACT_DIR, { recursive: true });
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.FRONTEND_ARTIFACT_DIR, 'mobile-composer.png'), Buffer.from(screenshot.data, 'base64'));
  }
  assert.deepEqual(errors, []);
});
