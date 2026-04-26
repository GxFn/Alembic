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

function createComposerContext(
  tools: Record<string, (params: Record<string, unknown>) => unknown>
) {
  const executeChildCall = vi.fn(
    async (request: { toolId: string; args: Record<string, unknown>; parentCallId: string }) => {
      try {
        const structuredContent = tools[request.toolId](request.args);
        return {
          ok: true,
          toolId: request.toolId,
          callId: `child-${request.toolId}`,
          parentCallId: request.parentCallId,
          startedAt: new Date().toISOString(),
          durationMs: 0,
          status: 'success',
          text: 'ok',
          structuredContent,
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
      } catch (err: unknown) {
        return {
          ok: false,
          toolId: request.toolId,
          callId: `child-${request.toolId}`,
          parentCallId: request.parentCallId,
          startedAt: new Date().toISOString(),
          durationMs: 0,
          status: 'error',
          text: err instanceof Error ? err.message : String(err),
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
      }
    }
  );

  const router = { execute: vi.fn(), executeChildCall, explain: vi.fn() };
  return {
    context: {
      toolCallContext: {
        callId: 'parent-call',
        toolId: 'composed_tool',
        surface: 'runtime',
        actor: { role: 'runtime' },
        source: { kind: 'runtime', name: 'test' },
        projectRoot: '/tmp',
        services: {
          get: () => {
            throw new Error('composer should use the tool routing service contract');
          },
        },
        serviceContracts: {
          toolRouting: { toolRouter: router },
        },
      },
    } as never,
    executeChildCall,
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

    it('should let Governance handle side-effect tools in composition steps', async () => {
      const reg = createMockRegistry({
        search: () => ({ items: [] }),
        submit_knowledge: () => ({ ok: true }),
      });
      const composer = new DynamicComposer(reg);

      const result = composer.compose({
        name: 'unsafe_submit_flow',
        description: 'unsafe submit flow',
        steps: [
          { tool: 'search', args: {} },
          { tool: 'submit_knowledge', args: {} },
        ],
        mergeStrategy: 'sequential',
      });

      expect(result.success).toBe(true);
      if (!result.handler) {
        throw new Error('Expected composed handler');
      }

      const executeChildCall = vi.fn(async (request) => ({
        ok: request.toolId !== 'submit_knowledge',
        toolId: request.toolId,
        callId: `child-${request.toolId}`,
        parentCallId: request.parentCallId,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        status: request.toolId === 'submit_knowledge' ? 'blocked' : 'success',
        text:
          request.toolId === 'submit_knowledge'
            ? "Capability 'submit_knowledge' is not composable"
            : 'ok',
        structuredContent: request.toolId === 'submit_knowledge' ? undefined : { items: [] },
        diagnostics: {
          degraded: false,
          fallbackUsed: false,
          warnings: [],
          timedOutStages: [],
          blockedTools:
            request.toolId === 'submit_knowledge'
              ? [
                  {
                    tool: request.toolId,
                    reason: "Capability 'submit_knowledge' is not composable",
                  },
                ]
              : [],
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

      const output = await result.handler({}, {
        toolRouter: { executeChildCall },
        toolCallContext: {
          callId: 'parent-call',
          toolId: 'unsafe_submit_flow',
          surface: 'runtime',
          actor: { role: 'runtime' },
          source: { kind: 'runtime', name: 'test' },
          projectRoot: '/tmp',
          services: {
            get: () => {
              throw new Error('composer should use context.toolRouter before services');
            },
          },
        },
      } as never);

      expect(output).toMatchObject({
        error: "Capability 'submit_knowledge' is not composable",
        status: 'blocked',
        tool: 'submit_knowledge',
      });
      expect(executeChildCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolId: 'submit_knowledge',
          surface: 'composer',
          parentCallId: 'parent-call',
        })
      );
    });

    it('should defer non-composable step decisions to child Governance', () => {
      const reg = createMockRegistry({
        get_tool_details: () => ({ parameters: {} }),
      });
      const composer = new DynamicComposer(reg);

      const result = composer.compose({
        name: 'meta_lookup_flow',
        description: 'meta lookup flow',
        steps: [{ tool: 'get_tool_details', args: { toolName: 'search_recipes' } }],
        mergeStrategy: 'sequential',
      });

      expect(result.success).toBe(true);
      expect(result.handler).toBeDefined();
    });

    describe('sequential', () => {
      it('should chain tool executions', async () => {
        const tools = {
          double: (p) => ({ value: (p.value as number) * 2 }),
          add_ten: (p) => ({ value: (p.value as number) + 10 }),
        };
        const reg = createMockRegistry(tools);
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
        if (!result.handler) {
          throw new Error('Expected composed handler');
        }

        const { context } = createComposerContext(tools);
        const output = await result.handler({}, context);
        expect(output).toEqual({ value: 20 });
      });

      it('should support extractKey', async () => {
        const tools = {
          search: () => ({ items: [1, 2, 3], total: 3 }),
          count: (p) => ({ count: (p.items as number[]).length }),
        };
        const reg = createMockRegistry(tools);
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
        if (!result.handler) {
          throw new Error('Expected composed handler');
        }
        const { context } = createComposerContext(tools);
        const output = await result.handler({}, context);
        expect(output).toEqual({ count: 3 });
      });
    });

    describe('parallel', () => {
      it('should execute all steps concurrently', async () => {
        const tools = {
          get_name: () => ({ name: 'Alice' }),
          get_age: () => ({ age: 30 }),
        };
        const reg = createMockRegistry(tools);
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
        if (!result.handler) {
          throw new Error('Expected composed handler');
        }
        const { context } = createComposerContext(tools);
        const output = (await result.handler({}, context)) as Record<string, unknown>;
        expect(output).toHaveProperty('get_name');
        expect(output).toHaveProperty('get_age');
        expect(output.get_name).toEqual({ name: 'Alice' });
        expect(output.get_age).toEqual({ age: 30 });
      });

      it('should project failed child envelopes in parallel results', async () => {
        const tools = {
          ok_tool: () => ({ data: 'ok' }),
          bad_tool: () => {
            throw new Error('fail');
          },
        };
        const reg = createMockRegistry(tools);
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
        if (!result.handler) {
          throw new Error('Expected composed handler');
        }
        const { context } = createComposerContext(tools);
        const output = (await result.handler({}, context)) as Record<string, unknown>;
        expect(output.ok_tool).toEqual({ data: 'ok' });
        expect(output.bad_tool).toMatchObject({ error: 'fail', status: 'error' });
      });
    });
  });
});
