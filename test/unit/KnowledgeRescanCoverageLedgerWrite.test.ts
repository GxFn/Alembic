import type { CoverageLedgerRepository } from '@alembic/core/repositories';
import { describe, expect, test, vi } from 'vitest';
import { selectScopedModuleMiningModules } from '../../lib/recipe-pipeline/generate/ModuleMiningSelection.js';
import {
  type KnowledgeRescanCoverageLedgerWriteInput,
  writeKnowledgeRescanCoverageLedgerForDimension,
} from '../../lib/recipe-pipeline/sustain/KnowledgeRescanWorkflow.js';
import { writeModuleMiningCoverageLedger } from '../../lib/shared/ModuleMiningEvidence.js';

function createFakeCoverageLedgerRepository(roundIndex = 3) {
  const upserts: Array<Record<string, unknown>> = [];
  const upsertRound = vi.fn();
  const repository = {
    getCell: vi.fn(() => null),
    listByProjectRoot: vi.fn(() => []),
    listRoundsByProjectRoot: vi.fn(() => [
      {
        projectRoot: '/proj',
        rescanId: 'round-3',
        roundIndex,
        startedAt: 1,
        completedAt: null,
        newRecipesThisRound: 0,
        triggerActor: 'test',
      },
    ]),
    upsertCell: vi.fn((input: Record<string, unknown>) => {
      upserts.push(input);
      return {
        ...input,
        createdAt: 0,
        updatedAt: 0,
      };
    }),
    upsertRound,
  } as unknown as CoverageLedgerRepository & { upsertRound: ReturnType<typeof vi.fn> };
  return { repository, upserts, upsertRound };
}

function makeInput(
  overrides: Partial<KnowledgeRescanCoverageLedgerWriteInput> = {}
): KnowledgeRescanCoverageLedgerWriteInput {
  const { repository } = createFakeCoverageLedgerRepository();
  return {
    candidateCount: 1,
    ctx: {
      container: {
        get: (name: string) => (name === 'coverageLedgerRepository' ? repository : undefined),
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    },
    dimensionId: 'api',
    projectContextFacts: {
      projectMapModules: [
        {
          moduleId: 'auth',
          moduleName: 'Auth',
          modulePath: 'src/auth',
          ownedFiles: ['src/auth/login.ts'],
        },
        {
          moduleId: 'billing',
          moduleName: 'Billing',
          modulePath: 'src/billing',
          ownedFiles: ['src/billing/charge.ts'],
        },
      ],
    },
    projectRoot: '/proj',
    referencedFiles: ['src/auth/login.ts:42'],
    roundIndex: 7,
    ...overrides,
  };
}

describe('knowledge rescan coverage ledger write', () => {
  test('accepted source-ref-backed recipe advances a seeded cell without touching round accounting', () => {
    const { repository, upserts, upsertRound } = createFakeCoverageLedgerRepository();
    const result = writeKnowledgeRescanCoverageLedgerForDimension(
      makeInput({
        ctx: {
          container: {
            get: (name: string) => (name === 'coverageLedgerRepository' ? repository : undefined),
          },
          logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        },
      })
    );

    expect(result).toMatchObject({ skipped: false, writtenCells: 2 });
    const authCell = upserts.find((upsert) => upsert.moduleId === 'target:Auth:src/auth');
    const billingCell = upserts.find((upsert) => upsert.moduleId === 'target:Billing:src/billing');
    expect(authCell).toMatchObject({
      coveredSourceRefs: ['src/auth/login.ts'],
      deferred: false,
      dimensionId: 'api',
      grade: 'partial',
      lastRound: 7,
      moduleId: 'target:Auth:src/auth',
    });
    expect(authCell?.coveredCount).toBeGreaterThan(0);
    expect(billingCell).toMatchObject({
      coveredCount: 0,
      deferred: false,
      dimensionId: 'api',
      grade: 'thin',
      moduleId: 'target:Billing:src/billing',
    });
    expect(upsertRound).not.toHaveBeenCalled();
  });

  test('all cells can converge when accepted source refs meet the per-cell target', () => {
    const { repository, upserts } = createFakeCoverageLedgerRepository();
    const ownedFiles = Array.from({ length: 5 }, (_, index) => `src/auth/file-${index}.ts`);

    const result = writeKnowledgeRescanCoverageLedgerForDimension(
      makeInput({
        ctx: {
          container: {
            get: (name: string) => (name === 'coverageLedgerRepository' ? repository : undefined),
          },
          logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        },
        projectContextFacts: {
          projectMapModules: [
            {
              moduleId: 'auth',
              moduleName: 'Auth',
              modulePath: 'src/auth',
              ownedFiles,
            },
          ],
        },
        referencedFiles: ownedFiles.map((file, index) => `${file}:${index + 1}`),
        roundIndex: 8,
      })
    );

    expect(result).toMatchObject({ skipped: false, writtenCells: 1 });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      coveredSourceRefs: ownedFiles,
      grade: 'covered',
      lastRound: 8,
      moduleId: 'target:Auth:src/auth',
    });
    expect(upserts[0]?.coveredCount).toBeGreaterThanOrEqual(5);
  });

  test('uses accepted recipe source refs instead of coarse dimension referenced files', () => {
    const { repository, upserts } = createFakeCoverageLedgerRepository();

    const result = writeKnowledgeRescanCoverageLedgerForDimension(
      makeInput({
        ctx: {
          container: {
            get: (name: string) => (name === 'coverageLedgerRepository' ? repository : undefined),
          },
          logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        },
        acceptedSourceRefs: ['src/auth/login.ts:42'],
        referencedFiles: ['Package.swift'],
      })
    );

    expect(result).toMatchObject({ skipped: false, writtenCells: 2 });
    const authCell = upserts.find((upsert) => upsert.moduleId === 'target:Auth:src/auth');
    expect(authCell).toMatchObject({
      coveredSourceRefs: ['src/auth/login.ts'],
      grade: 'partial',
      moduleId: 'target:Auth:src/auth',
    });
    expect(authCell?.coveredCount).toBeGreaterThan(0);
  });

  test('rejected or source-ref-less output does not increase coverage', () => {
    const { repository, upserts, upsertRound } = createFakeCoverageLedgerRepository();
    const ctx = {
      container: {
        get: (name: string) => (name === 'coverageLedgerRepository' ? repository : undefined),
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    };

    expect(
      writeKnowledgeRescanCoverageLedgerForDimension(
        makeInput({
          candidateCount: 0,
          ctx,
          referencedFiles: ['src/auth/login.ts:42'],
        })
      )
    ).toEqual({ skipped: true, reason: 'no-accepted-candidates' });
    expect(
      writeKnowledgeRescanCoverageLedgerForDimension(
        makeInput({
          acceptedSourceRefs: [],
          candidateCount: 1,
          ctx,
          referencedFiles: ['src/auth/login.ts:42'],
        })
      )
    ).toEqual({ skipped: true, reason: 'no-source-refs' });
    expect(upserts).toEqual([]);
    expect(upsertRound).not.toHaveBeenCalled();
  });

  test('keeps no-path ProjectMap module ids as explicit coverage ledger fallback', () => {
    const { repository, upserts } = createFakeCoverageLedgerRepository();

    const result = writeKnowledgeRescanCoverageLedgerForDimension(
      makeInput({
        ctx: {
          container: {
            get: (name: string) => (name === 'coverageLedgerRepository' ? repository : undefined),
          },
          logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        },
        projectContextFacts: {
          projectMapModules: [
            {
              moduleId: 'legacy-auth',
              moduleName: 'LegacyAuth',
              ownedFiles: ['legacy/auth.ts'],
            },
          ],
        },
        referencedFiles: ['legacy/auth.ts:1'],
      })
    );

    expect(result).toMatchObject({ skipped: false, writtenCells: 1 });
    expect(upserts).toEqual([
      expect.objectContaining({
        coveredSourceRefs: ['legacy/auth.ts'],
        moduleId: 'legacy-auth',
      }),
    ]);
  });

  test('moduleMining explicit targets can write coverage when gap execution dimensions are empty', () => {
    const { repository, upserts, upsertRound } = createFakeCoverageLedgerRepository();
    const selectedModules = selectScopedModuleMiningModules({
      bindings: [
        {
          dimensions: ['architecture'],
          moduleId: 'mod-2',
          moduleName: 'module-2',
          targetRecipes: 1,
        },
      ],
      executionDimensions: [],
      facts: {
        projectMapModules: [
          {
            moduleId: 'mod-2',
            moduleName: 'module-2',
            modulePath: 'src/module-2',
            ownedFiles: ['src/module-2/index.ts'],
          },
        ],
      } as never,
      moduleScope: ['module-2'],
    });

    const result = writeModuleMiningCoverageLedger({
      container: {
        get: (name: string) => (name === 'coverageLedgerRepository' ? repository : undefined),
      },
      logger: { info: vi.fn() },
      projectRoot: '/proj',
      selectedModules,
      sourceRefPaths: ['src/module-2/index.ts:12'],
    });

    expect(result).toMatchObject({
      dimensionIds: ['architecture'],
      measuredCells: 1,
      status: 'written',
      writtenCells: 1,
    });
    expect(upserts).toEqual([
      expect.objectContaining({
        coveredSourceRefs: ['src/module-2/index.ts'],
        dimensionId: 'architecture',
        grade: 'covered',
        moduleId: 'target:module-2:src/module-2',
        totalCandidateCount: 1,
      }),
    ]);
    expect(upsertRound).not.toHaveBeenCalled();
  });
});
