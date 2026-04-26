import { describe, expect, test, vi } from 'vitest';
import { WorkflowAdapter } from '../../lib/agent/adapters/WorkflowAdapter.js';
import { ToolRouter } from '../../lib/agent/core/ToolRouter.js';
import { CapabilityCatalog } from '../../lib/agent/tools/CapabilityCatalog.js';
import type { ToolCapabilityManifest } from '../../lib/agent/tools/CapabilityManifest.js';
import { WorkflowRegistry } from '../../lib/agent/workflow/WorkflowRegistry.js';

describe('WorkflowAdapter', () => {
  test('passes a typed workflow handler context', async () => {
    const manifest = workflowManifest('typed_workflow');
    const catalog = new CapabilityCatalog([manifest]);
    const workflowRegistry = new WorkflowRegistry();
    let router: ToolRouter;
    const handler = vi.fn(async (_params, context) => ({
      callId: context.toolCallContext.callId,
      toolId: context.toolCallContext.toolId,
      hasRouter: context.toolRouter === router,
    }));

    workflowRegistry.register({
      id: 'typed_workflow',
      description: 'Typed workflow',
      parameters: { type: 'object' },
      handler,
    });

    router = new ToolRouter({
      catalog,
      adapters: [new WorkflowAdapter(workflowRegistry)],
      services: {
        get() {
          throw new Error('workflow adapter should use the tool routing service contract');
        },
      },
    });

    const envelope = await router.execute({
      toolId: 'typed_workflow',
      args: { value: 1 },
      surface: 'runtime',
      actor: { role: 'runtime' },
      source: { kind: 'runtime', name: 'test' },
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.structuredContent).toMatchObject({
      toolId: 'typed_workflow',
      hasRouter: true,
    });
    expect(handler).toHaveBeenCalledWith(
      { value: 1 },
      expect.objectContaining({
        toolCallContext: expect.objectContaining({ toolId: 'typed_workflow', surface: 'runtime' }),
        toolRouter: router,
      })
    );
  });

  test('does not resolve ToolRouter from the raw service locator', async () => {
    const manifest = workflowManifest('service_locator_workflow');
    const workflowRegistry = new WorkflowRegistry();
    const serviceLocatorRouter = {
      execute: vi.fn(),
      executeChildCall: vi.fn(),
      explain: vi.fn(),
    };
    const handler = vi.fn(async (_params, context) => ({
      hasRouter: context.toolRouter !== null,
    }));

    workflowRegistry.register({
      id: 'service_locator_workflow',
      description: 'Service locator workflow',
      parameters: { type: 'object' },
      handler,
    });

    const adapter = new WorkflowAdapter(workflowRegistry);
    const envelope = await adapter.execute({
      manifest,
      args: {},
      decision: { allowed: true, stage: 'execute', reasons: [] },
      context: {
        callId: 'service-locator-call',
        toolId: 'service_locator_workflow',
        surface: 'runtime',
        actor: { role: 'runtime' },
        source: { kind: 'runtime', name: 'test' },
        projectRoot: '/tmp',
        services: {
          get(name: string) {
            return name === 'toolRouter' ? serviceLocatorRouter : null;
          },
        },
      },
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.structuredContent).toEqual({ hasRouter: false });
  });
});

function workflowManifest(id: string): ToolCapabilityManifest {
  return {
    id,
    title: id,
    kind: 'workflow',
    description: id,
    owner: 'test',
    lifecycle: 'active',
    surfaces: ['runtime', 'internal'],
    inputSchema: { type: 'object' },
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
      adapter: 'workflow',
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
