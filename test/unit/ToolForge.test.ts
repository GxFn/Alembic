import { describe, expect, it, vi } from 'vitest';

import { WorkflowAdapter } from '../../lib/agent/adapters/WorkflowAdapter.js';
import { DiagnosticsCollector } from '../../lib/agent/core/DiagnosticsCollector.js';
import { ToolRouter } from '../../lib/agent/core/ToolRouter.js';
import { ToolForge } from '../../lib/agent/forge/ToolForge.js';
import { CapabilityCatalog } from '../../lib/agent/tools/CapabilityCatalog.js';
import type { ToolCapabilityManifest } from '../../lib/agent/tools/CapabilityManifest.js';
import { WorkflowRegistry } from '../../lib/agent/workflow/WorkflowRegistry.js';

/* ────────── Mock ToolRegistry ────────── */

function createMockRegistry(tools: Record<string, (p: Record<string, unknown>) => unknown> = {}) {
  const toolMap = new Map(Object.entries(tools));
  return {
    has: (name: string) => toolMap.has(name),
    hasInternalTool: (name: string) => toolMap.has(name),
    projectForgedTool: vi.fn((def: { name: string }) => {
      toolMap.set(def.name, async () => ({}));
    }),
    revokeForgedTool: vi.fn((name: string) => toolMap.delete(name)),
  };
}

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

function createToolEnvelope(toolId: string, structuredContent: unknown, parentCallId: string) {
  return {
    ok: true,
    toolId,
    callId: `child-${toolId}`,
    parentCallId,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    status: 'success' as const,
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
      source: 'internal' as const,
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
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
      const reg = createMockRegistry({ alembic_search_knowledge: () => ({ results: [] }) });
      const catalog = new CapabilityCatalog([testManifest('alembic_search_knowledge')]);
      const forge = new ToolForge(reg, { capabilityCatalog: catalog });

      const result = await forge.forge({
        intent: 'search knowledge',
        action: 'search',
        target: 'knowledge',
      });

      expect(result.success).toBe(true);
      expect(result.mode).toBe('reuse');
      expect(result.toolName).toBe('alembic_search_knowledge');

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
      const catalog = new CapabilityCatalog([
        testManifest('validate_data'),
        testManifest('transform_data'),
        testManifest('load_data'),
      ]);
      const forge = new ToolForge(reg, { capabilityCatalog: catalog });

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

    it('registers composed tools as workflow capabilities and executes them through ToolRouter', async () => {
      const reg = createMockRegistry({
        stage_data: (p) => ({ value: Number(p.value ?? 1) + 1 }),
        normalize_data: (p) => ({ value: Number(p.value ?? 0) * 2 }),
      });
      const catalog = new CapabilityCatalog([
        testManifest('stage_data'),
        testManifest('normalize_data'),
      ]);
      const workflowRegistry = new WorkflowRegistry();
      const diagnostics = new DiagnosticsCollector();
      const childExecute = vi.fn(async (request) => {
        const fn = {
          stage_data: (p: Record<string, unknown>) => ({ value: Number(p.value ?? 1) + 1 }),
          normalize_data: (p: Record<string, unknown>) => ({ value: Number(p.value ?? 0) * 2 }),
        }[request.manifest.id as 'stage_data' | 'normalize_data'];
        return createToolEnvelope(
          request.manifest.id,
          fn(request.args),
          request.context.parentCallId
        );
      });
      const router = new ToolRouter({
        catalog,
        adapters: [
          new WorkflowAdapter(workflowRegistry),
          { kind: 'internal-tool' as const, execute: childExecute },
        ],
        services: {
          get() {
            throw new Error('workflow execution should use the tool routing service contract');
          },
        },
      });
      const forge = new ToolForge(reg, {
        capabilityCatalog: catalog,
        workflowRegistry,
        compositionSpecBuilder: () => ({
          name: 'stage_then_normalize',
          description: 'Stage then normalize data',
          steps: [
            { tool: 'stage_data', args: { value: 2 } },
            {
              tool: 'normalize_data',
              args: (prev) => prev as Record<string, unknown>,
            },
          ],
          mergeStrategy: 'sequential',
          parameters: {
            type: 'object',
            properties: { value: { type: 'number' } },
          },
        }),
      });

      const result = await forge.forge({
        intent: 'blend data through two existing steps',
        action: 'blend',
        target: 'data',
      });

      expect(result.success).toBe(true);
      expect(result.mode).toBe('compose');
      expect(catalog.getManifest('stage_then_normalize')).toMatchObject({
        id: 'stage_then_normalize',
        kind: 'workflow',
      });
      expect(workflowRegistry.has('stage_then_normalize')).toBe(true);
      expect(reg.projectForgedTool).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'stage_then_normalize' })
      );

      const envelope = await router.execute({
        toolId: 'stage_then_normalize',
        args: { value: 2 },
        surface: 'runtime',
        actor: { role: 'runtime' },
        source: { kind: 'runtime', name: 'test' },
        runtime: { diagnostics },
      });

      expect(envelope.ok).toBe(true);
      expect(envelope.structuredContent).toEqual({ value: 6 });
      expect(childExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          manifest: expect.objectContaining({ id: 'stage_data' }),
          context: expect.objectContaining({ surface: 'composer' }),
        })
      );
      expect(childExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          manifest: expect.objectContaining({ id: 'normalize_data' }),
          context: expect.objectContaining({ surface: 'composer' }),
        })
      );
      expect(diagnostics.toJSON().toolCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tool: 'stage_data',
            parentCallId: envelope.callId,
            surface: 'composer',
            kind: 'internal-tool',
          }),
          expect.objectContaining({
            tool: 'normalize_data',
            parentCallId: envelope.callId,
            surface: 'composer',
            kind: 'internal-tool',
          }),
          expect.objectContaining({
            tool: 'stage_then_normalize',
            callId: envelope.callId,
            surface: 'runtime',
            kind: 'workflow',
          }),
        ])
      );

      forge.dispose();
      expect(catalog.getManifest('stage_then_normalize')).toBeNull();
      expect(workflowRegistry.has('stage_then_normalize')).toBe(false);
    });
  });

  describe('forge — generate mode', () => {
    it('should generate tool when codeGenerator provided', async () => {
      const reg = createMockRegistry({});
      const catalog = new CapabilityCatalog();
      const forge = new ToolForge(reg, { capabilityCatalog: catalog });

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
      expect(reg.projectForgedTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'generate_thumbnail',
          description: 'Generate thumbnail',
          forgeMode: 'generate',
        })
      );
      expect(catalog.getManifest('generate_thumbnail')).toMatchObject({
        id: 'generate_thumbnail',
        kind: 'internal-tool',
        owner: 'agent-forge',
        lifecycle: 'experimental',
        surfaces: ['runtime'],
        governance: {
          policyProfile: 'write',
          approvalPolicy: 'explain-then-run',
          allowInComposer: false,
        },
      });

      forge.dispose();
      expect(catalog.getManifest('generate_thumbnail')).toBeNull();
    });

    it('should reject generate mode without CapabilityCatalog', async () => {
      const reg = createMockRegistry({});
      const forge = new ToolForge(reg);

      const result = await forge.forge({
        intent: 'generate thumbnail',
        action: 'generate',
        target: 'thumbnail',
        codeGenerator: async () => ({
          name: 'generate_thumbnail',
          description: 'Generate thumbnail',
          parameters: {},
          code: `function toolHandler(params) { return params; }`,
          testCases: [],
        }),
      });

      expect(result).toMatchObject({
        success: false,
        mode: 'generate',
        error: expect.stringContaining('requires CapabilityCatalog'),
      });
      expect(reg.projectForgedTool).not.toHaveBeenCalled();

      forge.dispose();
    });

    it('should fail generate if code fails safety check', async () => {
      const reg = createMockRegistry({});
      const forge = new ToolForge(reg, { capabilityCatalog: new CapabilityCatalog() });

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
      const forge = new ToolForge(reg, { capabilityCatalog: new CapabilityCatalog() });

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
      const catalog = new CapabilityCatalog([testManifest('search_knowledge')]);
      const forge = new ToolForge(reg, { signalBus, capabilityCatalog: catalog });

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
      const catalog = new CapabilityCatalog();
      const forge = new ToolForge(reg, { capabilityCatalog: catalog });

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
      expect(catalog.getManifest('disposable')).not.toBeNull();
      forge.dispose();
      expect(forge.temporaryRegistry.list()).toHaveLength(0);
      expect(catalog.getManifest('disposable')).toBeNull();
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
