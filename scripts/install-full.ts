#!/usr/bin/env node

/**
 * 全量安装 / 按需安装：统一入口
 * asd install:full           - 核心 + 可选依赖 + Dashboard
 * asd install:full --parser  - 上述 + Swift 解析器
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const withParser =
  process.env.ASD_INSTALL_PARSER === '1' || process.env.ASD_INSTALL_PARSER === 'true';
const withNativeUi =
  process.env.ASD_INSTALL_NATIVE_UI === '1' || process.env.ASD_INSTALL_NATIVE_UI === 'true';
const dashboardDist = path.join(rootDir, 'dashboard', 'dist');
execSync('npm install', { cwd: rootDir, stdio: 'inherit' });

// 2. Dashboard（仅当前端不存在时安装并构建）
if (!fs.existsSync(dashboardDist)) {
  const dashboardDir = path.join(rootDir, 'dashboard');
  execSync('npm install', { cwd: dashboardDir, stdio: 'inherit' });
  execSync('npm run build:dashboard', { cwd: rootDir, stdio: 'inherit' });
} else {
}

// 3. ParsePackage / Native UI（可选）
if (withParser) {
  execSync('npm run build:parser', { cwd: rootDir, stdio: 'inherit' });
} else {
}
if (withNativeUi || process.platform === 'darwin') {
  try {
    await import('./build-native-ui.js');
  } catch (_: any) {}
} else {
}
