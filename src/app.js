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
// 2. 更新系API（POST）向けの CSRF / Content-Type / Origin完全一致 防御検査
// フォーム送信等の単純リクエストによるCSRFや、別オリジン・スキーム違いからの不正要求を拒否する。
// ---------------------------------------------------------------------
function verifyMutatingRequestHeaders(
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

  // Content-Type が application/json であることを要求（HTML form からの直送信を遮断）
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  const mediaType = contentType.split(';')[0].trim();
  if (mediaType !== 'application/json') {
    throw new ValidationError('Content-Type には application/json を指定してください。', 415);
  }
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

  // ADMIN_TOKEN が未設定または見本値のままならHTTP管理削除を無効化する
  const validAdminToken =
    typeof adminToken === 'string' &&
    adminToken.trim().length >= 16 &&
    !adminToken.trim().startsWith('CHANGE_ME')
      ? adminToken.trim()
      : null;

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
        // 本文読取り完了後の時刻でセッション期限と日替わりIDを一貫判定する（読取中の期限切れ通過を防止）
        const actionNowDate = nowFn();
        const actionNowIso = actionNowDate.toISOString();
        const sess = resolveRequestSession(req, actionNowIso);

        // 無効・期限切れCookieが付いていた場合は黙って匿名化せず、明確な401で再送信選択させる
        if (sess.status === 'invalid') {
          sendJson(
            res,
            401,
            {
              error:
                'ログインの有効期限が切れています。再ログインするか、ログアウト状態（匿名）として再送信してください。',
              code: 'SESSION_EXPIRED',
            },
            buildClearCookieHeaders()
          );
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

      // [POST] 管理者専用：投稿の論理削除（is_deleted = 1）
      const adminDeleteMatch = pathname.match(/^\/api\/admin\/posts\/([^/]+)\/delete$/);
      if (adminDeleteMatch) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'POST' });
          return;
        }

        checkMutatingHeaders(req, { requireOrigin: hasAnyCookieHeader(req) });

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

        checkMutatingHeaders(req, { requireOrigin: hasAnyCookieHeader(req) });

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
