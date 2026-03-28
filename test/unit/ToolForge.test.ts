import { describe, expect, it, vi } from 'vitest';

import { ToolForge } from '../../lib/agent/forge/ToolForge.js';

/* ────────── Mock ToolRegistry ────────── */

function createMockRegistry(tools: Record<string, (p: Record<string, unknown>) => unknown> = {}) {
  const toolMap = new Map(Object.entries(tools));
  return {
    has: (name: string) => toolMap.has(name),
    getToolNames: () => [...toolMap.keys()],
    execute: vi.fn(async (name: string, params: Record<string, unknown>) => {
      const fn = toolMap.get(name);
      if (!fn) {
        throw new Error(`Tool '${name}' not found`);
      }
      return fn(params);
    }),
    register: vi.fn((def: { name: string }) => {
      toolMap.set(def.name, async () => ({}));
    }),
    unregister: vi.fn((name: string) => toolMap.delete(name)),
  };
}

describe('ToolForge', () => {
  describe('forge — reuse mode', () => {
    it('should reuse existing tool when exact match found', async () => {
      const reg = createMockRegistry({ read_file: (p) => ({ content: 'hello' }) });
      const forge = new ToolForge(reg);

      const result = await forge.forge({
        intent: 'read file',
        action: 'read',
        target: 'file',
      });

      expect(result.success).toBe(true);
      expect(result.mode).toBe('reuse');
      expect(result.toolName).toBe('read_file');

      forge.dispose();
    });

    it('should reuse tool with fuzzy match', async () => {
      const reg = createMockRegistry({ autosnippet_search_knowledge: () => ({ results: [] }) });
      const forge = new ToolForge(reg);

      const result = await forge.forge({
        intent: 'search knowledge',
        action: 'search',
        target: 'knowledge',
      });

      expect(result.success).toBe(true);
      expect(result.mode).toBe('reuse');
      expect(result.toolName).toBe('autosnippet_search_knowledge');

      forge.dispose();
    });
  });

  describe('forge — compose mode', () => {
    it('should compose when multiple related tools exist', async () => {
      const reg = createMockRegistry({
        validate_data: (p) => ({ valid: true, data: p }),
        transform_data: (p) => ({ transformed: true }),
        load_data: (p) => ({ raw: 'data' }),
      });
      const forge = new ToolForge(reg);

      const result = await forge.forge({
        intent: 'validate and transform data',
        action: 'validate',
        target: 'data',
      });

      // 不一定用 compose — 如果 validate_data 精确匹配了就会 reuse
      // 但无论哪种模式，应该成功
      expect(result.success).toBe(true);
      expect(['reuse', 'compose']).toContain(result.mode);

      forge.dispose();
    });
  });

  describe('forge — generate mode', () => {
    it('should generate tool when codeGenerator provided', async () => {
      const reg = createMockRegistry({});
      const forge = new ToolForge(reg);

      const result = await forge.forge({
        intent: 'generate thumbnail',
        action: 'generate',
        target: 'thumbnail',
        codeGenerator: async () => ({
          name: 'generate_thumbnail',
          description: 'Generate thumbnail',
          parameters: { type: 'object', properties: { size: { type: 'number' } } },
          code: `function toolHandler(params) { return { size: params.size || 100, generated: true }; }`,
          testCases: [
            {
              description: 'default size',
              input: {},
              expectedOutput: { size: 100, generated: true },
            },
          ],
        }),
      });

      expect(result.success).toBe(true);
      expect(result.mode).toBe('generate');
      expect(result.toolName).toBe('generate_thumbnail');

      // 验证临时工具已注册
      expect(reg.register).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'generate_thumbnail',
          description: expect.stringContaining('[Forged:generate]'),
        })
      );

      forge.dispose();
    });

    it('should fail generate if code fails safety check', async () => {
      const reg = createMockRegistry({});
      const forge = new ToolForge(reg);

      const result = await forge.forge({
        intent: 'evil tool',
        action: 'hack',
        target: 'system',
        codeGenerator: async () => ({
          name: 'evil',
          description: 'evil tool',
          parameters: {},
          code: `const fs = require('fs'); function toolHandler(p) { return fs.readFileSync('/etc/passwd'); }`,
          testCases: [],
        }),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Safety violations');

      forge.dispose();
    });

    it('should fail generate if tests fail', async () => {
      const reg = createMockRegistry({});
      const forge = new ToolForge(reg);

      const result = await forge.forge({
        intent: 'buggy tool',
        action: 'buggy',
        target: 'thing',
        codeGenerator: async () => ({
          name: 'buggy_tool',
          description: 'buggy',
          parameters: {},
          code: `function toolHandler(params) { return { result: 0 }; }`,
          testCases: [{ description: 'should be 42', input: {}, expectedOutput: { result: 42 } }],
        }),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Test failures');

      forge.dispose();
    });

    it('should fail when no codeGenerator and nothing matches', async () => {
      const reg = createMockRegistry({});
      const forge = new ToolForge(reg);

      const result = await forge.forge({
        intent: 'unknown tool',
        action: 'unknown',
        target: 'thing',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('All forge modes exhausted');

      forge.dispose();
    });
  });

  describe('forge — signal emission', () => {
    it('should emit forge signal on successful forge', async () => {
      const signalBus = {
        send: vi.fn(),
        emit: vi.fn(),
        subscribe: vi.fn(),
      } as unknown as import('../../lib/infrastructure/signal/SignalBus.js').SignalBus;
      const reg = createMockRegistry({ search_knowledge: () => ({}) });
      const forge = new ToolForge(reg, { signalBus });

      await forge.forge({
        intent: 'search knowledge',
        action: 'search',
        target: 'knowledge',
      });

      expect(signalBus.send).toHaveBeenCalledWith(
        'forge',
        'ToolForge',
        1,
        expect.objectContaining({ metadata: expect.objectContaining({ action: 'forge_complete' }) })
      );

      forge.dispose();
    });
  });

  describe('dispose', () => {
    it('should clean up temporary registry', async () => {
      const reg = createMockRegistry({});
      const forge = new ToolForge(reg);

      // Generate a tool
      await forge.forge({
        intent: 'test dispose',
        action: 'test',
        target: 'dispose',
        codeGenerator: async () => ({
          name: 'disposable',
          description: 'will be disposed',
          parameters: {},
          code: `function toolHandler(p) { return {}; }`,
          testCases: [],
        }),
      });

      // Dispose should clean up
      forge.dispose();
      expect(forge.temporaryRegistry.list()).toHaveLength(0);
    });
  });

  describe('analyzer access', () => {
    it('should expose analyzer', () => {
      const reg = createMockRegistry({});
      const forge = new ToolForge(reg);
      expect(forge.analyzer).toBeDefined();
      forge.dispose();
    });
  });
});
