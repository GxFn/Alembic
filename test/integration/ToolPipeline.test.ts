/**
 * 集成测试：ToolRegistry + ToolExecutionPipeline
 *
 * 覆盖范围:
 *   - ToolRegistry 注册/查询 + ToolRouter 执行
 *   - 参数别名规范化 (snake_case → camelCase, alias mapping)
 *   - 工具 schema 过滤
 *   - 工具执行错误处理
 *   - ToolExecutionPipeline 中间件链 (before/after)
 *   - 中间件拦截（blocked / routed cache metadata）
 */

import { vi } from 'vitest';
import { DiagnosticsCollector } from '../../lib/agent/runtime/DiagnosticsCollector.js';
import {
  allowlistGate,
  observationRecord,
  ToolExecutionPipeline,
} from '../../lib/agent/runtime/ToolExecutionPipeline.js';
import { InternalToolAdapter } from '../../lib/tools/adapters/InternalToolAdapter.js';
import { CapabilityCatalog } from '../../lib/tools/catalog/CapabilityCatalog.js';
import { createInternalToolManifest } from '../../lib/tools/catalog/CapabilityProjection.js';
import type { ToolDefinition } from '../../lib/tools/catalog/ToolDefinition.js';
import { ToolRegistry } from '../../lib/tools/catalog/ToolRegistry.js';
import { ToolRouter } from '../../lib/tools/core/ToolRouter.js';
import {
  ALL_TOOLS,
  getToolDetails,
  TOOL_CAPABILITY_CATALOG,
} from '../../lib/tools/handlers/index.js';

async function executeRegisteredTool(
  registry: ToolRegistry,
  tool: ToolDefinition,
  args: Record<string, unknown>
) {
  registry.register(tool);
  const router = new ToolRouter({
    catalog: new CapabilityCatalog([createInternalToolManifest(tool)]),
    adapters: [new InternalToolAdapter(registry)],
    projectRoot: '/tmp/test-project',
  });
  return await router.execute({
    toolId: tool.name,
    args,
    surface: 'runtime',
    actor: { role: 'runtime' },
    source: { kind: 'runtime', name: 'tool-pipeline-test' },
  });
}

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
      expect(registry.getInternalTool('tool_a')).toMatchObject({ name: 'tool_a' });
      expect(registry.getInternalTool('tool_b')).toMatchObject({ name: 'tool_b' });
      expect(registry.getInternalTool('tool_c')).toMatchObject({ name: 'tool_c' });
    });

    test('should project forged tools through dedicated internal store API', () => {
      registry.projectForgedTool({
        name: 'forged_generate_tool',
        description: 'Generated tool',
        parameters: { type: 'object' },
        forgeMode: 'generate',
        handler: async () => ({ ok: true }),
      });

      expect(registry.hasInternalTool('forged_generate_tool')).toBe(true);
      expect(registry.getInternalTool('forged_generate_tool')).toMatchObject({
        name: 'forged_generate_tool',
        description: '[Forged:generate] Generated tool',
        metadata: {
          owner: 'agent-forge',
          lifecycle: 'experimental',
          sideEffect: true,
          policyProfile: 'write',
          auditLevel: 'full',
        },
      });
    });

    test('should reject forged tool projection conflicts with existing internal tools', () => {
      registry.register({ name: 'static_tool', description: 'Static', handler: async () => ({}) });

      expect(() =>
        registry.projectForgedTool({
          name: 'static_tool',
          description: 'Generated conflict',
          forgeMode: 'generate',
          handler: async () => ({ ok: true }),
        })
      ).toThrow('conflicts with an existing internal tool');
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
      const envelope = await executeRegisteredTool(
        registry,
        {
          name: 'greet',
          description: 'Greet user',
          parameters: { properties: { name: { type: 'string' } } },
          handler: async (params: Record<string, unknown>) => ({
            greeting: `Hello ${params.name}`,
          }),
        },
        { name: 'Alice' }
      );

      expect(envelope).toMatchObject({
        ok: true,
        status: 'success',
        structuredContent: { greeting: 'Hello Alice' },
      });
    });

    test('should block non-existent capabilities before handler lookup', async () => {
      const router = new ToolRouter({
        catalog: new CapabilityCatalog(),
        adapters: [new InternalToolAdapter(registry)],
        projectRoot: '/tmp/test-project',
      });

      const envelope = await router.execute({
        toolId: 'ghost',
        args: {},
        surface: 'runtime',
        actor: { role: 'runtime' },
        source: { kind: 'runtime', name: 'tool-pipeline-test' },
      });

      expect(envelope).toMatchObject({
        ok: false,
        status: 'blocked',
        text: "Capability 'ghost' not found",
      });
    });

    test('should catch handler errors and return error object', async () => {
      const envelope = await executeRegisteredTool(
        registry,
        {
          name: 'broken',
          description: 'Always fails',
          handler: async () => {
            throw new Error('Internal failure');
          },
        },
        {}
      );

      expect(envelope).toMatchObject({
        ok: false,
        status: 'error',
        structuredContent: { error: 'Internal failure' },
      });
    });

    test('should keep governance metadata out of ToolRegistry runtime API', () => {
      registry.register({
        name: 'safe_lookup',
        description: 'Safe lookup',
        metadata: { directCallable: true, sideEffect: false },
        handler: async () => ({ ok: true }),
      });

      expect('isDirectCallable' in registry).toBe(false);
      expect('getToolMetadata' in registry).toBe(false);
      expect('execute' in registry).toBe(false);
      expect('executeEnvelope' in registry).toBe(false);
      expect('executeInternal' in registry).toBe(false);
    });

    test('should validate required parameters before handler execution', async () => {
      let executed = false;
      const envelope = await executeRegisteredTool(
        registry,
        {
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
        },
        {}
      );

      expect(executed).toBe(false);
      expect(envelope).toMatchObject({
        ok: false,
        status: 'blocked',
        text: expect.stringContaining('缺少必填参数 "name"'),
      });
    });

    test('should validate parameter type and enum before handler execution', async () => {
      const tool: ToolDefinition = {
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
      };
      registry.register(tool);
      const router = new ToolRouter({
        catalog: new CapabilityCatalog([createInternalToolManifest(tool)]),
        adapters: [new InternalToolAdapter(registry)],
        projectRoot: '/tmp/test-project',
      });
      const execute = (args: Record<string, unknown>) =>
        router.execute({
          toolId: 'typed_tool',
          args,
          surface: 'runtime',
          actor: { role: 'runtime' },
          source: { kind: 'runtime', name: 'tool-pipeline-test' },
        });

      const badType = await execute({ count: '1', mode: 'fast' });
      expect(badType).toMatchObject({
        ok: false,
        text: expect.stringContaining('参数 "count" 类型应为 number'),
      });

      const badEnum = await execute({ count: 1, mode: 'turbo' });
      expect(badEnum).toMatchObject({
        ok: false,
        text: expect.stringContaining('参数 "mode" 必须是: fast, safe'),
      });
    });
  });

  describe('Parameter normalization', () => {
    test('should normalize snake_case to camelCase', async () => {
      let received: Record<string, unknown> = {};
      await executeRegisteredTool(
        registry,
        {
          name: 'read_file',
          description: 'Read file',
          parameters: { properties: { filePath: {}, startLine: {}, endLine: {} } },
          handler: async (params: Record<string, unknown>) => {
            received = params;
            return {};
          },
        },
        {
          file_path: '/test.ts',
          start_line: 1,
          end_line: 10,
        }
      );
      expect(received.filePath).toBe('/test.ts');
      expect(received.startLine).toBe(1);
      expect(received.endLine).toBe(10);
    });

    test('should apply alias mapping', async () => {
      let received: Record<string, unknown> = {};
      await executeRegisteredTool(
        registry,
        {
          name: 'search',
          description: 'Search',
          parameters: { properties: { pattern: {}, fileFilter: {}, maxResults: {} } },
          handler: async (params: Record<string, unknown>) => {
            received = params;
            return {};
          },
        },
        {
          query: 'hello',
          file_filter: '*.ts',
          max_results: 10,
        }
      );
      expect(received.pattern).toBe('hello');
      expect(received.fileFilter).toBe('*.ts');
      expect(received.maxResults).toBe(10);
    });

    test('should pass through unknown params', async () => {
      let received: Record<string, unknown> = {};
      await executeRegisteredTool(
        registry,
        {
          name: 'flex',
          description: 'Flexible',
          parameters: { properties: { known: {} } },
          handler: async (params: Record<string, unknown>) => {
            received = params;
            return {};
          },
        },
        { known: 1, extra: 2 }
      );
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
      expect(byName.has('run_safe_command')).toBe(false);
      expect(byName.get('write_project_file')?.metadata).toMatchObject({
        auditLevel: 'full',
        directCallable: false,
        policyProfile: 'write',
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
    test('should keep schema projection out of ToolRegistry runtime API', () => {
      registry.register({
        name: 'schema_source',
        description: 'Schema source',
        parameters: { properties: {} },
        handler: async () => ({}),
      });

      expect('getToolSchemas' in registry).toBe(false);
      expect(registry.getInternalTool('schema_source')).toMatchObject({
        name: 'schema_source',
        description: 'Schema source',
        parameters: { properties: {} },
      });
    });

    test('get_tool_details should read schema from CapabilityCatalog', async () => {
      const result = await getToolDetails.handler({ toolName: 'read_project_file' }, {
        container: {
          get(name: string) {
            return name === 'capabilityCatalog' ? TOOL_CAPABILITY_CATALOG : null;
          },
        },
        projectRoot: '/tmp/project',
      } as never);

      expect(result).toMatchObject({
        name: 'read_project_file',
        description: expect.any(String),
        parameters: expect.objectContaining({ type: 'object' }),
      });
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
      const execute = vi.fn(async () => {
        order.push('execute');
        return {
          ok: true,
          toolId: 'test_tool',
          callId: 'router-call',
          startedAt: new Date().toISOString(),
          durationMs: 0,
          status: 'success',
          text: 'ok',
          structuredContent: { ok: true },
          diagnostics: {
            degraded: false,
            fallbackUsed: false,
            warnings: [],
            timedOutStages: [],
            blockedTools: [],
            truncatedToolCalls: 0,
            emptyResponses: 0,
            aiErrorCount: 0,
            gateFailures: [],
          },
          trust: {
            source: 'internal',
            sanitized: true,
            containsUntrustedText: false,
            containsSecrets: false,
          },
        };
      });

      const mockRuntime = {
        id: 'test-runtime',
        presetName: 'test',
        policies: { get: () => null },
        toolRouter: { execute },
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

    test('should delegate router cache policy instead of pipeline cache middleware', async () => {
      const pipeline = new ToolExecutionPipeline().use(observationRecord);
      const envelope = {
        ok: true,
        toolId: 'cached_tool',
        callId: 'router-cache-hit',
        startedAt: new Date().toISOString(),
        durationMs: 0,
        status: 'success',
        text: 'Cached result for cached_tool',
        structuredContent: { cached: true },
        cache: { hit: true, policy: 'session' },
        diagnostics: {
          degraded: false,
          fallbackUsed: false,
          warnings: [],
          timedOutStages: [],
          blockedTools: [],
          truncatedToolCalls: 0,
          emptyResponses: 0,
          aiErrorCount: 0,
          gateFailures: [],
        },
        trust: {
          source: 'internal',
          sanitized: true,
          containsUntrustedText: false,
          containsSecrets: false,
        },
      };
      const execute = vi.fn().mockResolvedValue(envelope);
      const memoryCoordinator = {
        getCachedResult: vi.fn().mockReturnValue({ stale: true }),
        recordObservation: vi.fn(),
      };

      const result = await pipeline.execute(
        { name: 'cached_tool', args: { query: 'q' }, id: 'call-router-cache' },
        {
          runtime: {
            id: 'r',
            presetName: 'test',
            policies: { get: () => null, validateToolCall: vi.fn() },
            toolRouter: { execute },
            container: {},
            projectRoot: '/tmp',
          } as never,
          loopCtx: {
            source: 'test',
            sharedState: {},
            memoryCoordinator,
          } as never,
          iteration: 0,
        }
      );

      expect(memoryCoordinator.getCachedResult).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          toolId: 'cached_tool',
          runtime: expect.objectContaining({ cache: memoryCoordinator }),
        })
      );
      expect(result.metadata.cacheHit).toBe(true);
      expect(result.metadata.envelope).toEqual(envelope);
      expect(result.result).toEqual({ cached: true });
      expect(memoryCoordinator.recordObservation).toHaveBeenCalledWith(
        'cached_tool',
        { query: 'q' },
        envelope,
        0,
        true
      );
    });

    test('should pass abortSignal to ToolRouter request', async () => {
      const pipeline = new ToolExecutionPipeline();
      const abortController = new AbortController();
      let capturedSignal: AbortSignal | null = null;
      const execute = vi.fn(async (request) => {
        capturedSignal = request.abortSignal;
        return {
          ok: true,
          toolId: 'signal_aware_tool',
          callId: 'router-signal',
          startedAt: new Date().toISOString(),
          durationMs: 0,
          status: 'success',
          text: 'ok',
          structuredContent: { ok: true },
          diagnostics: {
            degraded: false,
            fallbackUsed: false,
            warnings: [],
            timedOutStages: [],
            blockedTools: [],
            truncatedToolCalls: 0,
            emptyResponses: 0,
            aiErrorCount: 0,
            gateFailures: [],
          },
          trust: {
            source: 'internal',
            sanitized: true,
            containsUntrustedText: false,
            containsSecrets: false,
          },
        };
      });

      const result = await pipeline.execute(
        { name: 'signal_aware_tool', args: {}, id: 'call-signal' },
        {
          runtime: {
            id: 'r',
            presetName: 'test',
            policies: { get: () => null },
            toolRouter: { execute },
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

    test('should delegate already aborted calls to ToolRouter', async () => {
      const pipeline = new ToolExecutionPipeline();
      const abortController = new AbortController();
      abortController.abort();
      const execute = vi.fn(async () => ({
        ok: false,
        toolId: 'slow_tool',
        callId: 'router-aborted',
        startedAt: new Date().toISOString(),
        durationMs: 0,
        status: 'aborted',
        text: 'Tool execution aborted before start',
        diagnostics: {
          degraded: false,
          fallbackUsed: false,
          warnings: [],
          timedOutStages: [],
          blockedTools: [],
          truncatedToolCalls: 0,
          emptyResponses: 0,
          aiErrorCount: 0,
          gateFailures: [],
        },
        trust: {
          source: 'internal',
          sanitized: true,
          containsUntrustedText: false,
          containsSecrets: false,
        },
      }));

      const result = await pipeline.execute(
        { name: 'slow_tool', args: {}, id: 'call-aborted' },
        {
          runtime: {
            id: 'r',
            presetName: 'test',
            policies: { get: () => null },
            toolRouter: { execute },
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

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ abortSignal: abortController.signal })
      );
      expect(result.metadata.blocked).toBe(true);
      expect(result.result).toEqual({ error: 'Tool execution aborted before start' });
    });

    test('should delegate already aborted router calls to Governance', async () => {
      const pipeline = new ToolExecutionPipeline();
      const abortController = new AbortController();
      abortController.abort();
      const envelope = {
        ok: false,
        toolId: 'slow_tool',
        callId: 'router-call-aborted',
        startedAt: new Date().toISOString(),
        durationMs: 0,
        status: 'aborted',
        text: 'Tool execution aborted before start',
        diagnostics: {
          degraded: false,
          fallbackUsed: false,
          warnings: [],
          timedOutStages: [],
          blockedTools: [{ tool: 'slow_tool', reason: 'Tool execution aborted before start' }],
          truncatedToolCalls: 0,
          emptyResponses: 0,
          aiErrorCount: 0,
          gateFailures: [
            {
              stage: 'execute',
              action: 'block',
              reason: 'Tool execution aborted before start',
            },
          ],
        },
        trust: {
          source: 'internal',
          sanitized: true,
          containsUntrustedText: false,
          containsSecrets: false,
        },
      };
      const execute = vi.fn().mockResolvedValue(envelope);
      const diagnostics = new DiagnosticsCollector();

      const result = await pipeline.execute(
        { name: 'slow_tool', args: {}, id: 'call-aborted-router' },
        {
          runtime: {
            id: 'r',
            presetName: 'test',
            policies: { get: () => null, validateToolCall: vi.fn() },
            toolRouter: { execute },
            container: {},
            projectRoot: '/tmp',
          } as never,
          loopCtx: {
            source: 'test',
            sharedState: {},
            abortSignal: abortController.signal,
            diagnostics,
          } as never,
          iteration: 0,
        }
      );

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          toolId: 'slow_tool',
          abortSignal: abortController.signal,
        })
      );
      expect(result.metadata.blocked).toBe(true);
      expect(result.metadata.envelope).toEqual(envelope);
      expect(result.result).toEqual({ error: 'Tool execution aborted before start' });
      expect(diagnostics.toJSON().blockedTools).toEqual([
        expect.objectContaining({
          tool: 'slow_tool',
          reason: 'Tool execution aborted before start',
        }),
      ]);
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
