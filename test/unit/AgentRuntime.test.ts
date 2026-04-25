/**
 * AgentRuntime 单元测试
 *
 * 覆盖核心 ReAct 循环：execute 入口、Policy 校验、超时保护、
 * reactLoop 迭代、工具调用处理、文本响应、中止、错误恢复
 */
import { describe, expect, test, vi } from 'vitest';
import { AgentRuntime, MAX_TOOL_CALLS_PER_ITER } from '../../lib/agent/AgentRuntime.js';

/* ══════════════════════════════════════════════════════
 *  Mock Factories
 * ══════════════════════════════════════════════════════ */

/** 模拟 AiProvider — 最小化接口 */
function mockAiProvider(overrides: Record<string, unknown> = {}) {
  return {
    name: 'mock-provider',
    model: 'mock-model',
    chatWithTools: vi.fn().mockResolvedValue({
      type: 'text',
      text: 'This is a final answer from the AI.',
      functionCalls: null,
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
    chat: vi.fn().mockResolvedValue('mock chat response'),
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    supportsEmbedding: () => true,
    supportsNativeToolCalling: true,
    _circuitState: 'CLOSED',
    ...overrides,
  };
}

/** 模拟 ToolRegistry — 最小化接口 */
function mockToolRegistry() {
  return {
    getToolSchemas: vi.fn().mockReturnValue([
      {
        name: 'search_knowledge',
        description: 'Search the knowledge base',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ]),
    execute: vi.fn().mockResolvedValue({ result: 'tool result' }),
    getToolNames: vi.fn().mockReturnValue(['search_knowledge']),
    has: vi.fn().mockReturnValue(true),
  };
}

/** 模拟 Strategy — Single strategy (直接调用 reactLoop) */
function mockStrategy(overrides: Record<string, unknown> = {}) {
  return {
    name: 'single',
    execute: vi
      .fn()
      .mockImplementation(async (runtime: AgentRuntime, message: Record<string, unknown>) => {
        const text = (message.text || message.content || '') as string;
        return runtime.reactLoop(text, {});
      }),
    ...overrides,
  };
}

/** 模拟 PolicyEngine */
function mockPolicies(overrides: Record<string, unknown> = {}) {
  return {
    validateBefore: vi.fn().mockReturnValue({ ok: true }),
    validateDuring: vi.fn().mockReturnValue({ ok: true }),
    validateAfter: vi.fn().mockReturnValue({ ok: true }),
    validateToolCall: vi.fn().mockReturnValue({ ok: true }),
    getBudget: vi.fn().mockReturnValue({
      maxIterations: 10,
      maxTokens: 100000,
      timeoutMs: 30000,
    }),
    ...overrides,
  };
}

/** 模拟 AgentMessage */
function mockMessage(text = 'Hello, help me understand the codebase') {
  return {
    text,
    content: text,
    role: 'user',
    channel: 'test',
    replyFn: null as ((text: string) => Promise<void>) | null,
    reply: vi.fn(),
    // Partial mock — only fields used by AgentRuntime.execute()
  } as unknown as import('../../lib/agent/AgentMessage.js').AgentMessage;
}

function createRuntime(overrides: Record<string, unknown> = {}) {
  return new AgentRuntime({
    aiProvider: mockAiProvider(),
    toolRegistry: mockToolRegistry(),
    strategy: mockStrategy(),
    policies: mockPolicies(),
    capabilities: [],
    projectRoot: '/tmp/test-project',
    ...overrides,
    // eslint-disable-next-line -- partial mock intentionally omits AiProvider internals
  } as unknown as ConstructorParameters<typeof AgentRuntime>[0]);
}

/* ══════════════════════════════════════════════════════
 *  Tests
 * ══════════════════════════════════════════════════════ */

describe('AgentRuntime', () => {
  /* ──── 构造和初始化 ──── */

  describe('constructor', () => {
    test('should initialize with required config', () => {
      const rt = createRuntime();
      expect(rt.id).toBeDefined();
      expect(rt.id).toContain('runtime_');
      expect(rt.presetName).toBe('custom');
      expect(rt.iterationCount).toBe(0);
      expect(rt.toolCallHistory).toEqual([]);
      expect(rt.tokenUsage).toEqual({ input: 0, output: 0 });
    });

    test('should accept custom id and presetName', () => {
      const rt = createRuntime({ id: 'custom-id', presetName: 'insight' });
      expect(rt.id).toBe('custom-id');
      expect(rt.presetName).toBe('insight');
    });

    test('should have accessible projectRoot', () => {
      const rt = createRuntime({ projectRoot: '/my/project' });
      expect(rt.projectRoot).toBe('/my/project');
    });
  });

  /* ──── execute() 入口 ──── */

  describe('execute', () => {
    test('should delegate to strategy and return AgentResult', async () => {
      const strategy = mockStrategy();
      const rt = createRuntime({ strategy });
      const msg = mockMessage();

      const result = await rt.execute(msg);

      expect(strategy.execute).toHaveBeenCalledWith(rt, msg, expect.any(Object));
      expect(result).toBeDefined();
      expect(result.reply).toBeDefined();
      expect(result.state).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.diagnostics).toMatchObject({
        aiErrorCount: 0,
        blockedTools: [],
        degraded: false,
      });
    });

    test('should reject when policy validateBefore fails', async () => {
      const policies = mockPolicies({
        validateBefore: vi.fn().mockReturnValue({ ok: false, reason: 'Forbidden' }),
      });
      const rt = createRuntime({ policies });
      const result = await rt.execute(mockMessage());

      expect(result.reply).toContain('Forbidden');
      expect(result.iterations).toBe(0);
      expect(result.toolCalls).toEqual([]);
      expect(result.diagnostics?.warnings).toEqual([
        expect.objectContaining({ code: 'policy_rejected' }),
      ]);
    });

    test('should add qualityWarning when policy validateAfter fails', async () => {
      const policies = mockPolicies({
        validateAfter: vi.fn().mockReturnValue({ ok: false, reason: 'Low quality output' }),
      });
      const rt = createRuntime({ policies });
      const result = await rt.execute(mockMessage());

      expect(result.qualityWarning).toBe('Low quality output');
      expect(result.diagnostics?.warnings).toEqual([
        expect.objectContaining({ code: 'quality_warning' }),
      ]);
    });

    test('should handle timeout', async () => {
      const slowStrategy = mockStrategy({
        execute: vi.fn().mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 5000));
          return {
            reply: 'too late',
            toolCalls: [],
            tokenUsage: { input: 0, output: 0 },
            iterations: 0,
          };
        }),
      });
      const policies = mockPolicies({
        getBudget: vi.fn().mockReturnValue({ timeoutMs: 100 }),
      });
      const rt = createRuntime({ strategy: slowStrategy, policies });

      await expect(rt.execute(mockMessage())).rejects.toThrow(/timeout/i);
    });

    test('should abort strategy signal when top-level timeout fires', async () => {
      let capturedSignal: AbortSignal | null = null;
      const slowStrategy = mockStrategy({
        execute: vi.fn().mockImplementation(async (_runtime, _message, opts) => {
          capturedSignal = (opts?.abortSignal as AbortSignal) || null;
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return {
            reply: 'too late',
            toolCalls: [],
            tokenUsage: { input: 0, output: 0 },
            iterations: 0,
          };
        }),
      });
      const policies = mockPolicies({
        getBudget: vi.fn().mockReturnValue({ timeoutMs: 50 }),
      });
      const rt = createRuntime({ strategy: slowStrategy, policies });

      await expect(rt.execute(mockMessage())).rejects.toThrow(/timeout/i);
      expect(capturedSignal?.aborted).toBe(true);
    });
  });

  /* ──── reactLoop() 核心 ReAct 循环 ──── */

  describe('reactLoop', () => {
    test('should return text response on simple conversation', async () => {
      const rt = createRuntime();
      const result = await rt.reactLoop('What is this project?');

      expect(result.reply).toBeDefined();
      expect(typeof result.reply).toBe('string');
      expect(result.iterations).toBeGreaterThanOrEqual(1);
    });

    test('should execute tool calls when AI returns function calls', async () => {
      const toolRegistry = mockToolRegistry();
      const aiProvider = mockAiProvider({
        chatWithTools: vi
          .fn()
          .mockResolvedValueOnce({
            type: 'function_call',
            text: null,
            functionCalls: [
              { id: 'call_1', name: 'search_knowledge', args: { query: 'patterns' } },
            ],
            usage: { inputTokens: 100, outputTokens: 50 },
          })
          .mockResolvedValueOnce({
            type: 'text',
            text: 'Based on the search results, here are the patterns.',
            functionCalls: null,
            usage: { inputTokens: 200, outputTokens: 100 },
          }),
      });
      const rt = createRuntime({ aiProvider, toolRegistry });
      const result = await rt.reactLoop('Search for patterns');

      expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
      expect(result.tokenUsage.input).toBeGreaterThan(0);
    });

    test('should accumulate token usage across iterations', async () => {
      const aiProvider = mockAiProvider({
        chatWithTools: vi
          .fn()
          .mockResolvedValueOnce({
            type: 'function_call',
            functionCalls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'test' } }],
            usage: { inputTokens: 100, outputTokens: 50 },
          })
          .mockResolvedValueOnce({
            type: 'text',
            text: 'Final answer',
            usage: { inputTokens: 200, outputTokens: 100 },
          }),
      });
      const rt = createRuntime({ aiProvider });
      const result = await rt.reactLoop('query');

      expect(result.tokenUsage.input).toBe(300);
      expect(result.tokenUsage.output).toBe(150);
    });

    test('should tell the model when tool calls are truncated', async () => {
      const functionCalls = Array.from({ length: MAX_TOOL_CALLS_PER_ITER + 2 }, (_, index) => ({
        id: `c${index}`,
        name: 'search_knowledge',
        args: { query: `q${index}` },
      }));
      const chatWithTools = vi
        .fn()
        .mockResolvedValueOnce({
          type: 'function_call',
          functionCalls,
          usage: { inputTokens: 100, outputTokens: 50 },
        })
        .mockResolvedValueOnce({
          type: 'text',
          text: 'Final answer',
          usage: { inputTokens: 100, outputTokens: 50 },
        });
      const aiProvider = mockAiProvider({ chatWithTools });
      const toolRegistry = mockToolRegistry();
      const rt = createRuntime({ aiProvider, toolRegistry });

      const result = await rt.reactLoop('query');
      const secondCallOptions = chatWithTools.mock.calls[1][1] as {
        messages: Array<{ content?: string }>;
      };

      expect(result.toolCalls).toHaveLength(MAX_TOOL_CALLS_PER_ITER);
      expect(result.diagnostics?.truncatedToolCalls).toBe(2);
      expect(toolRegistry.execute).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_ITER);
      expect(
        secondCallOptions.messages.some((msg) => msg.content?.includes('工具调用数量超限'))
      ).toBe(true);
    });

    test('should respect history parameter', async () => {
      const aiProvider = mockAiProvider();
      const rt = createRuntime({ aiProvider });
      await rt.reactLoop('follow up', {
        history: [
          { role: 'user', content: 'previous message' },
          { role: 'assistant', content: 'previous reply' },
        ],
      });

      expect(aiProvider.chatWithTools).toHaveBeenCalled();
    });

    test('should support capability override', async () => {
      const rt = createRuntime();
      const result = await rt.reactLoop('analyze code', {
        capabilityOverride: ['code_analysis'],
      });

      expect(result).toBeDefined();
    });
  });

  /* ──── abort() ──── */

  describe('abort', () => {
    test('should stop the runtime', () => {
      const rt = createRuntime();
      // abort should not throw
      expect(() => rt.abort('user cancelled')).not.toThrow();
    });
  });

  /* ──── fileCache ──── */

  describe('fileCache', () => {
    test('should accept and expose file cache', () => {
      const rt = createRuntime();
      const files = [{ relativePath: 'src/index.ts', content: 'export {}', name: 'index.ts' }];
      rt.setFileCache(files);
      expect(rt.fileCache).toEqual(files);
    });

    test('should accept null to clear cache', () => {
      const rt = createRuntime();
      rt.setFileCache([{ relativePath: 'a.ts', content: '', name: 'a.ts' }]);
      rt.setFileCache(null);
      expect(rt.fileCache).toBeNull();
    });
  });

  /* ──── emitProgress ──── */

  describe('emitProgress', () => {
    test('should call onProgress callback', () => {
      const onProgress = vi.fn();
      const rt = createRuntime({ onProgress });
      rt.emitProgress('thinking', { detail: 'analyzing...' });

      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ type: 'thinking' }));
    });

    test('should not throw when onProgress is null', () => {
      const rt = createRuntime({ onProgress: null });
      expect(() => rt.emitProgress('test', {})).not.toThrow();
    });
  });

  /* ──── AI 错误恢复 ──── */

  describe('error recovery', () => {
    test('should handle AI provider throwing an error', async () => {
      const aiProvider = mockAiProvider({
        chatWithTools: vi.fn().mockRejectedValue(new Error('API rate limited')),
        _circuitState: 'CLOSED',
      });
      const rt = createRuntime({ aiProvider });

      // Should not propagate the error unhandled — produces a fallback reply
      const result = await rt.reactLoop('test query');
      expect(result).toBeDefined();
      expect(result.reply).toBeDefined();
    });

    test('should handle circuit breaker open state', async () => {
      const aiProvider = mockAiProvider({
        _circuitState: 'OPEN',
        chatWithTools: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('Circuit open'), { code: 'CIRCUIT_OPEN' })),
      });
      const rt = createRuntime({ aiProvider });

      const result = await rt.reactLoop('test');
      expect(result).toBeDefined();
    });
  });

  /* ──── 策略集成 ──── */

  describe('strategy integration', () => {
    test('should work with a custom strategy that wraps reactLoop', async () => {
      const customStrategy = {
        name: 'custom-wrap',
        execute: vi
          .fn()
          .mockImplementation(async (runtime: AgentRuntime, msg: Record<string, unknown>) => {
            const result = await runtime.reactLoop(msg.text as string, {
              systemPromptOverride: 'You are a custom agent.',
            });
            return { ...result, reply: `[Custom] ${result.reply}` };
          }),
      };
      const rt = createRuntime({ strategy: customStrategy });
      const result = await rt.execute(mockMessage('test'));

      expect(result.reply).toContain('[Custom]');
    });
  });
});
