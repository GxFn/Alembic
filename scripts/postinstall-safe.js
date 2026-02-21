#!/usr/bin/env node

/**
 * 安全的 postinstall 脚本 - 只检查不编译
 * 用于避免触发 npm 安全警告
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

// 检查预构建的二进制文件
function checkBinaries() {
  const checks = [
    {
      name: 'Native UI',
      path: path.join(root, 'resources', 'native-ui', 'native-ui'),
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

checkBinaries();
