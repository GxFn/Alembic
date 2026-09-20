import type { RuntimeCapabilityCatalog } from '@alembic/agent/tools/runtime';
import { afterEach, expect, test, vi } from 'vitest';
import * as AgentModule from '../../lib/injection/modules/AgentModule.js';
import { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { ToolContextFactory } from '../../lib/tools/ToolContextFactory.js';
import { ToolScopeResources } from '../../lib/tools/ToolScopeResources.js';
import { invokeRouter } from '../helpers/express.js';

const routeHost = vi.hoisted(() => ({ current: undefined as unknown }));
const sandboxExec = vi.hoisted(() => vi.fn());
vi.mock('../../lib/injection/ServiceContainer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/injection/ServiceContainer.js')>()),
  getServiceContainer: () => routeHost.current,
}));
vi.mock('#sandbox/SandboxExecutor.js', () => ({ sandboxExec }));

import aiRouter from '../../lib/http/routes/ai.js';

afterEach(() => {
  vi.restoreAllMocks();
  routeHost.current = undefined;
});

function configuredPorts() {
  return {
    knowledgeService: { get: vi.fn(), update: vi.fn(), reject: vi.fn() },
    searchEngine: { search: vi.fn() },
    recipeProductionGateway: {
      createOrStage: vi.fn(),
      evaluateReadiness: vi.fn(),
      publish: vi.fn(),
    },
    stagingManager: { listReviewQueue: vi.fn(), recordReview: vi.fn() },
    proposalGateway: { submit: vi.fn() },
  };
}

function mainContainer(ports: Record<string, unknown>) {
  const container = new ServiceContainer();
  container.singletons._projectRoot = process.cwd();
  AgentModule.register(container);
  for (const [name, value] of Object.entries(ports)) {
    container.register(name, () => value);
  }
  return container;
}

test('describes host ports without creating a tool scope or invoking Core/sandbox operations', () => {
  const ports = configuredPorts();
  const factory = new ToolContextFactory({
    container: { get: (name) => (ports as Record<string, unknown>)[name] },
    projectRoot: process.cwd(),
  });
  const create = vi.spyOn(factory, 'create');
  const forRequest = vi.spyOn(ToolScopeResources.prototype, 'forRequest');
  const snapshot = factory.getAvailability({});
  expect(snapshot.actions.graph).toEqual([]);
  expect(snapshot.actions.code).not.toContain('outline');
  expect(snapshot.actions.memory).toEqual(expect.arrayContaining(['save', 'recall']));
  expect(snapshot.actions.memory).not.toContain('note_finding');
  expect(snapshot.actions.evidence).toEqual([]);
  expect(snapshot.parameters?.knowledge?.search?.kind).toEqual(['all']);
  expect(snapshot.parameters?.knowledge?.manage?.operation).toEqual(
    expect.arrayContaining(['update', 'reject', 'review', 'review-queue', 'publish', 'evolve'])
  );
  expect(snapshot.parameters?.knowledge?.manage?.operation).not.toContain('score');
  expect(snapshot.parameters?.knowledge?.manage?.operation).not.toContain('validate');
  expect(create).not.toHaveBeenCalled();
  expect(forRequest).not.toHaveBeenCalled();
  expect(sandboxExec).not.toHaveBeenCalled();
  for (const port of Object.values(ports)) {
    for (const method of Object.values(port)) {
      expect(method).not.toHaveBeenCalled();
    }
  }
});

test('keeps runtime-dependent availability isolated between requests', () => {
  const factory = new ToolContextFactory({
    container: { get: () => undefined },
    projectRoot: process.cwd(),
  });
  const empty = factory.getAvailability({});
  const withEvidence = factory.getAvailability({
    memoryCoordinator: { noteFinding: vi.fn(), searchEvidence: vi.fn() },
    evidenceLedger: {
      get: vi.fn(),
      search: vi.fn(),
      listRecent: vi.fn(),
      stats: vi.fn(),
    },
  });
  expect(withEvidence.actions.memory).toContain('note_finding');
  expect(withEvidence.actions.evidence).toEqual(expect.arrayContaining(['get', 'search']));
  expect(empty.actions.memory).not.toContain('note_finding');
  expect(empty.actions.evidence).toEqual([]);
});

test('registered Main catalog projects missing graph and partial knowledge operations', () => {
  const container = mainContainer(configuredPorts());
  const catalog = container.get('capabilityCatalog') as RuntimeCapabilityCatalog;
  const result = catalog.querySchemas({
    runtime: {},
    selection: { graph: null, knowledge: ['manage'] },
  });
  expect(result.schemas.map((schema) => schema.name)).toEqual(['knowledge']);
  expect(result.allowedTools).toEqual({ knowledge: ['manage'] });
  const parameters = result.schemas[0].parameters as {
    properties: { params: { properties: { operation: { enum: string[] } } } };
  };
  expect(parameters.properties.params.properties.operation.enum).toContain('update');
  expect(parameters.properties.params.properties.operation.enum).not.toContain('score');
  expect(parameters.properties.params.properties.operation.enum).not.toContain('validate');
});

test('registered Main catalog retains search-only prime without inventing a read or management service', () => {
  const container = mainContainer({ searchEngine: { search: vi.fn() } });
  const catalog = container.get('capabilityCatalog') as RuntimeCapabilityCatalog;
  const result = catalog.querySchemas({ selection: ['knowledge'], runtime: {} });
  expect(result.allowedTools.knowledge).toEqual(expect.arrayContaining(['search', 'prime']));
  expect(result.allowedTools.knowledge).not.toContain('detail');
  expect(result.allowedTools.knowledge).not.toContain('manage');
});

test('HTTP capability listing consumes the query projection rather than a wider legacy schema list', async () => {
  const querySchemas = vi.fn(() => ({
    schemas: [{ name: 'host-filtered', description: 'available', parameters: {} }],
    allowedTools: {},
  }));
  const toToolSchemas = vi.fn(() => [
    { name: 'legacy-wide', description: 'stale', parameters: {} },
  ]);
  routeHost.current = { get: () => ({ querySchemas, toToolSchemas }) };
  const response = await invokeRouter(aiRouter, {
    method: 'GET',
    mountPath: '/api/v1/ai',
    path: '/api/v1/ai/agent/capabilities',
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    data: { tools: [{ name: 'host-filtered', description: 'available', parameters: {} }] },
  });
  expect(querySchemas).toHaveBeenCalledWith({ runtime: {} });
  expect(toToolSchemas).not.toHaveBeenCalled();
});

test('HTTP capability listing keeps the legacy schema-only host compatible', async () => {
  const toToolSchemas = vi.fn(() => [
    { name: 'legacy-host', description: 'available', parameters: {} },
  ]);
  routeHost.current = { get: () => ({ toToolSchemas }) };
  const response = await invokeRouter(aiRouter, {
    method: 'GET',
    mountPath: '/api/v1/ai',
    path: '/api/v1/ai/agent/capabilities',
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ data: { tools: [{ name: 'legacy-host' }] } });
  expect(toToolSchemas).toHaveBeenCalledOnce();
});
