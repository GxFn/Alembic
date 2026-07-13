import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  container: null as Record<string, unknown> | null,
}));

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => state.container),
}));

import type { AgentService, SystemRunContextFactory } from '@alembic/agent/service';
import modulesRouter from '../../lib/http/routes/modules.js';
import { ModuleService } from '../../lib/service/module/ModuleService.js';
import { invokeRouter } from '../helpers/express.js';

describe('module scan existing Recipe ID closure', () => {
  let projectRoot = '';

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alembic-module-scan-existing-id-'));
    await writeSourceFiles(projectRoot, 1);
  });

  afterEach(async () => {
    state.container = null;
    await fs.rm(projectRoot, { force: true, recursive: true });
  });

  test('passes the Agent-persisted pending ID through service, Dashboard operation and HTTP without extra writes', async () => {
    const run = vi.fn(async () =>
      agentRunResult({
        reply: '{"recipes":[{"title":"untrusted provider duplicate"}]}',
        toolCalls: [
          knowledgeSubmitCall({
            status: 'created',
            id: 'recipe-existing-pending',
            lifecycle: 'pending',
            title: 'Persisted Recipe',
            summary: 'Authoritative persisted reviewer summary.',
          }),
        ],
      })
    );
    const harness = createHarness(projectRoot, run);

    const response = await scanProjectOverHttp({ batchSize: 1, maxFiles: 1 });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    const data = response.body.data as Record<string, unknown>;
    expect(data.recipes).toEqual([
      expect.objectContaining({
        id: 'recipe-existing-pending',
        candidateId: 'recipe-existing-pending',
        status: 'created',
        lifecycle: 'pending',
        summary: 'Authoritative persisted reviewer summary.',
      }),
    ]);
    expect(data.outcome).toMatchObject({
      status: 'completed',
      recipeCount: 1,
      projectionAuthority: 'persisted-knowledge-submit-results-only',
      batches: [
        expect.objectContaining({
          persistenceOutcome: 'created',
          recipeCount: 1,
        }),
      ],
    });
    expect((data.recipes as Record<string, unknown>[])[0]).not.toHaveProperty('quality');
    expect(harness.qualityScore).not.toHaveBeenCalled();
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: 'zero submit with provider JSON',
      result: agentRunResult({
        reply: '{"recipes":[{"title":"provider-only"}]}',
        toolCalls: [],
      }),
      expectedOutcome: 'no-submit-attempt',
    },
    {
      name: 'rejected submit',
      result: agentRunResult({
        toolCalls: [knowledgeSubmitCall({ status: 'rejected', reason: 'schema-invalid' })],
      }),
      expectedOutcome: 'submit-without-created-recipe',
    },
    {
      name: 'failed submit',
      result: agentRunResult({
        toolCalls: [knowledgeSubmitCall({ status: 'failed', error: 'persistence-failed' })],
      }),
      expectedOutcome: 'submit-without-created-recipe',
    },
    {
      name: 'created submit with blank ID',
      result: agentRunResult({
        toolCalls: [knowledgeSubmitCall({ status: 'created', id: '  ', lifecycle: 'pending' })],
      }),
      expectedOutcome: 'submit-without-created-recipe',
    },
    {
      name: 'created submit with illegal lifecycle',
      result: agentRunResult({
        toolCalls: [
          knowledgeSubmitCall({ status: 'created', id: 'recipe-active', lifecycle: 'active' }),
        ],
      }),
      expectedOutcome: 'submit-without-created-recipe',
    },
  ])('returns empty recipes and authoritative diagnostics for $name', async ({
    result,
    expectedOutcome,
  }) => {
    const harness = createHarness(
      projectRoot,
      vi.fn(async () => result)
    );

    const response = await scanProjectOverHttp({ batchSize: 1, maxFiles: 1 });

    const data = response.body.data as Record<string, unknown>;
    expect(data.recipes).toEqual([]);
    expect(data.partial).toBe(false);
    expect(data.errors).toEqual([]);
    expect(data.outcome).toMatchObject({
      status: 'empty',
      recipeCount: 0,
      projectionAuthority: 'persisted-knowledge-submit-results-only',
      batches: [
        expect.objectContaining({
          persistenceOutcome: expectedOutcome,
          recipeCount: 0,
        }),
      ],
    });
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  test('reports an Agent failure as failed without manufacturing an HTTP success result', async () => {
    const harness = createHarness(
      projectRoot,
      vi.fn(async () => {
        throw new Error('agent runtime unavailable');
      })
    );

    const response = await scanProjectOverHttp({ batchSize: 1, maxFiles: 1 });

    const data = response.body.data as Record<string, unknown>;
    expect(data.recipes).toEqual([]);
    expect(data.partial).toBe(false);
    expect(data.outcome).toMatchObject({ status: 'failed', recipeCount: 0 });
    expect(data.errors).toEqual([
      expect.objectContaining({
        code: 'MODULE_SCAN_AGENT_ERROR',
        message: 'agent runtime unavailable',
      }),
    ]);
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  test('keeps completed existing IDs and marks the HTTP result partial when a later batch times out', async () => {
    await writeSourceFiles(projectRoot, 2);
    let callCount = 0;
    const run = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return agentRunResult({
          toolCalls: [
            knowledgeSubmitCall({
              status: 'created',
              id: 'recipe-before-timeout',
              lifecycle: 'staging',
            }),
          ],
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      return agentRunResult({ toolCalls: [] });
    });
    const harness = createHarness(projectRoot, run);

    const response = await scanProjectOverHttp({
      batchSize: 1,
      batchTimeout: 5,
      maxFiles: 2,
      totalTimeout: 1_000,
    });

    const data = response.body.data as Record<string, unknown>;
    expect(data.recipes).toEqual([
      expect.objectContaining({
        id: 'recipe-before-timeout',
        candidateId: 'recipe-before-timeout',
        lifecycle: 'staging',
      }),
    ]);
    expect(data.partial).toBe(true);
    expect(data.outcome).toMatchObject({ status: 'partial', recipeCount: 1 });
    expect(data.errors).toEqual([
      expect.objectContaining({
        code: 'MODULE_SCAN_BATCH_TIMEOUT',
        batch: 'project-batch-2',
      }),
    ]);
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });
});

function createHarness(projectRoot: string, run: ReturnType<typeof vi.fn>) {
  const create = vi.fn();
  const publish = vi.fn();
  const qualityScore = vi.fn(() => ({ score: 99, grade: 'A' }));
  const moduleService = new ModuleService(projectRoot, {
    agentService: { run } as unknown as AgentService,
    systemRunContextFactory: {
      createSystemContext: () => ({ scopeId: 'module-scan-test', systemRunContext: {} }),
    } as unknown as SystemRunContextFactory,
    aiStatus: () => ({ ready: true, reason: null, providerName: 'test', model: 'test' }),
    qualityScorer: { score: qualityScore },
  });
  const knowledgeService = { create, publish };
  const container = {
    get: vi.fn((name: string) => {
      if (name === 'moduleService') {
        return moduleService;
      }
      if (name === 'knowledgeService') {
        return knowledgeService;
      }
      throw new Error(`Unexpected service requested: ${name}`);
    }),
    services: { moduleService, knowledgeService },
    singletons: {},
  };
  state.container = container;
  return { container, create, moduleService, publish, qualityScore };
}

async function scanProjectOverHttp(options: Record<string, unknown>) {
  return invokeRouter(modulesRouter, {
    body: { options },
    method: 'POST',
    mountPath: '/api/v1/modules',
    path: '/api/v1/modules/scan-project',
    timeoutMs: 2_000,
  });
}

async function writeSourceFiles(projectRoot: string, count: number) {
  const sourceDir = path.join(projectRoot, 'src');
  await fs.mkdir(sourceDir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    await fs.writeFile(
      path.join(sourceDir, `Feature${index + 1}.ts`),
      Array.from(
        { length: 8 },
        (_, line) => `export const feature${index + 1}Line${line + 1} = ${line + 1};`
      ).join('\n')
    );
  }
}

function knowledgeSubmitCall(result: Record<string, unknown>) {
  return {
    tool: 'knowledge',
    name: 'knowledge',
    args: { action: 'submit' },
    result,
  };
}

function agentRunResult({
  reply = '',
  toolCalls = [],
}: {
  reply?: string;
  toolCalls?: Record<string, unknown>[];
}) {
  return {
    runId: 'module-scan-run',
    profileId: 'scan-extract',
    reply,
    status: 'success',
    toolCalls,
    usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
    diagnostics: null,
    phases: { produce: { reply, toolCalls } },
  };
}
