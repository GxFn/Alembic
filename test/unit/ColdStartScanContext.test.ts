import { describe, expect, test, vi } from 'vitest';
import type { ProjectSnapshot } from '../../lib/types/project-snapshot.js';
import { buildColdStartScanContext } from '../../lib/workflows/scan/lifecycle/ColdStartScanContext.js';
import type { KnowledgeEvidencePack } from '../../lib/workflows/scan/ScanTypes.js';

function makeSnapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    projectRoot: '/repo',
    sourceTag: 'bootstrap',
    isEmpty: false,
    activeDimensions: [{ id: 'architecture', label: 'Architecture', description: '' }],
    allFiles: [
      {
        path: '/repo/src/index.ts',
        relativePath: 'src/index.ts',
        name: 'index.ts',
        language: 'typescript',
        content: 'export const value = 1;',
      },
    ],
    language: { primaryLang: 'typescript', stats: {}, filesByLang: {} },
    incrementalPlan: null,
    ...overrides,
  } as ProjectSnapshot;
}

function makePack(): KnowledgeEvidencePack {
  return {
    project: { root: '/repo', primaryLang: 'typescript', fileCount: 1, modules: [] },
    files: [{ relativePath: 'src/index.ts', language: 'typescript', role: 'evidence' }],
    knowledge: [],
    graph: { entities: [], edges: [] },
    gaps: [],
    diagnostics: { truncated: false, warnings: [], retrievalMs: 3 },
  };
}

describe('buildColdStartScanContext', () => {
  test('returns null when scan context is disabled', async () => {
    await expect(
      buildColdStartScanContext({ container: { get: () => null } }, makeSnapshot(), undefined)
    ).resolves.toBeNull();
  });

  test('plans, retrieves evidence and tracks a cold-start run', async () => {
    const plan = {
      mode: 'cold-start' as const,
      depth: 'standard' as const,
      reason: 'test baseline',
      activeDimensions: ['architecture'],
      skippedDimensions: [],
      scope: { dimensions: ['architecture'] },
      fallback: null,
      budgets: {
        maxFiles: 10,
        maxKnowledgeItems: 20,
        maxTotalChars: 30_000,
        maxAgentIterations: 30,
      },
    };
    const scanPlanService = { plan: vi.fn(() => plan) };
    const knowledgeRetrievalPipeline = { retrieve: vi.fn(async () => makePack()) };
    const scanRunRepository = {
      create: vi.fn(() => ({
        id: 'scan-1',
        projectRoot: '/repo',
        mode: 'cold-start',
        depth: 'standard',
        status: 'running',
        reason: 'test baseline',
        activeDimensions: ['architecture'],
        scope: { dimensions: ['architecture'] },
        changeSet: null,
        budgets: {},
        summary: {},
        errorMessage: null,
        parentSnapshotId: null,
        baselineSnapshotId: null,
        startedAt: 100,
        completedAt: null,
        durationMs: null,
      })),
    };
    const scanEvidencePackRepository = {
      create: vi.fn(() => ({ id: 'pack-1', packKind: 'cold-start' })),
    };
    const services: Record<string, unknown> = {
      scanPlanService,
      knowledgeRetrievalPipeline,
      scanRunRepository,
      scanEvidencePackRepository,
    };

    const result = await buildColdStartScanContext(
      { container: { get: (name: string) => services[name] } },
      makeSnapshot(),
      { enabled: true, retrieveEvidence: true }
    );

    expect(result?.plan).toBe(plan);
    expect(result?.evidencePack?.project.root).toBe('/repo');
    expect(result?.run?.id).toBe('scan-1');
    expect(result?.evidencePackRecord?.id).toBe('pack-1');
    expect(scanPlanService.plan).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'bootstrap', allDimensionIds: ['architecture'] })
    );
    expect(knowledgeRetrievalPipeline.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'build-baseline', scope: { dimensions: ['architecture'] } })
    );
    expect(scanRunRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'cold-start', reason: 'test baseline' })
    );
    expect(scanEvidencePackRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'scan-1', packKind: 'cold-start' })
    );
  });
});
