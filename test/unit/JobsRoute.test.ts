import type { DaemonJobRecord } from '@alembic/core/daemon';
import type { Request } from 'express';
import { describe, expect, test } from 'vitest';
import { JobProcessEventRecorder } from '../../lib/daemon/JobProcessEventRecorder.js';
import {
  buildJobProcessArtifactUrl,
  buildJobProcessEventsResponse,
  buildJobProcessEventsUrl,
  buildJobStatusUrl,
  buildJobsApiOrigin,
  decorateJobForResponse,
} from '../../lib/http/routes/jobs.js';

describe('jobs route URL helpers', () => {
  test('uses the request Host header when it is available', () => {
    const request = makeRequest({ host: '127.0.0.1:39127' });

    expect(buildJobsApiOrigin(request)).toBe('http://127.0.0.1:39127');
    expect(buildJobStatusUrl(request, 'bootstrap_abc')).toBe(
      'http://127.0.0.1:39127/api/v1/jobs/bootstrap_abc'
    );
    expect(buildJobProcessEventsUrl(request, 'bootstrap_abc')).toBe(
      'http://127.0.0.1:39127/api/v1/jobs/bootstrap_abc/events'
    );
    expect(buildJobProcessArtifactUrl(request, 'bootstrap_abc', 'llm-input.md')).toBe(
      'http://127.0.0.1:39127/api/v1/jobs/bootstrap_abc/artifacts/llm-input.md'
    );
  });

  test('falls back to the local socket address and port', () => {
    const request = makeRequest({ localAddress: '0.0.0.0', localPort: 39127 });

    expect(buildJobsApiOrigin(request)).toBe('http://127.0.0.1:39127');
  });
});

describe('jobs process event response', () => {
  test('returns bounded Core process event views for Dashboard consumption', () => {
    const recorder = new JobProcessEventRecorder({ maxEventsPerJob: 5 });
    recorder.record({
      jobId: 'bootstrap_live',
      kind: 'workflow',
      phase: 'session',
      summary: 'Bootstrap session started',
      title: 'Bootstrap session started',
    });
    recorder.record({
      jobId: 'bootstrap_live',
      kind: 'summary',
      phase: 'dimension',
      severity: 'success',
      summary: 'Architecture completed',
      title: 'Bootstrap dimension completed',
    });

    const response = buildJobProcessEventsResponse({
      afterSequence: 1,
      jobId: 'bootstrap_live',
      limit: 10,
      recorder,
    });

    expect(response.endpointCapability).toMatchObject({
      available: true,
      endpoint: '/api/v1/jobs/:jobId/events',
    });
    expect(response.events).toHaveLength(1);
    expect(response.developerViews).toEqual([
      expect.objectContaining({
        eventId: 'bootstrap_live_process_0002',
        sequence: 2,
        title: 'Bootstrap dimension completed',
      }),
    ]);
  });

  test('preserves process event completeness metadata in developer views', () => {
    const recorder = new JobProcessEventRecorder({ maxEventsPerJob: 5 });
    recorder.record({
      content: {
        mimeType: 'text/markdown',
        role: 'assistant',
        text: 'Received 394 visible character(s).',
      },
      jobId: 'bootstrap_live',
      kind: 'llm.output',
      metadata: {
        contentOriginalChars: 34,
        contentRetainedChars: 34,
        contentTruncated: false,
        contentTruncatedChars: 0,
        contentTruncationLimit: 6000,
        finishReason: 'length',
        reasoningContentOmitted: true,
        visibleTextChars: 394,
      },
      phase: 'dimension-output',
      summary: 'LLM output received.',
      title: 'LLM output received',
    });

    const response = buildJobProcessEventsResponse({
      jobId: 'bootstrap_live',
      limit: 10,
      recorder,
    });

    expect(response.developerViews).toEqual([
      expect.objectContaining({
        content: expect.objectContaining({
          text: 'Received 394 visible character(s).',
        }),
        kind: 'llm.output',
        metadata: expect.objectContaining({
          contentTruncated: false,
          contentTruncationLimit: 6000,
          finishReason: 'length',
          reasoningContentOmitted: true,
          visibleTextChars: 394,
        }),
      }),
    ]);
  });
});

describe('jobs route response decoration', () => {
  test('adds live bootstrap progress to matching running jobs', () => {
    const job = makeJob({
      bootstrapSessionId: 'bs_live',
      status: 'running',
    });

    const decorated = decorateJobForResponse(job, {
      id: 'bs_live',
      status: 'running',
      progress: 40,
      total: 5,
      completed: 2,
      failed: 0,
      filling: 1,
      skeleton: 2,
      totalToolCalls: 7,
      tasks: [
        {
          id: 'dim_architecture',
          status: 'filling',
          meta: { label: 'Architecture' },
        },
      ],
    });

    expect(decorated.progress).toMatchObject({
      activeTaskId: 'dim_architecture',
      activeTaskLabel: 'Architecture',
      activeTaskStatus: 'filling',
      completed: 2,
      percent: 40,
      sessionId: 'bs_live',
      total: 5,
      totalToolCalls: 7,
    });
  });

  test('derives final progress and summary from completed session payloads', () => {
    const job = makeJob({
      bootstrapSessionId: 'bs_done',
      status: 'completed',
      result: {
        finalSession: {
          sessionId: 'bs_done',
          summary: {
            completed: 3,
            duration: 4200,
            efficiency: {
              toolCalls: 6,
              duplicateToolCalls: 2,
              cacheHits: 3,
              cacheMisses: 1,
              tokenUsage: { input: 30, output: 12, reasoning: 4, cacheHit: 8 },
              maxCompactionLevel: 2,
              totalCompactedItems: 9,
              nudgeCount: 1,
              replanCount: 1,
              emptyRetries: 0,
              forcedSummary: false,
            },
            failed: 0,
            totalTasks: 3,
          },
        },
      },
    });

    const decorated = decorateJobForResponse(job);

    expect(decorated.progress).toMatchObject({
      completed: 3,
      failed: 0,
      percent: 100,
      sessionId: 'bs_done',
      total: 3,
    });
    expect(decorated.summary).toMatchObject({
      completed: 3,
      failed: 0,
      totalTasks: 3,
    });
  });

  test('classifies aborted bootstrap sessions as cancelled even when older records were completed', () => {
    const job = makeJob({
      bootstrapSessionId: 'bs_cancelled',
      status: 'completed',
      result: {
        finalSession: {
          sessionId: 'bs_cancelled',
          status: 'aborted',
          progress: 100,
          summary: {
            aborted: true,
            cancelled: 9,
            completed: 5,
            failed: 0,
            reason: 'Cancelled by user via Dashboard',
            totalTasks: 14,
          },
        },
      },
    });

    const decorated = decorateJobForResponse(job);

    expect(decorated.status).toBe('cancelled');
    expect(decorated.progress).toMatchObject({
      cancelled: 9,
      completed: 5,
      failed: 0,
      percent: 100,
      sessionId: 'bs_cancelled',
      status: 'cancelled',
      total: 14,
    });
    expect(decorated.summary).toMatchObject({
      aborted: true,
      cancelled: 9,
      completed: 5,
      failed: 0,
      reason: 'Cancelled by user via Dashboard',
      status: 'cancelled',
      totalTasks: 14,
    });
  });

  test('keeps cancelled job responses cancelled when a late final session says completed', () => {
    const job = makeJob({
      bootstrapSessionId: 'bs_cancelled_late',
      status: 'cancelled',
      error: { code: 'CANCELLED', message: 'Cancelled via jobs API' },
      result: {
        finalSession: {
          sessionId: 'bs_cancelled_late',
          status: 'completed',
          progress: 100,
          summary: {
            completed: 1,
            failed: 0,
            totalTasks: 1,
          },
          tasks: [{ id: 'dim:one', result: { content: 'large payload' } }],
        },
      },
    });

    const decorated = decorateJobForResponse(job, null, { compact: true });

    expect(decorated.compact).toBe(true);
    expect(decorated.result).toBeUndefined();
    expect(decorated.status).toBe('cancelled');
    expect(decorated.progress).toMatchObject({
      completed: 1,
      failed: 0,
      percent: 100,
      sessionId: 'bs_cancelled_late',
      status: 'cancelled',
      total: 1,
    });
    expect(decorated.summary).toMatchObject({
      aborted: true,
      completed: 1,
      failed: 0,
      reason: 'Cancelled via jobs API',
      status: 'cancelled',
      totalTasks: 1,
    });
  });

  test('can emit compact job status without the heavy final session payload', () => {
    const job = makeJob({
      bootstrapSessionId: 'bs_compact',
      status: 'completed',
      result: {
        finalSession: {
          sessionId: 'bs_compact',
          summary: {
            completed: 3,
            duration: 4200,
            efficiency: {
              toolCalls: 6,
              duplicateToolCalls: 2,
              cacheHits: 3,
              cacheMisses: 1,
              tokenUsage: { input: 30, output: 12, reasoning: 4, cacheHit: 8 },
              maxCompactionLevel: 2,
              totalCompactedItems: 9,
              nudgeCount: 1,
              replanCount: 1,
              emptyRetries: 0,
              forcedSummary: false,
            },
            failed: 0,
            totalTasks: 3,
          },
          tasks: [{ id: 'dim:one', result: { content: 'large payload' } }],
        },
      },
    });

    const decorated = decorateJobForResponse(job, null, { compact: true });

    expect(decorated.compact).toBe(true);
    expect(decorated.result).toBeUndefined();
    expect(decorated.progress).toMatchObject({
      completed: 3,
      percent: 100,
      sessionId: 'bs_compact',
      total: 3,
    });
    expect(decorated.summary).toMatchObject({
      completed: 3,
      efficiency: {
        duplicateToolCalls: 2,
        cacheHits: 3,
        tokenUsage: { input: 30, output: 12, reasoning: 4, cacheHit: 8 },
      },
      failed: 0,
      status: 'completed',
      totalTasks: 3,
    });
  });

  test('builds compact job summary efficiency from task results when summary is absent', () => {
    const job = makeJob({
      bootstrapSessionId: 'bs_live_efficiency',
      status: 'running',
      result: {
        bootstrapSession: {
          id: 'bs_live_efficiency',
          status: 'running',
          total: 2,
          completed: 1,
          failed: 0,
          tasks: [
            {
              id: 'dim:one',
              status: 'completed',
              result: {
                efficiency: {
                  toolCalls: 3,
                  duplicateToolCalls: 1,
                  cacheHits: 2,
                  cacheMisses: 1,
                  tokenUsage: { input: 9, output: 4, reasoning: 2, cacheHit: 3 },
                  maxCompactionLevel: 1,
                  totalCompactedItems: 5,
                  nudgeCount: 1,
                  replanCount: 0,
                  emptyRetries: 1,
                  forcedSummary: false,
                },
              },
            },
          ],
        },
      },
    });

    const decorated = decorateJobForResponse(job, null, { compact: true });

    expect(decorated.result).toBeUndefined();
    expect(decorated.summary).toMatchObject({
      completed: 1,
      totalTasks: 2,
      efficiency: {
        toolCalls: 3,
        duplicateToolCalls: 1,
        cacheHits: 2,
        tokenUsage: { input: 9, output: 4, reasoning: 2, cacheHit: 3 },
      },
    });
  });

  test('keeps non-normal dimension results out of the completed bucket and exposes diagnostics', () => {
    const job = makeJob({
      bootstrapSessionId: 'bs_evidence_issue',
      status: 'running',
      result: {
        bootstrapSession: {
          id: 'bs_evidence_issue',
          status: 'completed_with_errors',
          total: 2,
          completed: 1,
          failed: 1,
          updatedAt: Date.parse('2026-05-08T00:01:30.000Z'),
          tasks: [
            {
              id: 'dim:api',
              status: 'failed',
              updatedAt: Date.parse('2026-05-08T00:01:30.000Z'),
              error: 'record repair did not produce findings',
              result: {
                status: 'degraded_no_findings',
                reason: 'record repair did not produce findings',
                efficiency: {
                  toolCalls: 5,
                  duplicateToolCalls: 1,
                  cacheHits: 2,
                  cacheMisses: 1,
                  tokenUsage: { input: 90, output: 20, reasoning: 5, cacheHit: 10 },
                  maxCompactionLevel: 4,
                  totalCompactedItems: 12,
                  nudgeCount: 2,
                  replanCount: 1,
                  emptyRetries: 0,
                  forcedSummary: true,
                  cancelReason: 'l4_compaction_failed_budget_exhausted',
                },
                diagnostics: {
                  degraded: true,
                  timedOutStages: ['quality_gate_record_repair'],
                  gateFailures: [
                    {
                      stage: 'l4_compaction',
                      action: 'degrade',
                      reason: 'l4_compaction_failed_budget_exhausted',
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    });

    const decorated = decorateJobForResponse(job, null, { compact: true });

    expect(decorated.status).toBe('failed');
    expect(decorated.progress).toMatchObject({
      completed: 1,
      failed: 1,
      percent: 100,
      status: 'failed',
      updatedAt: '2026-05-08T00:01:30.000Z',
    });
    expect(decorated.summary).toMatchObject({
      completed: 1,
      failed: 1,
      status: 'failed',
      efficiency: {
        toolCalls: 5,
        forcedSummary: true,
        cancelReason: 'l4_compaction_failed_budget_exhausted',
      },
      diagnostics: {
        degraded: true,
        forcedSummary: true,
        cancelReason: 'l4_compaction_failed_budget_exhausted',
        statuses: {
          degraded_no_findings: 1,
        },
        timedOutStages: ['quality_gate_record_repair'],
      },
    });
    expect(decorated.summary?.diagnostics).toMatchObject({
      issues: [
        {
          taskId: 'dim:api',
          status: 'degraded_no_findings',
          reason: 'record repair did not produce findings',
        },
      ],
    });
  });
});

function makeRequest(options: {
  host?: string;
  localAddress?: string;
  localPort?: number;
  protocol?: string;
}): Request {
  return {
    protocol: options.protocol || 'http',
    get(headerName: string): string | undefined {
      return headerName.toLowerCase() === 'host' ? options.host : undefined;
    },
    socket: {
      localAddress: options.localAddress,
      localPort: options.localPort,
    },
  } as unknown as Request;
}

function makeJob(overrides: Partial<DaemonJobRecord> = {}): DaemonJobRecord {
  const now = new Date('2026-05-08T00:00:00.000Z').toISOString();
  return {
    id: 'bootstrap_test',
    kind: 'bootstrap',
    status: 'queued',
    source: 'dashboard',
    projectRoot: '/tmp/project',
    dataRoot: '/tmp/project/.alembic',
    projectId: 'test',
    request: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
