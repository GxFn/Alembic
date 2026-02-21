#!/usr/bin/env node

/**
 * @file bench-real-projects.mjs
 * @description 性能基准测试 — 对 20 个真实项目执行 Discovery → AST → Enhancement 全链路
 *              输出每个阶段的耗时表。
 *
 * 用法: node scripts/bench-real-projects.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
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

// ── 加载模块 ──────────────────────────────────────────────────────
const { getDiscovererRegistry, resetDiscovererRegistry } = await import(
  '../lib/core/discovery/index.js'
);
const { LanguageService } = await import('../lib/shared/LanguageService.js');
const { DimensionCopy } = await import('../lib/shared/DimensionCopyRegistry.js');

// AST
await import('../lib/core/ast/index.js');
const { analyzeProject, isAvailable: astIsAvailable } = await import('../lib/core/AstAnalyzer.js');

// Enhancement
const { initEnhancementRegistry } = await import('../lib/core/enhancement/index.js');

// ── 主逻辑 ────────────────────────────────────────────────────────
async function benchmark() {
  const enhRegistry = await initEnhancementRegistry();

  const results = [];

  for (const name of PROJECTS) {
    const projectRoot = path.join(GITHUB_DIR, name);
    if (!fs.existsSync(projectRoot)) {
      console.warn(`⚠ 跳过 ${name}`);
      continue;
    }

    const row = { project: name, files: 0 };

    // Phase 1: Discovery
    const t1 = Date.now();
    resetDiscovererRegistry();
    const registry = getDiscovererRegistry();
    const discoverer = await registry.detect(projectRoot);
    row.detectMs = Date.now() - t1;

    const t2 = Date.now();
    await discoverer.load(projectRoot);
    const targets = await discoverer.listTargets();
    row.loadMs = Date.now() - t2;

    // File collection
    const t3 = Date.now();
    const seenPaths = new Set();
    const allFiles = [];
    const langStats = {};
    const MAX_FILES = 500;

    for (const t of targets) {
      try {
        const fileList = await discoverer.getTargetFiles(t);
        for (const f of fileList) {
          const fp = typeof f === 'string' ? f : f.path;
          if (seenPaths.has(fp)) {
            continue;
          }
          seenPaths.add(fp);
          const fname = typeof f === 'string' ? path.basename(f) : f.name || path.basename(fp);
          try {
            const content = fs.readFileSync(fp, 'utf8');
            allFiles.push({ name: fname, relativePath: path.relative(projectRoot, fp), content });
          } catch {
            /* skip */
          }

          const ext = path.extname(fname).replace('.', '') || 'unknown';
          langStats[ext] = (langStats[ext] || 0) + 1;

          if (allFiles.length >= MAX_FILES) {
            break;
          }
        }
      } catch {
        /* skip */
      }
      if (allFiles.length >= MAX_FILES) {
        break;
      }
    }
    row.fileCollectMs = Date.now() - t3;
    row.files = allFiles.length;
    row.discoverer = discoverer.id;

    // Phase 2: Language detection
    const t4 = Date.now();
    const primaryLang = LanguageService.detectPrimary(langStats);
    const profile = LanguageService.detectProfile(langStats);
    row.langDetectMs = Date.now() - t4;
    row.primaryLang = primaryLang;

    // Phase 3: AST
    const t5 = Date.now();
    let astSummary = null;
    if (astIsAvailable() && primaryLang) {
      try {
        astSummary = analyzeProject(allFiles, primaryLang);
      } catch {
        /* graceful */
      }
    }
    row.astMs = Date.now() - t5;
    row.astClasses = astSummary?.classes?.length || 0;
    row.astMethods = astSummary?.methods?.length || 0;

    // Phase 4: Enhancement
    const t6 = Date.now();
    const frameworks = targets
      .map((t) => (typeof t === 'object' ? t.framework : null))
      .filter(Boolean);
    const packs = enhRegistry.resolve(primaryLang, frameworks);
    row.enhancementMs = Date.now() - t6;
    row.enhPacks = packs.map((p) => p.id).join(',') || '—';

    // Phase 5: DimensionCopy
    const t7 = Date.now();
    const dims = [
      { id: 'code-standard', label: '代码规范', guide: 'default' },
      { id: 'architecture', label: '架构模式', guide: 'default' },
    ];
    try {
      DimensionCopy.applyMulti(dims, profile.primary, profile.secondary);
    } catch {
      /* graceful */
    }
    row.dimCopyMs = Date.now() - t7;

    row.totalMs =
      row.detectMs +
      row.loadMs +
      row.fileCollectMs +
      row.langDetectMs +
      row.astMs +
      row.enhancementMs +
      row.dimCopyMs;

    results.push(row);
    process.stdout.write(
      `✓ ${name.padEnd(20)} ${row.files.toString().padStart(5)} files | ` +
      `detect=${row.detectMs}ms load=${row.loadMs}ms collect=${row.fileCollectMs}ms ` +
      `ast=${row.astMs}ms total=${row.totalMs}ms\n`
    );
  }

  // ── 汇总表 ──────────────────────────────────────────────────────
  process.stdout.write('\n' + '═'.repeat(120) + '\n');
  process.stdout.write(
    'Project'.padEnd(22) +
    'Files'.padStart(6) +
    'Disc'.padStart(10) +
    'Detect'.padStart(8) +
    'Load'.padStart(8) +
    'Collect'.padStart(9) +
    'Lang'.padStart(10) +
    'AST'.padStart(8) +
    'Cls'.padStart(5) +
    'Enh'.padStart(8) +
    'DimC'.padStart(6) +
    'Total'.padStart(8) +
    '  Packs\n'
  );
  process.stdout.write('─'.repeat(120) + '\n');

  for (const r of results) {
    process.stdout.write(
      r.project.padEnd(22) +
      r.files.toString().padStart(6) +
      r.discoverer.padStart(10) +
      `${r.detectMs}ms`.padStart(8) +
      `${r.loadMs}ms`.padStart(8) +
      `${r.fileCollectMs}ms`.padStart(9) +
      (r.primaryLang || '?').padStart(10) +
      `${r.astMs}ms`.padStart(8) +
      r.astClasses.toString().padStart(5) +
      `${r.enhancementMs}ms`.padStart(8) +
      `${r.dimCopyMs}ms`.padStart(6) +
      `${r.totalMs}ms`.padStart(8) +
      `  ${r.enhPacks}\n`
    );
  }
  process.stdout.write('═'.repeat(120) + '\n');

  // 性能阈值检查
  let warnings = 0;
  for (const r of results) {
    if (r.detectMs > 500) {
      console.warn(`⚠ ${r.project}: detect ${r.detectMs}ms > 500ms 阈值`);
      warnings++;
    }
    if (r.totalMs > 120000) {
      console.warn(`⚠ ${r.project}: total ${r.totalMs}ms > 120s 阈值`);
      warnings++;
    }
    if (r.astMs > 30000) {
      console.warn(`⚠ ${r.project}: AST ${r.astMs}ms > 30s 阈值`);
      warnings++;
    }
  }

  if (warnings === 0) {
    process.stdout.write('\n✅ 所有性能指标在阈值内\n');
  } else {
    console.warn(`\n⚠ ${warnings} 项超过阈值`);
  }

  // 写入 JSON
  const outPath = path.join(ROOT, 'test', 'fixtures', 'real-project-bench.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  process.stdout.write(`\n📄 结果写入 ${outPath}\n`);
}

benchmark().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
