import { describe, expect, test } from 'vitest';
import { BootstrapTaskManager } from '../../lib/service/bootstrap/BootstrapTaskManager.js';

interface BootstrapTaskManagerStatus {
  efficiency?: {
    cacheHits: number;
    cancelReason?: string;
    duplicateToolCalls: number;
    forcedSummary?: boolean;
    toolCalls: number;
    tokenUsage: { cacheHit: number; input: number; output: number; reasoning: number };
  };
  status: string;
  summary: {
    aborted?: boolean;
    completed?: number;
    efficiency?: {
      cacheHits: number;
      cancelReason?: string;
      duplicateToolCalls: number;
      forcedSummary?: boolean;
      toolCalls: number;
      tokenUsage: { cacheHit: number; input: number; output: number; reasoning: number };
    };
    failed?: number;
    reason?: string;
    totalTasks?: number;
  } | null;
  tasks: Array<{
    error: string | null;
    eventCount?: number;
    id: string;
    result: Record<string, unknown> | null;
    status: string;
    updatedAt?: number;
  }>;
  totalToolCalls?: number;
  userCancelled: boolean;
}

function getStatus(manager: BootstrapTaskManager): BootstrapTaskManagerStatus {
  return manager.getSessionStatus() as BootstrapTaskManagerStatus;
}

describe('BootstrapTaskManager cancellation semantics', () => {
  test('ignores late task transitions after a user cancellation', () => {
    const manager = new BootstrapTaskManager();
    manager.startSession([
      { id: 'dim:overview', meta: { dimId: 'overview', label: 'Overview' } },
      { id: 'dim:architecture', meta: { dimId: 'architecture', label: 'Architecture' } },
    ]);

    manager.markTaskFilling('dim:overview');
    manager.abortSession('Cancelled by user');
    manager.markTaskCompleted('dim:overview', { created: 1 });
    manager.markTaskFilling('dim:architecture');
    manager.markTaskCompleted('dim:architecture', { created: 1 });

    const status = getStatus(manager);

    expect(status.status).toBe('aborted');
    expect(status.userCancelled).toBe(true);
    expect(status.summary).toMatchObject({
      aborted: true,
      completed: 0,
      failed: 2,
      reason: 'Cancelled by user',
      totalTasks: 2,
    });
    expect(status.tasks).toEqual([
      expect.objectContaining({
        error: 'Cancelled by user',
        id: 'dim:overview',
        result: null,
        status: 'failed',
      }),
      expect.objectContaining({
        error: 'Cancelled by user',
        id: 'dim:architecture',
        result: null,
        status: 'failed',
      }),
    ]);
  });

  test('aggregates task efficiency into running and final session status', () => {
    const manager = new BootstrapTaskManager();
    manager.startSession([
      { id: 'dim:overview', meta: { dimId: 'overview', label: 'Overview' } },
      { id: 'dim:architecture', meta: { dimId: 'architecture', label: 'Architecture' } },
    ]);

    manager.markTaskFilling('dim:overview');
    manager.markTaskCompleted('dim:overview', {
      created: 1,
      toolCallCount: 3,
      efficiency: {
        toolCalls: 3,
        duplicateToolCalls: 1,
        cacheHits: 2,
        cacheMisses: 1,
        tokenUsage: { input: 11, output: 7, reasoning: 4, cacheHit: 5 },
        maxCompactionLevel: 1,
        totalCompactedItems: 2,
        nudgeCount: 1,
        replanCount: 0,
        emptyRetries: 1,
        forcedSummary: false,
      },
    });

    expect(getStatus(manager)).toMatchObject({
      efficiency: {
        toolCalls: 3,
        duplicateToolCalls: 1,
        cacheHits: 2,
        tokenUsage: { input: 11, output: 7, reasoning: 4, cacheHit: 5 },
      },
      totalToolCalls: 3,
    });

    manager.markTaskFilling('dim:architecture');
    manager.markTaskCompleted('dim:architecture', {
      created: 1,
      toolCallCount: 2,
      efficiency: {
        toolCalls: 2,
        duplicateToolCalls: 0,
        cacheHits: 1,
        cacheMisses: 1,
        tokenUsage: { input: 13, output: 3, reasoning: 1, cacheHit: 2 },
        maxCompactionLevel: 3,
        totalCompactedItems: 4,
        nudgeCount: 0,
        replanCount: 1,
        emptyRetries: 0,
        forcedSummary: true,
      },
    });

    const status = getStatus(manager);
    expect(status.status).toBe('completed');
    expect(status.summary).toMatchObject({
      efficiency: {
        toolCalls: 5,
        duplicateToolCalls: 1,
        cacheHits: 3,
        tokenUsage: { input: 24, output: 10, reasoning: 5, cacheHit: 7 },
      },
    });
  });

  test('preserves failed task payloads for progress and efficiency summary', () => {
    const manager = new BootstrapTaskManager();
    manager.startSession([{ id: 'dim:api', meta: { dimId: 'api', label: 'API' } }]);

    manager.markTaskFilling('dim:api');
    manager.markTaskFailed('dim:api', 'record repair did not produce findings', {
      status: 'degraded_no_findings',
      reason: 'record repair did not produce findings',
      toolCallCount: 4,
      efficiency: {
        toolCalls: 4,
        duplicateToolCalls: 1,
        cacheHits: 1,
        cacheMisses: 2,
        tokenUsage: { input: 21, output: 8, reasoning: 3, cacheHit: 5 },
        maxCompactionLevel: 4,
        totalCompactedItems: 9,
        nudgeCount: 2,
        replanCount: 1,
        emptyRetries: 0,
        forcedSummary: true,
        cancelReason: 'l4_compaction_failed_budget_exhausted',
      },
    });

    const status = getStatus(manager);
    expect(status.status).toBe('completed_with_errors');
    expect(status.totalToolCalls).toBe(4);
    expect(status.summary).toMatchObject({
      completed: 0,
      failed: 1,
      efficiency: {
        toolCalls: 4,
        cacheHits: 1,
        forcedSummary: true,
        cancelReason: 'l4_compaction_failed_budget_exhausted',
      },
    });
    expect(status.tasks[0]).toMatchObject({
      status: 'failed',
      error: 'record repair did not produce findings',
      result: {
        status: 'degraded_no_findings',
        reason: 'record repair did not produce findings',
      },
    });
    expect(typeof status.tasks[0].updatedAt).toBe('number');
    expect(status.tasks[0].eventCount).toBeGreaterThanOrEqual(2);
  });
});
