#!/usr/bin/env node

/**
 * 清除旧的向量索引（含 AutoSnippet/recipes 前缀的形式）
 * 使用源头修复后，需要重新生成新的索引（无前缀形式）
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const projectRoot = args[0] || '/Users/gaoxuefeng/Documents/github/BiliDemo';

const indexDir = path.join(projectRoot, 'AutoSnippet/.autosnippet/context/index');
const vectorIndexPath = path.join(indexDir, 'vector_index.json');

if (!fs.existsSync(vectorIndexPath)) {
  process.exit(0);
}

// 检查索引格式
const data = JSON.parse(fs.readFileSync(vectorIndexPath, 'utf8'));
const hasOldFormat = data.items?.some((item) =>
  item.metadata?.sourcePath?.startsWith('AutoSnippet/recipes/')
);

if (!hasOldFormat) {
  process.exit(0);
}
const oldItems = data.items.filter((item) =>
  item.metadata?.sourcePath?.startsWith('AutoSnippet/recipes/')
);
oldItems.slice(0, 3).forEach((_item) => {});

// 删除旧索引
try {
  fs.unlinkSync(vectorIndexPath);

  // 删除 manifest.json
  const manifestPath = path.join(indexDir, '../manifest.json');
  if (fs.existsSync(manifestPath)) {
    fs.unlinkSync(manifestPath);
  }
} catch (e: any) {
  console.error('❌ 删除失败:', e.message);
  process.exit(1);
}
