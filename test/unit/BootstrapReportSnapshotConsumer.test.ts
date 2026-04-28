import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { CandidateResults } from '#workflows/bootstrap/consumers/BootstrapDimensionConsumer.js';
import type { SkillResults } from '#workflows/bootstrap/consumers/BootstrapSkillConsumer.js';
import {
  buildBootstrapReport,
  consumeBootstrapReportAndSnapshot,
  summarizeBootstrapDimensionStats,
} from '#workflows/bootstrap/reports/BootstrapReportSnapshotConsumer.js';
import type { SessionStore } from '../../lib/agent/memory/SessionStore.js';
import type { IncrementalPlan } from '../../lib/external/mcp/handlers/types.js';

const candidateResults: CandidateResults = { created: 2, failed: 0, errors: [] };
const skillResults: SkillResults = { created: 1, failed: 0, skills: ['project-api'], errors: [] };

function makeIncrementalPlan(): IncrementalPlan {
  return {
    canIncremental: true,
    mode: 'incremental',
    affectedDimensions: ['api'],
    skippedDimensions: ['ui'],
    previousSnapshot: null,
    diff: { added: ['a'], modified: ['b'], deleted: [], unchanged: ['c'], changeRatio: 0.5 },
    reason: 'test',
    restoredEpisodic: null,
  };
}

describe('bootstrap report snapshot consumer', () => {
  test('summarizes dimension token and tool usage', () => {
    expect(
      summarizeBootstrapDimensionStats({
        api: {
          candidateCount: 1,
          durationMs: 1,
          toolCallCount: 2,
          tokenUsage: { input: 3, output: 4 },
        },
        ui: {
          candidateCount: 0,
          durationMs: 1,
          toolCallCount: 1,
          tokenUsage: { input: 5, output: 6 },
        },
      })
    ).toEqual({
      totalToolCalls: 3,
      totalTokenUsage: { input: 8, output: 10 },
    });
  });

  test('builds bootstrap report DTO from workflow state', () => {
    const report = buildBootstrapReport({
      projectInfo: { name: 'Alembic', fileCount: 10, lang: 'ts' },
      dimensionStats: {
        api: {
          candidateCount: 2,
          rejectedCount: 1,
          analysisChars: 100,
          referencedFiles: 3,
          durationMs: 9,
          toolCallCount: 4,
          tokenUsage: { input: 1, output: 2 },
          qualityGate: { action: 'pass' },
        },
      },
      candidateResults,
      skillResults,
      consolidationResult: {
        total: { added: 1, updated: 2, merged: 3, skipped: 4 },
        durationMs: 12,
      },
      skippedDims: ['api'],
      incrementalSkippedDims: ['ui'],
      isIncremental: true,
      incrementalPlan: makeIncrementalPlan(),
      totalTimeMs: 1234,
      totalTokenUsage: { input: 1, output: 2 },
      totalToolCalls: 4,
    });

    expect(report).toMatchObject({
      project: { name: 'Alembic', files: 10, lang: 'ts' },
      duration: { totalMs: 1234, totalSec: 1 },
      totals: { candidates: 2, skills: 1, toolCalls: 4, errors: 0 },
      checkpoints: { restored: ['api'] },
      incremental: {
        mode: 'incremental',
        affectedDimensions: ['api'],
        skippedDimensions: ['ui'],
        diff: { added: 1, modified: 1, deleted: 0, unchanged: 1 },
      },
      semanticMemory: { added: 1, updated: 2, merged: 3, skipped: 4, durationMs: 12 },
      dimensions: {
        api: {
          candidatesSubmitted: 2,
          candidatesRejected: 1,
          analysisChars: 100,
          referencedFiles: 3,
          durationMs: 9,
          toolCallCount: 4,
          tokenUsage: { input: 1, output: 2 },
          qualityGate: { action: 'pass' },
        },
      },
    });
  });

  test('writes report and saves snapshot through injected boundaries', async () => {
    const dataRoot = await fs.mkdtemp(path.join(process.cwd(), '.tmp-bootstrap-report-'));
    const writeFileAsync = vi.fn();
    const saveSnapshot = vi.fn(() => 'snapshot-1');

    const result = await consumeBootstrapReportAndSnapshot({
      ctx: {
        container: {
          get: (name: string) => (name === 'database' ? { marker: 'db' } : null),
          singletons: {
            writeZone: {
              runtime: (file: string) => `runtime:${file}`,
              writeFileAsync,
            },
          },
        },
      },
      dataRoot,
      projectRoot: process.cwd(),
      projectInfo: { name: 'Alembic', fileCount: 1, lang: 'ts' },
      sessionId: 'session-1',
      allFiles: [{ path: '/repo/a.ts', relativePath: 'a.ts', content: 'export {}' }],
      sessionStore: {
        toJSON: () => ({}),
        getCompletedDimensions: () => [],
      } as unknown as SessionStore,
      dimensionStats: {
        api: {
          candidateCount: 1,
          durationMs: 1,
          toolCallCount: 1,
          tokenUsage: { input: 2, output: 3 },
        },
      },
      candidateResults,
      skillResults,
      consolidationResult: null,
      skippedDims: [],
      incrementalSkippedDims: [],
      enableParallel: true,
      concurrency: 3,
      startedAtMs: Date.now(),
      createIncrementalBootstrap: () => ({ saveSnapshot }),
    });

    expect(result.snapshotId).toBe('snapshot-1');
    expect(result.totalTokenUsage).toEqual({ input: 2, output: 3 });
    expect(writeFileAsync).toHaveBeenCalledWith(
      'runtime:bootstrap-report.json',
      expect.stringContaining('"version": "2.7.0"')
    );
    expect(saveSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        meta: expect.objectContaining({ candidateCount: 2, primaryLang: 'ts' }),
      })
    );

    await fs.rm(dataRoot, { recursive: true, force: true });
  });
});
