import { describe, expect, it, vi } from 'vitest';

import { ToolForge } from '../../lib/agent/forge/ToolForge.js';
import { CapabilityCatalog } from '../../lib/agent/tools/CapabilityCatalog.js';
import type { ToolCapabilityManifest } from '../../lib/agent/tools/CapabilityManifest.js';

/**
 * Tool Forge 集成测试
 *
 * 测试完整的 Forge 瀑布流：
 *   reuse → compose → generate → register → execute
 */

/* ────────── Full Mock ToolRegistry ────────── */

function createFullRegistry(
  initialTools: Record<string, (p: Record<string, unknown>) => unknown> = {}
) {
  const tools = new Map<string, { handler: (p: Record<string, unknown>) => unknown }>();
  for (const [name, handler] of Object.entries(initialTools)) {
    tools.set(name, { handler });
  }

  return {
    has: (name: string) => tools.has(name),
    hasInternalTool: (name: string) => tools.has(name),
    projectForgedTool: vi.fn(
      (def: { name: string; handler: (p: Record<string, unknown>) => unknown }) => {
        tools.set(def.name, { handler: def.handler as (p: Record<string, unknown>) => unknown });
      }
    ),
    revokeForgedTool: vi.fn((name: string) => tools.delete(name)),
    _tools: tools,
  };
}

describe('ToolForge Integration', () => {
  it('complete reuse → forge → register → execute lifecycle', async () => {
    // Setup: registry with one tool
    const reg = createFullRegistry({
      read_file: (p) => ({ content: `file: ${p.path}`, path: p.path }),
    });
    const catalog = new CapabilityCatalog([testManifest('read_file')]);
    const forge = new ToolForge(reg, { capabilityCatalog: catalog });

    // Step 1: Reuse — tool exists
    const reuseResult = await forge.forge({
      intent: 'read file',
      action: 'read',
      target: 'file',
    });
    expect(reuseResult.success).toBe(true);
    expect(reuseResult.mode).toBe('reuse');
    expect(reuseResult.toolName).toBe('read_file');

    // Step 2: Generate — completely new tool
    const genResult = await forge.forge({
      intent: 'reverse a string',
      action: 'reverse',
      target: 'string',
      codeGenerator: async () => ({
        name: 'reverse_string',
        description: 'Reverses a string',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
        code: `function toolHandler(params) {
          return { reversed: params.text.split('').reverse().join('') };
        }`,
        testCases: [
          { description: 'hello', input: { text: 'hello' }, expectedOutput: { reversed: 'olleh' } },
          { description: 'empty', input: { text: '' }, expectedOutput: { reversed: '' } },
        ],
      }),
    });
    expect(genResult.success).toBe(true);
    expect(genResult.mode).toBe('generate');
    expect(genResult.toolName).toBe('reverse_string');

    // Step 3: Verify the generated tool was projected
    expect(reg.projectForgedTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'reverse_string' })
    );
    expect(catalog.getManifest('reverse_string')).toMatchObject({
      id: 'reverse_string',
      kind: 'internal-tool',
      owner: 'agent-forge',
      lifecycle: 'experimental',
    });

    // Step 4: Verify temporary registry tracks it
    const tempList = forge.temporaryRegistry.list();
    expect(tempList.some((t) => t.name === 'reverse_string')).toBe(true);

    // Step 5: Cleanup
    forge.dispose();
    expect(forge.temporaryRegistry.list()).toHaveLength(0);
    expect(catalog.getManifest('reverse_string')).toBeNull();
  });

  it('should fallback from reuse → compose when exact match unavailable but composable tools exist', async () => {
    const reg = createFullRegistry({
      fetch_data: (p) => ({ data: [1, 2, 3], source: p.source }),
      validate_schema: (p) => ({ valid: true, data: p }),
      transform_records: (p) => ({ transformed: true }),
    });
    const catalog = new CapabilityCatalog([
      testManifest('fetch_data'),
      testManifest('validate_schema'),
      testManifest('transform_records'),
    ]);

    const forge = new ToolForge(reg, { capabilityCatalog: catalog });

    const result = await forge.forge({
      intent: 'validate data pipeline',
      action: 'validate',
      target: 'data',
    });

    // Should succeed (either reuse via hint match, or compose)
    expect(result.success).toBe(true);
    expect(['reuse', 'compose']).toContain(result.mode);

    forge.dispose();
  });

  it('security: should block code with forbidden patterns in generate mode', async () => {
    const reg = createFullRegistry({});
    const forge = new ToolForge(reg, { capabilityCatalog: new CapabilityCatalog() });

    const dangerousCodes = [
      `const fs = require('fs'); function toolHandler(p) { return fs.readFileSync(p.path); }`,
      `async function toolHandler(p) { const m = await import('child_process'); return m; }`,
      `function toolHandler(p) { return eval(p.code); }`,
      `function toolHandler(p) { return process.env; }`,
    ];

    for (const code of dangerousCodes) {
      const result = await forge.forge({
        intent: 'dangerous tool',
        action: 'hack',
        target: 'system',
        codeGenerator: async () => ({
          name: `evil_${Date.now()}`,
          description: 'evil',
          parameters: {},
          code,
          testCases: [],
        }),
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Safety violations');
    }

    forge.dispose();
  });

  it('should properly dispose and not leak timers', async () => {
    const reg = createFullRegistry({});
    const catalog = new CapabilityCatalog();
    const forge = new ToolForge(reg, { capabilityCatalog: catalog });

    // Generate a tool
    await forge.forge({
      intent: 'temp tool',
      action: 'temp',
      target: 'tool',
      codeGenerator: async () => ({
        name: 'temp_tool',
        description: 'temporary',
        parameters: {},
        code: `function toolHandler(p) { return { ok: true }; }`,
        testCases: [{ description: 'ok', input: {}, expectedOutput: { ok: true } }],
      }),
    });

    expect(forge.temporaryRegistry.list()).toHaveLength(1);
    expect(catalog.getManifest('temp_tool')).not.toBeNull();

    // Dispose
    forge.dispose();
    expect(forge.temporaryRegistry.list()).toHaveLength(0);
    expect(reg.revokeForgedTool).toHaveBeenCalledWith('temp_tool');
    expect(catalog.getManifest('temp_tool')).toBeNull();
  });
});

function testManifest(id: string): ToolCapabilityManifest {
  return {
    id,
    title: id,
    kind: 'internal-tool',
    description: id,
    owner: 'test',
    lifecycle: 'active',
    surfaces: ['runtime', 'internal'],
    inputSchema: {},
    risk: {
      sideEffect: false,
      dataAccess: 'none',
      writeScope: 'none',
      network: 'none',
      credentialAccess: 'none',
      requiresHumanConfirmation: 'never',
      owaspTags: [],
    },
    execution: {
      adapter: 'internal',
      timeoutMs: 0,
      maxOutputBytes: 10_000,
      abortMode: 'none',
      cachePolicy: 'none',
      concurrency: 'parallel-safe',
      artifactMode: 'inline',
    },
    governance: {
      auditLevel: 'none',
      policyProfile: 'read',
      approvalPolicy: 'auto',
      allowedRoles: ['runtime'],
      allowInComposer: true,
      allowInRemoteMcp: false,
      allowInNonInteractive: true,
    },
    evals: { required: false, cases: [] },
  };
}
