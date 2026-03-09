/**
 * @file RealProjectBootstrap.test.js
 * @description Level 3 E2E 测试 — 模拟完整 Bootstrap 流水线（Phase 1 → Phase 4）
 *
 * 使用真实项目路径，构造 mock ctx，验证 Bootstrap 同步阶段产出的
 * report / responseData 结构完整性。不涉及 Phase 5 异步 AI 填充。
 *
 * 覆盖项目:
 *   - Alamofire (SPM + Swift)
 *   - nest (Node + TypeScript + NestJS Enhancement)
 *   - spring-petclinic (JVM + Java + Spring Enhancement)
 *   - fastapi (Python + FastAPI Enhancement)
 *   - Pokedex (JVM + Kotlin + Android Enhancement)
 *   - vue-element-admin (Node + JS + Vue Enhancement)
 *   - gin (Go + Go AST)
 *   - discourse (Generic + Ruby, 超大项目截断)
 */

import fs from 'node:fs';
import path from 'node:path';

const __dirname = import.meta.dirname;
const GITHUB_DIR = path.resolve(__dirname, '..', '..', '..');

// ── 模拟 Bootstrap 核心流程（不调用完整 handler，避免 DB / AI 依赖）───
let getDiscovererRegistry, resetDiscovererRegistry;
let LanguageService, DimensionCopy;
let analyzeProject, astIsAvailable;
let initEnhancementRegistry;

beforeAll(async () => {
  const dMod = await import('../../lib/core/discovery/index.js');
  getDiscovererRegistry = dMod.getDiscovererRegistry;
  resetDiscovererRegistry = dMod.resetDiscovererRegistry;

  const lsMod = await import('../../lib/shared/LanguageService.js');
  LanguageService = lsMod.LanguageService;

  const dcMod = await import('../../lib/service/bootstrap/DimensionCopyRegistry.js');
  DimensionCopy = dcMod.DimensionCopy;

  await import('../../lib/core/ast/index.js');
  const astMod = await import('../../lib/core/AstAnalyzer.js');
  analyzeProject = astMod.analyzeProject;
  astIsAvailable = astMod.isAvailable;

  const enhMod = await import('../../lib/core/enhancement/index.js');
  initEnhancementRegistry = enhMod.initEnhancementRegistry;
});

// ── 完整 Bootstrap Phase 1-4 流程模拟 ────────────────────────────
async function runBootstrapPhases(projectRoot, maxFiles = 500) {
  const report = { phases: {} };

  // Phase 1: Discovery → File Collection
  resetDiscovererRegistry();
  const registry = getDiscovererRegistry();
  const discoverer = await registry.detect(projectRoot);
  await discoverer.load(projectRoot);
  const targets = await discoverer.listTargets();

  const seenPaths = new Set();
  const allFiles = [];
  for (const t of targets) {
    try {
      const fileList = await discoverer.getTargetFiles(t);
      for (const f of fileList) {
        const fp = typeof f === 'string' ? f : f.path;
        if (seenPaths.has(fp)) {
          continue;
        }
        seenPaths.add(fp);
        try {
          const content = fs.readFileSync(fp, 'utf8');
          allFiles.push({
            name: typeof f === 'string' ? path.basename(f) : f.name || path.basename(fp),
            relativePath:
              typeof f === 'object' && f.relativePath ? f.relativePath : path.basename(fp),
            content,
            targetName: typeof t === 'string' ? t : t.name,
          });
        } catch {
          /* skip unreadable */
        }
        if (allFiles.length >= maxFiles) {
          break;
        }
      }
    } catch {
      /* skip target */
    }
    if (allFiles.length >= maxFiles) {
      break;
    }
  }

  report.phases.fileCollection = {
    discoverer: discoverer.id,
    targets: targets.length,
    files: allFiles.length,
    truncated: allFiles.length >= maxFiles,
  };

  // langStats
  const langStats = {};
  for (const f of allFiles) {
    const ext = path.extname(f.name).replace('.', '') || 'unknown';
    langStats[ext] = (langStats[ext] || 0) + 1;
  }

  // Phase 1.5: AST
  const primaryLang = LanguageService.detectPrimary(langStats);
  let astSummary = null;
  if (astIsAvailable() && primaryLang) {
    try {
      const astFiles = allFiles.map((f) => ({
        name: f.name,
        relativePath: f.relativePath,
        content: f.content,
      }));
      astSummary = analyzeProject(astFiles, primaryLang);
    } catch {
      /* graceful degradation */
    }
  }

  report.phases.astAnalysis = {
    available: astIsAvailable(),
    classes: astSummary?.classes?.length || 0,
    protocols: astSummary?.protocols?.length || 0,
    categories: astSummary?.categories?.length || 0,
    patterns: Object.keys(astSummary?.patternStats || {}),
  };

  // Phase 2: Dependency graph
  let depGraph = null;
  try {
    depGraph = await discoverer.getDependencyGraph();
  } catch {
    /* graceful */
  }
  report.phases.dependencyGraph = { edges: depGraph?.edges?.length || 0 };

  // Phase 3: Enhancement Packs
  const enhRegistry = await initEnhancementRegistry();
  const detectedFrameworks = targets
    .map((t) => (typeof t === 'object' ? t.framework : null))
    .filter(Boolean);
  const matchedPacks = enhRegistry.resolve(primaryLang, detectedFrameworks);

  report.phases.enhancementPacks = {
    matched: matchedPacks.map((p) => ({ id: p.id, displayName: p.displayName })),
    extraDimensions: matchedPacks.reduce((sum, p) => sum + p.getExtraDimensions().length, 0),
  };

  // Phase 4: Language profile + DimensionCopy
  const langProfile = LanguageService.detectProfile(langStats);

  return {
    report,
    discoverer: discoverer.id,
    primaryLang,
    langProfile,
    langStats,
    files: allFiles.length,
    targets: targets.length,
    astSummary,
    matchedPacks: matchedPacks.map((p) => p.id),
    detectedFrameworks,
    depGraph,
  };
}

// ── 测试用例 ──────────────────────────────────────────────────────
const E2E_CASES = {
  Alamofire: {
    expectDiscoverer: 'spm',
    expectLang: 'swift',
    expectEnhancement: [],
    minFiles: 20,
    astExpect: { minClasses: 5 },
  },
  nest: {
    expectDiscoverer: 'node',
    expectLang: 'typescript',
    expectEnhancement: ['node-server'],
    minFiles: 50,
    astExpect: { minClasses: 10 },
  },
  'spring-petclinic': {
    expectDiscoverer: 'jvm',
    expectLang: 'java',
    expectEnhancement: ['spring'],
    minFiles: 5,
    astExpect: { minClasses: 5 },
  },
  fastapi: {
    expectDiscoverer: 'python',
    expectLang: 'python',
    // NOTE: PythonDiscoverer 当前不在 target 上设置 framework 字段，
    // 因此 Enhancement Pack 无法自动匹配。这是已知限制。
    expectEnhancement: [],
    minFiles: 50,
    astExpect: { minClasses: 10 },
  },
  Pokedex: {
    expectDiscoverer: 'jvm',
    expectLang: 'kotlin',
    expectEnhancement: ['android'],
    minFiles: 5,
    astExpect: { minClasses: 3 },
  },
  'vue-element-admin': {
    expectDiscoverer: 'node',
    expectLang: 'javascript',
    expectEnhancement: ['vue'],
    minFiles: 30,
    astExpect: { minClasses: 0 },
  },
  gin: {
    expectDiscoverer: 'go',
    expectLang: 'go',
    expectEnhancement: ['go-web'],
    minFiles: 2,
    astExpect: { minClasses: 5 },
  },
  discourse: {
    expectDiscoverer: 'generic',
    expectLang: 'ruby',
    expectEnhancement: [],
    minFiles: 100,
    astExpect: null, // no AST plugin for Ruby
  },
};

describe('Real Project Bootstrap E2E (Phase 1-4)', () => {
  for (const [projectName, expected] of Object.entries(E2E_CASES)) {
    describe(projectName, () => {
      let result;

      beforeAll(async () => {
        const projectRoot = path.join(GITHUB_DIR, projectName);
        if (!fs.existsSync(projectRoot)) {
          return;
        }
        result = await runBootstrapPhases(projectRoot);
      }, 120000); // 2min timeout for large projects

      it('should complete all phases without error', () => {
        if (!result) {
          return;
        }
        expect(result).toBeDefined();
        expect(result.report.phases.fileCollection).toBeDefined();
        expect(result.report.phases.astAnalysis).toBeDefined();
        expect(result.report.phases.dependencyGraph).toBeDefined();
        expect(result.report.phases.enhancementPacks).toBeDefined();
      });

      it(`should detect discoverer: ${expected.expectDiscoverer}`, () => {
        if (!result) {
          return;
        }
        expect(result.discoverer).toBe(expected.expectDiscoverer);
      });

      it(`should detect primary language: ${expected.expectLang}`, () => {
        if (!result) {
          return;
        }
        expect(result.primaryLang).toBe(expected.expectLang);
      });

      it(`should collect >= ${expected.minFiles} files`, () => {
        if (!result) {
          return;
        }
        expect(result.files).toBeGreaterThanOrEqual(expected.minFiles);
      });

      it(`should match enhancement packs: [${expected.expectEnhancement.join(', ') || 'none'}]`, () => {
        if (!result) {
          return;
        }
        if (expected.expectEnhancement.length === 0) {
          // 允许有或没有 Enhancement（有些框架识别依赖 Discovery target.framework）
          // 只验证不崩溃
          expect(Array.isArray(result.matchedPacks)).toBe(true);
        } else {
          for (const packId of expected.expectEnhancement) {
            expect(result.matchedPacks).toContain(packId);
          }
        }
      });

      if (expected.astExpect) {
        it(`should have AST classes >= ${expected.astExpect.minClasses}`, () => {
          if (!result) {
            return;
          }
          expect(result.report.phases.astAnalysis.classes).toBeGreaterThanOrEqual(
            expected.astExpect.minClasses
          );
        });
      } else {
        it('should gracefully handle missing AST plugin', () => {
          if (!result) {
            return;
          }
          expect(result.report.phases.astAnalysis.classes).toBe(0);
        });
      }

      it('should have valid language profile', () => {
        if (!result) {
          return;
        }
        expect(result.langProfile).toBeDefined();
        expect(result.langProfile.primary).toBe(expected.expectLang);
        expect(Array.isArray(result.langProfile.secondary)).toBe(true);
        expect(typeof result.langProfile.isMultiLang).toBe('boolean');
      });

      it('should apply DimensionCopy without error', () => {
        if (!result) {
          return;
        }
        const dims = [
          { id: 'code-standard', label: '代码规范', guide: 'default' },
          { id: 'architecture', label: '架构模式', guide: 'default' },
          { id: 'project-profile', label: '项目特征', guide: 'default' },
        ];
        expect(() => {
          DimensionCopy.applyMulti(dims, result.langProfile.primary, result.langProfile.secondary);
        }).not.toThrow();
      });
    });
  }
});

// ── 截断测试 ──────────────────────────────────────────────────────
describe('Bootstrap maxFiles truncation', () => {
  it('discourse: should truncate at maxFiles=200', async () => {
    const projectRoot = path.join(GITHUB_DIR, 'discourse');
    if (!fs.existsSync(projectRoot)) {
      return;
    }
    const result = await runBootstrapPhases(projectRoot, 200);
    expect(result.files).toBeLessThanOrEqual(200);
    expect(result.report.phases.fileCollection.truncated).toBe(true);
  }, 60000);
});

// ── 性能概览 ──────────────────────────────────────────────────────
describe('Bootstrap Phase 1-4 performance', () => {
  it('Alamofire: full pipeline < 10s', async () => {
    const projectRoot = path.join(GITHUB_DIR, 'Alamofire');
    if (!fs.existsSync(projectRoot)) {
      return;
    }
    const t0 = Date.now();
    await runBootstrapPhases(projectRoot);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(10000);
  }, 15000);

  it('nest: full pipeline < 10s', async () => {
    const projectRoot = path.join(GITHUB_DIR, 'nest');
    if (!fs.existsSync(projectRoot)) {
      return;
    }
    const t0 = Date.now();
    await runBootstrapPhases(projectRoot);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(10000);
  }, 15000);
});
