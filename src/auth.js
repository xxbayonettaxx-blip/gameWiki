'use strict';

/**
 * =====================================================================
 * src/auth.js
 * 役割：【認証コア】scrypt計算キュー・トークン生成・__Host- Cookie・Origin検査
 * 方針：
 *   - 外部npmパッケージに依存せず Node.js 標準の node:crypto のみで構成する。
 *   - scrypt の同時実行数と待機キューに上限を設け、総当たりによるメモリ枯渇を防ぐ。
 *   - HTTPS環境では __Host- プレフィックス＋Secure＋HttpOnly＋SameSite=Lax＋Domainなしを強制し、
 *     本番設定のまま非Secureへ自動劣化させない。
 * =====================================================================
 */

const crypto = require('node:crypto');
const { normalizeIp } = require('./validators');

const HTTPS_SESSION_COOKIE_NAME = '__Host-board_session';
const DEV_SESSION_COOKIE_NAME = 'board_session_dev';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7日間 (604,800秒)
const MAX_SESSIONS_PER_USER = 5;
const AUTH_MAX_BODY_BYTES = 4096; // 認証系APIの上限 4KB

const DEFAULT_SCRYPT_PARAMS = Object.freeze({
  version: 'v1',
  N: 16384, // 2^14
  r: 8,
  p: 5,
  keylen: 64,
  maxmem: 64 * 1024 * 1024, // 64 MiB
});

const SCRYPT_LIMITS = Object.freeze({
  minN: 1024,
  maxN: 65536,
  minR: 1,
  maxR: 16,
  minP: 1,
  maxP: 8,
  requiredKeylen: 64,
  minSaltBytes: 16,
  maxSaltBytes: 32,
  maxEstimatedMemoryBytes: 64 * 1024 * 1024,
});

const DEFAULT_SCRYPT_MAX_CONCURRENCY = 1;
const DEFAULT_SCRYPT_MAX_QUEUE = 4;

// 未登録ユーザー時も同じキュー・計算コストを通すためのダミー比較ハッシュ
const DUMMY_PASSWORD_HASH =
  `scrypt$v1$${DEFAULT_SCRYPT_PARAMS.N}$${DEFAULT_SCRYPT_PARAMS.r}$${DEFAULT_SCRYPT_PARAMS.p}$${DEFAULT_SCRYPT_PARAMS.keylen}$` +
  `${'0'.repeat(32)}$${'0'.repeat(128)}`;

class AuthQueueFullError extends Error {
  constructor(message = '現在認証処理が混み合っています。少し待ってから再試行してください。') {
    super(message);
    this.name = 'AuthQueueFullError';
    this.statusCode = 503;
  }
}

function defaultScryptAsync(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

function isPositiveIntString(raw) {
  return typeof raw === 'string' && /^[1-9]\d*$/.test(raw);
}

// ---------------------------------------------------------------------
// 1. 保存済み scrypt ハッシュ文字列の厳格パース・パラメータ境界検証
// 不正な値や許容上限を超えるパラメータを拒否し、異常値による無制限計算を防ぐ。
// 形式: scrypt$v1$<N>$<r>$<p>$<keylen>$<saltHex>$<derivedHex>
// ---------------------------------------------------------------------
function parseStoredPasswordHash(storedHash) {
  if (typeof storedHash !== 'string' || storedHash.length > 512) {
    return null;
  }
  const parts = storedHash.split('$');
  if (parts.length !== 8) {
    return null;
  }
  const [algo, version, nStr, rStr, pStr, keylenStr, saltHex, derivedHex] = parts;
  if (algo !== 'scrypt' || version !== 'v1') {
    return null;
  }
  if (
    !isPositiveIntString(nStr) ||
    !isPositiveIntString(rStr) ||
    !isPositiveIntString(pStr) ||
    !isPositiveIntString(keylenStr)
  ) {
    return null;
  }

  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  const keylen = Number(keylenStr);

  if (
    !Number.isSafeInteger(N) ||
    !Number.isSafeInteger(r) ||
    !Number.isSafeInteger(p) ||
    !Number.isSafeInteger(keylen)
  ) {
    return null;
  }

  const isPowerOfTwo = N > 0 && (N & (N - 1)) === 0;
  if (!isPowerOfTwo || N < SCRYPT_LIMITS.minN || N > SCRYPT_LIMITS.maxN) {
    return null;
  }
  if (r < SCRYPT_LIMITS.minR || r > SCRYPT_LIMITS.maxR) {
    return null;
  }
  if (p < SCRYPT_LIMITS.minP || p > SCRYPT_LIMITS.maxP) {
    return null;
  }
  if (keylen !== SCRYPT_LIMITS.requiredKeylen) {
    return null;
  }
  if (128 * N * r > SCRYPT_LIMITS.maxEstimatedMemoryBytes) {
    return null;
  }

  if (
    !/^[0-9a-f]+$/.test(saltHex) ||
    saltHex.length % 2 !== 0 ||
    saltHex.length < SCRYPT_LIMITS.minSaltBytes * 2 ||
    saltHex.length > SCRYPT_LIMITS.maxSaltBytes * 2
  ) {
    return null;
  }

  if (!/^[0-9a-f]+$/.test(derivedHex) || derivedHex.length !== keylen * 2) {
    return null;
  }

  return { version, N, r, p, keylen, saltHex, derivedHex };
}

// ---------------------------------------------------------------------
// 2. アプリ全体で共有する非同期 scrypt 計算キュー
// ---------------------------------------------------------------------
function createScryptQueue(options = {}) {
  const {
    maxConcurrency = DEFAULT_SCRYPT_MAX_CONCURRENCY,
    maxQueue = DEFAULT_SCRYPT_MAX_QUEUE,
    defaultParams = DEFAULT_SCRYPT_PARAMS,
    scryptFn = defaultScryptAsync,
  } = options;

  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error('scryptキューの maxConcurrency は1以上の整数で指定してください。');
  }
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) {
    throw new Error('scryptキューの maxQueue は0以上の整数で指定してください。');
  }

  let active = 0;
  const waiting = [];
  let totalExecuted = 0;
  let totalRejectedFull = 0;

  function pump() {
    while (active < maxConcurrency && waiting.length > 0) {
      const next = waiting.shift();
      runTask(next.taskFn, next.resolve, next.reject);
    }
  }

  function runTask(taskFn, resolve, reject) {
    active += 1;
    Promise.resolve()
      .then(taskFn)
      .then(
        (res) => {
          totalExecuted += 1;
          active -= 1;
          pump();
          resolve(res);
        },
        (err) => {
          totalExecuted += 1;
          active -= 1;
          pump();
          reject(err);
        }
      );
  }

  function enqueue(taskFn) {
    if (active < maxConcurrency) {
      return new Promise((resolve, reject) => {
        runTask(taskFn, resolve, reject);
      });
    }
    if (waiting.length >= maxQueue) {
      totalRejectedFull += 1;
      return Promise.reject(new AuthQueueFullError());
    }
    return new Promise((resolve, reject) => {
      waiting.push({ taskFn, resolve, reject });
    });
  }

  async function hashPassword(password, params = defaultParams) {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('ハッシュ対象のパスワードが不正です。');
    }
    const {
      N = DEFAULT_SCRYPT_PARAMS.N,
      r = DEFAULT_SCRYPT_PARAMS.r,
      p = DEFAULT_SCRYPT_PARAMS.p,
      keylen = DEFAULT_SCRYPT_PARAMS.keylen,
      maxmem = DEFAULT_SCRYPT_PARAMS.maxmem,
    } = params;
    const salt = crypto.randomBytes(16);
    const derived = await enqueue(() =>
      scryptFn(password, salt, keylen, { N, r, p, maxmem })
    );
    return `scrypt$v1$${N}$${r}$${p}$${keylen}$${salt.toString('hex')}$${Buffer.from(derived).toString('hex')}`;
  }

  async function verifyPassword(password, storedHash) {
    if (typeof password !== 'string' || password.length === 0) {
      return false;
    }
    const parsed = parseStoredPasswordHash(storedHash);
    if (!parsed) {
      return false;
    }
    const salt = Buffer.from(parsed.saltHex, 'hex');
    const expected = Buffer.from(parsed.derivedHex, 'hex');
    const derived = await enqueue(() =>
      scryptFn(password, salt, parsed.keylen, {
        N: parsed.N,
        r: parsed.r,
        p: parsed.p,
        maxmem: DEFAULT_SCRYPT_PARAMS.maxmem,
      })
    );
    const derivedBuf = Buffer.from(derived);
    if (derivedBuf.length !== expected.length) {
      return false;
    }
    return crypto.timingSafeEqual(derivedBuf, expected);
  }

  async function verifyDummyPassword(password) {
    await verifyPassword(typeof password === 'string' && password.length > 0 ? password : 'dummy', DUMMY_PASSWORD_HASH);
    return false;
  }

  function getStats() {
    return {
      active,
      waiting: waiting.length,
      maxConcurrency,
      maxQueue,
      totalExecuted,
      totalRejectedFull,
    };
  }

  return {
    enqueue,
    hashPassword,
    verifyPassword,
    verifyDummyPassword,
    getStats,
  };
}

// ---------------------------------------------------------------------
// 3. セッショントークン・Cookie・HTTPS・Origin 検証ヘルパー
// ---------------------------------------------------------------------
function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url'); // 43文字
}

function isValidSessionTokenFormat(rawToken) {
  return typeof rawToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(rawToken);
}

function hashSessionToken(rawToken) {
  if (!isValidSessionTokenFormat(rawToken)) {
    throw new Error('セッショントークンの形式が不正です。');
  }
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

function getSessionCookieName({ devInsecureCookie = false } = {}) {
  return devInsecureCookie ? DEV_SESSION_COOKIE_NAME : HTTPS_SESSION_COOKIE_NAME;
}

// trustProxy=true かつローカルループバック接続元のときのみ X-Forwarded-Proto を信頼する
function isSecureRequest(req, { trustProxy = false } = {}) {
  if (req?.socket?.encrypted === true) {
    return true;
  }
  if (!trustProxy) {
    return false;
  }
  const socketIp = normalizeIp(req?.socket?.remoteAddress || '');
  if (socketIp !== '127.0.0.1') {
    return false;
  }
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return forwardedProto === 'https';
}

// 対象Cookieを厳格に解析し、複数重複・トークン形式不正を invalid として返す
function parseSessionCookie(req, { devInsecureCookie = false } = {}) {
  const targetName = getSessionCookieName({ devInsecureCookie });
  const rawHeader = req?.headers?.cookie;
  const headerStr = Array.isArray(rawHeader)
    ? rawHeader.join('; ')
    : typeof rawHeader === 'string'
      ? rawHeader
      : '';

  if (headerStr.trim() === '') {
    return { present: false, token: null, invalid: false };
  }

  const matchedValues = [];
  const segments = headerStr.split(';');
  for (const segment of segments) {
    const trimmedSeg = segment.trim();
    if (!trimmedSeg) continue;
    const eqIndex = trimmedSeg.indexOf('=');
    if (eqIndex === -1) {
      if (trimmedSeg === targetName) {
        return { present: true, token: null, invalid: true };
      }
      continue;
    }
    const name = trimmedSeg.slice(0, eqIndex).trim();
    const value = trimmedSeg.slice(eqIndex + 1).trim();
    if (name === targetName) {
      matchedValues.push(value);
    }
  }

  if (matchedValues.length === 0) {
    return { present: false, token: null, invalid: false };
  }
  if (matchedValues.length > 1) {
    // 同名Cookieの重複送信は曖昧さを避けるため拒否
    return { present: true, token: null, invalid: true };
  }
  const token = matchedValues[0];
  if (!isValidSessionTokenFormat(token)) {
    return { present: true, token: null, invalid: true };
  }
  return { present: true, token, invalid: false };
}

function hasAnyCookieHeader(req) {
  const raw = req?.headers?.cookie;
  if (Array.isArray(raw)) {
    return raw.some((entry) => typeof entry === 'string' && entry.trim() !== '');
  }
  return typeof raw === 'string' && raw.trim() !== '';
}

function buildSetSessionCookieHeader(
  rawToken,
  { devInsecureCookie = false, maxAgeSeconds = SESSION_TTL_SECONDS } = {}
) {
  if (!isValidSessionTokenFormat(rawToken)) {
    throw new Error('Set-Cookie に不正なトークンは設定できません。');
  }
  const cookieName = getSessionCookieName({ devInsecureCookie });
  const parts = [
    `${cookieName}=${rawToken}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (!devInsecureCookie) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function buildClearSessionCookieHeader({ devInsecureCookie = false } = {}) {
  const cookieName = getSessionCookieName({ devInsecureCookie });
  const parts = [
    `${cookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (!devInsecureCookie) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function normalizeAllowedOrigin(rawOrigin) {
  if (rawOrigin === null || rawOrigin === undefined || String(rawOrigin).trim() === '') {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(String(rawOrigin).trim());
  } catch {
    throw new Error(`ALLOWED_ORIGIN のURL形式が不正です: ${rawOrigin}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`ALLOWED_ORIGIN は http または https を指定してください: ${rawOrigin}`);
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '' || parsed.username || parsed.password) {
    throw new Error(`ALLOWED_ORIGIN にはパスやクエリを含めずオリジン（例: https://koo-hi.com）のみ指定してください: ${rawOrigin}`);
  }
  return parsed.origin;
}

module.exports = {
  HTTPS_SESSION_COOKIE_NAME,
  DEV_SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  MAX_SESSIONS_PER_USER,
  AUTH_MAX_BODY_BYTES,
  DEFAULT_SCRYPT_PARAMS,
  SCRYPT_LIMITS,
  DEFAULT_SCRYPT_MAX_CONCURRENCY,
  DEFAULT_SCRYPT_MAX_QUEUE,
  DUMMY_PASSWORD_HASH,
  AuthQueueFullError,
  parseStoredPasswordHash,
  createScryptQueue,
  generateSessionToken,
  isValidSessionTokenFormat,
  hashSessionToken,
  getSessionCookieName,
  isSecureRequest,
  parseSessionCookie,
  hasAnyCookieHeader,
  buildSetSessionCookieHeader,
  buildClearSessionCookieHeader,
  normalizeAllowedOrigin,
};
