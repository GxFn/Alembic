import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '@alembic/core/daemon';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cancelDaemonJob } from '../../lib/daemon/jobs/DaemonJobRunner.js';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { invokeRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => ({
  auditLogger: {
    log: vi.fn(),
  },
  container: {
    get: vi.fn(),
  },
  knowledgeService: {
    create: vi.fn(),
  },
}));

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

import knowledgeRouter from '../../lib/http/routes/knowledge.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const tempRoots: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.knowledgeService.create.mockReset();
  mocks.container.get.mockImplementation((name: string) => {
    if (name === 'auditLogger') {
      return mocks.auditLogger;
    }
    if (name === 'knowledgeService') {
      return mocks.knowledgeService;
    }
    throw new Error(`unexpected service: ${name}`);
  });
});

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
  vi.restoreAllMocks();
});

describe('AO4 negative suites', () => {
  test('HTTP knowledge create no longer calls the old permission boundary', async () => {
    const response = await invokeRouter(knowledgeRouter, {
      body: {
        content: 'writes use entrypoint validation',
        title: 'AO4 entrypoint validation',
      },
      method: 'POST',
      mountPath: '/api/v1/knowledge',
      path: '/api/v1/knowledge',
    });

    expect(response.status).toBe(201);
    expect(mocks.knowledgeService.create).toHaveBeenCalled();
  });

  test('job cancellation persists the final cancelled state', () => {
    const projectRoot = tempRoot('alembic-ao4-job-project-');
    const store = new JobStore({ projectRoot });
    const job = store.create({ kind: 'bootstrap', source: 'dashboard' });
    store.markRunning(job.id);
    store.update(job.id, {
      bootstrapSessionId: 'ao4_cancel_session',
      result: { bootstrapSession: { id: 'ao4_cancel_session', status: 'running' } },
      status: 'running',
    });
    const taskManager = {
      abortSession: vi.fn(),
      getSessionStatus: vi.fn(() => ({
        id: 'ao4_cancel_session',
        status: 'aborted',
        summary: {
          aborted: true,
          cancelled: 1,
          completed: 0,
          failed: 0,
          reason: 'AO4 cancellation negative suite',
          totalTasks: 1,
        },
      })),
      isRunning: true,
      markCancelled: vi.fn(),
    };

    const cancelled = cancelDaemonJob({
      container: makeContainer(store, { generateTaskManager: taskManager }),
      jobId: job.id,
      reason: 'AO4 cancellation negative suite',
    });

    expect(taskManager.abortSession).toHaveBeenCalledWith('AO4 cancellation negative suite');
    expect(cancelled).toMatchObject({
      error: { message: 'AO4 cancellation negative suite' },
      status: 'cancelled',
    });
    expect(store.get(job.id)).toMatchObject({ status: 'cancelled' });
  });
});

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
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
    singletons: {},
  } as unknown as ServiceContainer;
}
