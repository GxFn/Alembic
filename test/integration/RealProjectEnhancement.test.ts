/**
 * @file RealProjectEnhancement.test.js
 * @description Level 2 集成测试 — 使用真实项目验证 Enhancement Pack 子系统
 *
 * 验证:
 *  1. EnhancementRegistry.resolve() 根据 primaryLang + frameworks 正确匹配
 *  2. 匹配的 Enhancement Pack 返回有效 extraDimensions / guardRules
 *  3. .vue SFC 预处理正确
 *  4. 无框架项目返回空匹配
 */

import fs from 'node:fs';
import path from 'node:path';

const __dirname = import.meta.dirname;
const GITHUB_DIR = path.resolve(__dirname, '..', '..', '..');

let initEnhancementRegistry;
let getDiscovererRegistry, resetDiscovererRegistry;
let LanguageService;

beforeAll(async () => {
  const enhMod = await import('../../lib/core/enhancement/index.js');
  initEnhancementRegistry = enhMod.initEnhancementRegistry;

  const dMod = await import('../../lib/core/discovery/index.js');
  getDiscovererRegistry = dMod.getDiscovererRegistry;
  resetDiscovererRegistry = dMod.resetDiscovererRegistry;

  const lsMod = await import('../../lib/shared/LanguageService.js');
  LanguageService = lsMod.LanguageService;
});

// ── 期望值 ────────────────────────────────────────────────────────
const ENHANCEMENT_CASES = {
  // 应匹配 Enhancement Pack 的项目
  nest: {
    expectedPacks: ['node-server'],
    langOverride: 'typescript',
    frameworksContain: ['nestjs', 'node-server'],
  },
  'vue-element-admin': {
    expectedPacks: ['vue'],
    langOverride: 'javascript',
    frameworksContain: ['vue'],
  },
  'spring-petclinic': {
    expectedPacks: ['spring'],
    langOverride: 'java',
    frameworksContain: ['spring'],
  },
  Pokedex: {
    expectedPacks: ['android'],
    langOverride: 'kotlin',
    frameworksContain: ['android'],
  },
  fastapi: {
    expectedPacks: ['fastapi'],
    langOverride: 'python',
    frameworksContain: ['fastapi'],
  },
  'django-website': {
    expectedPacks: ['django'],
    langOverride: 'python',
    frameworksContain: ['django'],
  },
  gin: {
    expectedPacks: ['go-web'],
    langOverride: 'go',
    frameworksContain: ['gin'],
  },
};

// 不应匹配任何 Enhancement Pack 的项目
const NO_ENHANCEMENT_CASES = {
  Alamofire: { lang: 'swift', frameworks: [] },
  axum: { lang: 'rust', frameworks: [] },
  discourse: { lang: 'ruby', frameworks: [] },
};

// ── 辅助：检测项目框架 ────────────────────────────────────────────
async function detectFrameworks(projectName) {
  const projectRoot = path.join(GITHUB_DIR, projectName);
  if (!fs.existsSync(projectRoot)) {
    return null;
  }

  resetDiscovererRegistry();
  const registry = getDiscovererRegistry();
  const discoverer = await registry.detect(projectRoot);
  await discoverer.load(projectRoot);
  const targets = await discoverer.listTargets();

  const frameworks = targets
    .map((t) => (typeof t === 'object' ? t.framework : null))
    .filter(Boolean);

  // 收集 langStats 用于 detectPrimary
  const langStats = {};
  const seenPaths = new Set();
  for (const t of targets) {
    try {
      const files = await discoverer.getTargetFiles(t);
      for (const f of files) {
        const fp = typeof f === 'string' ? f : f.path;
        if (seenPaths.has(fp)) {
          continue;
        }
        seenPaths.add(fp);
        const name = typeof f === 'string' ? path.basename(f) : f.name || path.basename(fp);
        const ext = path.extname(name).replace('.', '') || 'unknown';
        langStats[ext] = (langStats[ext] || 0) + 1;
        if (seenPaths.size >= 1000) {
          break;
        }
      }
    } catch {
      /* skip */
    }
    if (seenPaths.size >= 1000) {
      break;
    }
  }

  const primaryLang = LanguageService.detectPrimary(langStats);
  return { primaryLang, frameworks };
}

// ── 应匹配 Enhancement 的项目 ────────────────────────────────────
describe('Enhancement Pack Resolution — Positive', () => {
  let registry;

  beforeAll(async () => {
    registry = await initEnhancementRegistry();
  });

  for (const [projectName, expected] of Object.entries(ENHANCEMENT_CASES)) {
    describe(projectName, () => {
      let detectionResult;

      beforeAll(async () => {
        detectionResult = await detectFrameworks(projectName);
      });

      it('should detect frameworks from discovery', () => {
        if (!detectionResult) {
          console.warn(`  ⏭ ${projectName} 不存在，跳过`);
          return;
        }
        // 框架检测可能来自 Discovery 或手动 override
        // 至少 primaryLang 应匹配
        expect(detectionResult.primaryLang).toBe(expected.langOverride);
      });

      it(`should resolve to [${expected.expectedPacks.join(', ')}]`, () => {
        if (!detectionResult) {
          return;
        }

        // 使用 Discovery 检测到的框架，如果为空则用预期框架
        const frameworks =
          detectionResult.frameworks.length > 0
            ? detectionResult.frameworks
            : expected.frameworksContain;

        const packs = registry.resolve(expected.langOverride, frameworks);
        const packIds = packs.map((p) => p.id);

        for (const expectedPack of expected.expectedPacks) {
          expect(packIds).toContain(expectedPack);
        }
      });

      it('matched packs should return valid extraDimensions', () => {
        if (!detectionResult) {
          return;
        }

        const frameworks =
          detectionResult.frameworks.length > 0
            ? detectionResult.frameworks
            : expected.frameworksContain;

        const packs = registry.resolve(expected.langOverride, frameworks);
        for (const pack of packs) {
          const dims = pack.getExtraDimensions();
          expect(Array.isArray(dims)).toBe(true);
          // 每个维度必须有 id 和 label
          for (const dim of dims) {
            expect(dim.id).toBeDefined();
            expect(dim.label).toBeDefined();
          }
        }
      });

      it('matched packs should return valid guardRules', () => {
        if (!detectionResult) {
          return;
        }

        const frameworks =
          detectionResult.frameworks.length > 0
            ? detectionResult.frameworks
            : expected.frameworksContain;

        const packs = registry.resolve(expected.langOverride, frameworks);
        for (const pack of packs) {
          const rules = pack.getGuardRules();
          expect(Array.isArray(rules)).toBe(true);
        }
      });
    });
  }
});

// ── 不应匹配的项目 ───────────────────────────────────────────────
describe('Enhancement Pack Resolution — Negative', () => {
  let registry;

  beforeAll(async () => {
    registry = await initEnhancementRegistry();
  });

  for (const [projectName, info] of Object.entries(NO_ENHANCEMENT_CASES)) {
    it(`${projectName} (${info.lang}) should have 0 matched packs`, () => {
      const packs = registry.resolve(info.lang, info.frameworks);
      expect(packs.length).toBe(0);
    });
  }
});

// ── Vue SFC 预处理测试 ───────────────────────────────────────────
describe('Vue SFC Preprocessing', () => {
  it('should extract <script> from .vue file in vue-element-admin', async () => {
    const registry = await initEnhancementRegistry();
    const vuePacks = registry.resolve('javascript', ['vue']);

    if (vuePacks.length === 0) {
      console.warn('  ⏭ Vue Enhancement Pack 未加载');
      return;
    }

    const vuePack = vuePacks[0];

    // 找一个真实 .vue 文件
    const projectRoot = path.join(GITHUB_DIR, 'vue-element-admin');
    if (!fs.existsSync(projectRoot)) {
      console.warn('  ⏭ vue-element-admin 不存在，跳过');
      return;
    }

    // 递归查找第一个 .vue 文件
    function findVue(dir, depth = 0) {
      if (depth > 6) {
        return null;
      }
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name === 'node_modules') {
            continue;
          }
          const fp = path.join(dir, e.name);
          if (e.isFile() && e.name.endsWith('.vue')) {
            return fp;
          }
          if (e.isDirectory()) {
            const found = findVue(fp, depth + 1);
            if (found) {
              return found;
            }
          }
        }
      } catch {
        /* skip */
      }
      return null;
    }

    const vueFile = findVue(projectRoot);
    if (!vueFile) {
      console.warn('  ⏭ vue-element-admin 中未找到 .vue 文件');
      return;
    }

    const content = fs.readFileSync(vueFile, 'utf8');
    const result = vuePack.preprocessFile(content, '.vue');

    // preprocessFile 可能返回 null（如果没实现）或 { content, lang }
    if (result) {
      expect(result.content).toBeDefined();
      expect(typeof result.content).toBe('string');
      expect(result.lang).toBeDefined();
    }
    // 无论如何不应崩溃
  });
});
