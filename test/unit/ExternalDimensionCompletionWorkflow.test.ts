import { describe, expect, it, vi } from 'vitest';
import {
  type ExternalDimensionCompletionContext,
  type ExternalWorkflowSession,
  runExternalDimensionCompletionWorkflow,
} from '#workflows/common-capabilities/agent-execution/external/ExternalDimensionCompletionWorkflow.js';

describe('ExternalDimensionCompletionWorkflow', () => {
  it('returns validation envelopes before touching session state', async () => {
    const getActiveSession = vi.fn();
    const result = await runExternalDimensionCompletionWorkflow(
      createContext(),
      { analysisText: 'analysis text long enough' },
      { getActiveSession }
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_ERROR');
    expect(getActiveSession).not.toHaveBeenCalled();
  });

  it('returns SESSION_NOT_FOUND when no external session is active', async () => {
    const result = await runExternalDimensionCompletionWorkflow(
      createContext(),
      { dimensionId: 'architecture', analysisText: 'analysis text long enough' },
      { getActiveSession: () => null }
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SESSION_NOT_FOUND');
  });

  it('recovers submissions from tracker and marks an incomplete session dimension complete', async () => {
    const updates: Array<{ recipeId: string; tags: string[] }> = [];
    const checkpoint = vi.fn(async () => undefined);
    const emitted: Array<{ dimId: string; data: Record<string, unknown> }> = [];
    const session = createSession();
    const context = createContext({
      get: (name: string) => {
        if (name === 'knowledgeService') {
          return {
            get: async (recipeId: string) => ({
              title: recipeId,
              tags: ['existing'],
            }),
            update: async (recipeId: string, patch: { tags?: string[] }) => {
              updates.push({ recipeId, tags: patch.tags || [] });
            },
          };
        }
        return null;
      },
    });

    const result = await runExternalDimensionCompletionWorkflow(
      context,
      {
        dimensionId: 'architecture',
        analysisText: 'analysis text long enough to pass validation and store report',
        keyFindings: ['shared module boundary'],
      },
      {
        getActiveSession: () => session,
        saveCheckpoint: checkpoint,
        createEmitter: () => ({
          emitDimensionComplete: (dimId, data) => emitted.push({ dimId, data }),
          emitAllComplete: vi.fn(),
        }),
      }
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.recipesBound).toBe(2);
    expect(data.progress).toBe('1/2');
    expect(data.isBootstrapComplete).toBe(false);
    expect(data.subpackageCoverageWarning).toContain('internal-lib');
    expect(updates).toEqual([
      { recipeId: 'recipe-a', tags: ['existing', 'dimension:architecture', 'bootstrap:session-1'] },
      { recipeId: 'recipe-b', tags: ['existing', 'dimension:architecture', 'bootstrap:session-1'] },
    ]);
    expect(checkpoint).toHaveBeenCalledWith(
      '/tmp/alembic-test-project',
      'session-1',
      'architecture',
      {
        candidateCount: 2,
        analysisChars: 61,
        referencedFiles: 2,
        recipeIds: ['recipe-a', 'recipe-b'],
        skillCreated: false,
      }
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.data).toMatchObject({
      extracted: 2,
      progress: '1/2',
      recipesBound: 2,
      source: 'external-agent',
    });
  });
});

function createContext(overrides: Partial<ExternalDimensionCompletionContext['container']> = {}) {
  return {
    container: {
      singletons: { _projectRoot: '/tmp/alembic-test-project' },
      get: () => null,
      ...overrides,
    },
  } as ExternalDimensionCompletionContext;
}

function createSession(): ExternalWorkflowSession {
  let completed = false;
  const session = {
    id: 'session-1',
    projectRoot: '/tmp/alembic-test-project',
    expiresAt: Date.now(),
    dimensions: [
      { id: 'architecture', label: 'Architecture', skillWorthy: false },
      { id: 'tooling', label: 'Tooling', skillWorthy: false },
    ],
    submissionTracker: {
      getSubmissions: (dimId: string) =>
        dimId === 'architecture'
          ? [
              { recipeId: 'recipe-a', sources: ['src/a.ts:10'], title: 'A' },
              { recipeId: 'recipe-b', sources: ['packages/core/b.ts'], title: 'B' },
            ]
          : [],
      getAccumulatedEvidence: () => ({
        completedDimSummaries: [],
        sharedFiles: [],
        negativeSignals: [],
        usedTriggers: [],
      }),
    },
    sessionStore: {
      getDimensionReport: () => undefined,
    },
    getSnapshotCache: () => ({
      localPackageModules: [{ packageName: 'packages/internal-lib', name: 'internal-lib' }],
    }),
    getProgress: () => ({
      completed: completed ? 1 : 0,
      total: 2,
      completedDimIds: completed ? ['architecture'] : [],
      remainingDimIds: completed ? ['tooling'] : ['architecture', 'tooling'],
    }),
    get isComplete() {
      return false;
    },
    markDimensionComplete: () => {
      completed = true;
      return {
        updated: true,
        qualityReport: {
          totalScore: 72,
          pass: true,
          scores: {
            coverageScore: 80,
            evidenceScore: 70,
            diversityScore: 65,
            coherenceScore: 75,
          },
          suggestions: [],
        },
      };
    },
    storeHints: vi.fn(),
    getAccumulatedHints: () => ({}),
  };

  return session as unknown as ExternalWorkflowSession;
}
