import type { WorkflowReport } from '@alembic/core/host-agent-workflows';
import { describe, expect, test } from 'vitest';
import { augmentWorkflowReportWithEfficiency } from '#workflows/capabilities/execution/internal-agent/InternalDimensionFillFinalizer.js';

describe('internal dimension fill finalizer efficiency report augmentation', () => {
  test('writes aggregate and per-dimension efficiency into workflow reports', () => {
    const report = {
      version: '2.7.0',
      timestamp: '2026-05-20T00:00:00.000Z',
      project: { name: 'Alembic', files: 1, lang: 'ts' },
      duration: { totalMs: 100, totalSec: 0 },
      dimensions: { api: { toolCallCount: 3 }, ui: { toolCallCount: 2 } },
      totals: { toolCalls: 5 },
      checkpoints: { restored: [] },
      incremental: null,
      semanticMemory: null,
      session: { id: 'session-1' },
    } as WorkflowReport;

    const changed = augmentWorkflowReportWithEfficiency(report, {
      api: {
        candidateCount: 1,
        durationMs: 10,
        efficiency: {
          toolCalls: 3,
          duplicateToolCalls: 1,
          cacheHits: 2,
          cacheMisses: 1,
          tokenUsage: { input: 10, output: 4, reasoning: 2, cacheHit: 3 },
          maxCompactionLevel: 1,
          totalCompactedItems: 2,
          nudgeCount: 1,
          replanCount: 0,
          emptyRetries: 1,
          forcedSummary: false,
        },
      },
      ui: {
        candidateCount: 0,
        durationMs: 10,
        efficiency: {
          toolCalls: 2,
          duplicateToolCalls: 0,
          cacheHits: 1,
          cacheMisses: 1,
          tokenUsage: { input: 8, output: 3, reasoning: 1, cacheHit: 2 },
          maxCompactionLevel: 2,
          totalCompactedItems: 3,
          nudgeCount: 0,
          replanCount: 1,
          emptyRetries: 0,
          forcedSummary: true,
        },
      },
    });

    expect(changed).toBe(true);
    expect(report.efficiency).toMatchObject({
      toolCalls: 5,
      duplicateToolCalls: 1,
      cacheHits: 3,
      tokenUsage: { input: 18, output: 7, reasoning: 3, cacheHit: 5 },
      maxCompactionLevel: 2,
      forcedSummary: true,
    });
    expect(report.dimensions.api).toMatchObject({
      efficiency: { duplicateToolCalls: 1, emptyRetries: 1 },
    });
    expect(report.totals).toMatchObject({
      efficiency: { cacheHits: 3, totalCompactedItems: 5 },
    });
  });
});
