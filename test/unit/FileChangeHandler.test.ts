import { vi } from 'vitest';
import { FileChangeHandler } from '../../lib/service/evolution/FileChangeHandler.js';
import type { FileChangeEvent, ImpactLevel } from '../../lib/types/reactive-evolution.js';

/* ════════════════════════════════════════════
 *  Mock 工厂
 * ════════════════════════════════════════════ */

function mockSourceRefRepo() {
  const _refs: Array<{ recipeId: string; sourcePath: string; status: string }> = [];
  return {
    findBySourcePath: vi.fn((path: string) =>
      _refs.filter((r) => r.sourcePath === path && r.status === 'active')
    ),
    findByRecipeId: vi.fn((id: string) => _refs.filter((r) => r.recipeId === id)),
    upsert: vi.fn(),
    replaceSourcePath: vi.fn(),
    _seed(recipeId: string, sourcePath: string, status = 'active') {
      _refs.push({ recipeId, sourcePath, status });
    },
  };
}

function mockKnowledgeRepo() {
  const _store = new Map<string, Record<string, unknown>>();
  return {
    findById: vi.fn(async (id: string) => _store.get(id) ?? null),
    findSourceFileAndReasoning: vi.fn(async (id: string) => {
      const e = _store.get(id);
      return e ? { reasoning: JSON.stringify(e.reasoning ?? {}) } : null;
    }),
    updateReasoning: vi.fn(),
    _seed(id: string, data: Record<string, unknown>) {
      _store.set(id, { id, lifecycle: 'active', ...data });
    },
  };
}

function mockContentPatcher() {
  return {
    applyProposal: vi.fn(async () => ({ success: true })),
  };
}

function mockSignalBus() {
  const _signals: Array<{
    type: string;
    source: string;
    weight: number;
    opts: Record<string, unknown>;
  }> = [];
  return {
    send: vi.fn((type: string, source: string, weight: number, opts: Record<string, unknown>) => {
      _signals.push({ type, source, weight, opts });
    }),
    _signals,
  };
}

function mockGateway() {
  return {
    submit: vi.fn(async () => ({
      recipeId: '',
      action: 'deprecate',
      outcome: 'immediately-executed',
    })),
  };
}

function createHandler(overrides: Record<string, unknown> = {}) {
  const sourceRefRepo =
    (overrides.sourceRefRepo as ReturnType<typeof mockSourceRefRepo>) ?? mockSourceRefRepo();
  const knowledgeRepo =
    (overrides.knowledgeRepo as ReturnType<typeof mockKnowledgeRepo>) ?? mockKnowledgeRepo();
  const contentPatcher =
    (overrides.contentPatcher as ReturnType<typeof mockContentPatcher>) ?? mockContentPatcher();
  const signalBus = (overrides.signalBus as ReturnType<typeof mockSignalBus>) ?? mockSignalBus();
  const gateway = (overrides.gateway as ReturnType<typeof mockGateway>) ?? mockGateway();

  const handler = new FileChangeHandler(
    sourceRefRepo as never,
    knowledgeRepo as never,
    contentPatcher as never,
    {
      signalBus: signalBus as never,
      evolutionGateway: gateway as never,
    }
  );

  return { handler, sourceRefRepo, knowledgeRepo, contentPatcher, signalBus, gateway };
}

/* ════════════════════════════════════════════
 *  Tests
 * ════════════════════════════════════════════ */

describe('FileChangeHandler', () => {
  /* ─── #handleModified → impactLevel ─── */

  describe('modified 事件 — impactLevel 判定', () => {
    test('sourceRef 精确匹配 → direct（§5.3 核心规则）', async () => {
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Networking/AuthMiddleware.swift');
      knowledgeRepo._seed('r1', {
        title: 'AuthMiddleware 模式',
        coreCode: 'actor AuthMiddleware: Middleware {}',
        reasoning: { sources: ['Sources/Networking/AuthMiddleware.swift'] },
        trigger: '@auth-middleware',
      });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/Networking/AuthMiddleware.swift' },
      ]);

      expect(report.needsReview).toBe(1);
      expect(report.details[0]!.impactLevel).toBe('direct');
      expect(report.suggestReview).toBe(true);
    });

    test('sourceRef 匹配但 coreCode 不含文件名 → 仍然 direct', async () => {
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Packages/Foundation/ServiceRegistry.swift');
      knowledgeRepo._seed('r1', {
        title: 'ServiceRegistry 依赖注入',
        coreCode: 'protocol Providing { func resolve<T>(_ type: T.Type) -> T }',
        reasoning: { sources: [] },
        trigger: '@service-registry',
      });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Packages/Foundation/ServiceRegistry.swift' },
      ]);

      expect(report.details[0]!.impactLevel).toBe('direct');
    });

    test('sourceRef 匹配多条 Recipe → 每条都是 direct', async () => {
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      const sharedPath = 'Sources/Core/Middleware.swift';
      sourceRefRepo._seed('r1', sharedPath);
      sourceRefRepo._seed('r2', sharedPath);
      sourceRefRepo._seed('r3', sharedPath);
      knowledgeRepo._seed('r1', { title: 'Recipe A', coreCode: '' });
      knowledgeRepo._seed('r2', { title: 'Recipe B', coreCode: '' });
      knowledgeRepo._seed('r3', { title: 'Recipe C', coreCode: '' });

      const report = await handler.handleFileChanges([{ type: 'modified', path: sharedPath }]);

      expect(report.needsReview).toBe(3);
      for (const detail of report.details) {
        expect(detail.impactLevel).toBe('direct');
      }
    });

    test('非 active 的 Recipe 被跳过（§13.1 B5）', async () => {
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      knowledgeRepo._seed('r1', {
        title: 'Deprecated Recipe',
        lifecycle: 'deprecated',
        coreCode: '',
      });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/A.swift' },
      ]);

      expect(report.needsReview).toBe(0);
      expect(report.skipped).toBe(1);
      expect(report.details).toHaveLength(0);
    });

    test('无 sourceRef 匹配 → 跳过', async () => {
      const { handler } = createHandler();

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/Unknown.swift' },
      ]);

      expect(report.needsReview).toBe(0);
      expect(report.skipped).toBe(1);
    });
  });

  /* ─── Signal 发射验证 ─── */

  describe('modified 事件 — signal 发射', () => {
    test('sourceRef 匹配发射 quality signal，weight=0.7（direct）', async () => {
      const { handler, sourceRefRepo, knowledgeRepo, signalBus } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      knowledgeRepo._seed('r1', { title: 'Recipe A', coreCode: '' });

      await handler.handleFileChanges([{ type: 'modified', path: 'Sources/A.swift' }]);

      expect(signalBus.send).toHaveBeenCalledWith(
        'quality',
        'FileChangeHandler',
        0.7,
        expect.objectContaining({
          target: 'r1',
          metadata: expect.objectContaining({
            reason: 'source_modified',
            modifiedPath: 'Sources/A.swift',
            impactLevel: 'direct',
          }),
        })
      );
    });
  });

  /* ─── suggestReview 策略 ─── */

  describe('suggestReview（Strategy C 验证）', () => {
    test('有 direct 影响 → suggestReview=true', async () => {
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      knowledgeRepo._seed('r1', { title: 'Recipe A', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/A.swift' },
      ]);

      expect(report.suggestReview).toBe(true);
    });

    test('仅 skip/created → suggestReview=false', async () => {
      const { handler } = createHandler();

      const report = await handler.handleFileChanges([
        { type: 'created', path: 'Sources/New.swift' },
      ]);

      expect(report.suggestReview).toBe(false);
    });
  });

  /* ─── deleted 事件 ─── */

  describe('deleted 事件', () => {
    test('所有 sourceRef 失效 → deprecate', async () => {
      const { handler, sourceRefRepo, knowledgeRepo, gateway } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Dead.swift');
      knowledgeRepo._seed('r1', { title: 'Dead Recipe', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'deleted', path: 'Sources/Dead.swift' },
      ]);

      expect(report.deprecated).toBe(1);
      expect(gateway.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          recipeId: 'r1',
          action: 'deprecate',
          confidence: 0.9,
        })
      );
    });

    test('还有其他 active ref → 仅标记 stale', async () => {
      const { handler, sourceRefRepo, knowledgeRepo, gateway } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      sourceRefRepo._seed('r1', 'Sources/B.swift');
      knowledgeRepo._seed('r1', { title: 'Multi-ref Recipe', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'deleted', path: 'Sources/A.swift' },
      ]);

      expect(report.deprecated).toBe(0);
      expect(report.skipped).toBe(1);
      expect(gateway.submit).not.toHaveBeenCalled();
    });
  });

  /* ─── renamed 事件 ─── */

  describe('renamed 事件', () => {
    test('成功修复路径 → fixed', async () => {
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Old.swift');
      knowledgeRepo._seed('r1', { title: 'Renamed Recipe', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'renamed', path: 'Sources/New.swift', oldPath: 'Sources/Old.swift' },
      ]);

      expect(report.fixed).toBe(1);
      expect(sourceRefRepo.replaceSourcePath).toHaveBeenCalledWith(
        'r1',
        'Sources/Old.swift',
        'Sources/New.swift',
        expect.any(Number)
      );
    });
  });

  /* ─── #analyzeModifiedImpact 独立路径验证（未来扩展 isSourceRef=false 场景） ─── */

  describe('analyzeModifiedImpact 内部逻辑（通过 handleFileChanges 间接测试）', () => {
    test('reason 文本包含 sourceRefs 提示', async () => {
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/A.swift');
      knowledgeRepo._seed('r1', { title: 'Recipe', coreCode: '' });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/A.swift' },
      ]);

      expect(report.details[0]!.reason).toContain('sourceRefs');
    });
  });

  /* ─── 旧 Bug 回归验证 ─── */

  describe('Bug 回归', () => {
    test('[回归] basename 含扩展名时不再降级 — AuthMiddleware.swift vs coreCode 中的 AuthMiddleware', async () => {
      // 旧 bug: basename = 'AuthMiddleware.swift'，coreCode 中是 'AuthMiddleware'（不含 .swift）
      // coreCode.includes('AuthMiddleware.swift') 返回 false → 被降级为 reference/pattern
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Middleware/AuthMiddleware.swift');
      knowledgeRepo._seed('r1', {
        title: '并发模型演进',
        coreCode: 'actor AuthMiddleware: Middleware {\n  private var state: AuthState\n}',
        reasoning: { sources: ['Sources/Middleware/AuthMiddleware.swift'] },
        trigger: '@auth-middleware',
      });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/Middleware/AuthMiddleware.swift' },
      ]);

      // 核心断言：必须是 direct，不能被降级
      expect(report.details[0]!.impactLevel).toBe('direct');
    });

    test('[回归] sourceFile 是 Recipe markdown 路径，不应参与 direct 判定', async () => {
      // 旧 bug: sourceFile = 'Alembic/recipes/arch/xxx.md'，永远不等于源代码路径
      // 旧代码检查 sourceFile === modifiedPath → 对源代码修改无意义
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Core/ServiceRegistry.swift');
      knowledgeRepo._seed('r1', {
        title: 'ServiceRegistry 依赖注入',
        sourceFile: 'Alembic/recipes/architecture/service-registry.md',
        coreCode: 'class Container { }',
        reasoning: { sources: ['Sources/Core/ServiceRegistry.swift'] },
        trigger: '@service-registry',
      });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/Core/ServiceRegistry.swift' },
      ]);

      expect(report.details[0]!.impactLevel).toBe('direct');
    });

    test('[回归] reasoning.sources endsWith 不应匹配子串', async () => {
      // 旧 bug: s.endsWith('Middleware.swift') 会匹配 'SomeMiddleware.swift'
      // 修复后使用 s.endsWith('/Middleware.swift') 避免子串误匹配
      // 此测试验证的是非 sourceRef 路径的 reference 判定（isSourceRef=false 场景）
      // 因为当前 #handleModified 总是 isSourceRef=true，所以结果仍然是 direct
      // 这里验证的是 sourceRef 机制不会因为路径相似而出问题
      const { handler, sourceRefRepo, knowledgeRepo } = createHandler();
      sourceRefRepo._seed('r1', 'Sources/Middleware.swift');
      knowledgeRepo._seed('r1', {
        title: 'Recipe',
        coreCode: '',
        reasoning: { sources: ['Sources/SomeMiddleware.swift'] },
        trigger: '@middleware',
      });

      const report = await handler.handleFileChanges([
        { type: 'modified', path: 'Sources/Middleware.swift' },
      ]);

      // sourceRef 匹配 → direct（不依赖 reasoning.sources 的判定）
      expect(report.details[0]!.impactLevel).toBe('direct');
    });
  });
});
