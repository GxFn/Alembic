/**
 * 集成测试：ToolRegistry + ToolExecutionPipeline
 *
 * 覆盖范围:
 *   - ToolRegistry 注册/查询/执行
 *   - 参数别名规范化 (snake_case → camelCase, alias mapping)
 *   - 工具 schema 过滤
 *   - 工具执行错误处理
 *   - ToolExecutionPipeline 中间件链 (before/after)
 *   - 中间件拦截（blocked / cacheHit）
 */

import { vi } from 'vitest';

import { DiagnosticsCollector } from '../../lib/agent/core/DiagnosticsCollector.js';
import {
  allowlistGate,
  ToolExecutionPipeline,
} from '../../lib/agent/core/ToolExecutionPipeline.js';
import { ALL_TOOLS } from '../../lib/agent/tools/index.js';
import { ToolRegistry } from '../../lib/agent/tools/ToolRegistry.js';

describe('Integration: ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('Registration', () => {
    test('should register a tool', () => {
      registry.register({
        name: 'search_code',
        description: 'Search project code',
        handler: async () => ({ results: [] }),
      });
      expect(registry.has('search_code')).toBe(true);
      expect(registry.size).toBe(1);
    });

    test('should register multiple tools at once', () => {
      registry.registerAll([
        { name: 'tool_a', description: 'A', handler: async () => ({}) },
        { name: 'tool_b', description: 'B', handler: async () => ({}) },
        { name: 'tool_c', description: 'C', handler: async () => ({}) },
      ]);
      expect(registry.size).toBe(3);
      expect(registry.getToolNames()).toEqual(
        expect.arrayContaining(['tool_a', 'tool_b', 'tool_c'])
      );
    });

    test('should throw on tool without name', () => {
      expect(() => {
        registry.register({ name: '', description: 'no name', handler: async () => ({}) });
      }).toThrow();
    });

    test('should throw on tool without handler', () => {
      expect(() => {
        registry.register({ name: 'orphan', description: 'no handler' } as never);
      }).toThrow();
    });
  });

  describe('Execution', () => {
    test('should execute tool handler with params', async () => {
      registry.register({
        name: 'greet',
        description: 'Greet user',
        parameters: { properties: { name: { type: 'string' } } },
        handler: async (params: Record<string, unknown>) => ({ greeting: `Hello ${params.name}` }),
      });

      const result = await registry.execute('greet', { name: 'Alice' });
      expect(result).toEqual({ greeting: 'Hello Alice' });
    });

    test('should throw when executing non-existent tool', async () => {
      await expect(registry.execute('ghost', {})).rejects.toThrow("Tool 'ghost' not found");
    });

    test('should catch handler errors and return error object', async () => {
      registry.register({
        name: 'broken',
        description: 'Always fails',
        handler: async () => {
          throw new Error('Internal failure');
        },
      });

      const result = await registry.execute('broken', {});
      expect(result).toEqual({ error: 'Internal failure' });
    });

    test('should expose direct-call governance metadata', () => {
      registry.register({
        name: 'safe_lookup',
        description: 'Safe lookup',
        metadata: { directCallable: true, sideEffect: false },
        handler: async () => ({ ok: true }),
      });

      expect(registry.isDirectCallable('safe_lookup')).toBe(true);
      expect(registry.getToolMetadata('safe_lookup')).toMatchObject({
        directCallable: true,
        sideEffect: false,
      });
    });

    test('should validate required parameters before handler execution', async () => {
      let executed = false;
      registry.register({
        name: 'needs_name',
        description: 'Requires name',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        handler: async () => {
          executed = true;
          return { ok: true };
        },
      });

      const result = await registry.execute('needs_name', {});
      expect(executed).toBe(false);
      expect(result).toEqual({ error: expect.stringContaining('缺少必填参数 "name"') });
    });

    test('should validate parameter type and enum before handler execution', async () => {
      registry.register({
        name: 'typed_tool',
        description: 'Typed tool',
        parameters: {
          type: 'object',
          properties: {
            count: { type: 'number' },
            mode: { type: 'string', enum: ['fast', 'safe'] },
          },
          required: ['count', 'mode'],
        },
        handler: async () => ({ ok: true }),
      });

      const badType = await registry.execute('typed_tool', { count: '1', mode: 'fast' });
      expect(badType).toEqual({ error: expect.stringContaining('参数 "count" 类型应为 number') });

      const badEnum = await registry.execute('typed_tool', { count: 1, mode: 'turbo' });
      expect(badEnum).toEqual({ error: expect.stringContaining('参数 "mode" 必须是: fast, safe') });
    });
  });

  describe('Parameter normalization', () => {
    test('should normalize snake_case to camelCase', async () => {
      let received: Record<string, unknown> = {};
      registry.register({
        name: 'read_file',
        description: 'Read file',
        parameters: { properties: { filePath: {}, startLine: {}, endLine: {} } },
        handler: async (params: Record<string, unknown>) => {
          received = params;
          return {};
        },
      });

      await registry.execute('read_file', { file_path: '/test.ts', start_line: 1, end_line: 10 });
      expect(received.filePath).toBe('/test.ts');
      expect(received.startLine).toBe(1);
      expect(received.endLine).toBe(10);
    });

    test('should apply alias mapping', async () => {
      let received: Record<string, unknown> = {};
      registry.register({
        name: 'search',
        description: 'Search',
        parameters: { properties: { pattern: {}, fileFilter: {}, maxResults: {} } },
        handler: async (params: Record<string, unknown>) => {
          received = params;
          return {};
        },
      });

      await registry.execute('search', { query: 'hello', file_filter: '*.ts', max_results: 10 });
      expect(received.pattern).toBe('hello');
      expect(received.fileFilter).toBe('*.ts');
      expect(received.maxResults).toBe(10);
    });

    test('should pass through unknown params', async () => {
      let received: Record<string, unknown> = {};
      registry.register({
        name: 'flex',
        description: 'Flexible',
        parameters: { properties: { known: {} } },
        handler: async (params: Record<string, unknown>) => {
          received = params;
          return {};
        },
      });

      await registry.execute('flex', { known: 1, extra: 2 });
      expect(received.known).toBe(1);
      expect(received.extra).toBe(2);
    });
  });

  describe('Tool governance metadata', () => {
    test('should mark HTTP direct tools explicitly', () => {
      const byName = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));

      expect(byName.get('search_project_code')?.metadata).toMatchObject({
        abortMode: 'cooperative',
        auditLevel: 'checkOnly',
        composable: true,
        directCallable: true,
        policyProfile: 'read',
        sideEffect: false,
        surface: ['runtime', 'http'],
      });
      expect(byName.get('submit_knowledge')?.metadata).toMatchObject({
        auditLevel: 'full',
        composable: false,
        directCallable: false,
        policyProfile: 'write',
        sideEffect: true,
        surface: ['runtime'],
      });
      expect(byName.get('run_safe_command')?.metadata).toMatchObject({
        abortMode: 'hardTimeout',
        auditLevel: 'full',
        directCallable: false,
        policyProfile: 'system',
        sideEffect: true,
      });
      expect(byName.get('read_project_file')?.metadata).toMatchObject({
        directCallable: true,
        sideEffect: false,
        gatewayAction: 'read:project',
        gatewayResource: 'project',
      });
      expect(byName.get('search_recipes')?.metadata).toMatchObject({
        directCallable: true,
        sideEffect: false,
        gatewayAction: 'read:recipes',
        gatewayResource: 'recipes',
      });
      expect(byName.get('query_audit_log')?.metadata).toMatchObject({
        directCallable: true,
        sideEffect: false,
        gatewayAction: 'read:audit_logs',
        gatewayResource: '/audit_logs/self',
      });
      expect(byName.get('get_recommendations')?.metadata).toMatchObject({
        directCallable: true,
        sideEffect: false,
        gatewayAction: 'read:recipes',
        gatewayResource: 'recipes',
      });
      expect(byName.get('load_skill')?.metadata).toMatchObject({
        directCallable: true,
        sideEffect: false,
        gatewayAction: 'read:skills',
        gatewayResource: 'skills',
      });
      expect(byName.get('get_environment_info')?.metadata).toMatchObject({
        auditLevel: 'checkOnly',
        composable: false,
        directCallable: true,
        sideEffect: false,
        gatewayAction: 'read:environment',
        gatewayResource: 'environment',
      });
      expect(byName.get('get_tool_details')?.metadata).toMatchObject({
        composable: false,
        directCallable: true,
        gatewayAction: 'read:agent_tools',
        gatewayResource: 'agent_tools',
      });
      expect(byName.get('validate_candidate')?.metadata).toMatchObject({
        directCallable: true,
        gatewayAction: 'validate:candidates',
        gatewayResource: 'candidates',
        policyProfile: 'analysis',
      });
    });

    test('should provide capability metadata for every tool', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.metadata).toMatchObject({
          abortMode: expect.any(String),
          auditLevel: expect.any(String),
          composable: expect.any(Boolean),
          directCallable: expect.any(Boolean),
          policyProfile: expect.any(String),
          sideEffect: expect.any(Boolean),
          surface: expect.any(Array),
        });
      }
    });
  });

  describe('Tool schemas', () => {
    test('should return all schemas', () => {
      registry.registerAll([
        {
          name: 'a',
          description: 'Tool A',
          parameters: { properties: {} },
          handler: async () => ({}),
        },
        {
          name: 'b',
          description: 'Tool B',
          parameters: { properties: {} },
          handler: async () => ({}),
        },
      ]);

      const schemas = registry.getToolSchemas();
      expect(schemas).toHaveLength(2);
      expect(schemas[0]).toHaveProperty('name');
      expect(schemas[0]).toHaveProperty('description');
      expect(schemas[0]).toHaveProperty('parameters');
    });

    test('should filter by allowed tools', () => {
      registry.registerAll([
        { name: 'a', description: 'A', handler: async () => ({}) },
        { name: 'b', description: 'B', handler: async () => ({}) },
        { name: 'c', description: 'C', handler: async () => ({}) },
      ]);

      const schemas = registry.getToolSchemas(['a', 'c']);
      expect(schemas).toHaveLength(2);
      expect(schemas.map((s) => s.name)).toEqual(['a', 'c']);
    });
  });
});

describe('Integration: ToolExecutionPipeline', () => {
  describe('Middleware chain', () => {
    test('should run all before/after middleware in order', async () => {
      const pipeline = new ToolExecutionPipeline();
      const order: string[] = [];

      pipeline.use({
        name: 'logger',
        before: () => {
          order.push('logger:before');
        },
        after: () => {
          order.push('logger:after');
        },
      });

      pipeline.use({
        name: 'metrics',
        before: () => {
          order.push('metrics:before');
        },
        after: () => {
          order.push('metrics:after');
        },
      });

      // 需要 mock runtime 和 loopCtx
      const mockRegistry = new ToolRegistry();
      mockRegistry.register({
        name: 'test_tool',
        description: 'Test',
        handler: async () => {
          order.push('execute');
          return { ok: true };
        },
      });

      const mockRuntime = {
        id: 'test-runtime',
        presetName: 'test',
        policies: { get: () => null },
        toolRegistry: mockRegistry,
        container: {},
        projectRoot: '/tmp',
        fileCache: new Map(),
        lang: 'en',
        logger: null,
        aiProvider: null,
      };

      const mockLoopCtx = {
        source: 'test',
        sharedState: {},
        iteration: 0,
      };

      const result = await pipeline.execute(
        { name: 'test_tool', args: {}, id: 'call-1' },
        { runtime: mockRuntime as never, loopCtx: mockLoopCtx as never, iteration: 0 }
      );

      expect(order).toEqual([
        'logger:before',
        'metrics:before',
        'execute',
        'logger:after',
        'metrics:after',
      ]);
      expect(result.result).toEqual({ ok: true });
    });

    test('should block execution when before returns blocked', async () => {
      const pipeline = new ToolExecutionPipeline();
      let executed = false;

      pipeline.use({
        name: 'safety',
        before: (call) => {
          if (call.name === 'dangerous_tool') {
            return { blocked: true, result: { error: 'Blocked by policy' } };
          }
        },
      });

      const mockRegistry = new ToolRegistry();
      mockRegistry.register({
        name: 'dangerous_tool',
        description: 'Dangerous',
        handler: async () => {
          executed = true;
          return {};
        },
      });

      const result = await pipeline.execute(
        { name: 'dangerous_tool', args: {}, id: 'call-2' },
        {
          runtime: {
            id: 'r',
            presetName: 'test',
            policies: { get: () => null },
            toolRegistry: mockRegistry,
            container: {},
          } as never,
          loopCtx: { source: 'test', sharedState: {} } as never,
          iteration: 0,
        }
      );

      expect(executed).toBe(false);
      expect(result.metadata.blocked).toBe(true);
      expect(result.result).toEqual({ error: 'Blocked by policy' });
    });

    test('should short-circuit on cache hit', async () => {
      const pipeline = new ToolExecutionPipeline();

      pipeline.use({
        name: 'cache',
        before: () => {
          return { result: { cached: true } };
        },
      });

      const result = await pipeline.execute(
        { name: 'any_tool', args: {}, id: 'call-3' },
        {
          runtime: { id: 'r', policies: { get: () => null } } as never,
          loopCtx: { source: 'test' } as never,
          iteration: 0,
        }
      );

      expect(result.metadata.cacheHit).toBe(true);
      expect(result.result).toEqual({ cached: true });
    });

    test('should pass abortSignal to tool handler context', async () => {
      const pipeline = new ToolExecutionPipeline();
      const mockRegistry = new ToolRegistry();
      const abortController = new AbortController();
      let capturedSignal: AbortSignal | null = null;
      mockRegistry.register({
        name: 'signal_aware_tool',
        description: 'Signal aware tool',
        handler: async (_params, context) => {
          capturedSignal = (context.abortSignal as AbortSignal) || null;
          return { ok: true };
        },
      });

      const result = await pipeline.execute(
        { name: 'signal_aware_tool', args: {}, id: 'call-signal' },
        {
          runtime: {
            id: 'r',
            presetName: 'test',
            policies: { get: () => null },
            toolRegistry: mockRegistry,
            container: {},
          } as never,
          loopCtx: {
            source: 'test',
            sharedState: {},
            abortSignal: abortController.signal,
          } as never,
          iteration: 0,
        }
      );

      expect(result.result).toEqual({ ok: true });
      expect(capturedSignal).toBe(abortController.signal);
    });

    test('should not start tool handler when abortSignal is already aborted', async () => {
      const pipeline = new ToolExecutionPipeline();
      const mockRegistry = new ToolRegistry();
      const abortController = new AbortController();
      abortController.abort();
      let executed = false;
      mockRegistry.register({
        name: 'slow_tool',
        description: 'Slow tool',
        handler: async () => {
          executed = true;
          return { ok: true };
        },
      });

      const result = await pipeline.execute(
        { name: 'slow_tool', args: {}, id: 'call-aborted' },
        {
          runtime: {
            id: 'r',
            presetName: 'test',
            policies: { get: () => null },
            toolRegistry: mockRegistry,
            container: {},
          } as never,
          loopCtx: {
            source: 'test',
            sharedState: {},
            abortSignal: abortController.signal,
          } as never,
          iteration: 0,
        }
      );

      expect(executed).toBe(false);
      expect(result.metadata.blocked).toBe(true);
      expect(result.result).toEqual({ error: expect.stringContaining('aborted') });
    });

    test('should block registered static tools missing from the active allowlist', async () => {
      const pipeline = new ToolExecutionPipeline();
      const mockRegistry = new ToolRegistry();
      const diagnostics = new DiagnosticsCollector();
      let executed = false;
      mockRegistry.register({
        name: 'static_tool',
        description: 'Static tool',
        handler: async () => {
          executed = true;
          return { ok: true };
        },
      });

      const result = await pipeline.use(allowlistGate).execute(
        { name: 'static_tool', args: {}, id: 'call-static' },
        {
          runtime: {
            id: 'r',
            policies: { get: () => null },
            toolRegistry: mockRegistry,
            container: { get: () => ({ temporaryRegistry: { isTemporary: () => false } }) },
            logger: { info: vi.fn(), warn: vi.fn() },
          } as never,
          loopCtx: {
            source: 'test',
            toolSchemas: [{ name: 'allowed_tool' }],
            sharedState: {},
            diagnostics,
          } as never,
          iteration: 0,
        }
      );

      expect(executed).toBe(false);
      expect(result.metadata.blocked).toBe(true);
      expect(result.result).toEqual({ error: expect.stringContaining('不可用') });
      expect(diagnostics.toJSON().blockedTools).toEqual([
        expect.objectContaining({ tool: 'static_tool', reason: expect.stringContaining('不可用') }),
      ]);
    });
  });
});
