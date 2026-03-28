import { describe, expect, it, vi } from 'vitest';

import { DynamicComposer } from '../../lib/agent/forge/DynamicComposer.js';

/* ────────── Mock ToolRegistry ────────── */

function createMockRegistry(tools: Record<string, (params: Record<string, unknown>) => unknown>) {
  return {
    has: (name: string) => name in tools,
    execute: vi.fn(async (name: string, params: Record<string, unknown>) => {
      if (!(name in tools)) {
        throw new Error(`Tool '${name}' not found`);
      }
      return tools[name](params);
    }),
  };
}

describe('DynamicComposer', () => {
  describe('validate', () => {
    it('should pass when all tools exist', () => {
      const reg = createMockRegistry({ read_file: () => 'data', parse_json: () => ({}) });
      const composer = new DynamicComposer(reg);

      const result = composer.validate({
        name: 'test',
        description: 'test',
        steps: [
          { tool: 'read_file', args: {} },
          { tool: 'parse_json', args: {} },
        ],
        mergeStrategy: 'sequential',
      });

      expect(result.valid).toBe(true);
      expect(result.missingTools).toHaveLength(0);
    });

    it('should report missing tools', () => {
      const reg = createMockRegistry({ read_file: () => 'data' });
      const composer = new DynamicComposer(reg);

      const result = composer.validate({
        name: 'test',
        description: 'test',
        steps: [
          { tool: 'read_file', args: {} },
          { tool: 'ghost_tool', args: {} },
        ],
        mergeStrategy: 'sequential',
      });

      expect(result.valid).toBe(false);
      expect(result.missingTools).toEqual(['ghost_tool']);
    });
  });

  describe('compose', () => {
    it('should fail with empty steps', () => {
      const reg = createMockRegistry({});
      const composer = new DynamicComposer(reg);

      const result = composer.compose({
        name: 'empty',
        description: 'empty',
        steps: [],
        mergeStrategy: 'sequential',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('at least one step');
    });

    it('should fail with missing tools', () => {
      const reg = createMockRegistry({});
      const composer = new DynamicComposer(reg);

      const result = composer.compose({
        name: 'missing',
        description: 'missing',
        steps: [{ tool: 'nope', args: {} }],
        mergeStrategy: 'sequential',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing tools');
    });

    describe('sequential', () => {
      it('should chain tool executions', async () => {
        const reg = createMockRegistry({
          double: (p) => ({ value: (p.value as number) * 2 }),
          add_ten: (p) => ({ value: (p.value as number) + 10 }),
        });
        const composer = new DynamicComposer(reg);

        const result = composer.compose({
          name: 'double_then_add',
          description: 'double then add ten',
          steps: [
            { tool: 'double', args: { value: 5 } },
            { tool: 'add_ten', args: (prev) => ({ value: (prev as { value: number }).value }) },
          ],
          mergeStrategy: 'sequential',
        });

        expect(result.success).toBe(true);
        expect(result.handler).toBeDefined();

        const output = await result.handler!({}, {});
        expect(output).toEqual({ value: 20 });
      });

      it('should support extractKey', async () => {
        const reg = createMockRegistry({
          search: () => ({ items: [1, 2, 3], total: 3 }),
          count: (p) => ({ count: (p.items as number[]).length }),
        });
        const composer = new DynamicComposer(reg);

        const result = composer.compose({
          name: 'search_count',
          description: 'search and count',
          steps: [
            { tool: 'search', args: {}, extractKey: 'items' },
            { tool: 'count', args: (prev) => ({ items: prev }) },
          ],
          mergeStrategy: 'sequential',
        });

        expect(result.success).toBe(true);
        const output = await result.handler!({}, {});
        expect(output).toEqual({ count: 3 });
      });
    });

    describe('parallel', () => {
      it('should execute all steps concurrently', async () => {
        const reg = createMockRegistry({
          get_name: () => ({ name: 'Alice' }),
          get_age: () => ({ age: 30 }),
        });
        const composer = new DynamicComposer(reg);

        const result = composer.compose({
          name: 'profile',
          description: 'parallel profile',
          steps: [
            { tool: 'get_name', args: {} },
            { tool: 'get_age', args: {} },
          ],
          mergeStrategy: 'parallel',
        });

        expect(result.success).toBe(true);
        const output = (await result.handler!({}, {})) as Record<string, unknown>;
        expect(output).toHaveProperty('get_name');
        expect(output).toHaveProperty('get_age');
        expect(output.get_name).toEqual({ name: 'Alice' });
        expect(output.get_age).toEqual({ age: 30 });
      });

      it('should handle partial failures gracefully', async () => {
        const reg = createMockRegistry({
          ok_tool: () => ({ data: 'ok' }),
          bad_tool: () => {
            throw new Error('fail');
          },
        });
        const composer = new DynamicComposer(reg);

        const result = composer.compose({
          name: 'partial_fail',
          description: 'partial',
          steps: [
            { tool: 'ok_tool', args: {} },
            { tool: 'bad_tool', args: {} },
          ],
          mergeStrategy: 'parallel',
        });

        expect(result.success).toBe(true);
        const output = (await result.handler!({}, {})) as Record<string, unknown>;
        expect(output.ok_tool).toEqual({ data: 'ok' });
        // 失败的 step 应产生 error 条目
        const errorKeys = Object.keys(output).filter((k) => k.startsWith('error_'));
        expect(errorKeys.length).toBe(1);
      });
    });
  });
});
