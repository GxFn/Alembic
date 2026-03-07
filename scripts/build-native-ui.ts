#!/usr/bin/env node

/**
 * 在 macOS 上构建 native-ui 辅助程序（可选）
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from '../lib/shared/package-root.js';

if (process.platform !== 'darwin') {
  process.exit(0);
}

const root = PACKAGE_ROOT;
const src = path.join(root, 'resources', 'native-ui', 'main.swift');
const combinedSrc = path.join(root, 'resources', 'native-ui', 'combined-window.swift');
const out = path.join(root, 'resources', 'native-ui', 'native-ui');

// 检查是否在发布流程中（npm publish 会设置 npm_lifecycle_event）
const isPublishing = process.env.npm_lifecycle_event === 'prepublishOnly';

try {
  // 编译 native-ui（包含所有源文件）
  execSync(`swiftc "${src}" "${combinedSrc}" -o "${out}" -framework AppKit`, {
    cwd: root,
    stdio: 'pipe',
  });

  // 验证构建结果
  if (fs.existsSync(out)) {
  }
} catch (_err: unknown) {
  // 如果在发布流程中构建失败，应该报错
  if (isPublishing) {
    console.error('❌ Native UI 构建失败（发布流程中）');
    console.error('请确保：');
    console.error('  1. 当前系统是 macOS');
    console.error('  2. 已安装 Xcode Command Line Tools: xcode-select --install');
    console.error('  3. Swift 编译器可用: which swiftc');
    process.exit(1);
  }

  // 在用户安装时，如果已有预编译的二进制文件，静默跳过
  if (fs.existsSync(out)) {
  } else {
  }
}

// ── 发布流程：最终校验二进制必须存在 ──
if (isPublishing) {
  if (!fs.existsSync(out)) {
    console.error('❌ 发布中止：native-ui 二进制不存在于', out);
    console.error('   prepublishOnly 编译步骤可能被跳过或失败');
    process.exit(1);
  }
  const stat = fs.statSync(out);
  if (stat.size < 10_000) {
    console.error('❌ 发布中止：native-ui 二进制异常（仅', stat.size, '字节）');
    process.exit(1);
  }
  // 确保有执行权限
  try {
    fs.chmodSync(out, 0o755);
  } catch {
    /* ignore */
  }
}
