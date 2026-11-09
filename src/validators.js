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
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------
// 2. 文字検査用の正規表現定義
// - DISALLOWED_CONTROL_RE: 改行(\n)・タブ(\t)以外の制御文字（NULL文字等を遮断）
// - INVISIBLE_ONLY_STRIP_RE: 空白判定時に取り除く全角空白・ゼロ幅空白類
// ---------------------------------------------------------------------
const DISALLOWED_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const AUTHOR_DISALLOWED_RE = /[\x00-\x1F\x7F]/;
const INVISIBLE_STRIP_RE = /[\s\u3000\u200B-\u200D\u2060\uFEFF]+/g;
const EDGE_WHITESPACE_RE = /^[\s\u3000\u200B-\u200D\u2060\uFEFF]+|[\s\u3000\u200B-\u200D\u2060\uFEFF]+$/g;

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
function validatePostInput(body) {
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

  // 投稿者名の検証と既定値補完
  let authorName = '名無しさん';
  if (body.author_name !== undefined && body.author_name !== null) {
    if (typeof body.author_name !== 'string') {
      throw new ValidationError('投稿者名は文字列で指定してください。', 400);
    }
    if (AUTHOR_DISALLOWED_RE.test(body.author_name)) {
      throw new ValidationError('投稿者名に使用できない制御文字または改行が含まれています。', 400);
    }
    const trimmedName = body.author_name.replace(EDGE_WHITESPACE_RE, '');
    if (trimmedName.length > 30) {
      throw new ValidationError('投稿者名は30文字以内で入力してください。', 400);
    }
    if (trimmedName.length >= 1) {
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

module.exports = {
  ValidationError,
  parsePositiveInt,
  validatePostInput,
  validateIdSecret,
  getJstDateString,
  normalizeIp,
  generateVisitorId,
  extractClientIp,
};
