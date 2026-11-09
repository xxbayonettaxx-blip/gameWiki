'use strict';

/**
 * =====================================================================
 * src/app.js
 * 役割：【API・静的配信の組立て】HTTPサーバーを生成して返す（listenは行わない）
 * 方針：
 *   - server.js（本番待受）と test/api.test.js（一時DB＋空きポート検証）の双方で共通利用する。
 *   - 物理バイト上限（413）、Content-Type/Origin検査（415/403）、レート制限（429）、
 *     管理トークン定数時間比較（401）、公開ディレクトリ境界検証（403/404）を徹底する。
 * =====================================================================
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  ValidationError,
  parsePositiveInt,
  validatePostInput,
  validateIdSecret,
  generateVisitorId,
  extractClientIp,
} = require('./validators');

const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// 静的ファイルの拡張子と Content-Type の対応表（必要な形式のみ明示許可）
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------
// 1. 全レスポンス共通のセキュリティヘッダー付与
// CSP で script-src 'self' を強制し、万が一のインラインスクリプト実行もブラウザ側で遮断する。
// ---------------------------------------------------------------------
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
}

// JSONレスポンス送信ヘルパー
function sendJson(res, statusCode, payload, extraHeaders = {}) {
  setSecurityHeaders(res);
  for (const [k, v] of Object.entries(extraHeaders)) {
    res.setHeader(k, v);
  }
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ---------------------------------------------------------------------
// 2. 更新系API（POST）向けの CSRF / Content-Type 防御検査
// フォーム送信等の単純リクエストによるCSRFや、別オリジンからの不正要求を拒否する。
// ---------------------------------------------------------------------
function verifyMutatingRequestHeaders(req) {
  // Sec-Fetch-Site が cross-site の場合は即拒否
  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite === 'cross-site') {
    throw new ValidationError('外部サイトからの更新要求は許可されていません。', 403);
  }

  // Origin ヘッダーが存在する場合、Host ヘッダーと一致するか検証
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.trim() !== '') {
    let originHost;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      throw new ValidationError('不正な Origin ヘッダーです。', 403);
    }
    const requestHost = String(req.headers.host || '').toLowerCase();
    if (!requestHost || originHost !== requestHost) {
      throw new ValidationError('送信元オリジンが一致しません。', 403);
    }
  }

  // Content-Type が application/json であることを要求（HTML form からの直送信を遮断）
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  const mediaType = contentType.split(';')[0].trim();
  if (mediaType !== 'application/json') {
    throw new ValidationError('Content-Type には application/json を指定してください。', 415);
  }
}

// ---------------------------------------------------------------------
// 3. 物理バイト数上限付きの JSON ボディ読取関数（巨大データ DoS 防御・F5対策）
// 文字数ではなく Buffer の物理バイト数で監視し、上限超過を検知したチャンク時点で即座に 413 を返す。
// ---------------------------------------------------------------------
function readJsonBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) {
        return; // 上限超過後はメモリへ蓄積せず読み捨てる
      }
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        settled = true;
        chunks.length = 0;
        // クライアントの送信完了(end)を待たずに即座に 413 応答へ進める（残りのストリームは破棄）
        req.resume();
        const destroyTimer = setTimeout(() => {
          if (!req.complete && !req.destroyed) {
            req.destroy();
          }
        }, 500);
        destroyTimer.unref();
        req.once('end', () => clearTimeout(destroyTimer));
        req.once('close', () => clearTimeout(destroyTimer));

        reject(
          new ValidationError(
            `送信データが上限（${maxBodyBytes} バイト）を超えています。`,
            413
          )
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      if (totalBytes === 0) {
        resolve({});
        return;
      }
      const rawText = Buffer.concat(chunks, totalBytes).toString('utf8');
      try {
        const parsed = JSON.parse(rawText);
        resolve(parsed);
      } catch {
        reject(new ValidationError('JSONの形式が不正です。', 400));
      }
    });

    req.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------
// 4. 管理トークンの定数時間（タイミング攻撃耐性）照合関数
// ---------------------------------------------------------------------
function verifyAdminBearerToken(req, configuredAdminToken) {
  if (!configuredAdminToken) {
    return false;
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const provided = authHeader.slice('Bearer '.length).trim();
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(configuredAdminToken, 'utf8');
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------
// 5. アプリケーションサーバー生成ファクトリ関数
// ---------------------------------------------------------------------
function createApp(options = {}) {
  const {
    db,
    idSecret,
    adminToken = null,
    trustProxy = false,
    maxBodyBytes = 1024 * 1024, // 既定上限: 1MB
    rateLimitWindowMs = 60_000, // レート制限窓: 60秒
    rateLimitMaxPosts = 20, // 60秒あたり同一IPから最大20投稿
    publicDir = DEFAULT_PUBLIC_DIR,
    nowFn = () => new Date(),
    quiet = false,
  } = options;

  if (!db) {
    throw new Error('createApp には db インスタンスの指定が必須です。');
  }
  const validIdSecret = validateIdSecret(idSecret);
  const resolvedPublicDir = path.resolve(publicDir);

  // ADMIN_TOKEN が未設定または見本値のままならHTTP管理削除を無効化する
  const validAdminToken =
    typeof adminToken === 'string' &&
    adminToken.trim().length >= 16 &&
    !adminToken.trim().startsWith('CHANGE_ME')
      ? adminToken.trim()
      : null;

  // メモリ内レート制限テーブル（IP -> { count, resetAt }）
  const rateLimitMap = new Map();

  function checkRateLimit(clientIp, currentMs) {
    // 長期稼働時のメモリ肥大化を防ぐため、要素数が増えたら期限切れを一括掃除
    if (rateLimitMap.size > 2000) {
      for (const [ip, entry] of rateLimitMap.entries()) {
        if (entry.resetAt <= currentMs) {
          rateLimitMap.delete(ip);
        }
      }
    }

    const existing = rateLimitMap.get(clientIp);
    if (!existing || existing.resetAt <= currentMs) {
      rateLimitMap.set(clientIp, { count: 1, resetAt: currentMs + rateLimitWindowMs });
      return true;
    }
    if (existing.count >= rateLimitMaxPosts) {
      return false;
    }
    existing.count += 1;
    return true;
  }

  // -------------------------------------------------------------------
  // 6. 静的ファイル配信処理（パストラバーサル・非公開ファイル完全遮断）
  // -------------------------------------------------------------------
  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: '許可されていないHTTPメソッドです。' }, { Allow: 'GET, HEAD' });
      return;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      sendJson(res, 400, { error: 'URLのエンコード形式が不正です。' });
      return;
    }

    // NULLバイトおよび Windows 特有のバックスラッシュ区切り(\)混入を即時拒否
    if (decodedPath.includes('\0') || decodedPath.includes('\\')) {
      sendJson(res, 403, { error: '不正なパス指定です。' });
      return;
    }

    const relativeTarget = decodedPath === '/' ? '/index.html' : decodedPath;
    const segments = relativeTarget.split('/').filter(Boolean);

    // 隠しファイル（.env, .git 等）や親階層参照（..）を含むセグメントを拒否
    if (segments.some((seg) => seg.startsWith('.'))) {
      sendJson(res, 403, { error: 'このパスへのアクセスは禁止されています。' });
      return;
    }

    // 正規化後の絶対パスが resolvedPublicDir 配下にあることを厳密検証
    const candidatePath = path.resolve(resolvedPublicDir, '.' + '/' + segments.join('/'));
    const publicPrefix = resolvedPublicDir.endsWith(path.sep)
      ? resolvedPublicDir
      : resolvedPublicDir + path.sep;

    if (!candidatePath.startsWith(publicPrefix)) {
      sendJson(res, 403, { error: '公開領域外へのアクセスは禁止されています。' });
      return;
    }

    const ext = path.extname(candidatePath).toLowerCase();
    const contentType = MIME_TYPES[ext];
    if (!contentType) {
      sendJson(res, 404, { error: 'ページが見つかりません。' });
      return;
    }

    let stat;
    try {
      stat = fs.statSync(candidatePath);
    } catch {
      sendJson(res, 404, { error: 'ファイルが見つかりません。' });
      return;
    }

    if (!stat.isFile()) {
      sendJson(res, 404, { error: 'ファイルが見つかりません。' });
      return;
    }

    // F3対策：シンボリックリンクやWindowsジャンクションを辿った後の「実体パス（realpath）」でも
    // 公開ディレクトリ配下に収まっていることを検証し、外部ファイルへのリンク脱出を遮断する。
    let realPublicDir;
    let realCandidatePath;
    try {
      realPublicDir = fs.realpathSync(resolvedPublicDir);
      realCandidatePath = fs.realpathSync(candidatePath);
    } catch {
      sendJson(res, 404, { error: 'ファイルが見つかりません。' });
      return;
    }

    const realPublicPrefix = realPublicDir.endsWith(path.sep)
      ? realPublicDir
      : realPublicDir + path.sep;

    if (!realCandidatePath.startsWith(realPublicPrefix)) {
      sendJson(res, 403, { error: '公開領域外へのリンクアクセスは禁止されています。' });
      return;
    }

    const fileBuffer = fs.readFileSync(realCandidatePath);
    setSecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fileBuffer.length,
      'Cache-Control': 'no-cache',
    });

    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(fileBuffer);
    }
  }

  // -------------------------------------------------------------------
  // 7. メインHTTPルーティング（全処理を try...catch で保護しプロセス即死を防止）
  // -------------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    let pathname = '/';

    try {
      const parsedUrl = new URL(req.url || '/', 'http://localhost');
      pathname = parsedUrl.pathname;

      // [GET] ヘルスチェック
      if (pathname === '/api/health') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET' });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // [GET] カテゴリ一覧＋配下スレッド概要の取得
      if (pathname === '/api/categories') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET' });
          return;
        }
        const categories = db.listCategoriesWithThreads();
        sendJson(res, 200, { categories });
        return;
      }

      // [GET] 特定スレッドの詳細（タイトル・ピン留め文・マスク済み投稿ツリー用配列）の取得
      const threadMatch = pathname.match(/^\/api\/threads\/([^/]+)$/);
      if (threadMatch) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET' });
          return;
        }
        const threadId = parsePositiveInt(threadMatch[1], 'スレッドID');
        const detail = db.getThreadDetail(threadId);
        if (!detail) {
          sendJson(res, 404, { error: '指定されたスレッドが見つかりません。' });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }

      // [POST] 新規投稿・ツリー返信の登録
      if (pathname === '/api/posts') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '投稿には POST メソッドを使用してください。' }, { Allow: 'POST' });
          return;
        }

        verifyMutatingRequestHeaders(req);

        const clientIp = extractClientIp(req, { trustProxy });
        const nowDate = nowFn();
        if (!checkRateLimit(clientIp, nowDate.getTime())) {
          sendJson(res, 429, {
            error: '短時間に投稿が集中しています。少し時間をおいてから再試行してください。',
          });
          return;
        }

        const rawBody = await readJsonBody(req, maxBodyBytes);
        const validInput = validatePostInput(rawBody);
        const visitorId = generateVisitorId({
          ip: clientIp,
          secret: validIdSecret,
          now: nowDate,
        });

        const createdPost = db.createPost({
          threadId: validInput.threadId,
          parentId: validInput.parentId,
          authorName: validInput.authorName,
          visitorId,
          content: validInput.content,
        });

        sendJson(res, 201, { post: createdPost });
        return;
      }

      // [POST] 管理者専用：投稿の論理削除（is_deleted = 1）
      const adminDeleteMatch = pathname.match(/^\/api\/admin\/posts\/([^/]+)\/delete$/);
      if (adminDeleteMatch) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'POST' });
          return;
        }

        verifyMutatingRequestHeaders(req);

        if (!verifyAdminBearerToken(req, validAdminToken)) {
          sendJson(res, 401, { error: '管理者認証が必要です。' });
          return;
        }

        // ボディが空でもサイズ上限検査を通す
        await readJsonBody(req, maxBodyBytes);
        const postId = parsePositiveInt(adminDeleteMatch[1], '投稿ID');
        const result = db.softDeletePost(postId);
        if (!result.found) {
          sendJson(res, 404, { error: '指定された投稿が見つかりません。' });
          return;
        }
        sendJson(res, 200, { ok: true, postId, alreadyDeleted: result.alreadyDeleted });
        return;
      }

      // [POST] 管理者専用：投稿（＋返信ツリー）のピン留め設定・解除
      const adminPinMatch = pathname.match(/^\/api\/admin\/posts\/([^/]+)\/pin$/);
      if (adminPinMatch) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'POST' });
          return;
        }

        verifyMutatingRequestHeaders(req);

        if (!verifyAdminBearerToken(req, validAdminToken)) {
          sendJson(res, 401, { error: '管理者認証が必要です。' });
          return;
        }

        const body = await readJsonBody(req, maxBodyBytes);
        const postId = parsePositiveInt(adminPinMatch[1], '投稿ID');
        if (body !== null && body.pinned !== undefined && typeof body.pinned !== 'boolean') {
          throw new ValidationError('pinned には true または false を指定してください。', 400);
        }
        const pinnedFlag = body?.pinned === undefined ? true : body.pinned;
        const result = db.setPostPinned(postId, pinnedFlag);
        if (!result.found) {
          sendJson(res, 404, { error: '指定された投稿が見つかりません。' });
          return;
        }
        sendJson(res, 200, { ok: true, postId, isPinned: result.isPinned });
        return;
      }

      // 未知の /api/* パスはHTMLではなくJSONの404を返す
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: '指定されたAPIエンドポイントは存在しません。' });
        return;
      }

      // 上記以外は public/ 配下の静的ファイル配信へ委譲
      serveStatic(req, res, pathname);
    } catch (err) {
      if (err instanceof ValidationError) {
        const extra = err.statusCode === 413 ? { Connection: 'close' } : {};
        sendJson(res, err.statusCode, { error: err.message }, extra);
      } else {
        if (!quiet) {
          console.error('[ERROR] リクエスト処理中に予期せぬ例外が発生しました:', err);
        }
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'サーバー内部でエラーが発生しました。時間をおいて再試行してください。' });
        } else {
          res.end();
        }
      }
    } finally {
      if (!quiet) {
        const elapsed = Date.now() - startedAt;
        console.log(`[HTTP] ${req.method} ${pathname} -> ${res.statusCode} (${elapsed}ms)`);
      }
    }
  });

  // スローロリス等の長時間接続滞留を抑制する明示タイムアウト設定
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;

  return server;
}

module.exports = {
  DEFAULT_PUBLIC_DIR,
  createApp,
};
