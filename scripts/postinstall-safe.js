#!/usr/bin/env node

/**
 * 安全的 postinstall 脚本
 *
 * 在 macOS 上如果 native-ui 二进制缺失但 Swift 源码存在，
 * 尝试自动编译（需要 Xcode Command Line Tools）。
 * 编译失败不阻塞安装流程。
 */

import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

const NATIVE_UI_BIN = path.join(root, 'resources', 'native-ui', 'native-ui');
const NATIVE_UI_SRC = path.join(root, 'resources', 'native-ui', 'main.swift');
const NATIVE_UI_COMBINED = path.join(root, 'resources', 'native-ui', 'combined-window.swift');

/**
 * 在 macOS 上尝试编译 native-ui（如果二进制缺失）
 */
function tryBuildNativeUi() {
  // 非 macOS 跳过
  if (process.platform !== 'darwin') return;

  // 已有二进制，跳过
  if (fs.existsSync(NATIVE_UI_BIN)) return;

  // 检查源码是否存在
  if (!fs.existsSync(NATIVE_UI_SRC) || !fs.existsSync(NATIVE_UI_COMBINED)) {
    return;
  }

  // 检查 swiftc 是否可用
  try {
    execSync('which swiftc', { stdio: 'pipe' });
  } catch {
    console.log(
      '💡 Native UI 需要 Swift 编译器。运行 xcode-select --install 后执行：\n' +
      `   swiftc "${NATIVE_UI_SRC}" "${NATIVE_UI_COMBINED}" -o "${NATIVE_UI_BIN}" -framework AppKit`
    );
    return;
  }

  // 尝试编译
  try {
    execSync(
      `swiftc "${NATIVE_UI_SRC}" "${NATIVE_UI_COMBINED}" -o "${NATIVE_UI_BIN}" -framework AppKit`,
      { cwd: root, stdio: 'pipe', timeout: 120_000 }
    );
    if (fs.existsSync(NATIVE_UI_BIN)) {
      console.log('✅ Native UI 已自动编译');
    }
  } catch {
    console.log(
      '⚠️  Native UI 自动编译失败，Xcode file watcher 将使用 AppleScript 降级方案。\n' +
      '   手动编译: npm run build:native-ui（需要 Xcode Command Line Tools）'
    );
  }
}

// 检查预构建的二进制文件
function checkBinaries() {
  const checks = [
    {
      name: 'Native UI',
      path: NATIVE_UI_BIN,
      optional: true,
      platform: 'darwin',
    },
  ];

  checks.forEach(({ name, path: binPath, optional, platform }) => {
    // 跳过非目标平台
    if (platform && process.platform !== platform) {
      return;
    }

    if (fs.existsSync(binPath)) {
      const stat = fs.statSync(binPath);
      const _sizeKB = (stat.size / 1024).toFixed(1);
    } else if (optional) {
    } else {
      console.warn(`⚠️  ${name}: 未找到`);
    }
  });
}

tryBuildNativeUi();
checkBinaries();
