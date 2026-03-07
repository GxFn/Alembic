/**
 * @module ImportPathResolver
 * @description Phase 5: 将 import 路径解析为项目内文件路径
 *
 * 负责:
 *   - 相对路径 (./ ../) 解析
 *   - 文件扩展名补全 (.ts, .js, .py, ...)
 *   - index 文件约定 (./dir → ./dir/index.ts)
 *   - 外部依赖识别与过滤
 *   - tsconfig paths alias 支持 (@/xxx → src/xxx)
 *
 * 不负责:
 *   - webpack resolve alias (需额外配置)
 *   - Node.js exports map (需解析 package.json)
 */

import fs from 'node:fs';
import path from 'node:path';

export class ImportPathResolver {
  fileIndex: Map<string, string>;
  pathAliases: Array<{ prefix: string; targets: string[] }>;
  projectRoot: string;
  /**
   * @param {string} projectRoot 项目根目录
   * @param {string[]} allFiles 项目内所有文件的相对路径
   */
  constructor(projectRoot: string, allFiles: string[]) {
    this.projectRoot = projectRoot;
    /** @type {Map<string, string>} normalizedPath → actualFilePath */
    this.fileIndex = new Map();
    /** @type {Array<{prefix: string, targets: string[]}>} tsconfig paths 映射 */
    this.pathAliases = [];

    // 构建文件索引
    for (const f of allFiles) {
      // 完整路径
      this.fileIndex.set(f, f);

      // 去扩展名 → 完整路径
      const base = f.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|m|dart)$/, '');
      if (!this.fileIndex.has(base)) {
        this.fileIndex.set(base, f);
      }

      // index 文件约定: src/utils/ → src/utils/index.ts
      if (/\/index\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) {
        const dir = f.replace(/\/index\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
        if (!this.fileIndex.has(dir)) {
          this.fileIndex.set(dir, f);
        }
      }

      // Python __init__.py 约定: pkg/ → pkg/__init__.py
      if (f.endsWith('/__init__.py')) {
        const dir = f.replace(/\/__init__\.py$/, '');
        if (!this.fileIndex.has(dir)) {
          this.fileIndex.set(dir, f);
        }
      }
    }

    // 自动加载 tsconfig paths
    this._loadTsconfigPaths(projectRoot);
  }

  /**
   * 从 tsconfig.json 加载 paths alias 配置
   * @param {string} projectRoot
   * @private
   */
  _loadTsconfigPaths(projectRoot: string) {
    const candidates = ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json'];
    for (const name of candidates) {
      try {
        const configPath = path.join(projectRoot, name);
        if (!fs.existsSync(configPath)) {
          continue;
        }
        const raw = fs.readFileSync(configPath, 'utf-8');
        // 简单的 JSON 解析 (去除注释)
        const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const config = JSON.parse(cleaned);
        const compilerOptions = config.compilerOptions || {};
        const baseUrl = compilerOptions.baseUrl || '.';
        const paths = compilerOptions.paths;
        if (!paths) {
          continue;
        }

        for (const [aliasPattern, targetPatterns] of Object.entries(paths)) {
          // "@/*" → ["src/*"]
          // "~/*" → ["src/*"]
          // "@components/*" → ["src/components/*"]
          const prefix = aliasPattern.replace(/\/?\*$/, '');
          const targets = (Array.isArray(targetPatterns) ? targetPatterns : [targetPatterns]).map(
            (t) => {
              const target = String(t).replace(/\/?\*$/, '');
              // 相对于 baseUrl 解析
              return path.normalize(path.join(baseUrl, target));
            }
          );
          if (prefix) {
            this.pathAliases.push({ prefix, targets });
          }
        }

        // 只加载第一个找到的配置文件
        break;
      } catch (_e: unknown) {
        // 配置解析失败，静默跳过
      }
    }
  }

  /**
   * 解析 import 路径到项目文件
   *
   * @param {string} importPath 如 "./UserRepo" 或 "../shared/utils"
   * @param {string} importerFile 当前文件路径 (相对路径)
   * @returns {string|null} 解析后的文件路径 (相对) 或 null (外部依赖)
   */
  resolve(importPath: string | { toString(): string }, importerFile: string) {
    const pathStr = String(importPath);

    // 1. 跳过外部依赖 (先检查 alias，再判断外部)
    // 相对路径始终尝试解析
    if (pathStr.startsWith('.')) {
      const importerDir = path.dirname(importerFile);
      const resolved = path.normalize(path.join(importerDir, pathStr));
      if (this.fileIndex.has(resolved)) {
        return this.fileIndex.get(resolved);
      }
      return this.fileIndex.get(resolved) || null;
    }

    // 2. tsconfig paths alias 解析
    const aliasResolved = this._resolveAlias(pathStr);
    if (aliasResolved) {
      return aliasResolved;
    }

    // 3. 如果不是 alias 且是外部依赖 → null
    if (this._isExternal(pathStr)) {
      return null;
    }

    // 4. Python 模块路径 (点分隔 → 斜线)
    if (pathStr.includes('.') && !pathStr.includes('/')) {
      const slashed = pathStr.replace(/\./g, '/');
      if (this.fileIndex.has(slashed)) {
        return this.fileIndex.get(slashed);
      }
    }

    // 5. 直接匹配（Go 包路径、Rust crate path 等）
    return this.fileIndex.get(pathStr) || null;
  }

  /**
   * 尝试通过 tsconfig paths alias 解析
   * @param {string} importPath
   * @returns {string|null}
   * @private
   */
  _resolveAlias(importPath: string): string | null {
    for (const { prefix, targets } of this.pathAliases) {
      if (importPath === prefix || importPath.startsWith(`${prefix}/`)) {
        const remainder = importPath === prefix ? '' : importPath.slice(prefix.length + 1);
        for (const target of targets) {
          const resolved = remainder ? path.normalize(path.join(target, remainder)) : target;
          if (this.fileIndex.has(resolved)) {
            return this.fileIndex.get(resolved) ?? null;
          }
        }
      }
    }
    return null;
  }

  /**
   * 判断是否为外部依赖
   * @param {string} importPath
   * @returns {boolean}
   */
  _isExternal(importPath: string): boolean {
    // 相对路径不是外部
    if (importPath.startsWith('.') || importPath.startsWith('/')) {
      return false;
    }

    // scoped npm packages: @scope/pkg
    // bare specifier: lodash, express 等
    // 如果在文件索引中有匹配，说明是项目内的
    if (this.fileIndex.has(importPath)) {
      return false;
    }

    // Python 点分路径的特殊处理
    if (importPath.includes('.') && !importPath.includes('/')) {
      const slashed = importPath.replace(/\./g, '/');
      if (this.fileIndex.has(slashed)) {
        return false;
      }
    }

    return true;
  }
}

export default ImportPathResolver;
