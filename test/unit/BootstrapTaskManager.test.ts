import { describe, expect, test } from 'vitest';
import { BootstrapTaskManager } from '../../lib/service/bootstrap/BootstrapTaskManager.js';

interface BootstrapTaskManagerStatus {
  status: string;
  summary: {
    aborted?: boolean;
    completed?: number;
    failed?: number;
    reason?: string;
    totalTasks?: number;
  } | null;
  tasks: Array<{
    error: string | null;
    id: string;
    result: Record<string, unknown> | null;
    status: string;
  }>;
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
});
