'use strict';

/**
 * =====================================================================
 * src/sandbox.js
 * 役割：【ローカル専用デザイン実験ランチャー】
 * 使い方：
 *   npm run sandbox -- <案フォルダ名> [ポート番号(既定:3002)]
 *   例: npm run sandbox -- aether-v1
 * 方針：
 *   - 本番用 public/ を一切触らず、ui-sandbox/<案フォルダ名>/ を配信して実API・実DBと接続する。
 *   - 既定ポートを 3002 番にすることで、ポート 3001 の現行版と同時に並べて比較できる。
 * =====================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT } = require('./db');
const { startServer } = require('../server');

const SANDBOX_ROOT = path.join(PROJECT_ROOT, 'ui-sandbox');

function listAvailableVariants() {
  if (!fs.existsSync(SANDBOX_ROOT)) {
    return [];
  }
  return fs
    .readdirSync(SANDBOX_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

function main() {
  const [, , rawVariantName, rawPort] = process.argv;
  const variants = listAvailableVariants();

  const variantName = rawVariantName || variants[0];
  if (!variantName) {
    console.error('[SANDBOX] ui-sandbox/ 内にデザイン案フォルダがまだありません。');
    console.error('例: ui-sandbox/aether-v1/ に index.html 等を配置してから実行してください。');
    process.exit(1);
  }

  // F6対策：ドット始まりや「..」を含む名前を拒否し、実在する案フォルダ一覧（許可リスト）およびrealpath境界で厳密に検証
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(variantName) || !variants.includes(variantName)) {
    console.error(`[SANDBOX] 不正または存在しないデザイン案フォルダ名です: ${variantName}`);
    if (variants.length > 0) {
      console.error(`[SANDBOX] 利用可能なデザイン案: ${variants.join(', ')}`);
    }
    process.exit(1);
  }

  const targetDir = path.join(SANDBOX_ROOT, variantName);
  const realSandboxRoot = fs.realpathSync(SANDBOX_ROOT);
  const realTargetDir = fs.realpathSync(targetDir);
  const rootPrefix = realSandboxRoot.endsWith(path.sep)
    ? realSandboxRoot
    : realSandboxRoot + path.sep;

  if (!realTargetDir.startsWith(rootPrefix) || !fs.statSync(realTargetDir).isDirectory()) {
    console.error(`[SANDBOX] ui-sandbox 配下以外のディレクトリは指定できません: ${targetDir}`);
    process.exit(1);
  }

  process.env.PUBLIC_DIR = targetDir;
  process.env.PORT = rawPort || process.env.SANDBOX_PORT || '3002';

  console.log(`[SANDBOX] デザイン実験モードで起動します (案: ${variantName})`);
  startServer();
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[SANDBOX FATAL]', err.message);
    process.exit(1);
  }
}
