/**
 * @module SpmDiscoverer
 * @description 包装现有 SpmHelper，适配 ProjectDiscoverer 接口
 *
 * 检测: 项目根或子目录存在 Package.swift
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { ProjectDiscoverer } from '../../../core/discovery/ProjectDiscoverer.js';
import { LanguageService } from '../../../shared/LanguageService.js';
import { PackageSwiftParser } from './PackageSwiftParser.js';

export class SpmDiscoverer extends ProjectDiscoverer {
  /** @type {import('./SpmHelper.js').SpmHelper|null} */
  #spm = null;
  #projectRoot = null;

  get id() {
    return 'spm';
  }
  get displayName() {
    return 'Swift Package Manager (SPM)';
  }

  async detect(projectRoot) {
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

  async load(projectRoot) {
    this.#projectRoot = projectRoot;
    // 动态加载 SpmHelper（避免循环导入）
    const { SpmHelper } = await import('./SpmHelper.js');
    this.#spm = new SpmHelper(projectRoot);
    await this.#spm.load();
  }

  async listTargets() {
    if (!this.#spm) {
      return [];
    }
    const rawTargets = await this.#spm.listTargets();
    return rawTargets.map((t) => {
      const name = typeof t === 'string' ? t : t.name;
      return {
        name,
        path: typeof t === 'object' ? t.path || this.#projectRoot : this.#projectRoot,
        type: typeof t === 'object' ? t.type || 'library' : 'library',
        language: 'swift',
        metadata: typeof t === 'object' ? t : { name },
      };
    });
  }

  async getTargetFiles(target) {
    if (!this.#spm) {
      return [];
    }
    const targetName = typeof target === 'string' ? target : target.name;
    const fileList = await this.#spm.getTargetFiles(targetName);
    return fileList.map((f) => {
      const fp = typeof f === 'string' ? f : f.path;
      const lang = this.#inferLang(fp);
      return {
        name: typeof f === 'object' ? f.name || basename(fp) : basename(fp),
        path: fp,
        relativePath:
          typeof f === 'object'
            ? f.relativePath || relative(this.#projectRoot, fp)
            : relative(this.#projectRoot, fp),
        language: lang,
      };
    });
  }

  async getDependencyGraph() {
    if (!this.#projectRoot) {
      return { nodes: [], edges: [] };
    }

    // 直接用 PackageSwiftParser 构建依赖图，不依赖 SpmHelper
    const parser = new PackageSwiftParser(this.#projectRoot);
    const allPkgPaths = parser.findAllPackageSwifts(this.#projectRoot);

    if (allPkgPaths.length === 0) {
      return { nodes: [], edges: [] };
    }

    const nodes = [];
    const edges = [];
    const pkgNameSet = new Set();
    // targetName → 所属 packageName 映射（用于跨包 target 依赖解析）
    const targetToPkg = new Map();

    // ── 第一遍：收集所有 package + target 节点 ──
    const allParsed = [];
    // 记录 umbrella 包名（无 targets 且无 products 的纯组织性入口包），不作为图节点
    const umbrellaNames = new Set();
    for (const pkgPath of allPkgPaths) {
      try {
        const parsed = parser.parse(pkgPath);
        if (pkgNameSet.has(parsed.name)) continue;
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
      } catch {
        // 解析失败，跳过
      }
    }

    // ── 第二遍：构建 edges ──
    for (const parsed of allParsed) {
      // 跳过 umbrella 包的边
      if (umbrellaNames.has(parsed.name)) continue;

      // 包级 local path 依赖
      for (const dep of parsed.dependencies || []) {
        if (dep.type === 'local' && dep.path) {
          const depPkgSwift = join(parsed._dir, dep.path, 'Package.swift');
          if (existsSync(depPkgSwift)) {
            try {
              const depParsed = parser.parse(depPkgSwift);
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
        } else if (dep.url) {
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

  /** 获取底层 SpmHelper（向后兼容） */
  getSpmService() {
    return this.#spm;
  }

  #inferLang(filePath) {
    return LanguageService.inferLang(filePath);
  }
}
