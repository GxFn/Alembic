import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { IncrementalPlan } from '#types/workflows.js';
import type { SessionStore } from '../../lib/agent/memory/SessionStore.js';
import type {
  CandidateResults,
  SkillResults,
} from '../../lib/workflows/capabilities/execution/internal-agent/BootstrapConsumers.js';
import { writeWorkflowReportHistory } from '../../lib/workflows/capabilities/persistence/WorkflowReportHistoryStore.js';
import { buildWorkflowReport } from '../../lib/workflows/capabilities/persistence/WorkflowReportWriter.js';
import {
  persistWorkflowResult,
  summarizeWorkflowDimensionStats,
} from '../../lib/workflows/capabilities/persistence/WorkflowResultPersistence.js';

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

describe('WorkflowResultPersistence', () => {
  test('summarizes dimension token and tool usage', () => {
    expect(
      summarizeWorkflowDimensionStats({
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
    const report = buildWorkflowReport({
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
      completionSummary: {
        mode: 'bootstrap',
        isolation: 'full-completion',
        delivery: { status: 'completed', verification: null },
        wiki: { status: 'scheduled' },
        semanticMemory: {
          status: 'completed',
          result: {
            total: { added: 1, updated: 2, merged: 3, skipped: 4 },
            durationMs: 12,
          },
        },
      },
      snapshotSummary: {
        status: 'saved',
        id: 'snapshot-1',
        fileCount: 10,
        dimensionCount: 1,
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
      completion: {
        mode: 'bootstrap',
        isolation: 'full-completion',
        delivery: { status: 'completed', verification: null },
        wiki: { status: 'scheduled' },
        semanticMemory: {
          status: 'completed',
          result: {
            total: { added: 1, updated: 2, merged: 3, skipped: 4 },
            durationMs: 12,
          },
        },
      },
      snapshot: {
        status: 'saved',
        id: 'snapshot-1',
        fileCount: 10,
        dimensionCount: 1,
      },
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

  test('reports rescan finalizer isolation explicitly', () => {
    const report = buildWorkflowReport({
      projectInfo: { name: 'Alembic', fileCount: 10, lang: 'ts' },
      dimensionStats: {},
      candidateResults,
      skillResults,
      consolidationResult: null,
      completionSummary: {
        mode: 'rescan',
        isolation: 'pipeline-isolation',
        reason:
          'rescan skips delivery/wiki/semantic memory to avoid rebuilding downstream artifacts',
        delivery: { status: 'skipped', verification: null },
        wiki: { status: 'skipped' },
        semanticMemory: { status: 'skipped', result: null },
      },
      skippedDims: [],
      incrementalSkippedDims: [],
      totalTimeMs: 1234,
      totalTokenUsage: { input: 1, output: 2 },
      totalToolCalls: 0,
    });

    expect(report.semanticMemory).toBeNull();
    expect(report.completion).toMatchObject({
      mode: 'rescan',
      isolation: 'pipeline-isolation',
      delivery: { status: 'skipped' },
      wiki: { status: 'skipped' },
      semanticMemory: { status: 'skipped' },
    });
  });

  test('counts terminal-run tool calls in report terminal usage', () => {
    const report = buildWorkflowReport({
      projectInfo: { name: 'Alembic', fileCount: 10, lang: 'ts' },
      dimensionStats: {
        api: {
          candidateCount: 0,
          durationMs: 9,
          toolCallCount: 1,
          tokenUsage: { input: 1, output: 2 },
          diagnostics: {
            toolCalls: [{ tool: 'terminal', status: 'ok', ok: true, durationMs: 12 }],
          },
        },
      },
      candidateResults,
      skillResults,
      consolidationResult: null,
      skippedDims: [],
      incrementalSkippedDims: [],
      totalTimeMs: 1234,
      totalTokenUsage: { input: 1, output: 2 },
      totalToolCalls: 1,
    });

    expect(report.toolUsage).toMatchObject({
      total: 1,
      byTool: { terminal: 1 },
    });
    expect(report.terminal).toMatchObject({
      enabled: true,
      commands: [{ dimensionId: 'api', tool: 'terminal', status: 'ok', ok: true }],
      successRate: 1,
    });
  });

  test('marks terminal enabled when stage toolset exposes terminal', () => {
    const report = buildWorkflowReport({
      projectInfo: { name: 'Alembic', fileCount: 10, lang: 'ts' },
      dimensionStats: {
        api: {
          candidateCount: 0,
          durationMs: 9,
          toolCallCount: 0,
          tokenUsage: { input: 1, output: 2 },
          diagnostics: {
            stageToolsets: [
              {
                stage: 'analyze',
                allowedToolIds: ['code', 'terminal', 'graph', 'memory', 'meta'],
                source: 'system',
              },
            ],
          },
        },
      },
      candidateResults,
      skillResults,
      consolidationResult: null,
      skippedDims: [],
      incrementalSkippedDims: [],
      totalTimeMs: 1234,
      totalTokenUsage: { input: 1, output: 2 },
      totalToolCalls: 0,
    });

    expect(report.session).toMatchObject({
      terminalEnabled: true,
      terminalCapability: 'terminal-run',
    });
    expect(report.terminal).toMatchObject({
      enabled: true,
      commands: [],
      successRate: 0,
    });
  });

  test('writes report and saves snapshot through injected boundaries', async () => {
    const dataRoot = await fs.mkdtemp(path.join(process.cwd(), '.tmp-bootstrap-report-'));
    const writeFileAsync = vi.fn();
    const saveSnapshot = vi.fn(() => 'snapshot-1');

    const result = await persistWorkflowResult({
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
      createFileDiffPlanner: () => ({ saveSnapshot }),
    });

    expect(result.snapshotId).toBe('snapshot-1');
    expect(result.snapshot).toMatchObject({ status: 'saved', id: 'snapshot-1' });
    expect(result.totalTokenUsage).toEqual({ input: 2, output: 3 });
    const latestReportCall = writeFileAsync.mock.calls.find(
      ([target]) => target === 'runtime:bootstrap-report.json'
    );
    expect(latestReportCall).toBeTruthy();
    const latestReport = JSON.parse(String(latestReportCall?.[1]));
    expect(latestReport.snapshot).toMatchObject({ status: 'saved', id: 'snapshot-1' });
    const manifestCall = writeFileAsync.mock.calls.find(
      ([target]) => target === 'runtime:bootstrap-reports/artifacts/session-1/manifest.json'
    );
    expect(manifestCall).toBeTruthy();
    const manifest = JSON.parse(String(manifestCall?.[1]));
    expect(manifest).toMatchObject({
      sessionId: 'session-1',
      snapshot: { status: 'saved', id: 'snapshot-1' },
      terminal: { enabled: false, commandCount: 0 },
    });
    expect(saveSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        meta: expect.objectContaining({ candidateCount: 2, primaryLang: 'ts' }),
      })
    );

    await fs.rm(dataRoot, { recursive: true, force: true });
  });

  test('writes valid report history index and per-session artifact manifests', async () => {
    const dataRoot = await fs.mkdtemp(path.join(process.cwd(), '.tmp-bootstrap-history-'));
    const reportDir = path.join(dataRoot, '.asd');
    const reportA = buildWorkflowReport({
      sessionId: 'session-a',
      projectInfo: { name: 'Alembic', fileCount: 1, lang: 'ts' },
      dimensionStats: {},
      candidateResults,
      skillResults,
      consolidationResult: null,
      snapshotSummary: { status: 'skipped', id: null, reason: 'database unavailable' },
      skippedDims: [],
      incrementalSkippedDims: [],
      totalTimeMs: 1,
      totalTokenUsage: { input: 0, output: 0 },
      totalToolCalls: 0,
    });
    const reportB = buildWorkflowReport({
      sessionId: 'session-b',
      projectInfo: { name: 'Alembic', fileCount: 2, lang: 'ts' },
      dimensionStats: {},
      candidateResults,
      skillResults,
      consolidationResult: null,
      snapshotSummary: {
        status: 'saved',
        id: 'snapshot-b',
        fileCount: 2,
        dimensionCount: 0,
      },
      skippedDims: [],
      incrementalSkippedDims: [],
      totalTimeMs: 2,
      totalTokenUsage: { input: 0, output: 0 },
      totalToolCalls: 0,
    });

    await writeWorkflowReportHistory(reportDir, reportA);
    await writeWorkflowReportHistory(reportDir, reportB);
    await writeWorkflowReportHistory(reportDir, reportA);

    const index = JSON.parse(
      await fs.readFile(path.join(reportDir, 'bootstrap-reports', 'index.json'), 'utf8')
    );
    expect(index.reports.map((entry: { sessionId: string }) => entry.sessionId)).toEqual([
      'session-a',
      'session-b',
    ]);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(reportDir, 'bootstrap-reports', 'artifacts', 'session-b', 'manifest.json'),
        'utf8'
      )
    );
    expect(manifest).toMatchObject({
      sessionId: 'session-b',
      snapshot: { status: 'saved', id: 'snapshot-b' },
    });

    await fs.rm(dataRoot, { recursive: true, force: true });
  });
});
