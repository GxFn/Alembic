/**
 * @file RealProjectAst.test.js
 * @description Level 2 集成测试 — 使用真实项目验证 AST 分析子系统
 *
 * 验证:
 *  1. analyzeFile() 对真实代码文件不抛异常
 *  2. analyzeProject() 聚合结果的 classes / protocols / methods 数量合理
 *  3. 无 AST 插件的语言（Go/Rust/Ruby）优雅降级
 *  4. 性能：大型项目在合理时间内完成
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GITHUB_DIR = path.resolve(__dirname, '..', '..', '..');

let analyzeFile, analyzeProject, _astIsAvailable;
let getDiscovererRegistry, resetDiscovererRegistry;
let _LanguageService;

beforeAll(async () => {
  // 加载 AST 插件
  await import('../../lib/core/ast/index.js');
  const astMod = await import('../../lib/core/AstAnalyzer.js');
  analyzeFile = astMod.analyzeFile;
  analyzeProject = astMod.analyzeProject;
  _astIsAvailable = astMod.isAvailable;

  const dMod = await import('../../lib/core/discovery/index.js');
  getDiscovererRegistry = dMod.getDiscovererRegistry;
  resetDiscovererRegistry = dMod.resetDiscovererRegistry;

  const lsMod = await import('../../lib/shared/LanguageService.js');
  _LanguageService = lsMod.LanguageService;
});

// ── 期望值 ────────────────────────────────────────────────────────
const AST_PROJECTS = {
  Alamofire: { lang: 'swift', minClasses: 5, minFiles: 5 },
  iCarousel: { lang: 'objectivec', minClasses: 1, minFiles: 2 },
  flask: { lang: 'python', minClasses: 2, minFiles: 5 },
  nest: { lang: 'typescript', minClasses: 10, minFiles: 20 },
  'spring-petclinic': { lang: 'java', minClasses: 5, minFiles: 3 },
  Pokedex: { lang: 'kotlin', minClasses: 3, minFiles: 3 },
  todomvc: { lang: 'javascript', minClasses: 0, minFiles: 5 },
  gin: { lang: 'go', minClasses: 5, minFiles: 5 },
};

// 无 AST 插件的项目 — 优雅降级测试
const NO_AST_PROJECTS = ['axum', 'discourse'];

// ── 辅助 ──────────────────────────────────────────────────────────
async function collectFiles(projectName, maxFiles = 500) {
  const projectRoot = path.join(GITHUB_DIR, projectName);
  if (!fs.existsSync(projectRoot)) {
    return null;
  }

  resetDiscovererRegistry();
  const registry = getDiscovererRegistry();
  const discoverer = await registry.detect(projectRoot);
  await discoverer.load(projectRoot);
  const targets = await discoverer.listTargets();

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
        try {
          const content = fs.readFileSync(fp, 'utf8');
          files.push({
            name: typeof f === 'string' ? path.basename(f) : f.name || path.basename(fp),
            relativePath:
              typeof f === 'object' && f.relativePath ? f.relativePath : path.basename(fp),
            content,
          });
        } catch {
          /* skip unreadable */
        }
        if (files.length >= maxFiles) {
          break;
        }
      }
    } catch {
      /* skip target */
    }
    if (files.length >= maxFiles) {
      break;
    }
  }

  return files;
}

// ── 有 AST 插件的项目 ────────────────────────────────────────────
describe('Real Project AST Analysis', () => {
  for (const [projectName, expected] of Object.entries(AST_PROJECTS)) {
    describe(projectName, () => {
      let files = null;
      let summary = null;

      beforeAll(async () => {
        files = await collectFiles(projectName);
        if (!files || files.length === 0) {
          return;
        }

        const t0 = Date.now();
        summary = analyzeProject(files, expected.lang);
        const _elapsed = Date.now() - t0;
      }, 60000); // 60s timeout for large projects

      it('should have collectible files', () => {
        if (!files) {
          console.warn(`  ⏭ ${projectName} 不存在，跳过`);
          return;
        }
        expect(files.length).toBeGreaterThan(0);
      });

      it('should produce AST summary', () => {
        if (!files) {
          return;
        }
        expect(summary).toBeDefined();
        expect(summary).not.toBeNull();
      });

      it(`should find >= ${expected.minClasses} classes`, () => {
        if (!files || !summary) {
          return;
        }
        expect(summary.classes.length).toBeGreaterThanOrEqual(expected.minClasses);
      });

      it(`should analyze >= ${expected.minFiles} files`, () => {
        if (!files || !summary) {
          return;
        }
        expect(summary.fileCount).toBeGreaterThanOrEqual(expected.minFiles);
      });

      it('should have valid patternStats', () => {
        if (!files || !summary) {
          return;
        }
        expect(summary.patternStats).toBeDefined();
        expect(typeof summary.patternStats).toBe('object');
      });
    });
  }
});

// ── 无 AST 插件的项目（优雅降级）──────────────────────────────────
describe('AST Graceful Degradation (no plugin)', () => {
  for (const projectName of NO_AST_PROJECTS) {
    it(`${projectName}: analyzeFile() should return null without throwing`, async () => {
      const projectRoot = path.join(GITHUB_DIR, projectName);
      if (!fs.existsSync(projectRoot)) {
        console.warn(`  ⏭ ${projectName} 不存在，跳过`);
        return;
      }

      // 找到第一个源文件读取内容
      const langMap = { axum: 'rust', discourse: 'ruby' };
      const extMap = { axum: '.rs', discourse: '.rb' };

      // 递归查找第一个匹配文件
      function findFirst(dir, ext, depth = 0) {
        if (depth > 5) {
          return null;
        }
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.name.startsWith('.')) {
              continue;
            }
            const fp = path.join(dir, e.name);
            if (e.isFile() && e.name.endsWith(ext)) {
              return fp;
            }
            if (e.isDirectory() && !['node_modules', '.git', 'vendor'].includes(e.name)) {
              const found = findFirst(fp, ext, depth + 1);
              if (found) {
                return found;
              }
            }
          }
        } catch {
          /* permission error */
        }
        return null;
      }

      const fp = findFirst(projectRoot, extMap[projectName]);
      if (!fp) {
        console.warn(`  ⏭ ${projectName}: 未找到 ${extMap[projectName]} 文件`);
        return;
      }

      const content = fs.readFileSync(fp, 'utf8');
      const result = analyzeFile(content, langMap[projectName]);
      expect(result).toBeNull(); // 无插件 → null
    });
  }
});

// ── 性能基准 ──────────────────────────────────────────────────────
describe('AST Performance', () => {
  it('SwiftFormat (500+ files) should analyze in < 30s', async () => {
    const files = await collectFiles('SwiftFormat');
    if (!files || files.length < 50) {
      console.warn('  ⏭ SwiftFormat 不存在或文件过少，跳过性能测试');
      return;
    }

    const t0 = Date.now();
    const summary = analyzeProject(files, 'swift');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(30000);
    expect(summary).toBeDefined();
  }, 60000);
});
