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

import { ToolExecutionPipeline } from '../../lib/service/agent/core/ToolExecutionPipeline.js';
import { ToolRegistry } from '../../lib/service/agent/tools/ToolRegistry.js';

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
        registry.register({ name: 'orphan', description: 'no handler' } as any);
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
        { runtime: mockRuntime as any, loopCtx: mockLoopCtx as any, iteration: 0 }
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
          } as any,
          loopCtx: { source: 'test', sharedState: {} } as any,
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
          runtime: { id: 'r', policies: { get: () => null } } as any,
          loopCtx: { source: 'test' } as any,
          iteration: 0,
        }
      );

      expect(result.metadata.cacheHit).toBe(true);
      expect(result.result).toEqual({ cached: true });
    });
  });
});
