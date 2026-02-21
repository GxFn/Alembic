#!/usr/bin/env node

/**
 * npm install 时可选构建 ParsePackage（Swift 解析器，依赖 swift-syntax）
 * 仅当 ASD_BUILD_SWIFT_PARSER=1 时构建；否则打印说明并跳过。成功则运行时优先使用 ParsePackage；未构建时回退 dump-package / AST-lite。
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const parsePackageDir = path.join(rootDir, 'tools', 'parse-package');
const manifestPath = path.join(parsePackageDir, 'Package.swift');
const binaryPath = path.join(parsePackageDir, '.build', 'release', 'ParsePackage');

function runSwiftBuild() {
  const result = spawnSync('swift', ['build', '-c', 'release'], {
    cwd: parsePackageDir,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status === 0 && fs.existsSync(binaryPath)) {
  }
  process.exit(0);
}

if (!fs.existsSync(manifestPath)) {
  process.exit(0);
}
if (fs.existsSync(binaryPath)) {
  process.exit(0);
}

// 仅当显式设置环境变量时构建，并说明在安装什么
if (process.env.ASD_BUILD_SWIFT_PARSER === '1' || process.env.ASD_BUILD_SWIFT_PARSER === 'true') {
  runSwiftBuild();
  process.exit(0);
}
process.exit(0);
