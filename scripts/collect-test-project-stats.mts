#!/usr/bin/env node

/**
 * @file collect-test-project-stats.mjs
 * @description 遍历 20 个真实测试项目，执行 Discovery → langStats 收集，
 *              输出 JSON 快照供单元测试使用。
 *
 * 用法: node scripts/collect-test-project-stats.mjs
 * 输出: test/fixtures/real-project-stats.json
 */

import fs from 'node:fs';
import path from 'node:path';

const __dirname = import.meta.dirname;
const ROOT = path.resolve(__dirname, '..');

// ── 测试项目列表 ──────────────────────────────────────────────────
const GITHUB_DIR = path.resolve(ROOT, '..');
const PROJECTS = [
  'Alamofire',
  'iCarousel',
  'Euclid',
  'Expression',
  'VectorMath',
  'layout',
  'RetroRampage',
  'Consumer',
  'SwiftFormat',
  'flask',
  'fastapi',
  'django-website',
  'spring-petclinic',
  'Pokedex',
  'gin',
  'axum',
  'nest',
  'todomvc',
  'vue-element-admin',
  'discourse',
];

// ── 加载 Alembic 模块 ─────────────────────────────────────────
const { getDiscovererRegistry, resetDiscovererRegistry } = await import(
  '../lib/core/discovery/index.js'
);
const { LanguageService } = await import('../lib/shared/LanguageService.js');

// ── 主逻辑 ───────────────────────────────────────────────────────
async function collectStats() {
  const results = {};

  for (const name of PROJECTS) {
    const projectRoot = path.join(GITHUB_DIR, name);
    if (!fs.existsSync(projectRoot)) {
      console.warn(`⚠ 跳过 ${name} — 目录不存在: ${projectRoot}`);
      continue;
    }
    const t0 = Date.now();
    process.stdout.write(`▶ 分析 ${name} ...\n`);

    try {
      // 每次重置 registry 以避免缓存干扰
      resetDiscovererRegistry();
      const registry = getDiscovererRegistry();

      // Phase 1: Discovery
      const discoverer = await registry.detect(projectRoot);
      await discoverer.load(projectRoot);
      const targets = await discoverer.listTargets();

      // 收集文件
      const seenPaths = new Set();
      const files = [];
      for (const t of targets) {
        try {
          const fileList = await discoverer.getTargetFiles(t);
          for (const f of fileList) {
            const fp = typeof f === 'string' ? f : f.path;
            if (seenPaths.has(fp)) {
              continue;
            }
            seenPaths.add(fp);
            files.push({
              name: typeof f === 'string' ? path.basename(f) : f.name || path.basename(fp),
              path: fp,
            });
            if (files.length >= 2000) {
              break;
            }
          }
        } catch {
          /* skip target */
        }
        if (files.length >= 2000) {
          break;
        }
      }

      // langStats
      const langStats = {};
      for (const f of files) {
        const ext = path.extname(f.name).replace('.', '') || 'unknown';
        langStats[ext] = (langStats[ext] || 0) + 1;
      }

      // LanguageService
      const profile = LanguageService.detectProfile(langStats);
      const primaryLang = LanguageService.detectPrimary(langStats);

      // 依赖图
      let depGraph = null;
      try {
        depGraph = await discoverer.getDependencyGraph();
      } catch {
        /* not available */
      }

      const elapsed = Date.now() - t0;

      results[name] = {
        projectRoot,
        discoverer: discoverer.id,
        discovererName: discoverer.displayName,
        targets: targets.length,
        files: files.length,
        langStats,
        primaryLang,
        profile: {
          primary: profile.primary,
          secondary: profile.secondary,
          isMultiLang: profile.isMultiLang,
        },
        depEdges: depGraph?.edges?.length || 0,
        elapsedMs: elapsed,
      };

      process.stdout.write(
        `  ✓ ${discoverer.id} | ${files.length} files | primary=${primaryLang} | ${elapsed}ms\n`
      );
    } catch (err) {
      console.error(`  ✗ ${name} 失败: ${err.message}`);
      results[name] = { error: err.message };
    }
  }

  // 写入 fixtures
  const outPath = path.join(ROOT, 'test', 'fixtures', 'real-project-stats.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  process.stdout.write(`\n✅ 写入 ${outPath} (${Object.keys(results).length} 个项目)\n`);

  return results;
}

collectStats().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
