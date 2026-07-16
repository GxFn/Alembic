import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runGenerateWorkflow } from '../../lib/recipe-pipeline/generate/GenerateWorkflow.js';
import { runGeneratePlanGate } from '../../lib/recipe-pipeline/plan/PlanSelectionGate.js';
import { executeRecipePipelineJob } from '../../lib/recipe-pipeline/RecipePipelineFacade.js';

vi.mock('../../lib/recipe-pipeline/plan/PlanSelectionGate.js', () => ({
  runGeneratePlanGate: vi.fn(),
}));
vi.mock('../../lib/recipe-pipeline/generate/GenerateWorkflow.js', () => ({
  runGenerateWorkflow: vi.fn(),
}));

describe('RecipePipelineFacade strict cold start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bypasses executable legacy Plan and does not report asyncFill strict success', async () => {
    vi.mocked(runGenerateWorkflow).mockResolvedValue({
      data: { mode: 'strict-production', status: 'FINALIZED' },
    });
    const result = await executeRecipePipelineJob({
      args: {
        strictProduction: {
          schemaVersion: 1,
          authorizationReceiptHash: sha('authorization'),
          authorizationReceiptPath: 'strict-production/authorizations/run-a.json',
          runId: 'run-a',
        },
      },
      container: {} as never,
      jobId: 'job-a',
      kind: 'bootstrap',
      logger: logger(),
      source: 'api',
    });

    expect(runGeneratePlanGate).not.toHaveBeenCalled();
    expect(runGenerateWorkflow).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        strictProduction: expect.objectContaining({
          ownerId: 'daemon-job:job-a',
          runId: 'run-a',
        }),
      }),
      { mode: 'full' }
    );
    expect(result).toEqual({ mode: 'strict-production', status: 'FINALIZED', asyncFill: false });
  });

  it('fails closed for a malformed strict request instead of falling back to legacy', async () => {
    await expect(
      executeRecipePipelineJob({
        args: { strictProduction: { schemaVersion: 1, runId: 'run-a' } },
        container: {} as never,
        jobId: 'job-a',
        kind: 'bootstrap',
        logger: logger(),
        source: 'api',
      })
    ).rejects.toThrow('STRICT_PRODUCTION_REQUEST_INVALID');
    expect(runGeneratePlanGate).not.toHaveBeenCalled();
    expect(runGenerateWorkflow).not.toHaveBeenCalled();
  });

  it('passes one versioned external setup authority through the real facade boundary', async () => {
    vi.mocked(runGenerateWorkflow).mockResolvedValue({
      data: { mode: 'strict-production-recovery', status: 'RECOVERED' },
    });
    const setupAuthority = {
      schemaVersion: 1 as const,
      action: 'recover' as const,
      scenario: 'rebuild' as const,
      snapshotRootRef: 'ENV.TEST_MR_ALEMBIC_REBUILD.snapshotRootRef',
      operationLockRootRef: 'ENV.TEST_MR_ALEMBIC_REBUILD.operationLockRootRef',
      evidenceRootRef: 'ENV.TEST_MR_ALEMBIC_REBUILD.evidenceRootRef',
      plannedAbsentPathReceiptHash: sha('planned-paths'),
      preResetObservationRef: 'OBSERVED_MR_PRE_RESET',
      restorePolicyRef: 'AUTH_MR_REBUILD_PRE_RESET',
      pathPlanHash: sha('path-plan'),
    };

    await executeRecipePipelineJob({
      args: {
        strictProduction: {
          schemaVersion: 1,
          authorizationReceiptHash: sha('authorization'),
          authorizationReceiptPath: 'strict-setup-authority.json',
          runId: 'run-a',
          setupAuthority,
        },
      },
      container: {} as never,
      jobId: 'job-recovery',
      kind: 'bootstrap',
      logger: logger(),
      source: 'api',
    });

    expect(runGenerateWorkflow).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        strictProduction: expect.objectContaining({
          ownerId: 'daemon-job:job-recovery',
          setupAuthority,
        }),
      }),
      { mode: 'full' }
    );
  });

  it('rejects raw path overrides and unknown setup authority keys', async () => {
    await expect(
      executeRecipePipelineJob({
        args: {
          strictProduction: {
            schemaVersion: 1,
            authorizationReceiptHash: sha('authorization'),
            authorizationReceiptPath: 'strict-setup-authority.json',
            runId: 'run-a',
            setupAuthority: {
              schemaVersion: 1,
              action: 'execute',
              scenario: 'pristine',
              snapshotRootRef: 'NOT_APPLICABLE_PHYSICAL_ABSENCE',
              operationLockRootRef: 'ENV.TEST_MR_ALEMBIC_PRISTINE.operationLockRootRef',
              evidenceRootRef: 'ENV.TEST_MR_ALEMBIC_PRISTINE.evidenceRootRef',
              plannedAbsentPathReceiptHash: sha('planned-paths'),
              preResetObservationRef: 'NOT_APPLICABLE_PHYSICAL_ABSENCE',
              restorePolicyRef: 'AUTH_MR_PRISTINE_ALLOCATION',
              pathPlanHash: sha('path-plan'),
              dataRoot: '/caller/override/is/forbidden',
            },
          },
        },
        container: {} as never,
        jobId: 'job-invalid',
        kind: 'bootstrap',
        logger: logger(),
        source: 'api',
      })
    ).rejects.toThrow('STRICT_PRODUCTION_REQUEST_INVALID');
  });
});

function logger() {
  return { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function sha(value: string): string {
  return `sha256:${value.length.toString(16).padStart(64, 'a').slice(-64)}`;
}
