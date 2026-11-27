'use strict';

/**
 * =====================================================================
 * src/validators.js
 * 役割：【検問所】入力値の検証（ガード節）と日替わりID（visitor_id）生成
 * 方針：
 *   - DBやHTTPオブジェクトに直接依存しない純粋関数で構成し、単体テストを容易にする。
 *   - JavaScript特有の型強制（Number(null) === 0 等）を変換前のガード節で遮断する。
 *   - 全角スペース（U+3000）や改行・ゼロ幅空白のみの「見かけ上の空投稿」を拒否する。
 * =====================================================================
 */

const crypto = require('node:crypto');

// ---------------------------------------------------------------------
// 1. 入力検証エラー専用クラス
// APサーバー（src/app.js）側で 400 / 404 などのHTTPステータスと、
// 予期せぬサーバー内部障害（500）を明確に区別するために使用する。
// ---------------------------------------------------------------------
class ValidationError extends Error {
  constructor(message, statusCode = 400, code = null, details = null) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------
// 2. 文字検査用の正規表現定義
// - DISALLOWED_CONTROL_RE: 改行(\n)・タブ(\t)以外の制御文字（NULL文字等を遮断）
// - INVISIBLE_ONLY_STRIP_RE: 空白判定時に取り除く全角空白・ゼロ幅空白類
// ---------------------------------------------------------------------
const DISALLOWED_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const AUTHOR_DISALLOWED_RE = /[\x00-\x1F\x7F]/;
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/;
const INVISIBLE_STRIP_RE = /[\s\u3000\u200B-\u200D\u2060\uFEFF]+/g;
const EDGE_WHITESPACE_RE = /^[\s\u3000\u200B-\u200D\u2060\uFEFF]+|[\s\u3000\u200B-\u200D\u2060\uFEFF]+$/g;

function countCodePoints(str) {
  return Array.from(str).length;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------
// 3. 正の整数（1以上）の厳格パース関数
// Number(null) === 0 や Number("") === 0、Number(true) === 1 の罠を防ぐため、
// 型変換の前に必ず「安全な整数」または「数字のみの文字列」かを検証する。
// ---------------------------------------------------------------------
function parsePositiveInt(value, fieldLabel = 'ID') {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 1) {
      return value;
    }
    throw new ValidationError(`${fieldLabel}は1以上の整数で指定してください。`, 400);
  }

  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 1) {
      return parsed;
    }
  }

  throw new ValidationError(`${fieldLabel}は1以上の整数で指定してください。`, 400);
}

// ---------------------------------------------------------------------
// 4. 投稿・返信リクエストボディの検証関数
// - thread_id : 必須・1以上の整数
// - parent_id : 任意・null/undefined なら親投稿、指定時は1以上の整数
// - author_name: 任意・空欄時は「名無しさん」を補完、最大30文字
// - content   : 必須・空白/改行のみ不可、最大2000文字
// ---------------------------------------------------------------------
function validatePostInput(body, { ignoreAuthorName = false } = {}) {
  // ペイロード自体がオブジェクトかどうかのガード節（nullや配列を拒否）
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('リクエスト形式が不正です（JSONオブジェクトが必要です）。', 400);
  }

  // スレッドIDの検証
  const threadId = parsePositiveInt(body.thread_id, 'スレッドID');

  // 返信先IDの検証（null または undefined の場合のみ「親投稿」として扱う）
  let parentId = null;
  if (body.parent_id !== null && body.parent_id !== undefined) {
    parentId = parsePositiveInt(body.parent_id, '返信先ID');
  }

  // 投稿者名の検証と既定値補完（会員投稿時はクライアント値を無視してサーバー側アカウント名を用いる）
  let authorName = '名無しさん';
  if (!ignoreAuthorName && body.author_name !== undefined && body.author_name !== null) {
    if (typeof body.author_name !== 'string') {
      throw new ValidationError('投稿者名は文字列で指定してください。', 400);
    }
    if (AUTHOR_DISALLOWED_RE.test(body.author_name)) {
      throw new ValidationError('投稿者名に使用できない制御文字または改行が含まれています。', 400);
    }
    const trimmedName = body.author_name.replace(EDGE_WHITESPACE_RE, '');
    const authorLen = countCodePoints(trimmedName);
    if (authorLen > 30) {
      throw new ValidationError('投稿者名は30文字以内で入力してください。', 400);
    }
    if (authorLen >= 1) {
      authorName = trimmedName;
    }
  }

  // 本文の検証
  if (typeof body.content !== 'string') {
    throw new ValidationError('本文を入力してください。', 400);
  }

  // OS間の改行コード差（\r\n, \r）を \n に統一してから検査する
  const normalizedContent = body.content.replace(/\r\n?/g, '\n');

  if (DISALLOWED_CONTROL_RE.test(normalizedContent)) {
    throw new ValidationError('本文に使用できない制御文字が含まれています。', 400);
  }

  // 半角空白・全角空白(U+3000)・タブ・改行・ゼロ幅空白をすべて除いた可視文字が残るか確認
  const visibleChars = normalizedContent.replace(INVISIBLE_STRIP_RE, '');
  if (visibleChars.length === 0) {
    throw new ValidationError('空白や改行のみの本文は投稿できません。', 400);
  }

  // 末尾の不要な空白・改行だけを整え、上限2000文字を検査する
  const cleanedContent = normalizedContent.replace(/[ \t\u3000\n]+$/, '');
  if (cleanedContent.length > 2000) {
    throw new ValidationError('本文は2000文字以内で入力してください。', 400);
  }

  return {
    threadId,
    parentId,
    authorName,
    content: cleanedContent,
  };
}

// ---------------------------------------------------------------------
// 5. 起動時の秘密鍵（ID_SECRET）検証関数
// 未設定や .env.example の見本文字列のまま起動してしまう運用ミスを阻止する。
// ---------------------------------------------------------------------
function validateIdSecret(secret) {
  if (typeof secret !== 'string') {
    throw new Error('環境変数 ID_SECRET が設定されていません。.env を確認してください。');
  }
  const trimmed = secret.trim();
  if (trimmed.length < 16 || trimmed.startsWith('CHANGE_ME')) {
    throw new Error(
      '環境変数 ID_SECRET が短すぎる（16文字未満）か、見本値（CHANGE_ME...）のままです。安全なランダム文字列を設定してください。'
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------
// 6. 日本時間（JST: UTC+9）の日付文字列（YYYY-MM-DD）を算出する純粋関数
// 実行OSのタイムゾーン設定に依存しないよう、UTCミリ秒に9時間を加算して算出する。
// ---------------------------------------------------------------------
function getJstDateString(now = new Date()) {
  const dateObj = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(dateObj.getTime())) {
    throw new Error('日替わりID計算用の日時が不正です。');
  }
  const jstTimeMs = dateObj.getTime() + 9 * 60 * 60 * 1000;
  const jstDate = new Date(jstTimeMs);
  const yyyy = jstDate.getUTCFullYear();
  const mm = String(jstDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jstDate.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------
// 7. IPアドレス表記の正規化関数
// デュアルスタック環境で IPv4 が "::ffff:127.0.0.1" になる表記揺れを吸収する。
// ---------------------------------------------------------------------
function normalizeIp(rawIp) {
  if (typeof rawIp !== 'string' || rawIp.trim() === '') {
    return 'unknown';
  }
  const trimmed = rawIp.trim();
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice('::ffff:'.length);
  }
  if (trimmed === '::1') {
    return '127.0.0.1';
  }
  return trimmed;
}

// ---------------------------------------------------------------------
// 8. 日替わりID（visitor_id）生成関数（鍵付き HMAC-SHA256）
// テスト時に任意の ip・secret・now を注入して 23:59 -> 00:00 の切替を検証できる。
// ※ 本IDは画面上の目安表示用であり、本人認証や削除権限の根拠には使用しない。
// ---------------------------------------------------------------------
function generateVisitorId({ ip, secret, now = new Date() }) {
  const validSecret = validateIdSecret(secret);
  const jstDate = getJstDateString(now);
  const normalizedIp = normalizeIp(ip);

  return crypto
    .createHmac('sha256', validSecret)
    .update(`${jstDate}|${normalizedIp}`)
    .digest('base64url')
    .slice(0, 10);
}

// ---------------------------------------------------------------------
// 9. HTTPリクエストからの接続元IP取得関数
// 偽装可能な X-Forwarded-For 等を無条件に信用せず、
// trustProxy=true かつローカルループバック(Nginx等)からの接続時のみ転送ヘッダーを参照する。
// ---------------------------------------------------------------------
function extractClientIp(req, { trustProxy = false } = {}) {
  const socketIp = normalizeIp(req?.socket?.remoteAddress || '');
  const isLoopback = socketIp === '127.0.0.1';

  if (trustProxy && isLoopback) {
    const realIp = req.headers?.['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim() !== '') {
      return normalizeIp(realIp.split(',')[0]);
    }
    const forwardedFor = req.headers?.['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor.trim() !== '') {
      return normalizeIp(forwardedFor.split(',')[0]);
    }
  }

  return socketIp;
}

// ---------------------------------------------------------------------
// 10. 認証入力の検証（ユーザー名・パスワード・ロール）
// - SQLite の length() と一致するよう Unicode コードポイント数で検査する。
// - パスワードは黙った前後トリムや切り詰め、Unicode正規化を行わない。
// ---------------------------------------------------------------------
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 30;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

function validateUsername(rawUsername) {
  if (typeof rawUsername !== 'string') {
    throw new ValidationError('ユーザー名は文字列で入力してください。', 400);
  }
  if (AUTHOR_DISALLOWED_RE.test(rawUsername) || ZERO_WIDTH_RE.test(rawUsername)) {
    throw new ValidationError('ユーザー名に使用できない制御文字・改行・不可視文字が含まれています。', 400);
  }
  const trimmed = rawUsername.replace(EDGE_WHITESPACE_RE, '');
  const len = countCodePoints(trimmed);
  if (len < MIN_USERNAME_LENGTH || len > MAX_USERNAME_LENGTH) {
    throw new ValidationError(
      `ユーザー名は${MIN_USERNAME_LENGTH}〜${MAX_USERNAME_LENGTH}文字で入力してください。`,
      400
    );
  }
  return trimmed;
}

function validatePassword(rawPassword, { minLength = MIN_PASSWORD_LENGTH, maxLength = MAX_PASSWORD_LENGTH, label = 'パスワード' } = {}) {
  if (typeof rawPassword !== 'string') {
    throw new ValidationError(`${label}は文字列で入力してください。`, 400);
  }
  if (AUTHOR_DISALLOWED_RE.test(rawPassword)) {
    throw new ValidationError(`${label}に使用できない制御文字または改行が含まれています。`, 400);
  }
  // 空白文字や不可視文字のみのパスワードは拒否（ただし先頭・末尾の空白自体は黙って削除しない）
  if (rawPassword.replace(INVISIBLE_STRIP_RE, '').length === 0) {
    throw new ValidationError(`${label}に空白のみの値は指定できません。`, 400);
  }
  const len = countCodePoints(rawPassword);
  if (len < minLength || len > maxLength) {
    throw new ValidationError(
      `${label}は${minLength}〜${maxLength}文字で入力してください。`,
      400
    );
  }
  return rawPassword;
}

function validateUserRole(rawRole) {
  if (rawRole !== 'user' && rawRole !== 'admin') {
    throw new ValidationError("権限ロールは 'user' または 'admin' を指定してください。", 400);
  }
  return rawRole;
}

function validateAuthRegisterInput(body) {
  if (!isPlainObject(body)) {
    throw new ValidationError('リクエスト形式が不正です（JSONオブジェクトが必要です）。', 400);
  }
  // role や created_by 等の余分なクライアント入力は無視し、常に 'user' 固定で扱う
  return {
    username: validateUsername(body.username),
    password: validatePassword(body.password, {
      minLength: MIN_PASSWORD_LENGTH,
      maxLength: MAX_PASSWORD_LENGTH,
      label: 'パスワード',
    }),
  };
}

function validateAuthLoginInput(body) {
  if (!isPlainObject(body)) {
    throw new ValidationError('リクエスト形式が不正です（JSONオブジェクトが必要です）。', 400);
  }
  return {
    username: validateUsername(body.username),
    // 将来の最低文字数引き上げ時にも既存利用者がログインできるよう minLength=1 で受け付ける
    password: validatePassword(body.password, {
      minLength: 1,
      maxLength: MAX_PASSWORD_LENGTH,
      label: 'パスワード',
    }),
  };
}

function validateChangePasswordInput(body) {
  if (!isPlainObject(body)) {
    throw new ValidationError('リクエスト形式が不正です（JSONオブジェクトが必要です）。', 400);
  }
  return {
    currentPassword: validatePassword(body.currentPassword, {
      minLength: 1,
      maxLength: MAX_PASSWORD_LENGTH,
      label: '現在のパスワード',
    }),
    newPassword: validatePassword(body.newPassword, {
      minLength: MIN_PASSWORD_LENGTH,
      maxLength: MAX_PASSWORD_LENGTH,
      label: '新しいパスワード',
    }),
  };
}

// ---------------------------------------------------------------------
// 11. 管理MVP用のカテゴリ・スレッド・ページング入力検証
// ---------------------------------------------------------------------
function validateCategoryName(rawName) {
  if (typeof rawName !== 'string' || AUTHOR_DISALLOWED_RE.test(rawName) || ZERO_WIDTH_RE.test(rawName)) {
    throw new ValidationError('カテゴリ名に使用できない制御文字・改行・不可視文字が含まれているか、形式が不正です。', 400);
  }
  const trimmed = rawName.replace(EDGE_WHITESPACE_RE, '');
  const len = countCodePoints(trimmed);
  if (len < 1 || len > 30) {
    throw new ValidationError('カテゴリ名は1〜30文字で指定してください。', 400);
  }
  return trimmed;
}

function validateThreadTitle(rawTitle) {
  if (typeof rawTitle !== 'string' || AUTHOR_DISALLOWED_RE.test(rawTitle) || ZERO_WIDTH_RE.test(rawTitle)) {
    throw new ValidationError('スレッドタイトルに使用できない制御文字・改行・不可視文字が含まれているか、形式が不正です。', 400);
  }
  const trimmed = rawTitle.replace(EDGE_WHITESPACE_RE, '');
  const len = countCodePoints(trimmed);
  if (len < 1 || len > 100) {
    throw new ValidationError('スレッドタイトルは1〜100文字で指定してください。', 400);
  }
  return trimmed;
}

function validateThreadPinnedText(rawText) {
  if (rawText === null || rawText === undefined) {
    return null;
  }
  if (typeof rawText !== 'string') {
    throw new ValidationError('スレッド案内文（pinned_text）は文字列で指定してください。', 400);
  }
  const normalized = rawText.replace(/\r\n?/g, '\n');
  if (DISALLOWED_CONTROL_RE.test(normalized) || ZERO_WIDTH_RE.test(normalized)) {
    throw new ValidationError('スレッド案内文に使用できない制御文字または不可視文字が含まれています。', 400);
  }
  const visibleChars = normalized.replace(INVISIBLE_STRIP_RE, '');
  if (visibleChars.length === 0) {
    return null;
  }
  const cleaned = normalized.replace(EDGE_WHITESPACE_RE, '');
  if (countCodePoints(cleaned) > 500) {
    throw new ValidationError('スレッド案内文（pinned_text）は500文字以内で指定してください。', 400);
  }
  return cleaned;
}

function validateNonNegativeInt(value, fieldLabel = '表示順') {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
    throw new ValidationError(`${fieldLabel}（display_order）は0以上の整数で指定してください。`, 400);
  }
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  throw new ValidationError(`${fieldLabel}（display_order）は0以上の整数で指定してください。`, 400);
}

function parsePaginationLimit(rawValue, { defaultLimit = 50, maxLimit = 100 } = {}) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return defaultLimit;
  }
  const parsed = parsePositiveInt(rawValue, '取得件数(limit)');
  if (parsed > maxLimit) {
    throw new ValidationError(`取得件数(limit)は1〜${maxLimit}の範囲で指定してください。`, 400);
  }
  return parsed;
}

function parsePaginationOffset(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return 0;
  }
  if (typeof rawValue === 'number') {
    if (Number.isSafeInteger(rawValue) && rawValue >= 0) {
      return rawValue;
    }
    throw new ValidationError('開始位置(offset)は0以上の整数で指定してください。', 400);
  }
  if (typeof rawValue === 'string' && /^(?:0|[1-9]\d*)$/.test(rawValue.trim())) {
    const parsed = Number(rawValue.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  throw new ValidationError('開始位置(offset)は0以上の整数で指定してください。', 400);
}

// ---------------------------------------------------------------------
// 12. Step 2（v1.2）ロール別権限設定の検証（未知キー・admin変更拒否）
// ---------------------------------------------------------------------
const EDITABLE_PERMISSION_ROLES = Object.freeze(['user', 'guest']);
const PERMISSION_KEYS = Object.freeze(['create_post', 'create_thread', 'pin_post', 'upload_image']);
const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
  admin: Object.freeze({
    create_post: true,
    create_thread: true,
    pin_post: true,
    upload_image: true,
  }),
  user: Object.freeze({
    create_post: true,
    create_thread: false,
    pin_post: false,
    upload_image: true,
  }),
  guest: Object.freeze({
    create_post: true,
    create_thread: false,
    pin_post: false,
    upload_image: false,
  }),
});

function validatePermissionRole(rawRole) {
  if (rawRole !== 'user' && rawRole !== 'guest') {
    throw new ValidationError(
      "権限編集の対象ロールは 'user' または 'guest' のみ指定できます（admin は常時全権限固定です）。",
      400
    );
  }
  return rawRole;
}

function validateRolePermissionsPayload(body) {
  if (!isPlainObject(body)) {
    throw new ValidationError('リクエスト形式が不正です（JSONオブジェクトが必要です）。', 400);
  }
  let source = body;
  if ('permissions' in body) {
    const extraKeys = Object.keys(body).filter((k) => k !== 'permissions');
    if (extraKeys.length > 0) {
      throw new ValidationError(
        `permissions 以外に不正なキー（${extraKeys[0]}）が含まれています。`,
        400,
        'UNKNOWN_PERMISSION_KEY'
      );
    }
    if (!isPlainObject(body.permissions)) {
      throw new ValidationError('permissions にはオブジェクトを指定してください。', 400);
    }
    source = body.permissions;
  }

  const entries = Object.entries(source);
  if (entries.length === 0) {
    throw new ValidationError('更新する権限キー（create_post 等）を1つ以上指定してください。', 400);
  }

  const clean = {};
  for (const [key, val] of entries) {
    if (!PERMISSION_KEYS.includes(key)) {
      throw new ValidationError(
        `未定義の権限キー（${key}）は指定できません。`,
        400,
        'UNKNOWN_PERMISSION_KEY'
      );
    }
    if (typeof val !== 'boolean') {
      throw new ValidationError(`権限値（${key}）は true または false で指定してください。`, 400);
    }
    clean[key] = val;
  }
  return clean;
}

module.exports = {
  ValidationError,
  MIN_USERNAME_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  EDITABLE_PERMISSION_ROLES,
  PERMISSION_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
  countCodePoints,
  parsePositiveInt,
  validatePostInput,
  validateIdSecret,
  getJstDateString,
  normalizeIp,
  generateVisitorId,
  extractClientIp,
  validateUsername,
  validatePassword,
  validateUserRole,
  validatePermissionRole,
  validateRolePermissionsPayload,
  validateAuthRegisterInput,
  validateAuthLoginInput,
  validateChangePasswordInput,
  validateCategoryName,
  validateThreadTitle,
  validateThreadPinnedText,
  validateNonNegativeInt,
  parsePaginationLimit,
  parsePaginationOffset,
};
