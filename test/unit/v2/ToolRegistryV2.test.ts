import { describe, expect, test, vi } from 'vitest';
import {
  generateLightweightSchemas,
  getActionNames,
  getToolNames,
  TOOL_REGISTRY,
} from '#tools/v2/registry.js';
import { ToolRouterV2 } from '#tools/v2/router.js';
import type { CapabilityV2Def, ToolContext, ToolResult } from '#tools/v2/types.js';

const ALL_TOOL_NAMES = ['code', 'terminal', 'knowledge', 'graph', 'memory', 'meta'] as const;

const EXPECTED_ACTIONS: Record<string, string[]> = {
  code: ['search', 'read', 'outline', 'structure', 'write'],
  terminal: ['exec'],
  knowledge: ['search', 'submit', 'detail', 'manage'],
  graph: ['overview', 'query'],
  memory: ['save', 'recall', 'note_finding'],
  meta: ['tools', 'plan', 'review'],
};

const TOTAL_ACTIONS = Object.values(EXPECTED_ACTIONS).reduce((s, a) => s + a.length, 0);

function stubCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { projectRoot: '/tmp/test', tokenBudget: 4000, ...overrides };
}

/* ================================================================ */
/*  TOOL_REGISTRY structural integrity                               */
/* ================================================================ */

describe('TOOL_REGISTRY structural integrity', () => {
  test('registers all 6 tools', () => {
    expect(getToolNames().sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  test('each tool has the expected actions', () => {
    for (const [tool, actions] of Object.entries(EXPECTED_ACTIONS)) {
      expect(getActionNames(tool).sort()).toEqual([...actions].sort());
    }
  });

  test('total action count is 18', () => {
    const count = getToolNames().reduce((s, t) => s + getActionNames(t).length, 0);
    expect(count).toBe(18);
    expect(TOTAL_ACTIONS).toBe(18);
  });

  test('every action has handler, params schema, and summary', () => {
    for (const spec of Object.values(TOOL_REGISTRY)) {
      for (const [name, action] of Object.entries(spec.actions)) {
        expect(action.handler, `${spec.name}.${name} handler`).toBeTypeOf('function');
        expect(action.params, `${spec.name}.${name} params`).toBeDefined();
        expect(action.params.type, `${spec.name}.${name} params.type`).toBe('object');
        expect(action.summary, `${spec.name}.${name} summary`).toBeTruthy();
      }
    }
  });

  test('every tool spec has name and description', () => {
    for (const spec of Object.values(TOOL_REGISTRY)) {
      expect(spec.name).toBeTruthy();
      expect(spec.description).toBeTruthy();
    }
  });
});

/* ================================================================ */
/*  generateLightweightSchemas                                       */
/* ================================================================ */

describe('generateLightweightSchemas', () => {
  test('returns 6 schemas when unfiltered', () => {
    const schemas = generateLightweightSchemas();
    expect(schemas).toHaveLength(6);
  });

  test('filters by allowedTools', () => {
    const schemas = generateLightweightSchemas({ code: ['search', 'read'] });
    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe('code');
  });

  test('filters multiple tools', () => {
    const schemas = generateLightweightSchemas({
      code: ['search'],
      terminal: ['exec'],
      meta: ['tools'],
    });
    expect(schemas).toHaveLength(3);
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(['code', 'meta', 'terminal']);
  });

  test('schema format has name, description, and parameters with action enum', () => {
    const schemas = generateLightweightSchemas();
    for (const schema of schemas) {
      expect(schema.name).toBeTruthy();
      expect(schema.description).toBeTruthy();
      expect(schema.parameters).toBeDefined();

      const props = schema.parameters.properties as Record<string, Record<string, unknown>>;
      expect(props.action).toBeDefined();
      expect(props.action.type).toBe('string');
      expect(Array.isArray(props.action.enum)).toBe(true);
      expect((props.action.enum as string[]).length).toBeGreaterThan(0);

      expect(props.params).toBeDefined();
      expect(schema.parameters.required).toEqual(['action', 'params']);
    }
  });

  test('filtered schema action enum only contains allowed actions', () => {
    const schemas = generateLightweightSchemas({ code: ['search', 'write'] });
    const props = schemas[0].parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.action.enum).toEqual(['search', 'write']);
  });
});

/* ================================================================ */
/*  ToolRouterV2                                                     */
/* ================================================================ */

describe('ToolRouterV2', () => {
  describe('parseToolCall', () => {
    test('parses valid LLM raw arguments (object)', () => {
      const router = new ToolRouterV2();
      const result = router.parseToolCall('code', {
        action: 'search',
        params: { patterns: ['TODO'] },
      });
      expect(result).toEqual({
        tool: 'code',
        action: 'search',
        params: { patterns: ['TODO'] },
      });
    });

    test('parses valid LLM raw arguments (JSON string)', () => {
      const router = new ToolRouterV2();
      const result = router.parseToolCall(
        'terminal',
        JSON.stringify({ action: 'exec', params: { command: 'ls' } })
      );
      expect(result).toEqual({
        tool: 'terminal',
        action: 'exec',
        params: { command: 'ls' },
      });
    });

    test('defaults params to empty object when omitted', () => {
      const router = new ToolRouterV2();
      const result = router.parseToolCall('graph', { action: 'overview' });
      expect(result).toEqual({ tool: 'graph', action: 'overview', params: {} });
    });

    test('returns error when action is missing', () => {
      const router = new ToolRouterV2();
      const result = router.parseToolCall('code', { params: { path: 'a.ts' } });
      expect('error' in result).toBe(true);
      expect((result as { error: string }).error).toContain('Missing "action"');
    });

    test('returns error for malformed JSON string', () => {
      const router = new ToolRouterV2();
      const result = router.parseToolCall('code', '{invalid json}');
      expect('error' in result).toBe(true);
    });
  });

  describe('execute', () => {
    test('returns fail for unknown tool', async () => {
      const router = new ToolRouterV2();
      const result = await router.execute(
        { tool: 'nonexistent', action: 'foo', params: {} },
        stubCtx()
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Invalid call');
    });

    test('returns fail for unknown action', async () => {
      const router = new ToolRouterV2();
      const result = await router.execute(
        { tool: 'code', action: 'nonexistent', params: {} },
        stubCtx()
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Invalid call');
    });

    test('dispatches to handler and returns result', async () => {
      const mockResult: ToolResult = {
        ok: true,
        data: { found: true },
        _meta: { cached: false, tokensEstimate: 10, durationMs: 0 },
      };
      const mockHandler = vi.fn().mockResolvedValue(mockResult);

      const originalHandler = TOOL_REGISTRY.meta.actions.review.handler;
      TOOL_REGISTRY.meta.actions.review.handler = mockHandler;

      try {
        const router = new ToolRouterV2();
        const result = await router.execute(
          { tool: 'meta', action: 'review', params: {} },
          stubCtx()
        );
        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ found: true });
        expect(mockHandler).toHaveBeenCalledOnce();

        const [passedParams, passedCtx] = mockHandler.mock.calls[0];
        expect(passedParams).toEqual({});
        expect(passedCtx.projectRoot).toBe('/tmp/test');
        expect(passedCtx.toolRegistry).toBe(TOOL_REGISTRY);
      } finally {
        TOOL_REGISTRY.meta.actions.review.handler = originalHandler;
      }
    });

    test('catches handler exceptions and returns fail', async () => {
      const throwingHandler = vi.fn().mockRejectedValue(new Error('boom'));
      const originalHandler = TOOL_REGISTRY.meta.actions.review.handler;
      TOOL_REGISTRY.meta.actions.review.handler = throwingHandler;

      try {
        const router = new ToolRouterV2();
        const result = await router.execute(
          { tool: 'meta', action: 'review', params: {} },
          stubCtx()
        );
        expect(result.ok).toBe(false);
        expect(result.error).toContain('boom');
      } finally {
        TOOL_REGISTRY.meta.actions.review.handler = originalHandler;
      }
    });
  });

  describe('capability permission checks', () => {
    test('allows all calls when no capability is set', async () => {
      const mockResult: ToolResult = {
        ok: true,
        data: 'ok',
        _meta: { cached: false, tokensEstimate: 1, durationMs: 0 },
      };
      const mockHandler = vi.fn().mockResolvedValue(mockResult);
      const original = TOOL_REGISTRY.code.actions.write.handler;
      TOOL_REGISTRY.code.actions.write.handler = mockHandler;

      try {
        const router = new ToolRouterV2();
        const result = await router.execute(
          { tool: 'code', action: 'write', params: { path: 'x', content: 'y' } },
          stubCtx()
        );
        expect(result.ok).toBe(true);
        expect(mockHandler).toHaveBeenCalledOnce();
      } finally {
        TOOL_REGISTRY.code.actions.write.handler = original;
      }
    });

    test('denies tool not in capability allowedTools', async () => {
      const cap: CapabilityV2Def = {
        name: 'test-cap',
        description: 'test',
        allowedTools: { code: ['search', 'read'] },
      };
      const router = new ToolRouterV2({ capability: cap });
      const result = await router.execute(
        { tool: 'terminal', action: 'exec', params: { command: 'ls' } },
        stubCtx()
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Permission denied');
      expect(result.error).toContain('terminal');
    });

    test('denies action not in capability allowed actions', async () => {
      const cap: CapabilityV2Def = {
        name: 'test-cap',
        description: 'test',
        allowedTools: { code: ['search', 'read'] },
      };
      const router = new ToolRouterV2({ capability: cap });
      const result = await router.execute(
        { tool: 'code', action: 'write', params: { path: 'x', content: 'y' } },
        stubCtx()
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Permission denied');
      expect(result.error).toContain('write');
    });

    test('allows action explicitly listed in capability', async () => {
      const mockResult: ToolResult = {
        ok: true,
        data: [],
        _meta: { cached: false, tokensEstimate: 1, durationMs: 0 },
      };
      const mockHandler = vi.fn().mockResolvedValue(mockResult);
      const original = TOOL_REGISTRY.code.actions.search.handler;
      TOOL_REGISTRY.code.actions.search.handler = mockHandler;

      try {
        const cap: CapabilityV2Def = {
          name: 'test-cap',
          description: 'test',
          allowedTools: { code: ['search', 'read'] },
        };
        const router = new ToolRouterV2({ capability: cap });
        const result = await router.execute(
          { tool: 'code', action: 'search', params: { patterns: ['x'] } },
          stubCtx()
        );
        expect(result.ok).toBe(true);
        expect(mockHandler).toHaveBeenCalledOnce();
      } finally {
        TOOL_REGISTRY.code.actions.search.handler = original;
      }
    });
  });

  describe('getSchemas', () => {
    test('returns all schemas when no capability is set', () => {
      const router = new ToolRouterV2();
      const schemas = router.getSchemas();
      expect(schemas).toHaveLength(6);
    });

    test('filters schemas by capability allowedTools', () => {
      const cap: CapabilityV2Def = {
        name: 'restricted',
        description: 'test',
        allowedTools: {
          code: ['search', 'read'],
          memory: ['recall'],
        },
      };
      const router = new ToolRouterV2({ capability: cap });
      const schemas = router.getSchemas();
      expect(schemas).toHaveLength(2);

      const names = schemas.map((s) => s.name).sort();
      expect(names).toEqual(['code', 'memory']);

      const codeSchema = schemas.find((s) => s.name === 'code')!;
      const codeProps = codeSchema.parameters.properties as Record<string, Record<string, unknown>>;
      expect(codeProps.action.enum).toEqual(['search', 'read']);
    });
  });
});
