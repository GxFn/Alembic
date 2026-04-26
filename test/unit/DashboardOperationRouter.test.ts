import { describe, expect, test, vi } from 'vitest';
import { DashboardOperationAdapter } from '../../lib/tools/adapters/DashboardOperationAdapter.js';
import {
  DASHBOARD_OPERATION_HANDLERS,
  DASHBOARD_OPERATION_IDS,
  DASHBOARD_OPERATION_MANIFESTS,
} from '../../lib/tools/adapters/DashboardOperations.js';
import { CapabilityCatalog } from '../../lib/tools/catalog/CapabilityCatalog.js';
import { ToolRouter } from '../../lib/tools/core/ToolRouter.js';

function createRouter(container: Record<string, unknown>) {
  return new ToolRouter({
    catalog: new CapabilityCatalog(DASHBOARD_OPERATION_MANIFESTS),
    adapters: [new DashboardOperationAdapter(DASHBOARD_OPERATION_HANDLERS)],
    projectRoot: '/tmp/project',
    services: container as never,
  });
}

function dashboardRequest(toolId: string, args: Record<string, unknown> = {}) {
  return {
    toolId,
    args,
    surface: 'dashboard' as const,
    actor: { role: 'developer', user: 'local' },
    source: { kind: 'dashboard' as const, name: '/api/v1/test' },
  };
}

describe('DashboardOperationRouter', () => {
  test('projects dashboard operations as dashboard-only capabilities', () => {
    const catalog = new CapabilityCatalog(DASHBOARD_OPERATION_MANIFESTS);
    const dashboardCapabilities = catalog.list({ surface: 'dashboard' });

    expect(dashboardCapabilities.map((capability) => capability.id)).toContain(
      DASHBOARD_OPERATION_IDS.updateModuleMap
    );
    expect(catalog.getManifest(DASHBOARD_OPERATION_IDS.updateModuleMap)).toMatchObject({
      kind: 'dashboard-operation',
      surfaces: ['dashboard'],
      risk: { sideEffect: true },
      execution: { adapter: 'dashboard' },
    });
  });

  test('executes dashboard update-module-map through ToolRouter', async () => {
    const updateModuleMap = vi.fn().mockResolvedValue({ updated: true });
    const container = {
      services: {},
      singletons: {},
      get: vi.fn((name: string) => {
        if (name === 'moduleService') {
          return { updateModuleMap };
        }
        throw new Error(`unknown service ${name}`);
      }),
    };
    const router = createRouter(container);

    const result = await router.execute(dashboardRequest(DASHBOARD_OPERATION_IDS.updateModuleMap));

    expect(updateModuleMap).toHaveBeenCalledWith({ aggressive: true });
    expect(result).toMatchObject({
      ok: true,
      toolId: DASHBOARD_OPERATION_IDS.updateModuleMap,
      status: 'success',
      structuredContent: { updated: true },
      trust: { source: 'user' },
    });
  });

  test('blocks dashboard operations from non-dashboard surfaces', async () => {
    const router = createRouter({ services: {}, singletons: {}, get: vi.fn() });

    const result = await router.execute({
      ...dashboardRequest(DASHBOARD_OPERATION_IDS.updateModuleMap),
      surface: 'http',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      toolId: DASHBOARD_OPERATION_IDS.updateModuleMap,
    });
    expect(result.text).toContain('not exposed on http');
  });

  test('returns an error envelope when rebuild index is unavailable in mock mode', async () => {
    const router = createRouter({
      services: {},
      singletons: { _aiProviderManager: { isMock: true } },
      get: vi.fn(),
    });

    const result = await router.execute(
      dashboardRequest(DASHBOARD_OPERATION_IDS.rebuildSemanticIndex)
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'error',
      toolId: DASHBOARD_OPERATION_IDS.rebuildSemanticIndex,
    });
    expect(result.text).toContain('Embedding 不可用');
  });
});
