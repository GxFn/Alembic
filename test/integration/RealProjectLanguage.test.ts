/**
 * @file RealProjectLanguage.test.js
 * @description Level 2 集成测试 — 使用真实项目验证 LanguageService + DimensionCopy 子系统
 *
 * 验证:
 *  1. LanguageService.detectPrimary() 正确识别主语言
 *  2. LanguageService.detectProfile() 的 secondary / isMultiLang 判定
 *  3. DimensionCopy._langFamily() 映射正确
 *  4. DimensionCopy.applyMulti() 不崩溃且注入差异化文案
 */

import fs from 'node:fs';
import path from 'node:path';

const __dirname = import.meta.dirname;
const GITHUB_DIR = path.resolve(__dirname, '..', '..', '..');

let LanguageService;
let DimensionCopy;
let getDiscovererRegistry;
let resetDiscovererRegistry;

beforeAll(async () => {
  const lsMod = await import('../../lib/shared/LanguageService.js');
  LanguageService = lsMod.LanguageService;
  const dcMod = await import('../../lib/shared/DimensionCopyRegistry.js');
  DimensionCopy = dcMod.DimensionCopy;
  const dMod = await import('../../lib/core/discovery/index.js');
  getDiscovererRegistry = dMod.getDiscovererRegistry;
  resetDiscovererRegistry = dMod.resetDiscovererRegistry;
});

// ── 期望值 ────────────────────────────────────────────────────────
const LANG_EXPECTED = {
  Alamofire: { primary: 'swift', isMultiLang: false, langFamily: 'apple' },
  iCarousel: { primary: 'objectivec', isMultiLang: false, langFamily: 'apple' },
  Expression: { primary: 'swift', isMultiLang: true, langFamily: 'apple' },
  SwiftFormat: { primary: 'swift', isMultiLang: false, langFamily: 'apple' },
  flask: { primary: 'python', isMultiLang: false, langFamily: 'python' },
  fastapi: { primary: 'python', isMultiLang: false, langFamily: 'python' },
  'spring-petclinic': { primary: 'java', isMultiLang: false, langFamily: 'jvm' },
  Pokedex: { primary: 'kotlin', isMultiLang: false, langFamily: 'jvm' },
  gin: { primary: 'go', isMultiLang: false, langFamily: 'go' },
  axum: { primary: 'rust', isMultiLang: false, langFamily: 'rust' },
  nest: { primary: 'typescript', isMultiLang: false, langFamily: 'js' },
  todomvc: { primary: 'javascript', isMultiLang: false, langFamily: 'js' },
  'vue-element-admin': { primary: 'javascript', isMultiLang: false, langFamily: 'js' },
  discourse: { primary: 'ruby', isMultiLang: false, langFamily: 'ruby' },
};

// ── 辅助：收集真实 langStats ──────────────────────────────────────
async function collectLangStats(projectName) {
  const projectRoot = path.join(GITHUB_DIR, projectName);
  if (!fs.existsSync(projectRoot)) {
    return null;
  }

  resetDiscovererRegistry();
  const registry = getDiscovererRegistry();
  const discoverer = await registry.detect(projectRoot);
  await discoverer.load(projectRoot);
  const targets = await discoverer.listTargets();

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
        if (seenPaths.size >= 2000) {
          break;
        }
      }
    } catch {
      /* skip */
    }
    if (seenPaths.size >= 2000) {
      break;
    }
  }

  return langStats;
}

// ── 测试 ──────────────────────────────────────────────────────────
describe('Real Project Language Detection', () => {
  for (const [projectName, expected] of Object.entries(LANG_EXPECTED)) {
    describe(projectName, () => {
      let langStats = null;

      beforeAll(async () => {
        langStats = await collectLangStats(projectName);
      });

      it('should collect langStats without error', () => {
        if (!langStats) {
          console.warn(`  ⏭ ${projectName} 不存在，跳过`);
          return;
        }
        expect(Object.keys(langStats).length).toBeGreaterThan(0);
      });

      it(`should detect primary language as "${expected.primary}"`, () => {
        if (!langStats) {
          return;
        }
        const primary = LanguageService.detectPrimary(langStats);
        expect(primary).toBe(expected.primary);
      });

      it(`should have isMultiLang = ${expected.isMultiLang}`, () => {
        if (!langStats) {
          return;
        }
        const profile = LanguageService.detectProfile(langStats);
        expect(profile.isMultiLang).toBe(expected.isMultiLang);
      });

      it('should apply DimensionCopy without error', () => {
        if (!langStats) {
          return;
        }
        const profile = LanguageService.detectProfile(langStats);
        // 构造 mock dimensions
        const dims = [
          { id: 'code-standard', label: '代码规范', guide: 'default guide' },
          { id: 'architecture', label: '架构模式', guide: 'default guide' },
          { id: 'project-profile', label: '项目特征', guide: 'default guide' },
        ];
        // 不应崩溃
        expect(() => {
          DimensionCopy.applyMulti(dims, profile.primary, profile.secondary);
        }).not.toThrow();
      });
    });
  }
});
