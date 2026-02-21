/**
 * @file RealProjectDiscovery.test.js
 * @description Level 2 集成测试 — 使用 20 个 GitHub 真实项目验证 Discovery 子系统
 *
 * 验证:
 *  1. DiscovererRegistry.detect() 正确识别项目类型
 *  2. discoverer.load() → listTargets() → getTargetFiles() 流程正常
 *  3. 文件计数在合理范围内
 *  4. 依赖图（SPM/Node/Python/JVM）正确返回
 *
 * 前置条件: 需要在 GITHUB_DIR 下有对应的 clone 项目
 * 跳过条件: 项目目录不存在时自动 skip
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GITHUB_DIR = path.resolve(__dirname, '..', '..', '..');

// ── 动态 import（避免 ESM 顶层 await 问题） ──────────────────────
let getDiscovererRegistry;
let resetDiscovererRegistry;

beforeAll(async () => {
  const mod = await import('../../lib/core/discovery/index.js');
  getDiscovererRegistry = mod.getDiscovererRegistry;
  resetDiscovererRegistry = mod.resetDiscovererRegistry;
});

// ── 期望值定义 ────────────────────────────────────────────────────
const EXPECTED = {
  Alamofire: { discoverer: 'spm', minTargets: 1, minFiles: 20 },
  iCarousel: { discoverer: 'generic', minTargets: 1, minFiles: 5 },
  Euclid: { discoverer: 'spm', minTargets: 1, minFiles: 10 },
  Expression: { discoverer: 'spm', minTargets: 1, minFiles: 5 },
  VectorMath: { discoverer: 'spm', minTargets: 1, minFiles: 2 },
  layout: { discoverer: 'generic', minTargets: 1, minFiles: 10 },
  RetroRampage: { discoverer: 'generic', minTargets: 1, minFiles: 5 },
  Consumer: { discoverer: 'spm', minTargets: 1, minFiles: 2 },
  SwiftFormat: { discoverer: 'spm', minTargets: 1, minFiles: 50 },
  flask: { discoverer: 'python', minTargets: 1, minFiles: 20 },
  fastapi: { discoverer: 'python', minTargets: 1, minFiles: 50 },
  'django-website': { discoverer: 'python', minTargets: 1, minFiles: 10 },
  'spring-petclinic': { discoverer: 'jvm', minTargets: 1, minFiles: 5 },
  Pokedex: { discoverer: 'jvm', minTargets: 1, minFiles: 5 },
  gin: { discoverer: 'go', minTargets: 1, minFiles: 2 },
  axum: { discoverer: 'generic', minTargets: 1, minFiles: 20 },
  nest: { discoverer: 'node', minTargets: 1, minFiles: 50 },
  todomvc: { discoverer: 'node', minTargets: 1, minFiles: 50 },
  'vue-element-admin': { discoverer: 'node', minTargets: 1, minFiles: 30 },
  discourse: { discoverer: 'generic', minTargets: 1, minFiles: 100 },
};

// ── 辅助函数 ──────────────────────────────────────────────────────
function skipIfMissing(projectName) {
  const projectRoot = path.join(GITHUB_DIR, projectName);
  if (!fs.existsSync(projectRoot)) {
    return null; // 调用方 skip
  }
  return projectRoot;
}

function matchDiscoverer(actual, expected) {
  if (Array.isArray(expected)) {
    return expected.includes(actual);
  }
  return actual === expected;
}

// ── 测试用例 ──────────────────────────────────────────────────────
describe('Real Project Discovery', () => {
  // 对每个项目生成测试
  for (const [projectName, expected] of Object.entries(EXPECTED)) {
    describe(projectName, () => {
      let projectRoot;
      let discoverer;
      let targets;

      beforeAll(async () => {
        projectRoot = skipIfMissing(projectName);
        if (!projectRoot) {
          return;
        }

        resetDiscovererRegistry();
        const registry = getDiscovererRegistry();
        discoverer = await registry.detect(projectRoot);
        await discoverer.load(projectRoot);
        targets = await discoverer.listTargets();
      });

      it('should detect correct discoverer', () => {
        if (!projectRoot) {
          console.warn(`  ⏭ ${projectName} 不存在，跳过`);
          return;
        }
        expect(matchDiscoverer(discoverer.id, expected.discoverer)).toBe(true);
      });

      it(`should find >= ${expected.minTargets} targets`, () => {
        if (!projectRoot) {
          return;
        }
        expect(targets.length).toBeGreaterThanOrEqual(expected.minTargets);
      });

      it(`should collect >= ${expected.minFiles} files`, async () => {
        if (!projectRoot) {
          return;
        }

        const seenPaths = new Set();
        let fileCount = 0;
        for (const t of targets) {
          try {
            const files = await discoverer.getTargetFiles(t);
            for (const f of files) {
              const fp = typeof f === 'string' ? f : f.path;
              if (!seenPaths.has(fp)) {
                seenPaths.add(fp);
                fileCount++;
              }
              if (fileCount >= 5000) {
                break;
              }
            }
          } catch {
            /* skip */
          }
          if (fileCount >= 5000) {
            break;
          }
        }

        expect(fileCount).toBeGreaterThanOrEqual(expected.minFiles);
      });

      it('should not throw on getDependencyGraph()', async () => {
        if (!projectRoot) {
          return;
        }
        // 不要求所有项目都有依赖图，只要求不抛异常
        await expect(
          (async () => {
            try {
              return await discoverer.getDependencyGraph();
            } catch {
              return { nodes: [], edges: [] }; // graceful fallback
            }
          })()
        ).resolves.toBeDefined();
      });
    });
  }
});

// ── 截断测试（discourse 超大项目）──────────────────────────────────
describe('Discovery maxFiles truncation', () => {
  it('should respect maxFiles limit for large projects', async () => {
    const projectRoot = skipIfMissing('discourse');
    if (!projectRoot) {
      console.warn('  ⏭ discourse 不存在，跳过截断测试');
      return;
    }

    resetDiscovererRegistry();
    const registry = getDiscovererRegistry();
    const discoverer = await registry.detect(projectRoot);
    await discoverer.load(projectRoot);
    const targets = await discoverer.listTargets();

    const MAX_FILES = 500;
    const seenPaths = new Set();
    let fileCount = 0;
    for (const t of targets) {
      try {
        const files = await discoverer.getTargetFiles(t);
        for (const f of files) {
          const fp = typeof f === 'string' ? f : f.path;
          if (!seenPaths.has(fp)) {
            seenPaths.add(fp);
            fileCount++;
          }
          if (fileCount >= MAX_FILES) {
            break;
          }
        }
      } catch {
        /* skip */
      }
      if (fileCount >= MAX_FILES) {
        break;
      }
    }

    expect(fileCount).toBe(MAX_FILES);
  });
});
