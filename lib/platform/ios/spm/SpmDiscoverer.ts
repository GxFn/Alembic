/**
 * @module SpmDiscoverer
 * @description SPM 项目发现器，适配 ProjectDiscoverer 接口
 *
 * 直接使用 PackageSwiftParser 解析 Package.swift，提供模块列表和文件遍历。
 * SpmHelper 仅用于 Xcode 工作流的依赖检查/修复，不在此链路加载。
 *
 * 检测: 项目根或子目录存在 Package.swift
 */

import { existsSync, readdirSync, type Stats, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { ProjectDiscoverer } from '#core/discovery/ProjectDiscoverer.js';
import { LanguageService } from '#shared/LanguageService.js';
import { PackageSwiftParser } from './PackageSwiftParser.js';

export class SpmDiscoverer extends ProjectDiscoverer {
  #parser: PackageSwiftParser | null = null;
  #projectRoot: string | null = null;
  /** @type {Array<{ pkgPath: string, parsed: ReturnType<PackageSwiftParser['parse']> }>} */
  #parsedPackages: { pkgPath: string; parsed: ReturnType<PackageSwiftParser['parse']> }[] = [];

  get id() {
    return 'spm';
  }
  get displayName() {
    return 'Swift Package Manager (SPM)';
  }

  async detect(projectRoot: string) {
    // 检查项目根是否有 Package.swift
    const hasRoot = existsSync(join(projectRoot, 'Package.swift'));
    if (hasRoot) {
      return { match: true, confidence: 0.95, reason: 'Package.swift found at project root' };
    }

    // 检查子目录是否有 Package.swift（多包项目）
    try {
      const entries = readdirSync(projectRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          if (existsSync(join(projectRoot, entry.name, 'Package.swift'))) {
            return {
              match: true,
              confidence: 0.85,
              reason: `Package.swift found in ${entry.name}/`,
            };
          }
        }
      }
    } catch {
      /* ignore */
    }

    return { match: false, confidence: 0, reason: 'No Package.swift found' };
  }

  async load(projectRoot: string) {
    this.#projectRoot = projectRoot;
    this.#parser = new PackageSwiftParser(projectRoot);
    this.#parsedPackages = [];

    const allPaths = this.#parser.findAllPackageSwifts(projectRoot);
    for (const pkgPath of allPaths) {
      try {
        const parsed = this.#parser.parse(pkgPath);
        if (parsed) {
          this.#parsedPackages.push({ pkgPath, parsed });
        }
      } catch {
        // 解析失败，跳过
      }
    }
  }

  async listTargets() {
    if (!this.#parser) {
      return [];
    }

    const targets: {
      name: string;
      path: string;
      type: string;
      language: string;
      metadata: Record<string, unknown>;
    }[] = [];
    for (const { pkgPath, parsed } of this.#parsedPackages) {
      const pkgDir = dirname(pkgPath);
      for (const t of parsed.targets || []) {
        targets.push({
          name: t.name,
          path: pkgDir,
          type: t.type || 'library',
          language: 'swift',
          metadata: {
            ...t,
            packageName: parsed.name,
            packagePath: pkgPath,
            targetDir: pkgDir,
          },
        });
      }
    }
    return targets;
  }

  async getTargetFiles(target: string | { name: string }) {
    if (!this.#parser) {
      return [];
    }

    const targetName = typeof target === 'string' ? target : target.name;

    // 找到 target 所在的包目录和自定义 path
    let sourcesDir: string | null = null;
    for (const { pkgPath, parsed } of this.#parsedPackages) {
      const matchTarget = parsed.targets?.find((t: { name: string }) => t.name === targetName);
      if (matchTarget) {
        const pkgDir = dirname(pkgPath);
        // 优先使用 target 声明的自定义 path
        const candidates: string[] = [];
        if (matchTarget.path) {
          candidates.push(join(pkgDir, matchTarget.path));
        }
        candidates.push(join(pkgDir, 'Sources', targetName));
        candidates.push(join(pkgDir, targetName));
        for (const dir of candidates) {
          if (existsSync(dir)) {
            sourcesDir = dir;
            break;
          }
        }
        if (sourcesDir) {
          break;
        }
      }
    }

    if (!sourcesDir) {
      // Fallback: projectRoot/Sources/targetName
      const fallback = join(this.#projectRoot!, 'Sources', targetName);
      if (existsSync(fallback)) {
        sourcesDir = fallback;
      } else {
        return [];
      }
    }

    return this.#walkSourceFiles(sourcesDir).map((f) => ({
      name: f.name,
      path: f.path,
      relativePath: f.relativePath,
      language: this.#inferLang(f.path),
    }));
  }

  async getDependencyGraph() {
    if (!this.#projectRoot || !this.#parser) {
      return { nodes: [], edges: [] };
    }

    if (this.#parsedPackages.length === 0) {
      return { nodes: [], edges: [] };
    }

    const nodes: {
      id: string;
      label: string;
      type: string;
      fullPath?: string;
      targetCount?: number;
      parent?: string;
      targetType?: string;
      indirect?: boolean;
    }[] = [];
    const edges: { from: string; to: string; type: string }[] = [];
    const pkgNameSet = new Set();
    const targetToPkg = new Map();

    // ── 第一遍：收集所有 package + target 节点 ──
    const allParsed: (ReturnType<PackageSwiftParser['parse']> & { _dir: string })[] = [];
    const umbrellaNames = new Set();
    for (const { pkgPath, parsed } of this.#parsedPackages) {
      if (pkgNameSet.has(parsed.name)) {
        continue;
      }
      pkgNameSet.add(parsed.name);
      allParsed.push({ ...parsed, _dir: dirname(pkgPath) });

      // 跳过 umbrella 包（无 targets + 无 products）——它只是组织子包的入口
      const hasTargets = parsed.targets && parsed.targets.length > 0;
      const hasProducts = parsed.products && parsed.products.length > 0;
      if (!hasTargets && !hasProducts) {
        umbrellaNames.add(parsed.name);
        continue;
      }

      // package 节点
      nodes.push({
        id: parsed.name,
        label: parsed.name,
        type: 'package',
        fullPath: dirname(pkgPath),
        targetCount: parsed.targets.length,
      });

      // target 节点
      for (const t of parsed.targets) {
        nodes.push({
          id: t.name,
          label: t.name,
          type: 'target',
          parent: parsed.name,
          targetType: t.type,
        });
        targetToPkg.set(t.name, parsed.name);
      }

      // product name → package（product 名可能和 target 名不同）
      for (const prod of parsed.products || []) {
        if (!targetToPkg.has(prod.name)) {
          targetToPkg.set(prod.name, parsed.name);
        }
      }
    }

    // ── 第二遍：构建 edges ──
    for (const parsed of allParsed) {
      // 跳过 umbrella 包的边
      if (umbrellaNames.has(parsed.name)) {
        continue;
      }

      // 包级 local path 依赖
      for (const dep of parsed.dependencies || []) {
        if (dep.type === 'local' && 'path' in dep && dep.path) {
          const depPkgSwift = join(parsed._dir, dep.path, 'Package.swift');
          if (existsSync(depPkgSwift)) {
            try {
              const depParsed = this.#parser.parse(depPkgSwift);
              // 跳过指向 umbrella 包的边
              if (!umbrellaNames.has(depParsed.name)) {
                edges.push({ from: parsed.name, to: depParsed.name, type: 'depends_on' });
              }
            } catch {
              const targetName = basename(dep.path);
              if (!umbrellaNames.has(targetName)) {
                edges.push({ from: parsed.name, to: targetName, type: 'depends_on' });
              }
            }
          }
        } else if ('url' in dep && dep.url) {
          const remoteName = basename(dep.url).replace(/\.git$/, '');
          if (!pkgNameSet.has(remoteName)) {
            pkgNameSet.add(remoteName);
            nodes.push({ id: remoteName, label: remoteName, type: 'remote', indirect: true });
          }
          edges.push({ from: parsed.name, to: remoteName, type: 'depends_on' });
        }
      }

      // target 级依赖
      for (const t of parsed.targets || []) {
        // target → parent package (contains)
        edges.push({ from: parsed.name, to: t.name, type: 'contains' });

        for (const depName of t.dependencies || []) {
          // target → target 依赖（跳过指向 umbrella 包的）
          if (!umbrellaNames.has(depName)) {
            edges.push({ from: t.name, to: depName, type: 'depends_on' });
          }
        }
      }
    }

    return { nodes, edges };
  }

  /** @deprecated SpmHelper 不再由 SpmDiscoverer 持有，仅 XcodeIntegration 通过 container 使用 */
  getSpmService() {
    return null;
  }

  // ─────────────── Private Helpers ───────────────

  /**
   * 遍历源码目录，返回源文件列表
   * @param dir 源码根目录
   * @returns []}
   */
  #walkSourceFiles(dir: string) {
    const CODE_EXTS = new Set(['.swift', '.m', '.h', '.c', '.cpp', '.mm']);
    const SKIP_DIRS = new Set([
      'node_modules',
      '.git',
      'dist',
      'build',
      '.build',
      'DerivedData',
      'Pods',
      'Carthage',
    ]);
    const MAX_FILES = 300;
    const files: { name: string; path: string; relativePath: string }[] = [];

    const walk = (d: string, rel = '') => {
      if (files.length >= MAX_FILES) {
        return;
      }
      let entries: string[];
      try {
        entries = readdirSync(d);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) {
          break;
        }
        if (entry.startsWith('.')) {
          continue;
        }
        const full = join(d, entry);
        const relPath = rel ? `${rel}/${entry}` : entry;
        let st: Stats;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(entry)) {
            walk(full, relPath);
          }
        } else if (CODE_EXTS.has(extname(entry).toLowerCase())) {
          if (st.size <= 512 * 1024) {
            files.push({ name: entry, path: full, relativePath: relPath });
          }
        }
      }
    };
    walk(dir);
    return files;
  }

  #inferLang(filePath: string) {
    return LanguageService.inferLang(filePath);
  }
}
