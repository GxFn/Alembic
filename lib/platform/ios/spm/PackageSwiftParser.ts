/**
 * PackageSwiftParser — Package.swift 解析器
 * 从 V1 PackageParserV2 迁移，提取包名/版本/targets/dependencies/products/platforms
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Logger from '#infra/logging/Logger.js';

export class PackageSwiftParser {
  #projectRoot;
  #cache;
  #logger;

  constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
    this.#cache = new Map();
    this.#logger = Logger.getInstance();
  }

  /**
   * 向上递归查找 Package.swift
   * @returns 路径
   */
  findPackageSwift(startPath = this.#projectRoot) {
    const cacheKey = `find:${startPath}`;
    if (this.#cache.has(cacheKey)) {
      return this.#cache.get(cacheKey);
    }

    let dir = startPath;
    for (let i = 0; i < 10; i++) {
      const candidate = join(dir, 'Package.swift');
      if (existsSync(candidate)) {
        this.#cache.set(cacheKey, candidate);
        return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return null;
  }

  /**
   * 向下递归扫描所有 Package.swift（支持多 Package 项目）
   * @param rootDir 扫描起点（默认 projectRoot）
   * @returns Package.swift 路径数组
   */
  findAllPackageSwifts(rootDir = this.#projectRoot) {
    const cacheKey = `findAll:${rootDir}`;
    if (this.#cache.has(cacheKey)) {
      return this.#cache.get(cacheKey);
    }

    const results: string[] = [];
    const skipDirs = new Set([
      'node_modules',
      '.git',
      'Build',
      '.build',
      '.swiftpm',
      'Pods',
      'DerivedData',
    ]);

    const scan = (dir: string, depth = 0) => {
      if (depth > 5) {
        return; // 限制深度
      }
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (skipDirs.has(entry.name)) {
              continue;
            }
            scan(join(dir, entry.name), depth + 1);
          } else if (entry.name === 'Package.swift') {
            results.push(join(dir, entry.name));
          }
        }
      } catch {
        // 权限错误等，跳过
      }
    };

    scan(rootDir);
    this.#cache.set(cacheKey, results);
    return results;
  }

  /**
   * 解析 Package.swift
   * @returns }
   */
  parse(packagePath: string) {
    if (!packagePath || !existsSync(packagePath)) {
      throw new Error(`Package.swift not found: ${packagePath}`);
    }

    const content = readFileSync(packagePath, 'utf-8');
    const result = {
      path: packagePath,
      name: this.#extractName(content),
      version: this.#extractVersion(content),
      targets: this.#extractTargets(content),
      dependencies: this.#extractDependencies(content),
      products: this.#extractProducts(content),
      platforms: this.#extractPlatforms(content),
    };

    this.#logger.debug(
      `[PackageSwiftParser] 解析完成: ${result.name} (${result.targets.length} targets)`
    );
    return result;
  }

  /** 获取包摘要 */
  getSummary(packagePath: string) {
    try {
      const parsed = this.parse(packagePath);
      return {
        name: parsed.name,
        version: parsed.version,
        targetCount: parsed.targets.length,
        dependencyCount: parsed.dependencies.length,
        platforms: parsed.platforms,
      };
    } catch {
      return null;
    }
  }

  /** 提取 target blocks（公开方法，供外部使用） */
  extractTargets(content: string) {
    return this.#extractTargets(content);
  }

  clearCache() {
    this.#cache.clear();
  }

  // ─── 私有提取方法 ──────────────────────────────────────

  #extractName(content: string) {
    const m = content.match(/name\s*:\s*"([^"]+)"/);
    return m ? m[1] : 'unknown';
  }

  #extractVersion(content: string) {
    const m = content.match(/version\s*:\s*"([^"]+)"/);
    return m ? m[1] : '0.0.0';
  }

  #extractTargets(content: string) {
    const targets: { name: string; type: string; path: string | null; dependencies: string[] }[] =
      [];
    const re = /\.(?:target|testTarget|executableTarget)\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = re.exec(content)) !== null) {
      const type = match[0].includes('testTarget')
        ? 'testTarget'
        : match[0].includes('executableTarget')
          ? 'executableTarget'
          : 'target';

      const startPos = match.index + match[0].length;
      let depth = 1;
      let endPos = startPos;

      while (depth > 0 && endPos < content.length) {
        if (content[endPos] === '(') {
          depth++;
        } else if (content[endPos] === ')') {
          depth--;
        }
        endPos++;
      }

      if (depth === 0) {
        const block = content.substring(startPos, endPos - 1);
        const nameMatch = block.match(/name\s*:\s*"([^"]+)"/);
        if (!nameMatch) {
          continue;
        }

        const pathMatch = block.match(/path\s*:\s*"([^"]+)"/);
        const depsMatch = block.match(/dependencies\s*:\s*\[([^\]]*)\]/s);
        const deps: string[] = [];
        if (depsMatch) {
          const depRe = /\.(?:product|target)\s*\(\s*name\s*:\s*"([^"]+)"/g;
          let dm: RegExpExecArray | null;
          while ((dm = depRe.exec(depsMatch[1])) !== null) {
            deps.push(dm[1]);
          }
        }

        targets.push({
          name: nameMatch[1],
          type,
          path: pathMatch ? pathMatch[1] : null,
          dependencies: deps,
        });
      }
    }

    return targets;
  }

  #extractDependencies(content: string) {
    const deps: (
      | { url: string; version: string | null; type: string }
      | { path: string; type: string }
    )[] = [];

    // 1. URL 依赖: .package(url: "...", ...)
    const urlRe = /\.package\s*\(\s*url\s*:\s*"([^"]+)"[^)]*\)/g;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(content)) !== null) {
      const block = m[0];
      const fromMatch = block.match(/from\s*:\s*"([^"]+)"/);
      const exactMatch = block.match(/exact\s*:\s*"([^"]+)"/);
      deps.push({
        url: m[1],
        version: fromMatch ? fromMatch[1] : exactMatch ? exactMatch[1] : null,
        type: 'package',
      });
    }

    // 2. Local path 依赖: .package(path: "...")
    const pathRe = /\.package\s*\(\s*path\s*:\s*"([^"]+)"\s*\)/g;
    while ((m = pathRe.exec(content)) !== null) {
      deps.push({
        path: m[1],
        type: 'local',
      });
    }

    return deps;
  }

  #extractProducts(content: string) {
    const products: { name: string; type: string }[] = [];
    const re = /\.(library|executable)\s*\(\s*name\s*:\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      products.push({ name: m[2], type: m[1] });
    }
    return products;
  }

  #extractPlatforms(content: string) {
    const platforms: { name: string; version: string }[] = [];
    const re = /\.(iOS|macOS|tvOS|watchOS|visionOS)\s*\(\s*\.v(\d+(?:_\d+)?)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      platforms.push({ name: m[1], version: m[2].replace(/_/g, '.') });
    }
    return platforms;
  }
}
