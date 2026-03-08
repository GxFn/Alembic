/**
 * isOwnDevRepo — 检测当前 projectRoot 是否是 AutoSnippet 自身的开发仓库
 *
 * 用于防止 MCP 服务器 / CLI 在开发环境中把源码仓库当做用户项目，
 * 避免在开发仓库内创建 `.autosnippet/` 和 `AutoSnippet/candidates/` 等运行时数据。
 *
 * 检测条件（三者同时满足）：
 *  1. projectRoot/package.json 的 name === 'autosnippet'
 *  2. projectRoot/lib/bootstrap.ts 存在（源码标记）
 *  3. projectRoot/SOUL.md 存在（项目灵魂文档）
 */

import fs from 'node:fs';
import path from 'node:path';

/** 多路径缓存（同一进程可能检测多个目录） */
const _cache = new Map<string, boolean>();

/**
 * 判断 dir 是否是 AutoSnippet 自身的源码开发仓库
 * 结果按 dir 缓存，避免重复 IO
 */
export function isAutoSnippetDevRepo(dir: string): boolean {
  const resolved = path.resolve(dir);
  const cached = _cache.get(resolved);
  if (cached !== undefined) {
    return cached;
  }

  let result = false;
  try {
    // 条件 1: package.json name === 'autosnippet'
    const pkgPath = path.join(resolved, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const raw = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw) as { name?: string };
      if (pkg.name === 'autosnippet') {
        // 条件 2 & 3: 源码标记文件同时存在
        const hasBootstrap = fs.existsSync(path.join(resolved, 'lib', 'bootstrap.ts'));
        const hasSoul = fs.existsSync(path.join(resolved, 'SOUL.md'));
        result = hasBootstrap && hasSoul;
      }
    }
  } catch {
    // 读取失败 → 不是开发仓库
  }

  _cache.set(resolved, result);
  return result;
}

/**
 * 重置缓存（仅用于测试）
 */
export function _resetDevRepoCache() {
  _cache.clear();
}
