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
  validateAuthRegisterInput,
  validateAuthLoginInput,
  validateChangePasswordInput,
  validateIdSecret,
  generateVisitorId,
  extractClientIp,
} = require('./validators');
const {
  SESSION_TTL_SECONDS,
  MAX_SESSIONS_PER_USER,
  AUTH_MAX_BODY_BYTES,
  AuthQueueFullError,
  createScryptQueue,
  generateSessionToken,
  hashSessionToken,
  isSecureRequest,
  parseSessionCookie,
  hasAnyCookieHeader,
  buildSetSessionCookieHeader,
  buildClearSessionCookieHeader,
  normalizeAllowedOrigin,
} = require('./auth');

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
// 2. 更新系API（POST/PATCH/DELETE）向けの CSRF / Origin完全一致 防御検査
// フォーム送信等の単純リクエストによるCSRFや、別オリジン・スキーム違いからの不正要求を拒否する。
// Content-Type 検査は将来のバイナリ画像API分離を見据えて別関数へ切り離す（R3）。
// ---------------------------------------------------------------------
function verifyOriginAndSecFetch(
  req,
  { requireOrigin = false, allowedOrigin = null, trustProxy = false } = {}
) {
  // Sec-Fetch-Site が cross-site の場合は即拒否
  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite === 'cross-site') {
    throw new ValidationError('外部サイトからの更新要求は許可されていません。', 403);
  }

  let expectedOrigin = allowedOrigin;
  if (!expectedOrigin) {
    const rawHost = String(req.headers.host || '').trim();
    if (!rawHost) {
      throw new ValidationError('Host ヘッダーが不足しています。', 403);
    }
    const scheme = isSecureRequest(req, { trustProxy }) ? 'https' : 'http';
    try {
      const hostUrl = new URL(`${scheme}://${rawHost}`);
      if (hostUrl.host.toLowerCase() !== rawHost.toLowerCase()) {
        throw new Error('host mismatch');
      }
      expectedOrigin = hostUrl.origin.toLowerCase();
    } catch {
      throw new ValidationError('不正な Host ヘッダーです。', 403);
    }
  } else {
    expectedOrigin = expectedOrigin.toLowerCase();
  }

  // Origin ヘッダーが存在する場合（または必須ルート時）、scheme+host+port を完全一致検証
  const origin = req.headers.origin;
  if (origin === undefined) {
    if (requireOrigin) {
      throw new ValidationError('Origin ヘッダーが必要です。', 403);
    }
  } else {
    const trimmedOrigin = typeof origin === 'string' ? origin.trim() : '';
    if (trimmedOrigin === '' || trimmedOrigin.toLowerCase() === 'null') {
      throw new ValidationError('不正な Origin ヘッダーです。', 403);
    }
    let originNormalized;
    try {
      originNormalized = new URL(trimmedOrigin).origin.toLowerCase();
    } catch {
      throw new ValidationError('不正な Origin ヘッダーです。', 403);
    }
    if (!originNormalized || originNormalized === 'null' || originNormalized !== expectedOrigin) {
      throw new ValidationError('送信元オリジンが一致しません。', 403);
    }
  }
}

function verifyJsonContentType(req) {
  // Content-Type が application/json であることを要求（HTML form からの直送信を遮断）
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  const mediaType = contentType.split(';')[0].trim();
  if (mediaType !== 'application/json') {
    throw new ValidationError('Content-Type には application/json を指定してください。', 415);
  }
}

function verifyMutatingRequestHeaders(req, options = {}) {
  verifyOriginAndSecFetch(req, options);
  verifyJsonContentType(req);
}

// ---------------------------------------------------------------------
// 2b. 上限・TTL付きのスライディングウィンドウ制限ヘルパー（Map肥大化防止）
// ---------------------------------------------------------------------
function createWindowLimiter({ windowMs, maxHits, maxEntries = 2000 }) {
  const map = new Map();

  function sweepIfFull(currentMs) {
    if (map.size < maxEntries) return;
    for (const [k, entry] of map.entries()) {
      if (entry.resetAt <= currentMs) {
        map.delete(k);
      }
    }
    while (map.size >= maxEntries) {
      const oldestKey = map.keys().next().value;
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
  }

  function isBlocked(key, currentMs) {
    const existing = map.get(key);
    if (!existing || existing.resetAt <= currentMs) {
      return false;
    }
    return existing.count >= maxHits;
  }

  function consume(key, currentMs) {
    sweepIfFull(currentMs);
    const existing = map.get(key);
    if (!existing || existing.resetAt <= currentMs) {
      map.set(key, { count: 1, resetAt: currentMs + windowMs });
      return true;
    }
    if (existing.count >= maxHits) {
      return false;
    }
    existing.count += 1;
    return true;
  }

  return { isBlocked, consume };
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
// 5. アプリケーションサーバー生成ファクトリ関数
// ---------------------------------------------------------------------
function createApp(options = {}) {
  const {
    db,
    idSecret,
    trustProxy = false,
    allowedOrigin = null,
    allowSignup = true,
    devInsecureCookie = false,
    maxBodyBytes = 1024 * 1024, // 通常投稿の既定上限: 1MB
    authMaxBodyBytes = AUTH_MAX_BODY_BYTES, // 認証系APIの既定上限: 4KB
    rateLimitWindowMs = 60_000, // 通常投稿レート制限窓: 60秒
    rateLimitMaxPosts = 20, // 60秒あたり同一IPから最大20投稿
    authRateLimitWindowMs = 5 * 60_000, // 認証レート制限窓: 5分
    authRateLimitMaxPerIp = 15,
    authRateLimitMaxPerAccount = 10,
    rateLimitMaxEntries = 2000,
    sessionTtlSeconds = SESSION_TTL_SECONDS,
    maxSessionsPerUser = MAX_SESSIONS_PER_USER,
    scryptQueue: customScryptQueue = null,
    scryptOptions = {},
    publicDir = DEFAULT_PUBLIC_DIR,
    nowFn = () => new Date(),
    quiet = false,
  } = options;

  if (!db) {
    throw new Error('createApp には db インスタンスの指定が必須です。');
  }
  const validIdSecret = validateIdSecret(idSecret);
  const resolvedPublicDir = path.resolve(publicDir);
  const configuredAllowedOrigin = normalizeAllowedOrigin(allowedOrigin);
  const signupEnabled = allowSignup !== false && String(allowSignup).toLowerCase() !== 'false';
  const allowDevInsecureCookie =
    devInsecureCookie === true || String(devInsecureCookie).toLowerCase() === 'true';
  const scryptQueue = customScryptQueue || createScryptQueue(scryptOptions);

  const postLimiter = createWindowLimiter({
    windowMs: rateLimitWindowMs,
    maxHits: rateLimitMaxPosts,
    maxEntries: rateLimitMaxEntries,
  });
  const authIpLimiter = createWindowLimiter({
    windowMs: authRateLimitWindowMs,
    maxHits: authRateLimitMaxPerIp,
    maxEntries: rateLimitMaxEntries,
  });
  const authAccountFailLimiter = createWindowLimiter({
    windowMs: authRateLimitWindowMs,
    maxHits: authRateLimitMaxPerAccount,
    maxEntries: rateLimitMaxEntries,
  });

  const authMetrics = {
    registerSuccess: 0,
    loginSuccess: 0,
    loginFailure: 0,
    rateLimited429: 0,
    queueRejected503: 0,
    passwordChanged: 0,
  };

  let lastPurgeMs = 0;
  const SESSION_PURGE_INTERVAL_MS = 10 * 60_000;

  function purgeExpiredSessionsIfDue(currentMs, nowIso) {
    if (currentMs - lastPurgeMs >= SESSION_PURGE_INTERVAL_MS) {
      lastPurgeMs = currentMs;
      db.purgeExpiredSessions(nowIso, 200);
    }
  }

  function ensureCookieTransportSafe(req) {
    if (!allowDevInsecureCookie && !isSecureRequest(req, { trustProxy })) {
      throw new ValidationError(
        'HTTPS接続が確認できないため認証セッションを発行できません。',
        403
      );
    }
  }

  function resolveRequestSession(req, nowIso) {
    const cookieState = parseSessionCookie(req, { devInsecureCookie: allowDevInsecureCookie });
    if (!cookieState.present) {
      return { status: 'none', cookieState, tokenHash: null, auth: null };
    }
    if (cookieState.invalid) {
      return { status: 'invalid', cookieState, tokenHash: null, auth: null };
    }
    const tokenHash = hashSessionToken(cookieState.token);
    const auth = db.getSessionAuthByTokenHash(tokenHash, nowIso);
    if (!auth) {
      return { status: 'invalid', cookieState, tokenHash, auth: null };
    }
    return { status: 'valid', cookieState, tokenHash, auth };
  }

  function buildClearCookieHeaders() {
    return {
      'Set-Cookie': buildClearSessionCookieHeader({ devInsecureCookie: allowDevInsecureCookie }),
    };
  }

  function checkMutatingHeaders(req, { requireOrigin = false } = {}) {
    verifyMutatingRequestHeaders(req, {
      requireOrigin,
      allowedOrigin: configuredAllowedOrigin,
      trustProxy,
    });
  }

  // 管理画面向け統一セッション認可チェック（第1段階：API入口での即座拒否）
  function requireAdminSession(req, res, nowIso) {
    const sess = resolveRequestSession(req, nowIso);
    if (sess.status === 'invalid') {
      sendJson(
        res,
        401,
        { error: 'ログインの有効期限が切れています。再ログインしてください。', code: 'SESSION_EXPIRED' },
        buildClearCookieHeaders()
      );
      return null;
    }
    if (sess.status !== 'valid') {
      sendJson(res, 401, {
        error: '管理者アカウントでのログインが必要です。',
        code: 'UNAUTHORIZED',
      });
      return null;
    }
    if (sess.auth.user.role !== 'admin') {
      sendJson(res, 403, {
        error: 'この操作には管理者権限が必要です。',
        code: 'FORBIDDEN',
      });
      return null;
    }
    if (sess.auth.user.mustChangePassword) {
      sendJson(res, 403, {
        error: '仮パスワードを変更して再ログインするまで管理画面は利用できません。',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
      return null;
    }
    return {
      sess,
      buildTxAuth: () => ({
        sessionTokenHash: sess.tokenHash,
        expectedUserId: sess.auth.user.id,
        expectedAuthVersion: sess.auth.authVersion,
        nowIso: nowFn().toISOString(),
      }),
    };
  }

  function ensurePlainBodyObject(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('リクエスト形式が不正です（JSONオブジェクトが必要です）。', 400);
    }
    return body;
  }

  // -------------------------------------------------------------------
  // 6. 静的ファイル配信処理（パストラバーサル・非公開ファイル完全遮断・ETag/304対応）
  // -------------------------------------------------------------------
  function matchesIfNoneMatch(headerValue, etag) {
    if (typeof headerValue !== 'string' || headerValue.trim() === '') {
      return false;
    }
    const trimmed = headerValue.trim();
    if (trimmed === '*') {
      return true;
    }
    const candidates = trimmed.split(',').map((item) => item.trim());
    return candidates.some((tag) => {
      const normalized = tag.startsWith('W/') ? tag.slice(2).trim() : tag;
      return normalized === etag;
    });
  }

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
    const etag = `"${crypto.createHash('sha256').update(fileBuffer).digest('base64url').slice(0, 24)}"`;
    setSecurityHeaders(res);

    const lowerTarget = relativeTarget.toLowerCase();
    const noStoreAsset =
      lowerTarget === '/admin.html' ||
      lowerTarget === '/admin.js' ||
      lowerTarget === '/admin.css';

    if (noStoreAsset) {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fileBuffer.length,
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(fileBuffer);
      }
      return;
    }

    if (matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
      res.writeHead(304, {
        ETag: etag,
        'Cache-Control': 'no-cache',
      });
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fileBuffer.length,
      'Cache-Control': 'no-cache',
      ETag: etag,
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

      // サブパス `/board/` 配備時の互換処理（Nginxが /board をそのまま渡した場合でもルート / と同様に動作させる）
      if (pathname === '/board') {
        setSecurityHeaders(res);
        res.writeHead(301, { Location: `/board/${parsedUrl.search || ''}` });
        res.end();
        return;
      }
      if (pathname === '/board/') {
        pathname = '/';
      } else if (pathname.startsWith('/board/')) {
        pathname = pathname.slice('/board'.length);
      }

      // [GET] ヘルスチェック
      if (pathname === '/api/health') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET' });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // [GET] 初回描画用まとめ取得（認証状態＋カテゴリ・スレッド一覧＋初期スレッド詳細を1往復で返す）
      if (pathname === '/api/bootstrap') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET' });
          return;
        }
        const rawThreadId = parsedUrl.searchParams.get('threadId');
        const requestedThreadId =
          rawThreadId !== null && rawThreadId !== ''
            ? parsePositiveInt(rawThreadId, 'スレッドID')
            : null;

        const nowDate = nowFn();
        const nowIso = nowDate.toISOString();
        purgeExpiredSessionsIfDue(nowDate.getTime(), nowIso);
        const sess = resolveRequestSession(req, nowIso);
        const extraHeaders = sess.status === 'invalid' ? buildClearCookieHeaders() : {};
        const user = sess.status === 'valid' ? sess.auth.user : null;

        const categories = db.listCategoriesWithThreads();
        let targetThreadId = null;
        if (requestedThreadId !== null) {
          for (const cat of categories) {
            if ((cat.threads || []).some((t) => t.id === requestedThreadId)) {
              targetThreadId = requestedThreadId;
              break;
            }
          }
        }
        if (targetThreadId === null) {
          for (const cat of categories) {
            if ((cat.threads || []).length > 0) {
              targetThreadId = cat.threads[0].id;
              break;
            }
          }
        }
        const initialThread = targetThreadId !== null ? db.getThreadDetail(targetThreadId) : null;
        sendJson(res, 200, { user, categories, initialThread }, extraHeaders);
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

      // [GET] 現在のログイン状態取得
      if (pathname === '/api/auth/me') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET' });
          return;
        }
        const nowDate = nowFn();
        const nowIso = nowDate.toISOString();
        purgeExpiredSessionsIfDue(nowDate.getTime(), nowIso);
        const sess = resolveRequestSession(req, nowIso);
        if (sess.status === 'invalid') {
          sendJson(res, 200, { user: null }, buildClearCookieHeaders());
          return;
        }
        sendJson(res, 200, { user: sess.status === 'valid' ? sess.auth.user : null });
        return;
      }

      // [POST] 新規アカウント登録＋即ログイン
      if (pathname === '/api/auth/register') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST メソッドを使用してください。' }, { Allow: 'POST' });
          return;
        }
        checkMutatingHeaders(req, { requireOrigin: true });

        const clientIp = extractClientIp(req, { trustProxy });
        const nowDate = nowFn();
        const nowMs = nowDate.getTime();
        purgeExpiredSessionsIfDue(nowMs, nowDate.toISOString());

        if (!authIpLimiter.consume(clientIp, nowMs)) {
          authMetrics.rateLimited429 += 1;
          sendJson(res, 429, {
            error: '認証リクエストが集中しています。少し時間をおいてから再試行してください。',
          });
          return;
        }

        const rawBody = await readJsonBody(req, authMaxBodyBytes);
        if (!signupEnabled) {
          sendJson(res, 403, { error: '現在、新規アカウント登録の受付を一時停止しています。' });
          return;
        }
        ensureCookieTransportSafe(req);

        const validInput = validateAuthRegisterInput(rawBody);
        const passwordHash = await scryptQueue.hashPassword(validInput.password);

        const commitDate = nowFn();
        const commitIso = commitDate.toISOString();
        const expiresAt = new Date(commitDate.getTime() + sessionTtlSeconds * 1000).toISOString();
        const rawToken = generateSessionToken();
        const tokenHash = hashSessionToken(rawToken);

        const user = db.createUserWithSession({
          username: validInput.username,
          passwordHash,
          role: 'user',
          tokenHash,
          expiresAt,
          nowIso: commitIso,
        });

        authMetrics.registerSuccess += 1;
        sendJson(
          res,
          201,
          { user },
          {
            'Set-Cookie': buildSetSessionCookieHeader(rawToken, {
              devInsecureCookie: allowDevInsecureCookie,
              maxAgeSeconds: sessionTtlSeconds,
            }),
          }
        );
        return;
      }

      // [POST] ログイン
      if (pathname === '/api/auth/login') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST メソッドを使用してください。' }, { Allow: 'POST' });
          return;
        }
        checkMutatingHeaders(req, { requireOrigin: true });

        const clientIp = extractClientIp(req, { trustProxy });
        const nowDate = nowFn();
        const nowMs = nowDate.getTime();
        purgeExpiredSessionsIfDue(nowMs, nowDate.toISOString());

        if (!authIpLimiter.consume(clientIp, nowMs)) {
          authMetrics.rateLimited429 += 1;
          sendJson(res, 429, {
            error: '認証リクエストが集中しています。少し時間をおいてから再試行してください。',
          });
          return;
        }

        const rawBody = await readJsonBody(req, authMaxBodyBytes);
        ensureCookieTransportSafe(req);

        const validInput = validateAuthLoginInput(rawBody);
        if (authAccountFailLimiter.isBlocked(validInput.username, nowMs)) {
          authMetrics.rateLimited429 += 1;
          sendJson(res, 429, {
            error: 'ログイン試行が集中しています。少し時間をおいてから再試行してください。',
          });
          return;
        }

        const authUser = db.getUserForAuthByUsername(validInput.username);
        let isMatch = false;
        let expectedAuthVersion = 0;

        if (!authUser) {
          await scryptQueue.verifyDummyPassword(validInput.password);
        } else {
          expectedAuthVersion = Number(authUser.auth_version);
          isMatch = await scryptQueue.verifyPassword(validInput.password, authUser.password_hash);
        }

        if (!authUser || !isMatch) {
          authAccountFailLimiter.consume(validInput.username, nowMs);
          authMetrics.loginFailure += 1;
          sendJson(res, 401, { error: 'ユーザー名またはパスワードが正しくありません。' });
          return;
        }

        const existingCookie = parseSessionCookie(req, { devInsecureCookie: allowDevInsecureCookie });
        const replaceTokenHash =
          !existingCookie.invalid && existingCookie.token
            ? hashSessionToken(existingCookie.token)
            : null;

        const commitDate = nowFn();
        const commitIso = commitDate.toISOString();
        const expiresAt = new Date(commitDate.getTime() + sessionTtlSeconds * 1000).toISOString();
        const rawToken = generateSessionToken();
        const tokenHash = hashSessionToken(rawToken);

        const issued = db.issueSessionIfVersionMatches({
          userId: authUser.id,
          expectedAuthVersion,
          tokenHash,
          expiresAt,
          nowIso: commitIso,
          maxSessions: maxSessionsPerUser,
          replaceTokenHash,
        });

        if (!issued.issued) {
          authMetrics.loginFailure += 1;
          sendJson(res, 401, {
            error: '認証状態が更新されたためログインを完了できませんでした。再度お試しください。',
          });
          return;
        }

        authMetrics.loginSuccess += 1;
        sendJson(
          res,
          200,
          { user: issued.user },
          {
            'Set-Cookie': buildSetSessionCookieHeader(rawToken, {
              devInsecureCookie: allowDevInsecureCookie,
              maxAgeSeconds: sessionTtlSeconds,
            }),
          }
        );
        return;
      }

      // [POST] ログアウト（仮パスワード中でも常に許可・冪等）
      if (pathname === '/api/auth/logout') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST メソッドを使用してください。' }, { Allow: 'POST' });
          return;
        }
        checkMutatingHeaders(req, { requireOrigin: true });
        await readJsonBody(req, authMaxBodyBytes);

        const cookieState = parseSessionCookie(req, { devInsecureCookie: allowDevInsecureCookie });
        if (!cookieState.invalid && cookieState.token) {
          db.deleteSessionByTokenHash(hashSessionToken(cookieState.token));
        }

        sendJson(res, 200, { ok: true }, buildClearCookieHeaders());
        return;
      }

      // [POST] 本人によるパスワード変更（R1: 確定時に世代一致と現セッション生存を再確認）
      if (pathname === '/api/auth/password') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST メソッドを使用してください。' }, { Allow: 'POST' });
          return;
        }
        checkMutatingHeaders(req, { requireOrigin: true });

        const clientIp = extractClientIp(req, { trustProxy });
        const nowDate = nowFn();
        const nowMs = nowDate.getTime();
        const nowIso = nowDate.toISOString();
        purgeExpiredSessionsIfDue(nowMs, nowIso);

        if (!authIpLimiter.consume(clientIp, nowMs)) {
          authMetrics.rateLimited429 += 1;
          sendJson(res, 429, {
            error: 'リクエストが集中しています。少し時間をおいてから再試行してください。',
          });
          return;
        }

        const rawBody = await readJsonBody(req, authMaxBodyBytes);
        const authNowDate = nowFn();
        const authNowMs = authNowDate.getTime();
        const authNowIso = authNowDate.toISOString();
        const sess = resolveRequestSession(req, authNowIso);
        if (sess.status !== 'valid') {
          sendJson(
            res,
            401,
            { error: 'ログインの有効期限が切れているか未ログインです。' },
            sess.status === 'invalid' ? buildClearCookieHeaders() : {}
          );
          return;
        }

        const validInput = validateChangePasswordInput(rawBody);
        const userId = sess.auth.user.id;
        const username = sess.auth.user.username;
        const expectedAuthVersion = sess.auth.authVersion;
        const sessionTokenHash = sess.tokenHash;
        const currentHash = sess.auth.passwordHash;

        if (authAccountFailLimiter.isBlocked(username, authNowMs)) {
          authMetrics.rateLimited429 += 1;
          sendJson(res, 429, {
            error: '認証試行が集中しています。少し時間をおいてから再試行してください。',
          });
          return;
        }

        const currentOk = await scryptQueue.verifyPassword(validInput.currentPassword, currentHash);
        if (!currentOk) {
          authAccountFailLimiter.consume(username, authNowMs);
          authMetrics.loginFailure += 1;
          sendJson(res, 401, { error: '現在のパスワードが正しくありません。' });
          return;
        }

        const newPasswordHash = await scryptQueue.hashPassword(validInput.newPassword);
        const confirmIso = nowFn().toISOString();
        const changed = db.changePasswordIfUnchanged({
          userId,
          expectedAuthVersion,
          sessionTokenHash,
          newPasswordHash,
          nowIso: confirmIso,
        });

        if (!changed.updated) {
          sendJson(
            res,
            401,
            {
              error: '認証状態が更新されたかセッションが失効したため変更できませんでした。再度ログインしてください。',
            },
            buildClearCookieHeaders()
          );
          return;
        }

        authMetrics.passwordChanged += 1;
        sendJson(res, 200, { ok: true }, buildClearCookieHeaders());
        return;
      }

      // [POST] 新規投稿・ツリー返信の登録
      if (pathname === '/api/posts') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '投稿には POST メソッドを使用してください。' }, { Allow: 'POST' });
          return;
        }

        const anyCookie = hasAnyCookieHeader(req);
        checkMutatingHeaders(req, { requireOrigin: anyCookie });

        const clientIp = extractClientIp(req, { trustProxy });
        const rateLimitNowMs = nowFn().getTime();
        if (!postLimiter.consume(clientIp, rateLimitNowMs)) {
          sendJson(res, 429, {
            error: '短時間に投稿が集中しています。少し時間をおいてから再試行してください。',
          });
          return;
        }

        const rawBody = await readJsonBody(req, maxBodyBytes);
        const bodyObj =
          rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : null;

        // 送信意図（認証あり／なし・想定ユーザーID）の型と整合性を検証する
        if (bodyObj && bodyObj.expect_auth !== undefined && typeof bodyObj.expect_auth !== 'boolean') {
          throw new ValidationError('expect_auth は真偽値で指定してください。', 400);
        }
        const hasExpectedUserId = Boolean(bodyObj && bodyObj.expected_user_id !== undefined);
        const expectedUserId = hasExpectedUserId ? bodyObj.expected_user_id : undefined;
        if (
          hasExpectedUserId &&
          expectedUserId !== null &&
          (!Number.isSafeInteger(expectedUserId) || expectedUserId < 1)
        ) {
          throw new ValidationError('expected_user_id は null または正の整数で指定してください。', 400);
        }
        if (bodyObj && hasExpectedUserId) {
          if (bodyObj.expect_auth === true && expectedUserId === null) {
            throw new ValidationError('expect_auth と expected_user_id の指定が矛盾しています。', 400);
          }
          if (bodyObj.expect_auth === false && typeof expectedUserId === 'number') {
            throw new ValidationError('expect_auth と expected_user_id の指定が矛盾しています。', 400);
          }
        }
        const expectAuth = Boolean(bodyObj && bodyObj.expect_auth === true);

        // 本文読取り完了後の時刻でセッション期限と日替わりIDを一貫判定する（読取中の期限切れ通過を防止）
        // ※ DB保存までawaitを挟まず同期的に処理し、判定後のレースを防ぐ
        const actionNowDate = nowFn();
        const actionNowIso = actionNowDate.toISOString();
        const sess = resolveRequestSession(req, actionNowIso);

        // 無効・期限切れCookieが付いていた場合、または会員投稿を意図(expect_auth / expected_user_id指定)したのに
        // 別タブログアウト等でCookieが消えていた場合は黙って匿名化せず、明確な401で再送信選択させる
        if (
          sess.status === 'invalid' ||
          ((expectAuth || typeof expectedUserId === 'number') && sess.status !== 'valid')
        ) {
          const extraHeaders = sess.status === 'invalid' ? buildClearCookieHeaders() : {};
          sendJson(
            res,
            401,
            {
              error:
                'ログインの有効期限が切れています。再ログインするか、ログアウト状態（匿名）として再送信してください。',
              code: 'SESSION_EXPIRED',
            },
            extraHeaders
          );
          return;
        }

        // expected_user_id 指定時（現行フロント）、別タブでのアカウント切替（会員A→B、匿名→会員A）を検出したら
        // 意図しない投稿者として保存せず409で現在の認証状態を返す（未指定の旧クライアントは後方互換のためスキップ）
        if (hasExpectedUserId && sess.status === 'valid' && expectedUserId !== sess.auth.user.id) {
          const currentUser = {
            id: sess.auth.user.id,
            username: sess.auth.user.username,
            role: sess.auth.user.role,
            mustChangePassword: Boolean(sess.auth.user.mustChangePassword),
          };
          const mismatchMessage =
            expectedUserId === null
              ? `別タブ等で「${currentUser.username}」としてログインされています。下書きを保持したまま表示を切り替えたため、このまま会員として投稿するか、アカウント画面からログアウトしてください。`
              : `別タブ等でログイン中のアカウントが「${currentUser.username}」に切り替わっています。下書きを保持しているため、このアカウントのまま投稿するか、アカウント画面で切り替えてから再度送信してください。`;
          sendJson(res, 409, {
            error: mismatchMessage,
            code: 'AUTH_USER_MISMATCH',
            currentUser,
          });
          return;
        }

        // R2: 仮パスワード中の通常投稿を403で拒否する
        if (sess.status === 'valid' && sess.auth.user.mustChangePassword) {
          sendJson(res, 403, {
            error: '仮パスワードのままでは投稿できません。先にパスワードを変更してください。',
            code: 'PASSWORD_CHANGE_REQUIRED',
          });
          return;
        }

        const isMemberPost = sess.status === 'valid';
        const validInput = validatePostInput(rawBody, { ignoreAuthorName: isMemberPost });
        const visitorId = generateVisitorId({
          ip: clientIp,
          secret: validIdSecret,
          now: actionNowDate,
        });

        const createdPost = db.createPost({
          threadId: validInput.threadId,
          parentId: validInput.parentId,
          authorName: isMemberPost ? sess.auth.user.username : validInput.authorName,
          visitorId,
          content: validInput.content,
          createdBy: isMemberPost ? sess.auth.user.id : null,
        });

        sendJson(res, 201, { post: createdPost });
        return;
      }

      // ===============================================================
      // 管理画面専用 API（v1.1 統一セッション認可 ＋ 確定直前再認可 ＋ 同一TX監査）
      // 旧 verifyAdminBearerToken 経路は v1.1 で完全廃止済み。
      // ===============================================================

      // [GET] 管理画面概要（統計・カテゴリ＋スレッド一覧）
      if (pathname === '/api/admin/overview') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET' });
          return;
        }
        const adminCtx = requireAdminSession(req, res, nowFn().toISOString());
        if (!adminCtx) return;
        const overview = db.getAdminOverview();
        sendJson(res, 200, {
          user: {
            id: adminCtx.sess.auth.user.id,
            username: adminCtx.sess.auth.user.username,
            role: adminCtx.sess.auth.user.role,
          },
          ...overview,
        });
        return;
      }

      // [GET] 管理用ユーザー一覧（ページング上限あり・hash類一切除外）
      if (pathname === '/api/admin/users') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET' });
          return;
        }
        const nowIso = nowFn().toISOString();
        const adminCtx = requireAdminSession(req, res, nowIso);
        if (!adminCtx) return;
        const result = db.listAdminUsers({
          limit: parsedUrl.searchParams.get('limit'),
          offset: parsedUrl.searchParams.get('offset'),
          nowIso,
        });
        sendJson(res, 200, result);
        return;
      }

      // [GET] 管理操作監査ログ一覧（カーソルページング）
      if (pathname === '/api/admin/audit-logs') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET' });
          return;
        }
        const adminCtx = requireAdminSession(req, res, nowFn().toISOString());
        if (!adminCtx) return;
        const result = db.listAdminAuditLogs({
          limit: parsedUrl.searchParams.get('limit'),
          beforeId: parsedUrl.searchParams.get('before_id'),
        });
        sendJson(res, 200, result);
        return;
      }

      // [GET] 管理用スレッド配下投稿一覧（論理削除済みはSQL側でマスク済み）
      const adminThreadPostsMatch = pathname.match(/^\/api\/admin\/threads\/([^/]+)\/posts$/);
      if (adminThreadPostsMatch) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET' });
          return;
        }
        const adminCtx = requireAdminSession(req, res, nowFn().toISOString());
        if (!adminCtx) return;
        const threadId = parsePositiveInt(adminThreadPostsMatch[1], 'スレッドID');
        const detail = db.getAdminThreadPosts(threadId);
        if (!detail) {
          sendJson(res, 404, { error: '指定されたスレッドが見つかりません。' });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }

      // [GET] スレッド物理削除の事前プレビュー（対象タイトル＋現在投稿件数）
      const adminThreadPreviewMatch = pathname.match(/^\/api\/admin\/threads\/([^/]+)\/delete-preview$/);
      if (adminThreadPreviewMatch) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET' });
          return;
        }
        const adminCtx = requireAdminSession(req, res, nowFn().toISOString());
        if (!adminCtx) return;
        const threadId = parsePositiveInt(adminThreadPreviewMatch[1], 'スレッドID');
        const preview = db.getPurgeThreadPreview(threadId);
        if (!preview.found) {
          sendJson(res, 404, { error: '指定されたスレッドが見つかりません。' });
          return;
        }
        sendJson(res, 200, {
          thread: {
            id: preview.thread.id,
            category_id: preview.thread.category_id,
            category_name: preview.category.name,
            title: preview.thread.title,
          },
          postsCount: preview.postsCount,
        });
        return;
      }

      // [POST] 管理者専用：投稿の論理削除（is_deleted = 1）
      const adminDeleteMatch = pathname.match(/^\/api\/admin\/posts\/([^/]+)\/delete$/);
      if (adminDeleteMatch) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'POST' });
          return;
        }
        checkMutatingHeaders(req, { requireOrigin: true });
        const adminCtx = requireAdminSession(req, res, nowFn().toISOString());
        if (!adminCtx) return;

        ensurePlainBodyObject(await readJsonBody(req, maxBodyBytes));
        const postId = parsePositiveInt(adminDeleteMatch[1], '投稿ID');
        const result = db.softDeletePost(postId, { adminAuth: adminCtx.buildTxAuth() });
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
        checkMutatingHeaders(req, { requireOrigin: true });
        const adminCtx = requireAdminSession(req, res, nowFn().toISOString());
        if (!adminCtx) return;

        const body = ensurePlainBodyObject(await readJsonBody(req, maxBodyBytes));
        const postId = parsePositiveInt(adminPinMatch[1], '投稿ID');
        if (body.pinned !== undefined && typeof body.pinned !== 'boolean') {
          throw new ValidationError('pinned には true または false を指定してください。', 400);
        }
        const pinnedFlag = body.pinned === undefined ? true : body.pinned;
        const result = db.setPostPinned(postId, pinnedFlag, { adminAuth: adminCtx.buildTxAuth() });
        if (!result.found) {
          sendJson(res, 404, { error: '指定された投稿が見つかりません。' });
          return;
        }
        sendJson(res, 200, { ok: true, postId, isPinned: result.isPinned });
        return;
      }

      // [POST] 管理者専用：カテゴリ追加
      if (pathname === '/api/admin/categories') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'POST' });
          return;
        }
        checkMutatingHeaders(req, { requireOrigin: true });
        const adminCtx = requireAdminSession(req, res, nowFn().toISOString());
        if (!adminCtx) return;

        const body = ensurePlainBodyObject(await readJsonBody(req, maxBodyBytes));
        const rawOrder = body.displayOrder !== undefined ? body.displayOrder : body.display_order;
        const category = db.createCategory({
          name: body.name,
          displayOrder: rawOrder === undefined ? null : rawOrder,
          adminAuth: adminCtx.buildTxAuth(),
        });
        sendJson(res, 201, { category });
        return;
      }

      // [PATCH / DELETE] 管理者専用：カテゴリ更新・削除
      const adminCategoryItemMatch = pathname.match(/^\/api\/admin\/categories\/([^/]+)$/);
      if (adminCategoryItemMatch) {
        if (req.method !== 'PATCH' && req.method !== 'DELETE') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'PATCH, DELETE' });
          return;
        }
        checkMutatingHeaders(req, { requireOrigin: true });
        const adminCtx = requireAdminSession(req, res, nowFn().toISOString());
        if (!adminCtx) return;

        const categoryId = parsePositiveInt(adminCategoryItemMatch[1], 'カテゴリID');
        const body = ensurePlainBodyObject(await readJsonBody(req, maxBodyBytes));

        if (req.method === 'PATCH') {
          const rawOrder = body.displayOrder !== undefined ? body.displayOrder : body.display_order;
          if (body.name === undefined && rawOrder === undefined) {
            throw new ValidationError('更新項目（name または displayOrder）を指定してください。', 400);
          }
          if (body.name === null || rawOrder === null) {
            throw new ValidationError('更新項目に null は指定できません。', 400);
          }
          const result = db.updateCategory({
            categoryId,
            name: body.name,
            displayOrder: rawOrder,
            adminAuth: adminCtx.buildTxAuth(),
          });
          if (!result.found) {
            sendJson(res, 404, { error: '指定されたカテゴリが見つかりません。' });
            return;
          }
          sendJson(res, 200, { category: result.category });
          return;
        }

        const result = db.deleteCategory(categoryId, { adminAuth: adminCtx.buildTxAuth() });
        if (!result.found) {
          sendJson(res, 404, { error: '指定されたカテゴリが見つかりません。' });
          return;
        }
        sendJson(res, 200, { ok: true, deletedCategory: result.deletedCategory });
        return;
      }

      // [POST] 管理者専用：スレッド追加
      if (pathname === '/api/admin/threads') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'POST' });
          return;
        }
        checkMutatingHeaders(req, { requireOrigin: true });
        const adminCtx = requireAdminSession(req, res, nowFn().toISOString());
        if (!adminCtx) return;

        const body = ensurePlainBodyObject(await readJsonBody(req, maxBodyBytes));
        const rawCatId = body.categoryId !== undefined ? body.categoryId : body.category_id;
        const categoryId = parsePositiveInt(rawCatId, 'カテゴリID');
        const rawPinnedText = body.pinnedText !== undefined ? body.pinnedText : body.pinned_text;
        const rawIsPinned = body.isPinned !== undefined ? body.isPinned : body.is_pinned;
        const rawOrder = body.displayOrder !== undefined ? body.displayOrder : body.display_order;

        const thread = db.createThread({
          categoryId,
          title: body.title,
          pinnedText: rawPinnedText === undefined ? null : rawPinnedText,
          isPinned: rawIsPinned === undefined ? false : rawIsPinned,
          displayOrder: rawOrder === undefined ? null : rawOrder,
          createdBy: adminCtx.sess.auth.user.id,
          adminAuth: adminCtx.buildTxAuth(),
        });
        sendJson(res, 201, { thread });
        return;
      }

      // [PATCH / DELETE] 管理者専用：スレッド更新・物理削除（直前件数照合付き）
      const adminThreadItemMatch = pathname.match(/^\/api\/admin\/threads\/([^/]+)$/);
      if (adminThreadItemMatch) {
        if (req.method !== 'PATCH' && req.method !== 'DELETE') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'PATCH, DELETE' });
          return;
        }
        checkMutatingHeaders(req, { requireOrigin: true });
        const adminCtx = requireAdminSession(req, res, nowFn().toISOString());
        if (!adminCtx) return;

        const threadId = parsePositiveInt(adminThreadItemMatch[1], 'スレッドID');
        const body = ensurePlainBodyObject(await readJsonBody(req, maxBodyBytes));

        if (req.method === 'PATCH') {
          const rawPinnedText = body.pinnedText !== undefined ? body.pinnedText : body.pinned_text;
          const rawIsPinned = body.isPinned !== undefined ? body.isPinned : body.is_pinned;
          const rawOrder = body.displayOrder !== undefined ? body.displayOrder : body.display_order;
          if (
            body.title === undefined &&
            rawPinnedText === undefined &&
            rawIsPinned === undefined &&
            rawOrder === undefined
          ) {
            throw new ValidationError('更新項目を1つ以上指定してください。', 400);
          }
          if (body.title === null || rawOrder === null) {
            throw new ValidationError('title または displayOrder に null は指定できません。', 400);
          }
          const result = db.updateThread({
            threadId,
            title: body.title,
            pinnedText: rawPinnedText,
            isPinned: rawIsPinned,
            displayOrder: rawOrder,
            adminAuth: adminCtx.buildTxAuth(),
          });
          if (!result.found) {
            sendJson(res, 404, { error: '指定されたスレッドが見つかりません。' });
            return;
          }
          sendJson(res, 200, { thread: result.thread });
          return;
        }

        const expectedPostCount =
          body.expectedPostCount !== undefined ? body.expectedPostCount : body.expected_post_count;
        const result = db.purgeThread(threadId, {
          requireConfirmation: true,
          confirmTitle: body.confirmTitle,
          expectedPostCount,
          adminAuth: adminCtx.buildTxAuth(),
        });
        if (!result.found) {
          sendJson(res, 404, { error: '指定されたスレッドが見つかりません。' });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          deletedThread: result.deletedThread,
          deletedPostsCount: result.deletedPostsCount,
        });
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
        const errorBody = { error: err.message };
        if (err.code) errorBody.code = err.code;
        if (err.details) errorBody.details = err.details;
        sendJson(res, err.statusCode, errorBody, extra);
      } else if (err instanceof AuthQueueFullError) {
        authMetrics.queueRejected503 += 1;
        sendJson(res, 503, { error: err.message }, { 'Retry-After': '2' });
      } else {
        if (!quiet) {
          console.error('[ERROR] リクエスト処理中に予期せぬ例外が発生しました:', err?.message || 'unknown error');
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

  server.getAuthMetrics = () => ({
    ...authMetrics,
    scryptQueue: scryptQueue.getStats(),
  });

  return server;
}

module.exports = {
  DEFAULT_PUBLIC_DIR,
  createApp,
};
