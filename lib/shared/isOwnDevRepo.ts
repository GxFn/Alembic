/**
 * isOwnDevRepo — 检测 projectRoot 是否应排除 AutoSnippet 运行时数据创建
 *
 * 三层保护：
 *  1. isAutoSnippetDevRepo — AutoSnippet 自身源码仓库
 *  2. isAutoSnippetEcosystemRepo — AutoSnippet 生态项目（autosnippet-book 等）
 *  3. isExcludedProject — 综合判定：不适合创建知识库的项目
 *
 * 用于防止 MCP 服务器 / CLI 在不当目录创建 `.autosnippet/` 运行时数据。
 *
 * isAutoSnippetDevRepo 检测条件（三者同时满足）：
 *  1. projectRoot/package.json 的 name === 'autosnippet'
 *  2. projectRoot/lib/bootstrap.ts 存在（源码标记）
 *  3. projectRoot/SOUL.md 存在（项目灵魂文档）
 */

import fs from 'node:fs';
import path from 'node:path';

/** 多路径缓存（同一进程可能检测多个目录） */
const _cache = new Map<string, boolean>();

/** 排除项目缓存 */
const _excludeCache = new Map<string, { excluded: boolean; reason: string }>();

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
 * 判断 dir 是否是 AutoSnippet 生态项目（不应创建运行时数据）
 *
 * 检测条件：package.json 的 name 以 'autosnippet-' 开头
 * 例如 autosnippet-book、autosnippet-examples 等
 */
export function isAutoSnippetEcosystemRepo(dir: string): boolean {
  const resolved = path.resolve(dir);
  try {
    const pkgPath = path.join(resolved, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const raw = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw) as { name?: string };
      return typeof pkg.name === 'string' && pkg.name.startsWith('autosnippet-');
    }
  } catch {
    // 读取失败 → 不是
  }
  return false;
}

/**
 * 综合判定：项目是否应排除创建 .autosnippet/ 运行时数据
 *
 * 当前排除：
 *  1. AutoSnippet 源码仓库本身
 *  2. AutoSnippet 生态项目（autosnippet-book 等）
 *  3. 存在 .autosnippet-skip 标记文件的项目（用户手动排除）
 *
 * @returns { excluded: boolean; reason: string }
 */
export function isExcludedProject(dir: string): { excluded: boolean; reason: string } {
  const resolved = path.resolve(dir);
  const cached = _excludeCache.get(resolved);
  if (cached !== undefined) {
    return cached;
  }

  let result: { excluded: boolean; reason: string };

  if (isAutoSnippetDevRepo(resolved)) {
    result = { excluded: true, reason: 'AutoSnippet 源码开发仓库' };
  } else if (isAutoSnippetEcosystemRepo(resolved)) {
    result = { excluded: true, reason: 'AutoSnippet 生态项目' };
  } else if (fs.existsSync(path.join(resolved, '.autosnippet-skip'))) {
    result = { excluded: true, reason: '项目包含 .autosnippet-skip 标记' };
  } else {
    result = { excluded: false, reason: '' };
  }

  _excludeCache.set(resolved, result);
  return result;
}

/** 重置缓存（仅用于测试） */
export function _resetDevRepoCache() {
  _cache.clear();
  _excludeCache.clear();
}
