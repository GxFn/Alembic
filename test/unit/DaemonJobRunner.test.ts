import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '@alembic/core/daemon/JobStore';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { markInterruptedDaemonJobs } from '../../lib/daemon/DaemonJobRunner.js';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-runner-home-'));
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-runner-project-'));
}

function makeContainer(store: JobStore): ServiceContainer {
  return {
    get(name: string) {
      if (name === 'jobStore') {
        return store;
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
    const job = store.create({ kind: 'bootstrap', source: 'codex' });
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
