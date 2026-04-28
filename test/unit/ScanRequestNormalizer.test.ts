import { describe, expect, test } from 'vitest';
import { ScanRequestNormalizer } from '../../lib/workflows/scan/normalization/ScanRequestNormalizer.js';

describe('ScanRequestNormalizer', () => {
  const normalizer = new ScanRequestNormalizer({ defaultProjectRoot: '/repo' });

  test('normalizes scan plan requests with baseline and change set fields', () => {
    expect(
      normalizer.toScanPlanRequest({
        intent: 'deep-mining',
        baseline: { runId: 'run-1', snapshotId: 'snapshot-1' },
        dimensions: ['architecture'],
        modules: ['api'],
        changeSet: { modified: ['src/api.ts'], source: 'manual' },
        budget: { maxFiles: 12 },
      })
    ).toMatchObject({
      projectRoot: '/repo',
      intent: 'deep-mining',
      baselineRunId: 'run-1',
      baselineSnapshotId: 'snapshot-1',
      dimensions: ['architecture'],
      modules: ['api'],
      changeSet: { modified: ['src/api.ts'], source: 'manual' },
      budget: { maxFiles: 12 },
    });
  });

  test('normalizes retrieval requests with mode-derived intent', () => {
    expect(
      normalizer.toKnowledgeRetrievalInput({
        mode: 'incremental-correction',
        files: [{ path: 'src/api.ts', content: 'export {}' }],
      })
    ).toMatchObject({
      projectRoot: '/repo',
      mode: 'incremental-correction',
      intent: 'audit-impacted-recipes',
      files: [{ relativePath: 'src/api.ts', path: 'src/api.ts', content: 'export {}' }],
    });
  });

  test('normalizes incremental correction run input', () => {
    expect(
      normalizer.toIncrementalCorrectionRunInput(
        { runDeterministic: false, runAgent: true, depth: 'deep', primaryLang: 'ts' },
        [{ type: 'modified', path: 'src/api.ts', eventSource: 'ide-edit' }]
      )
    ).toEqual({
      projectRoot: '/repo',
      events: [{ type: 'modified', path: 'src/api.ts', eventSource: 'ide-edit' }],
      runDeterministic: false,
      runAgent: true,
      depth: 'deep',
      budget: undefined,
      primaryLang: 'ts',
    });
  });

  test('normalizes deep-mining requests with nested baseline', () => {
    expect(
      normalizer.toDeepMiningRequest({
        baseline: { snapshotId: 'snapshot-1' },
        dimensions: ['security'],
        depth: 'exhaustive',
        maxNewCandidates: 5,
        runAgent: true,
      })
    ).toMatchObject({
      projectRoot: '/repo',
      baselineSnapshotId: 'snapshot-1',
      dimensions: ['security'],
      depth: 'exhaustive',
      maxNewCandidates: 5,
      runAgent: true,
    });
  });

  test('projects execution requests into lifecycle requests', () => {
    expect(
      normalizer.toDeepMiningLifecycleRequest({
        baselineRunId: 'run-1',
        query: 'routing',
        runAgent: true,
      })
    ).toMatchObject({
      source: 'http',
      requestedMode: 'deep-mining',
      intent: 'deep-mining',
      baseline: { runId: 'run-1' },
      query: 'routing',
      execution: { runAgent: true },
    });

    expect(
      normalizer.toIncrementalCorrectionLifecycleRequest({ runDeterministic: false }, [
        { type: 'modified', path: 'src/api.ts' },
      ])
    ).toMatchObject({
      requestedMode: 'incremental-correction',
      intent: 'change-set',
      events: [{ type: 'modified', path: 'src/api.ts' }],
      execution: { runDeterministic: false, runAgent: false },
    });
  });

  test('normalizes maintenance and file-change scan options', () => {
    expect(
      normalizer.toMaintenanceOptions({
        refreshSearchIndex: false,
        includeRedundancy: true,
      })
    ).toEqual({
      projectRoot: '/repo',
      forceSourceRefReconcile: undefined,
      refreshSearchIndex: false,
      includeDecay: undefined,
      includeEnhancements: undefined,
      includeRedundancy: true,
    });

    expect(
      normalizer.toFileChangesScanOptions(
        { enabled: true, runAgent: true, depth: 'standard' },
        { projectRoot: '/other' }
      )
    ).toMatchObject({
      enabled: true,
      projectRoot: '/other',
      runAgent: true,
      depth: 'standard',
    });
  });
});
