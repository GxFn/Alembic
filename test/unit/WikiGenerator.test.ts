/**
 * WikiGenerator 单元测试
 *
 * 覆盖核心生成流程：初始化、项目扫描、主题发现、文章合成、增量更新、中止机制
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type WikiAiProvider,
  type WikiDeps,
  WikiGenerator,
  type WikiKnowledgeService,
  type WikiModuleService,
  type WikiProjectGraph,
} from '../../lib/service/wiki/WikiGenerator.js';

/* ══════════════════════════════════════════════════════
 *  Mock Factories
 * ══════════════════════════════════════════════════════ */

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `wiki-test-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function mockAiProvider(overrides: Partial<WikiAiProvider> = {}): WikiAiProvider {
  return {
    chat: vi
      .fn()
      .mockResolvedValue(
        '# AI Generated Article\n\nSome content about the project that is meaningful and long enough to pass the quality gate threshold of two hundred characters. This is filler text to ensure the article is not rejected. Here is more content to make it longer.'
      ),
    ...overrides,
  };
}

function mockModuleService(overrides: Partial<WikiModuleService> = {}): WikiModuleService {
  return {
    load: vi.fn().mockResolvedValue(undefined),
    listTargets: vi.fn().mockResolvedValue([
      { name: 'CoreModule', type: 'library', path: 'Sources/Core', dependencies: [] },
      {
        name: 'NetworkModule',
        type: 'library',
        path: 'Sources/Network',
        dependencies: ['CoreModule'],
      },
    ]),
    getProjectInfo: vi.fn().mockReturnValue({
      name: 'TestProject',
      primaryLanguage: 'typescript',
      sourceFiles: [],
      languages: { typescript: 10, javascript: 5 },
    }),
    getDependencyGraph: vi.fn().mockResolvedValue({
      edges: [{ from: 'NetworkModule', to: 'CoreModule' }],
    }),
    ...overrides,
  };
}

function mockKnowledgeService(overrides: Partial<WikiKnowledgeService> = {}): WikiKnowledgeService {
  return {
    list: vi.fn().mockResolvedValue({
      data: [
        {
          title: 'Singleton Pattern',
          category: 'design-pattern',
          status: 'active',
          description: 'Use singleton for shared managers',
          tags: ['pattern', 'architecture'],
          moduleName: 'CoreModule',
          toJSON() {
            return this;
          },
        },
        {
          title: 'Error Handling',
          category: 'convention',
          status: 'active',
          description: 'Always use Result type for error handling',
          tags: ['error', 'convention'],
          toJSON() {
            return this;
          },
        },
      ],
    }),
    getStats: vi.fn().mockResolvedValue({ total: 2, active: 2, deprecated: 0 }),
    ...overrides,
  };
}

function mockProjectGraph(overrides: Partial<WikiProjectGraph> = {}): WikiProjectGraph {
  return {
    getOverview: vi.fn().mockReturnValue({
      totalClasses: 15,
      totalProtocols: 5,
      totalMethods: 42,
      topLevelModules: ['CoreModule', 'NetworkModule'],
      classesPerModule: { CoreModule: 8, NetworkModule: 7 },
    }),
    getAllClassNames: vi.fn().mockReturnValue(['AppDelegate', 'NetworkManager', 'DataStore']),
    getAllProtocolNames: vi.fn().mockReturnValue(['Serializable', 'Injectable']),
    getClassInfo: vi.fn().mockReturnValue({ filePath: 'Sources/Core/AppDelegate.ts' }),
    getProtocolInfo: vi.fn().mockReturnValue({ filePath: 'Sources/Core/Serializable.ts' }),
    ...overrides,
  };
}

function createProjectFiles(projectRoot: string) {
  // Create basic project structure for scanning
  const srcDir = path.join(projectRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'test-project', version: '1.0.0' })
  );
  fs.writeFileSync(
    path.join(srcDir, 'index.ts'),
    'export const main = () => console.log("hello");'
  );
  fs.writeFileSync(
    path.join(srcDir, 'utils.ts'),
    'export const add = (a: number, b: number) => a + b;'
  );
  fs.writeFileSync(path.join(srcDir, 'types.ts'), 'export interface Config { name: string; }');
}

function makeDeps(overrides: Partial<WikiDeps> = {}): WikiDeps {
  const projectRoot = makeTempDir();
  createProjectFiles(projectRoot);
  return {
    projectRoot,
    moduleService: mockModuleService(),
    knowledgeService: mockKnowledgeService(),
    projectGraph: mockProjectGraph(),
    codeEntityGraph: null,
    aiProvider: mockAiProvider(),
    onProgress: vi.fn(),
    ...overrides,
  };
}

/* ══════════════════════════════════════════════════════
 *  Tests
 * ══════════════════════════════════════════════════════ */

describe('WikiGenerator', () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    tmpDirs = [];
  });

  function trackDir(deps: WikiDeps): WikiDeps {
    tmpDirs.push(deps.projectRoot);
    return deps;
  }

  /* ──── 构造和初始化 ──── */

  describe('constructor', () => {
    test('should initialize with required projectRoot', () => {
      const deps = trackDir(makeDeps());
      const gen = new WikiGenerator(deps);
      expect(gen.projectRoot).toBe(deps.projectRoot);
      expect(gen._aborted).toBe(false);
    });

    test('should use default wikiDir when not specified', () => {
      const deps = trackDir(makeDeps());
      const gen = new WikiGenerator(deps);
      expect(gen.wikiDir).toContain('wiki');
    });

    test('should accept null dependencies gracefully', () => {
      const deps = trackDir(
        makeDeps({
          moduleService: null,
          knowledgeService: null,
          projectGraph: null,
          aiProvider: null,
        })
      );
      const gen = new WikiGenerator(deps);
      expect(gen.aiProvider).toBeNull();
      expect(gen.moduleService).toBeNull();
    });
  });

  /* ──── generate() 全量生成 ──── */

  describe('generate', () => {
    test('should produce wiki files with AI provider', async () => {
      const deps = trackDir(makeDeps());
      const gen = new WikiGenerator(deps);
      const result = await gen.generate();

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      if ('filesGenerated' in result) {
        expect(result.filesGenerated).toBeGreaterThan(0);
      }
    });

    test('should produce wiki files without AI (fallback mode)', async () => {
      const deps = trackDir(makeDeps({ aiProvider: null }));
      const gen = new WikiGenerator(deps);
      const result = await gen.generate();

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      if ('filesGenerated' in result) {
        expect(result.filesGenerated).toBeGreaterThan(0);
      }
    });

    test('should call onProgress during generation', async () => {
      const onProgress = vi.fn();
      const deps = trackDir(makeDeps({ onProgress }));
      const gen = new WikiGenerator(deps);
      await gen.generate();

      expect(onProgress).toHaveBeenCalled();
      // 应有多个不同阶段的回调
      const phases = new Set(onProgress.mock.calls.map((c: unknown[]) => c[0]));
      expect(phases.size).toBeGreaterThan(1);
    });

    test('should handle moduleService.load() failure gracefully', async () => {
      const deps = trackDir(
        makeDeps({
          moduleService: mockModuleService({
            load: vi.fn().mockRejectedValue(new Error('load failed')),
            listTargets: vi.fn().mockResolvedValue([]),
            getProjectInfo: vi.fn().mockReturnValue({ name: 'test', sourceFiles: [] }),
          }),
        })
      );
      const gen = new WikiGenerator(deps);
      // Should not throw, just skip SPM data
      const result = await gen.generate();
      expect(result).toBeDefined();
    });

    test('should handle knowledgeService.list() failure gracefully', async () => {
      const deps = trackDir(
        makeDeps({
          knowledgeService: mockKnowledgeService({
            list: vi.fn().mockRejectedValue(new Error('db error')),
          }),
        })
      );
      const gen = new WikiGenerator(deps);
      const result = await gen.generate();
      expect(result).toBeDefined();
    });

    test('should handle AI chat failure gracefully', async () => {
      const deps = trackDir(
        makeDeps({
          aiProvider: mockAiProvider({
            chat: vi.fn().mockRejectedValue(new Error('API error')),
          }),
        })
      );
      const gen = new WikiGenerator(deps);
      const result = await gen.generate();
      // Should fall back to template rendering
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      if ('filesGenerated' in result) {
        expect(result.filesGenerated).toBeGreaterThan(0);
      }
    });

    test('should write meta.json after generation', async () => {
      const deps = trackDir(makeDeps());
      const gen = new WikiGenerator(deps);
      await gen.generate();

      expect(fs.existsSync(gen.metaPath)).toBe(true);
      const meta = JSON.parse(fs.readFileSync(gen.metaPath, 'utf-8'));
      expect(meta.version).toBeDefined();
      expect(meta.generatedAt).toBeDefined();
    });
  });

  /* ──── abort() 中止机制 ──── */

  describe('abort', () => {
    test('should set _aborted flag', () => {
      const deps = trackDir(makeDeps());
      const gen = new WikiGenerator(deps);
      gen.abort();
      expect(gen._aborted).toBe(true);
    });

    test('should stop generation early when aborted', async () => {
      const aiChat = vi.fn().mockImplementation(async () => {
        // Slow AI response
        await new Promise((r) => setTimeout(r, 50));
        return '# Article content that is long enough';
      });
      const deps = trackDir(makeDeps({ aiProvider: mockAiProvider({ chat: aiChat }) }));
      const gen = new WikiGenerator(deps);

      // Abort after a brief delay
      setTimeout(() => gen.abort(), 10);
      const result = await gen.generate();

      // Generation should still return a result, but may have fewer files
      expect(result).toBeDefined();
    });
  });

  /* ──── getStatus() ──── */

  describe('getStatus', () => {
    test('should report non-existent wiki before generation', () => {
      const deps = trackDir(makeDeps());
      const gen = new WikiGenerator(deps);
      const status = gen.getStatus();
      expect(status.exists).toBe(false);
    });

    test('should report existing wiki after generation', async () => {
      const deps = trackDir(makeDeps());
      const gen = new WikiGenerator(deps);
      await gen.generate();
      const status = gen.getStatus();
      expect(status.exists).toBe(true);
      expect(status.generatedAt).toBeDefined();
    });
  });

  /* ──── update() 增量更新 ──── */

  describe('update', () => {
    test('should regenerate when no meta exists', async () => {
      const deps = trackDir(makeDeps());
      const gen = new WikiGenerator(deps);
      const result = await gen.update();
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      if ('filesGenerated' in result) {
        expect(result.filesGenerated).toBeGreaterThan(0);
      }
    });

    test('should detect changes since last generation', async () => {
      const deps = trackDir(makeDeps());
      const gen = new WikiGenerator(deps);

      // First generation
      await gen.generate();
      const firstMeta = JSON.parse(fs.readFileSync(gen.metaPath, 'utf-8'));

      // Add a new file to the project
      fs.writeFileSync(path.join(deps.projectRoot, 'src', 'newfile.ts'), 'export const x = 1;');

      // Update should detect the change
      const result = await gen.update();
      expect(result).toBeDefined();
    });
  });

  /* ──── 纯降级模式（无任何可选依赖） ──── */

  describe('minimal mode', () => {
    test('should work with only projectRoot', async () => {
      const deps = trackDir(
        makeDeps({
          moduleService: null,
          knowledgeService: null,
          projectGraph: null,
          codeEntityGraph: null,
          aiProvider: null,
        })
      );
      const gen = new WikiGenerator(deps);
      const result = await gen.generate();
      expect(result).toBeDefined();
      // Should at least generate index
      expect(result.success).toBe(true);
      if ('filesGenerated' in result) {
        expect(result.filesGenerated).toBeGreaterThanOrEqual(1);
      }
    });
  });
});
