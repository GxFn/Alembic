/**
 * RecipeImpactPlanner.test.ts
 *
 * 单测覆盖:
 *   - deleted 文件 → source-deleted / source-deleted-partial
 *   - modified 文件 → source-modified-pattern / ignored (impact-below-threshold)
 *   - stale sourceRef → source-missing
 *   - null diff → buildPlanFromStaleOnly
 *   - 多条 Recipe 引用同一文件的合并去重
 *   - 空 diff → 空 candidates
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  type DiffInput,
  type EvolutionCandidate,
  type EvolutionCandidatePlan,
  RecipeImpactPlanner,
  submitRescanImpactDecisions,
  toRescanImpactDecision,
} from '../../lib/service/evolution/RecipeImpactPlanner.js';

// ── Mock factories ──

function makeSourceRefRepo(data: {
  byPath?: Record<
    string,
    Array<{
      recipeId: string;
      sourcePath: string;
      status: string;
      newPath: string | null;
      verifiedAt: number;
    }>
  >;
  byRecipeId?: Record<
    string,
    Array<{
      recipeId: string;
      sourcePath: string;
      status: string;
      newPath: string | null;
      verifiedAt: number;
    }>
  >;
  stale?: Array<{
    recipeId: string;
    sourcePath: string;
    status: string;
    newPath: string | null;
    verifiedAt: number;
  }>;
}) {
  return {
    findBySourcePath: vi.fn((path: string) => data.byPath?.[path] ?? []),
    findByRecipeId: vi.fn((id: string) => data.byRecipeId?.[id] ?? []),
    findStale: vi.fn(() => data.stale ?? []),
    findOne: vi.fn(),
    upsert: vi.fn(),
    deleteOne: vi.fn(),
    isAccessible: vi.fn(() => true),
  } as unknown as InstanceType<
    typeof import('../../lib/repository/sourceref/RecipeSourceRefRepository.js').RecipeSourceRefRepositoryImpl
  >;
}

function makeKnowledgeRepo(
  entries: Record<
    string,
    {
      id: string;
      title: string;
      trigger?: string;
      lifecycle?: string;
      content?: string;
      coreCode?: string;
    }
  >
) {
  return {
    findById: vi.fn((id: string) => entries[id] ?? null),
    findAllIdAndReasoning: vi.fn(() => []),
  } as unknown as InstanceType<
    typeof import('../../lib/repository/knowledge/KnowledgeRepository.impl.js').default
  >;
}

// ── Tests ──

describe('RecipeImpactPlanner', () => {
  it('should return empty plan for empty diff', async () => {
    const planner = new RecipeImpactPlanner(
      '/project',
      makeSourceRefRepo({}),
      makeKnowledgeRepo({})
    );
    const diff: DiffInput = { added: [], modified: [], deleted: [] };
    const plan = await planner.plan(diff);
    expect(plan.candidates).toHaveLength(0);
    expect(plan.summary.totalChangedFiles).toBe(0);
  });

  it('should detect source-deleted when all refs are deleted', async () => {
    const sourceRefRepo = makeSourceRefRepo({
      byPath: {
        'src/foo.ts': [
          {
            recipeId: 'r1',
            sourcePath: 'src/foo.ts',
            status: 'active',
            newPath: null,
            verifiedAt: 0,
          },
        ],
      },
      byRecipeId: {
        r1: [
          {
            recipeId: 'r1',
            sourcePath: 'src/foo.ts',
            status: 'active',
            newPath: null,
            verifiedAt: 0,
          },
        ],
      },
    });
    const knowledgeRepo = makeKnowledgeRepo({
      r1: { id: 'r1', title: 'Recipe 1' },
    });

    const planner = new RecipeImpactPlanner('/project', sourceRefRepo, knowledgeRepo);
    const diff: DiffInput = { added: [], modified: [], deleted: ['src/foo.ts'] };
    const plan = await planner.plan(diff);

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].reason).toBe('source-deleted');
    expect(plan.candidates[0].impactScore).toBe(1.0);
    expect(plan.candidates[0].recipeId).toBe('r1');
  });

  it('should detect source-deleted-partial when some refs remain active', async () => {
    const sourceRefRepo = makeSourceRefRepo({
      byPath: {
        'src/foo.ts': [
          {
            recipeId: 'r1',
            sourcePath: 'src/foo.ts',
            status: 'active',
            newPath: null,
            verifiedAt: 0,
          },
        ],
      },
      byRecipeId: {
        r1: [
          {
            recipeId: 'r1',
            sourcePath: 'src/foo.ts',
            status: 'active',
            newPath: null,
            verifiedAt: 0,
          },
          {
            recipeId: 'r1',
            sourcePath: 'src/bar.ts',
            status: 'active',
            newPath: null,
            verifiedAt: 0,
          },
        ],
      },
    });
    const knowledgeRepo = makeKnowledgeRepo({
      r1: { id: 'r1', title: 'Recipe 1' },
    });

    const planner = new RecipeImpactPlanner('/project', sourceRefRepo, knowledgeRepo);
    const diff: DiffInput = { added: [], modified: [], deleted: ['src/foo.ts'] };
    const plan = await planner.plan(diff);

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].reason).toBe('source-deleted-partial');
    expect(plan.candidates[0].impactScore).toBe(0.7);
    expect(plan.candidates[0].activeRefCount).toBe(1);
  });

  it('should ignore deleted file with no recipe reference', async () => {
    const planner = new RecipeImpactPlanner(
      '/project',
      makeSourceRefRepo({}),
      makeKnowledgeRepo({})
    );
    const diff: DiffInput = { added: [], modified: [], deleted: ['src/orphan.ts'] };
    const plan = await planner.plan(diff);

    expect(plan.candidates).toHaveLength(0);
    expect(plan.ignored).toHaveLength(1);
    expect(plan.ignored[0].reason).toBe('no-recipe-reference');
  });

  it('should detect modified pattern changes for staging recipes', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'recipe-impact-'));
    try {
      writeFileSync(
        join(projectRoot, 'RetryPolicy.swift'),
        [
          'final class NetworkKitRetryPolicy {',
          '  func retryTransientFailure() {',
          '    let isTransient = true',
          '    _ = isTransient',
          '  }',
          '}',
        ].join('\n')
      );
      const sourceRefRepo = makeSourceRefRepo({
        byPath: {
          'RetryPolicy.swift': [
            {
              recipeId: 'r1',
              sourcePath: 'RetryPolicy.swift',
              status: 'active',
              newPath: null,
              verifiedAt: 0,
            },
          ],
        },
        byRecipeId: {
          r1: [
            {
              recipeId: 'r1',
              sourcePath: 'RetryPolicy.swift',
              status: 'active',
              newPath: null,
              verifiedAt: 0,
            },
          ],
        },
      });
      const knowledgeRepo = makeKnowledgeRepo({
        r1: {
          id: 'r1',
          title: 'Retry policy',
          lifecycle: 'staging',
          coreCode: 'final class NetworkKitRetryPolicy { func retryTransientFailure() {} }',
        },
      });

      const planner = new RecipeImpactPlanner(projectRoot, sourceRefRepo, knowledgeRepo);
      const diff: DiffInput = { added: [], modified: ['RetryPolicy.swift'], deleted: [] };
      const plan = await planner.plan(diff);

      expect(plan.candidates).toHaveLength(1);
      expect(plan.candidates[0].reason).toBe('source-modified-pattern');
      expect(plan.candidates[0].recipeId).toBe('r1');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('should ignore modified changes for deprecated recipes', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'recipe-impact-'));
    try {
      writeFileSync(join(projectRoot, 'RetryPolicy.swift'), 'final class NetworkKitRetryPolicy {}');
      const sourceRefRepo = makeSourceRefRepo({
        byPath: {
          'RetryPolicy.swift': [
            {
              recipeId: 'r1',
              sourcePath: 'RetryPolicy.swift',
              status: 'active',
              newPath: null,
              verifiedAt: 0,
            },
          ],
        },
      });
      const knowledgeRepo = makeKnowledgeRepo({
        r1: {
          id: 'r1',
          title: 'Deprecated retry policy',
          lifecycle: 'deprecated',
          coreCode: 'final class NetworkKitRetryPolicy {}',
        },
      });

      const planner = new RecipeImpactPlanner(projectRoot, sourceRefRepo, knowledgeRepo);
      const diff: DiffInput = { added: [], modified: ['RetryPolicy.swift'], deleted: [] };
      const plan = await planner.plan(diff);

      expect(plan.candidates).toHaveLength(0);
      expect(plan.ignored).toContainEqual({
        filePath: 'RetryPolicy.swift',
        reason: 'recipe-not-active',
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('should return stale-only plan when diff is null', async () => {
    const sourceRefRepo = makeSourceRefRepo({
      stale: [
        { recipeId: 'r1', sourcePath: 'src/old.ts', status: 'stale', newPath: null, verifiedAt: 0 },
      ],
      byRecipeId: {
        r1: [
          {
            recipeId: 'r1',
            sourcePath: 'src/old.ts',
            status: 'stale',
            newPath: null,
            verifiedAt: 0,
          },
        ],
      },
    });
    const knowledgeRepo = makeKnowledgeRepo({
      r1: { id: 'r1', title: 'Recipe 1' },
    });

    const planner = new RecipeImpactPlanner('/project', sourceRefRepo, knowledgeRepo);
    const plan = await planner.plan(null);

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].reason).toBe('source-missing');
  });

  it('should merge multiple affected files for same recipe', async () => {
    const sourceRefRepo = makeSourceRefRepo({
      byPath: {
        'src/a.ts': [
          {
            recipeId: 'r1',
            sourcePath: 'src/a.ts',
            status: 'active',
            newPath: null,
            verifiedAt: 0,
          },
        ],
        'src/b.ts': [
          {
            recipeId: 'r1',
            sourcePath: 'src/b.ts',
            status: 'active',
            newPath: null,
            verifiedAt: 0,
          },
        ],
      },
      byRecipeId: {
        r1: [
          {
            recipeId: 'r1',
            sourcePath: 'src/a.ts',
            status: 'active',
            newPath: null,
            verifiedAt: 0,
          },
          {
            recipeId: 'r1',
            sourcePath: 'src/b.ts',
            status: 'active',
            newPath: null,
            verifiedAt: 0,
          },
        ],
      },
    });
    const knowledgeRepo = makeKnowledgeRepo({
      r1: { id: 'r1', title: 'Recipe 1' },
    });

    const planner = new RecipeImpactPlanner('/project', sourceRefRepo, knowledgeRepo);
    const diff: DiffInput = { added: [], modified: [], deleted: ['src/a.ts', 'src/b.ts'] };
    const plan = await planner.plan(diff);

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].affectedFiles).toContain('src/a.ts');
    expect(plan.candidates[0].affectedFiles).toContain('src/b.ts');
    expect(plan.candidates[0].reason).toBe('source-deleted-partial');
  });

  it('should produce correct summary', async () => {
    const sourceRefRepo = makeSourceRefRepo({
      byPath: {
        'src/deleted.ts': [
          {
            recipeId: 'r1',
            sourcePath: 'src/deleted.ts',
            status: 'active',
            newPath: null,
            verifiedAt: 0,
          },
        ],
      },
      byRecipeId: {
        r1: [
          {
            recipeId: 'r1',
            sourcePath: 'src/deleted.ts',
            status: 'active',
            newPath: null,
            verifiedAt: 0,
          },
        ],
      },
    });
    const knowledgeRepo = makeKnowledgeRepo({
      r1: { id: 'r1', title: 'Recipe 1' },
    });

    const planner = new RecipeImpactPlanner('/project', sourceRefRepo, knowledgeRepo);
    const diff: DiffInput = { added: ['src/new.ts'], modified: [], deleted: ['src/deleted.ts'] };
    const plan = await planner.plan(diff);

    expect(plan.summary.totalChangedFiles).toBe(2);
    expect(plan.summary.candidateCount).toBe(1);
    expect(plan.summary.byReason['source-deleted']).toBe(1);
  });
});

describe('rescan impact decisions', () => {
  const modifiedCandidate: EvolutionCandidate = {
    recipeId: 'r1',
    recipeTitle: 'Middleware Chain',
    reason: 'source-modified-pattern',
    affectedFiles: ['Sources/AuthMiddleware.swift'],
    impactScore: 0.66,
    matchedTokens: ['Middleware', 'RequestContext'],
    sourceRefs: ['Sources/AuthMiddleware.swift'],
    activeRefCount: 1,
  };

  it('converts modified-pattern candidates to update decisions', () => {
    const decision = toRescanImpactDecision(modifiedCandidate, {
      now: 123,
      source: 'rescan-evolution',
    });

    expect(decision).toMatchObject({
      recipeId: 'r1',
      action: 'update',
      source: 'rescan-evolution',
      confidence: 0.9,
    });
    expect(decision?.evidence?.[0]).toMatchObject({
      affectedFiles: ['Sources/AuthMiddleware.swift'],
      matchedTokens: ['Middleware', 'RequestContext'],
      detectedAt: 123,
    });
  });

  it('leaves source-missing candidates for Evolution Agent verification', () => {
    const decision = toRescanImpactDecision({
      ...modifiedCandidate,
      reason: 'source-missing',
      impactScore: 0.5,
      matchedTokens: [],
    });

    expect(decision).toBeNull();
  });

  it('submits only deterministic impact decisions through the gateway', async () => {
    const gateway = {
      submit: vi.fn(async (decision) => ({
        recipeId: decision.recipeId,
        action: decision.action,
        outcome: 'proposal-created' as const,
        proposalId: 'ep-1',
      })),
    };
    const plan: EvolutionCandidatePlan = {
      candidates: [
        modifiedCandidate,
        {
          ...modifiedCandidate,
          recipeId: 'r2',
          reason: 'source-missing',
          impactScore: 0.5,
          matchedTokens: [],
        },
      ],
      ignored: [],
      summary: {
        totalChangedFiles: 1,
        filesWithRecipeRef: 2,
        candidateCount: 2,
        ignoredCount: 0,
        byReason: { 'source-modified-pattern': 1, 'source-missing': 1 },
      },
    };

    const result = await submitRescanImpactDecisions(plan, gateway);

    expect(gateway.submit).toHaveBeenCalledOnce();
    expect(result.submitted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.processedRecipeIds).toEqual(['r1']);
  });

  it('treats duplicate deterministic impact proposals as already processed', async () => {
    const gateway = {
      submit: vi.fn(async (decision) => ({
        recipeId: decision.recipeId,
        action: decision.action,
        outcome: 'skipped' as const,
        error: 'Duplicate proposal (evidence not richer)',
      })),
    };
    const plan: EvolutionCandidatePlan = {
      candidates: [modifiedCandidate],
      ignored: [],
      summary: {
        totalChangedFiles: 1,
        filesWithRecipeRef: 1,
        candidateCount: 1,
        ignoredCount: 0,
        byReason: { 'source-modified-pattern': 1 },
      },
    };

    const result = await submitRescanImpactDecisions(plan, gateway);

    expect(result.submitted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.processedRecipeIds).toEqual(['r1']);
    expect(result.errors).toEqual([]);
  });
});
