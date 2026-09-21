import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingExecutionContext, EmbeddingPort } from '@alembic/core/vector';
import Database from 'better-sqlite3';
import { describe, expect, test, vi } from 'vitest';
import type { IncrementalPlan } from '../../#types/handler-runtime.js';
import {
  type GenerateRuntimeContainer,
  initializeGenerateRuntime,
} from '../../lib/recipe-pipeline/generate/execution/RuntimeInitializer.js';

function makeContainer(
  overrides: Partial<GenerateRuntimeContainer> = {}
): GenerateRuntimeContainer {
  return {
    get: vi.fn(() => null),
    singletons: {},
    ...overrides,
  };
}

function makeIncrementalPlan(
  restoredEpisodic: NonNullable<IncrementalPlan['restoredEpisodic']>
): IncrementalPlan {
  return {
    canIncremental: true,
    mode: 'incremental',
    affectedDimensions: [],
    skippedDimensions: ['api'],
    previousSnapshot: null,
    diff: null,
    reason: 'test',
    restoredEpisodic,
  };
}

describe('initializeGenerateRuntime', () => {
  test('uses only the independent query/document embedding port for semantic memory', async () => {
    const db = new Database(':memory:');
    const root = mkdtempSync(join(tmpdir(), 'embedding-runtime-'));
    const embedQuery = vi.fn(async (_text: string, _context?: EmbeddingExecutionContext) => [1, 0]);
    const embedDocuments = vi.fn(async (texts: readonly string[]) => texts.map(() => [1, 0]));
    const embedding: EmbeddingPort = {
      embedQuery,
      embedDocuments,
      describeCapabilities: () => ({
        provider: 'fixture',
        model: 'fixed',
        dimension: 2,
        batchSupported: true,
        inputKinds: ['query', 'document'],
        normalization: 'normalized',
        formatProfile: 'asymmetric',
      }),
    };
    const llmEmbed = vi.fn(async () => [0, 1]);
    let memory: Awaited<ReturnType<typeof initializeGenerateRuntime>>['semanticMemory'] = null;
    try {
      const runtime = await initializeGenerateRuntime({
        container: makeContainer({
          get: () => db,
          singletons: { _embedProvider: embedding, aiProvider: { embed: llmEmbed } },
        }),
        projectRoot: root,
        dataRoot: root,
        primaryLang: 'ts',
        allFiles: [],
        targetFileMap: {},
      });
      memory = runtime.semanticMemory;
      expect(memory).not.toBeNull();
      if (!memory) {
        throw new Error('Expected semantic memory');
      }
      const embed = memory.getEmbeddingFunction();
      expect(embed).toBeTypeOf('function');
      if (!embed) {
        throw new Error('Expected independent embedding callback');
      }
      const controller = new AbortController();
      await embed('document', { inputKind: 'document', abortSignal: controller.signal });
      memory.add({ content: 'fixed vector space', type: 'fact' });
      await memory.retrieve('vector', { abortSignal: controller.signal });
      expect(embedDocuments).toHaveBeenCalledOnce();
      expect(embedQuery).toHaveBeenCalledOnce();
      expect(embedQuery.mock.calls[0][1]).toMatchObject({ signal: expect.any(AbortSignal) });
      expect(llmEmbed).not.toHaveBeenCalled();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('initializes project info, runtime stores and memory coordinator without legacy graph', async () => {
    const legacyGraphBuilder = vi.fn(async () => ({
      getOverview: vi.fn(() => ({ totalClasses: 2, totalProtocols: 1, buildTimeMs: 10 })),
    }));
    const container = makeContainer();
    (container as GenerateRuntimeContainer & { buildProjectGraph?: unknown }).buildProjectGraph =
      legacyGraphBuilder;

    const runtime = await initializeGenerateRuntime({
      container,
      projectRoot: '/repo/Alembic',
      dataRoot: '/data',
      primaryLang: 'ts',
      allFiles: [{ relativePath: 'a.ts' }],
      targetFileMap: { api: {} },
      depGraphData: { nodes: [] },
      astProjectSummary: { projectMetrics: { classes: 2 } },
      guardAudit: { summary: { violations: 0 } },
      isIncremental: false,
      incrementalPlan: null,
    });

    expect(container.singletons._fileCache).toEqual([{ relativePath: 'a.ts' }]);
    expect(legacyGraphBuilder).not.toHaveBeenCalled();
    expect(runtime.projectGraph).toBeNull();
    expect(runtime.projectInfo).toEqual({ name: 'Alembic', lang: 'ts', fileCount: 1 });
    expect(runtime.dimContext.projectContext).toMatchObject({
      projectName: 'Alembic',
      primaryLang: 'ts',
      fileCount: 1,
      targetCount: 1,
      modules: ['api'],
    });
    expect(runtime.sessionStore.getStats()).toMatchObject({ completedDimensions: 0 });
    expect(runtime.semanticMemory).toBeNull();
    expect(runtime.memoryCoordinator).toBeTruthy();
  });

  test('rehydrates restored incremental memory and syncs digests into DimensionContext', async () => {
    const restoredEpisodic = {
      getCompletedDimensions: () => ['api'],
      getDimensionReport: () => ({ referencedFiles: ['src/api.ts'] }),
      toJSON: () => ({
        dimensionReports: {
          api: {
            dimId: 'api',
            completedAt: Date.now(),
            analysisText: 'restored',
            findings: [],
            referencedFiles: ['src/api.ts'],
            candidatesSummary: [],
            workingMemoryDistilled: null,
            digest: { summary: 'restored api' },
          },
        },
        crossReferences: [],
        tierReflections: [],
        submittedCandidates: {},
        projectContext: {},
      }),
    };

    const runtime = await initializeGenerateRuntime({
      container: makeContainer(),
      projectRoot: '/repo/Alembic',
      dataRoot: '/data',
      primaryLang: 'ts',
      allFiles: [],
      targetFileMap: {},
      isIncremental: true,
      incrementalPlan: makeIncrementalPlan(restoredEpisodic),
    });

    expect(runtime.sessionStore.getCompletedDimensions()).toEqual(['api']);
    expect(runtime.dimContext.completedDimensions.get('api')).toMatchObject({
      summary: 'restored api',
      dimId: 'api',
    });
  });

  test('keeps legacy graph failures out of runtime initialization', async () => {
    const legacyGraphBuilder = vi.fn(async () => {
      throw new Error('graph failed');
    });
    const container = makeContainer();
    (container as GenerateRuntimeContainer & { buildProjectGraph?: unknown }).buildProjectGraph =
      legacyGraphBuilder;
    const runtime = await initializeGenerateRuntime({
      container,
      projectRoot: '/repo/Alembic',
      dataRoot: '/data',
      primaryLang: null,
      allFiles: null,
      targetFileMap: null,
    });

    expect(legacyGraphBuilder).not.toHaveBeenCalled();
    expect(runtime.projectGraph).toBeNull();
    expect(runtime.projectInfo).toEqual({ name: 'Alembic', lang: 'unknown', fileCount: 0 });
  });
});
