import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '@alembic/core/daemon';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cancelDaemonJob, markInterruptedDaemonJobs } from '../../lib/daemon/DaemonJobRunner.js';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-runner-home-'));
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-runner-project-'));
}

function makeContainer(store: JobStore, services: Record<string, unknown> = {}): ServiceContainer {
  return {
    get(name: string) {
      if (name === 'jobStore') {
        return store;
      }
      if (name in services) {
        return services[name];
      }
      throw new Error(`missing service: ${name}`);
    },
  } as unknown as ServiceContainer;
}

function makeLogger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  vi.restoreAllMocks();
});

describe('markInterruptedDaemonJobs', () => {
  test('fails active daemon jobs and logs the recovery action', () => {
    useTempAlembicHome();
    const store = new JobStore({ projectRoot: makeProjectRoot() });
    const job = store.create({ kind: 'bootstrap', source: 'http' });
    store.markRunning(job.id);
    const logger = makeLogger();

    const interrupted = markInterruptedDaemonJobs({
      code: 'DAEMON_RESTARTED',
      container: makeContainer(store),
      logger,
      reason: 'daemon restarted before completion',
    });

    expect(interrupted.map((item) => item.id)).toEqual([job.id]);
    expect(store.get(job.id)).toMatchObject({
      status: 'failed',
      error: { code: 'DAEMON_RESTARTED', message: 'daemon restarted before completion' },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Marked interrupted daemon jobs as failed',
      expect.objectContaining({
        count: 1,
        jobIds: [job.id],
      })
    );
  });

  test('stays quiet when there are no active jobs to recover', () => {
    useTempAlembicHome();
    const store = new JobStore({ projectRoot: makeProjectRoot() });
    const job = store.create({ kind: 'rescan' });
    store.markRunning(job.id);
    store.complete(job.id, { ok: true });
    const logger = makeLogger();

    const interrupted = markInterruptedDaemonJobs({
      container: makeContainer(store),
      logger,
      reason: 'daemon restarted before completion',
    });

    expect(interrupted).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('cancelDaemonJob', () => {
  test('persists a running bootstrap abort as a cancelled job with final session evidence', () => {
    useTempAlembicHome();
    const store = new JobStore({ projectRoot: makeProjectRoot() });
    const created = store.create({ kind: 'bootstrap', source: 'dashboard' });
    store.markRunning(created.id);
    store.update(created.id, {
      bootstrapSessionId: 'bs_cancel',
      result: { bootstrapSession: { id: 'bs_cancel', status: 'running' } },
      status: 'running',
    });

    const session = {
      id: 'bs_cancel',
      status: 'running',
      summary: null,
    } as Record<string, unknown>;
    const taskManager = {
      abortSession: vi.fn((reason: string) => {
        session.status = 'aborted';
        session.summary = {
          aborted: true,
          cancelled: 9,
          completed: 5,
          failed: 0,
          reason,
          totalTasks: 14,
        };
      }),
      getSessionStatus: vi.fn(() => session),
      isRunning: true,
      markCancelled: vi.fn(),
    };

    const cancelled = cancelDaemonJob({
      container: makeContainer(store, { bootstrapTaskManager: taskManager }),
      jobId: created.id,
      reason: 'Cancelled by Dashboard Jobs view',
    });

    expect(taskManager.abortSession).toHaveBeenCalledWith('Cancelled by Dashboard Jobs view');
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      error: { message: 'Cancelled by Dashboard Jobs view' },
      result: {
        finalSession: {
          status: 'aborted',
          summary: {
            aborted: true,
            cancelled: 9,
            completed: 5,
            failed: 0,
            totalTasks: 14,
          },
        },
      },
    });
  });
});
