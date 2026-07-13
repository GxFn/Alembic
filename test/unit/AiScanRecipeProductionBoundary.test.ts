import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  projectRoot: '',
  run: vi.fn(),
}));

vi.mock('../../lib/injection/AiRuntimeStatus.js', () => ({
  getAiRuntimeStatus: vi.fn(() => ({ ready: true })),
  getAiUnavailableMessage: vi.fn(() => 'AI unavailable'),
}));

vi.mock('../../lib/service/module/ModuleService.js', () => ({
  ModuleService: class {
    async load() {}
    async listTargets() {
      return [{ name: 'App' }];
    }
    async getTargetFiles() {
      return [
        {
          name: 'Feature.ts',
          path: path.join(state.projectRoot, 'Feature.ts'),
          relativePath: 'Feature.ts',
        },
      ];
    }
  },
}));

import { AiScanService } from '../../lib/cli/AiScanService.js';

describe('AiScanService Recipe production boundary', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    state.projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alembic-ai-scan-'));
    await fs.writeFile(
      path.join(state.projectRoot, 'Feature.ts'),
      Array.from({ length: 12 }, (_, index) => `export const value${index} = ${index};`).join('\n')
    );
  });

  afterEach(async () => {
    await fs.rm(state.projectRoot, { force: true, recursive: true });
  });

  test('reports Agent/Core-created pending or staging ids without a second product write', async () => {
    state.run.mockImplementation(async (input) => {
      input.execution?.onToolCall?.(
        'knowledge',
        { action: 'submit' },
        {
          ok: true,
          data: {
            status: 'created',
            id: 'recipe-created-by-core',
            lifecycle: 'staging',
            readiness: { ready: false, violations: [] },
          },
        },
        1
      );
      return agentRunResult('{"recipes":[]}');
    });
    const container = buildContainer();
    const service = new AiScanService({ container, projectRoot: state.projectRoot });

    const report = await service.scan('App');

    expect(report).toMatchObject({ created: 1, files: 1, previewed: 0 });
    expect(report.entries).toEqual([
      expect.objectContaining({ id: 'recipe-created-by-core', lifecycle: 'staging' }),
    ]);
    expect(container.get).not.toHaveBeenCalledWith('knowledgeService');
  });

  test('dry-run disables Agent tools and previews without any write-capable service lookup', async () => {
    state.run.mockImplementation(async (input) => {
      expect(input.execution?.toolChoiceOverride).toBe('none');
      expect(input.execution?.onToolCall).toBeTypeOf('function');
      return agentRunResult(
        JSON.stringify({
          recipes: [
            {
              title: 'Preview Recipe',
              content: { pattern: 'A sufficiently long preview pattern for validation.' },
            },
          ],
        })
      );
    });
    const container = buildContainer();
    const service = new AiScanService({ container, projectRoot: state.projectRoot });

    const report = await service.scan('App', { dryRun: true });

    expect(report).toMatchObject({ created: 0, files: 1, previewed: 1 });
    expect(report.entries).toEqual([]);
    expect(container.get).not.toHaveBeenCalledWith('knowledgeService');
  });
});

function buildContainer() {
  const container = {
    get: vi.fn((name: string) => {
      if (name === 'agentService') {
        return { run: state.run };
      }
      if (name === 'systemRunContextFactory') {
        return {
          createSystemContext: () => ({ scopeId: 'scope-test', systemRunContext: {} }),
        };
      }
      throw new Error(`Unexpected service requested: ${name}`);
    }),
    singletons: {},
  };
  return container;
}

function agentRunResult(reply: string) {
  return {
    runId: 'run-test',
    profileId: 'scan-extract',
    reply,
    status: 'success',
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
    diagnostics: null,
  };
}
