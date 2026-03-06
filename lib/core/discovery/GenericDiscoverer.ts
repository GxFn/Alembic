/**
 * @module GenericDiscoverer
 * @description 通用兜底项目结构发现器
 *
 * 始终匹配，confidence 0.1。
 * 按语言统计最多的扩展名确定主语言。
 * 按顶层目录分 Target。
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { LanguageService } from '../../shared/LanguageService.js';
import { ProjectDiscoverer } from './ProjectDiscoverer.js';

const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.cursor',
  'dist',
  'build',
  'out',
  '.build',
  'target',
  'Pods',
  'Carthage',
  'DerivedData',
  '__pycache__',
  '.venv',
  'venv',
  '.gradle',
  '.idea',
  'vendor',
  'coverage',
  '.cache',
]);

const SOURCE_EXTENSIONS = LanguageService.sourceExts;

export class GenericDiscoverer extends ProjectDiscoverer {
  #projectRoot = null;
  #targets = [];
  #primaryLang = 'unknown';

  // @ts-expect-error TS migration: TS2416
  get id() {
    return 'generic';
  }
  // @ts-expect-error TS migration: TS2416
  get displayName() {
    return 'Generic (directory scan)';
  }

  // @ts-expect-error TS migration: TS2416
  async detect(projectRoot) {
    // 始终匹配
    return { match: true, confidence: 0.1, reason: 'Generic fallback discoverer' };
  }

  async load(projectRoot) {
    this.#projectRoot = projectRoot;
    this.#targets = [];

    // 统计语言分布
    const langStats = {};
    this.#scanLangStats(projectRoot, langStats, 0);

    // 找到主语言
    let maxCount = 0;
    for (const [lang, count] of Object.entries(langStats)) {
      // @ts-expect-error TS migration: TS2365
      if (count > maxCount) {
        // @ts-expect-error TS migration: TS2322
        maxCount = count;
        this.#primaryLang = lang;
      }
    }

    // 按顶层约定目录分 Target
    const targetDirs = ['src', 'lib', 'app', 'pkg', 'cmd', 'internal', 'test', 'tests'];
    let foundTargets = false;

    try {
      const entries = readdirSync(projectRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (entry.name.startsWith('.') || EXCLUDE_DIRS.has(entry.name)) {
          continue;
        }

        if (targetDirs.includes(entry.name.toLowerCase())) {
          const isTest = /^tests?$/.test(entry.name);
          this.#targets.push({
            name: entry.name,
            path: join(projectRoot, entry.name),
            type: isTest ? 'test' : 'library',
            language: this.#primaryLang,
          });
          foundTargets = true;
        }
      }
    } catch {
      /* skip */
    }

    // 没有约定目录则整个项目为一个 Target
    if (!foundTargets) {
      this.#targets.push({
        name: basename(projectRoot),
        path: projectRoot,
        type: 'library',
        language: this.#primaryLang,
      });
    }
  }

  // @ts-expect-error TS migration: TS2416
  async listTargets() {
    return this.#targets;
  }

  // @ts-expect-error TS migration: TS2416
  async getTargetFiles(target) {
    const targetPath =
      typeof target === 'string'
        ? this.#targets.find((t) => t.name === target)?.path || this.#projectRoot
        : target.path;

    if (!targetPath || !existsSync(targetPath)) {
      return [];
    }

    const files = [];
    this.#collectFiles(targetPath, targetPath, files);
    return files;
  }

  // @ts-expect-error TS migration: TS2416
  async getDependencyGraph() {
    // GenericDiscoverer 无法推断依赖图
    return { nodes: this.#targets.map((t) => t.name), edges: [] };
  }

  // ── 内部实现 ──

  #scanLangStats(dir, stats, depth) {
    if (depth > 5) {
      return; // 限制深度, 只采样
    }
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        if (EXCLUDE_DIRS.has(entry.name)) {
          continue;
        }

        if (entry.isDirectory()) {
          this.#scanLangStats(join(dir, entry.name), stats, depth + 1);
        } else if (entry.isFile()) {
          const ext = extname(entry.name);
          if (SOURCE_EXTENSIONS.has(ext)) {
            const lang = LanguageService.inferLang(entry.name) || 'unknown';
            stats[lang] = (stats[lang] || 0) + 1;
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  #collectFiles(dir, rootDir, files, depth = 0) {
    if (depth > 15) {
      return;
    }
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        if (EXCLUDE_DIRS.has(entry.name)) {
          continue;
        }

        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          this.#collectFiles(fullPath, rootDir, files, depth + 1);
        } else if (entry.isFile()) {
          const ext = extname(entry.name);
          if (SOURCE_EXTENSIONS.has(ext)) {
            const lang = LanguageService.inferLang(entry.name) || 'unknown';
            files.push({
              name: entry.name,
              path: fullPath,
              relativePath: relative(rootDir, fullPath),
              language: lang,
            });
          }
        }
      }
    } catch {
      /* skip */
    }
  }
}
