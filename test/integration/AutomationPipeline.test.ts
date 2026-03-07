/**
 * 集成测试：Automation Pipeline — TriggerResolver → ContextCollector → ActionPipeline → Orchestrator
 *
 * 覆盖范围:
 *   - TriggerResolver 字符串/对象触发器解析
 *   - ContextCollector 上下文规范化与语言检测
 *   - ActionPipeline handler 注册、执行、错误处理、fallback
 *   - AutomationOrchestrator 全链路编排 + 历史记录
 */

import { ActionPipeline } from '../../lib/service/automation/ActionPipeline.js';
import { AutomationOrchestrator } from '../../lib/service/automation/AutomationOrchestrator.js';
import { ContextCollector } from '../../lib/service/automation/ContextCollector.js';
import { TriggerResolver } from '../../lib/service/automation/TriggerResolver.js';

describe('Integration: Automation Pipeline', () => {
  // ─── TriggerResolver ─────────────────────────

  describe('TriggerResolver', () => {
    let resolver: TriggerResolver;

    beforeEach(() => {
      resolver = new TriggerResolver();
    });

    test('should resolve as:directive strings', () => {
      const result = resolver.resolve('as:create MySnippet');
      expect(result.type).toBe('create');
      expect(result.name).toBe('create');
      expect(result.params).toEqual({ option: 'MySnippet' });
      expect(result.raw).toBe('as:create MySnippet');
    });

    test('should resolve as:s as search', () => {
      const result = resolver.resolve('as:s auth pattern');
      expect(result.type).toBe('search');
      expect(result.name).toBe('s');
      expect(result.params).toEqual({ option: 'auth pattern' });
    });

    test('should resolve as:a as audit', () => {
      const result = resolver.resolve('as:a');
      expect(result.type).toBe('audit');
      expect(result.name).toBe('a');
    });

    test('should resolve as:include as injection', () => {
      const result = resolver.resolve('as:include header.h');
      expect(result.type).toBe('injection');
      expect(result.name).toBe('include');
    });

    test('should resolve as:import as injection', () => {
      const result = resolver.resolve('as:import module');
      expect(result.type).toBe('injection');
    });

    test('should resolve event:name format triggers', () => {
      const result = resolver.resolve('file:changed src/index.ts');
      expect(result.type).toBe('file');
      expect(result.name).toBe('changed');
      expect(result.params).toEqual({ option: 'src/index.ts' });
    });

    test('should resolve plain strings as custom', () => {
      const result = resolver.resolve('hello world');
      expect(result.type).toBe('custom');
      expect(result.name).toBe('hello world');
    });

    test('should resolve object triggers', () => {
      const result = resolver.resolve({ type: 'search', name: 'query', params: { q: 'test' } });
      expect(result.type).toBe('search');
      expect(result.name).toBe('query');
      expect(result.params).toEqual({ q: 'test' });
    });

    test('should handle missing type in object triggers', () => {
      const result = resolver.resolve({ name: 'something' });
      expect(result.type).toBe('unknown');
    });
  });

  // ─── ContextCollector ─────────────────────────

  describe('ContextCollector', () => {
    let collector: ContextCollector;

    beforeEach(() => {
      collector = new ContextCollector();
    });

    test('should add defaults when collecting empty context', () => {
      const ctx = collector.collect({});
      expect(ctx.filePath).toBeNull();
      expect(ctx.content).toBeNull();
      expect(ctx.language).toBeNull();
      expect(ctx.user).toBe('default');
      expect(ctx.timestamp).toBeDefined();
      expect(ctx.environment.platform).toBeDefined();
      expect(ctx.environment.nodeVersion).toBeDefined();
    });

    test('should detect language from file extension', () => {
      const ctx = collector.collect({ filePath: 'src/index.ts' });
      expect(ctx.language).toBe('typescript');
    });

    test('should detect swift language', () => {
      const ctx = collector.collect({ filePath: 'Sources/App.swift' });
      expect(ctx.language).toBe('swift');
    });

    test('should detect python language', () => {
      const ctx = collector.collect({ filePath: 'main.py' });
      expect(ctx.language).toBe('python');
    });

    test('should preserve provided context', () => {
      const ctx = collector.collect({
        filePath: '/src/test.js',
        content: 'console.log("hi")',
        user: 'alice',
        projectRoot: '/projects/myapp',
      });
      expect(ctx.filePath).toBe('/src/test.js');
      expect(ctx.content).toBe('console.log("hi")');
      expect(ctx.user).toBe('alice');
      expect(ctx.projectRoot).toBe('/projects/myapp');
    });

    test('should not override provided language', () => {
      const ctx = collector.collect({ filePath: 'test.js', language: 'typescript' });
      expect(ctx.language).toBe('typescript');
    });
  });

  // ─── ActionPipeline ───────────────────────────

  describe('ActionPipeline', () => {
    let pipeline: ActionPipeline;

    beforeEach(() => {
      pipeline = new ActionPipeline();
    });

    test('should register and execute handler', async () => {
      pipeline.register('search', async (trigger, ctx) => {
        return { found: 3, query: trigger.params?.option };
      });

      const result = await pipeline.execute({ type: 'search', params: { option: 'auth' } }, {});
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ found: 3, query: 'auth' });
    });

    test('should return error for unregistered handler type', async () => {
      const result = await pipeline.execute({ type: 'nonexistent' }, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('nonexistent');
    });

    test('should use wildcard fallback handler', async () => {
      pipeline.register('*', async (trigger) => {
        return { fallback: true, type: trigger.type };
      });

      const result = await pipeline.execute({ type: 'any_type' }, {});
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ fallback: true, type: 'any_type' });
    });

    test('should catch handler errors and return failure', async () => {
      pipeline.register('broken', async () => {
        throw new Error('Handler exploded');
      });

      const result = await pipeline.execute({ type: 'broken' }, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Handler exploded');
    });

    test('should list registered types', () => {
      pipeline.register('create', async () => ({}));
      pipeline.register('search', async () => ({}));
      pipeline.register('audit', async () => ({}));

      const types = pipeline.getRegisteredTypes();
      expect(types).toContain('create');
      expect(types).toContain('search');
      expect(types).toContain('audit');
      expect(types).toHaveLength(3);
    });
  });

  // ─── AutomationOrchestrator (Full Flow) ───────

  describe('AutomationOrchestrator (Full Flow)', () => {
    let orchestrator: AutomationOrchestrator;

    beforeEach(() => {
      orchestrator = new AutomationOrchestrator();
    });

    test('should execute full pipeline: string trigger → resolve → collect → execute', async () => {
      orchestrator.registerAction('search', async (trigger, ctx) => {
        return { hits: 5, query: trigger.params?.option, lang: ctx.language };
      });

      const result = await orchestrator.run('as:s authentication', {
        filePath: 'src/auth.ts',
      });

      expect(result.success).toBe(true);
      expect(result.resolvedTrigger.type).toBe('search');
      expect(result.result).toMatchObject({ hits: 5, query: 'authentication' });
    });

    test('should execute with object trigger', async () => {
      orchestrator.registerAction('create', async (trigger) => {
        return { created: true, name: trigger.name };
      });

      const result = await orchestrator.run(
        { type: 'create', name: 'MyPattern', params: {} },
        { user: 'dev' }
      );

      expect(result.success).toBe(true);
      expect(result.resolvedTrigger.type).toBe('create');
    });

    test('should record execution history', async () => {
      orchestrator.registerAction('audit', async () => ({ violations: 0 }));

      await orchestrator.run('as:a', {});
      await orchestrator.run('as:a', { filePath: 'test.swift' });

      const history = orchestrator.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].trigger.type).toBe('audit');
      expect(history[1].context.filePath).toBe('test.swift');
      expect(history[0].timestamp).toBeDefined();
    });

    test('should limit history to 200 entries', async () => {
      orchestrator.registerAction('ping', async () => ({ ok: true }));

      for (let i = 0; i < 210; i++) {
        await orchestrator.run({ type: 'ping', params: {} });
      }

      const history = orchestrator.getHistory();
      expect(history.length).toBeLessThanOrEqual(200);
    });

    test('should handle pipeline failure gracefully', async () => {
      const result = await orchestrator.run('as:c something', {});
      // No handler registered for 'create' → should fail
      expect(result.success).toBe(false);
      expect(result.resolvedTrigger.type).toBe('create');
    });

    test('should allow custom dependencies injection', () => {
      const customResolver = new TriggerResolver();
      const customCollector = new ContextCollector();
      const customPipeline = new ActionPipeline();

      const custom = new AutomationOrchestrator({
        triggerResolver: customResolver,
        contextCollector: customCollector,
        pipeline: customPipeline,
      });

      expect(custom.getPipeline()).toBe(customPipeline);
    });
  });
});
