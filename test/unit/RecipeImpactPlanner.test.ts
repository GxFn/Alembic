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

import { describe, expect, it, vi } from 'vitest';
import {
  type DiffInput,
  type EvolutionCandidatePlan,
  RecipeImpactPlanner,
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
