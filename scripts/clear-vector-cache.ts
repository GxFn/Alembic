#!/usr/bin/env node

/**
 * 清除向量数据库缓存
 * 用于解决向量维度不匹配问题
 */

import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

import fs from 'node:fs';
import path from 'node:path';

// 获取项目路径（从参数或当前目录）
const projectRoot = process.argv[2] || process.cwd();

// 向量索引文件位置
const vectorIndexPaths = [
  // 新位置：{projectRoot}/.autosnippet/context/index/vector_index.json
  path.join(projectRoot, '.autosnippet', 'context', 'index', 'vector_index.json'),
  // 旧位置（兼容）
  path.join(projectRoot, '.autosnippet', 'vector_index.json'),
  path.join(projectRoot, 'AutoSnippet', '.autosnippet', 'context', 'index', 'vector_index.json'),
];

let deletedCount = 0;
let _totalVectors = 0;

for (const filePath of vectorIndexPaths) {
  if (fs.existsSync(filePath)) {
    try {
      // 读取并显示信息
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const vectorCount = data.items ? data.items.length : 0;
      const _firstVectorDim = data.items?.[0]?.vector?.length || 0;

      _totalVectors += vectorCount;

      // 删除文件
      fs.unlinkSync(filePath);
      deletedCount++;
    } catch (_err: any) {}
  }
}

if (deletedCount > 0) {
} else {
}
