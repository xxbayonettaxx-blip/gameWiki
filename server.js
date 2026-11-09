'use strict';

/**
 * =====================================================================
 * server.js
 * 役割：【起動入口】環境変数の検査・実DB接続・HTTPサーバー待受(listen)・終了処理
 * 方針：
 *   - テストコードからはこのファイルを読み込まず src/app.js を使用する。
 *   - ローカルおよびリバースプロキシ配下では既定で 127.0.0.1（ループバック）のみ待ち受ける。
 *   - 起動ログに実際のDBパス・PRAGMA値（foreign_keys / journal_mode）・待受先を出力し観測性を確保する。
 * =====================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT, createBoardDb, resolveProjectDbPath } = require('./src/db');
const { DEFAULT_PUBLIC_DIR, createApp } = require('./src/app');
const { validateIdSecret } = require('./src/validators');

function resolvePublicDir(rawPublicDir) {
  if (!rawPublicDir || rawPublicDir.trim() === '') {
    return DEFAULT_PUBLIC_DIR;
  }
  const resolved = path.isAbsolute(rawPublicDir)
    ? path.normalize(rawPublicDir)
    : path.resolve(PROJECT_ROOT, rawPublicDir.trim());

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`指定された公開フォルダ PUBLIC_DIR が存在しません: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`指定された PUBLIC_DIR はディレクトリではありません: ${resolved}`);
  }
  return resolved;
}

function startServer() {
  // 1. 環境変数の検証（秘密鍵不足時は勝手に自動生成せず、明確なエラーを出して即停止する）
  const idSecret = validateIdSecret(process.env.ID_SECRET);
  const host = (process.env.HOST || '127.0.0.1').trim();
  const rawPort = process.env.PORT || '3001';
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`環境変数 PORT の値が不正です: ${rawPort}`);
  }

  const trustProxy = String(process.env.TRUST_PROXY || 'false').toLowerCase() === 'true';
  const dbPath = resolveProjectDbPath(process.env.DB_PATH || './data/board.db');
  const publicDir = resolvePublicDir(process.env.PUBLIC_DIR);

  // 2. 実データベースの初期化と PRAGMA 状態の検証
  const db = createBoardDb({ dbPath });
  const dbStatus = db.getStatus();

  // 3. アプリケーションの組立て
  const server = createApp({
    db,
    idSecret,
    adminToken: process.env.ADMIN_TOKEN || null,
    trustProxy,
    publicDir,
  });

  // 4. ポート待受の開始と観測ログ出力
  server.listen(port, host, () => {
    const addr = server.address();
    console.log('==========================================================');
    console.log('[STARTUP] basic_board v0.5 が起動しました');
    console.log(`[STARTUP] 待受アドレス : http://${addr.address}:${addr.port}`);
    console.log(`[STARTUP] 公開フォルダ : ${publicDir}`);
    console.log(`[STARTUP] DBファイル   : ${dbStatus.dbPath}`);
    console.log(
      `[STARTUP] SQLite設定   : foreign_keys=${dbStatus.foreignKeys}, journal_mode=${dbStatus.journalMode}`
    );
    console.log(`[STARTUP] プロキシ信頼 : trustProxy=${trustProxy}`);
    console.log('==========================================================');
  });

  // 5. 安全な終了処理（Ctrl+C や systemd 停止時にWALを綺麗に閉じてDB破損を防ぐ）
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[SHUTDOWN] ${signal} を受信しました。サーバーを安全に停止します...`);
    server.close(() => {
      try {
        db.close();
        console.log('[SHUTDOWN] SQLite接続を閉じました。終了します。');
      } finally {
        process.exit(0);
      }
    });
    // 万が一通信が残り続けた場合の強制終了タイマー
    setTimeout(() => {
      try {
        db.close();
      } catch {
        // ignore
      }
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, db };
}

if (require.main === module) {
  try {
    startServer();
  } catch (err) {
    console.error('[FATAL] 起動に失敗しました:', err.message);
    process.exit(1);
  }
}

module.exports = { startServer };
