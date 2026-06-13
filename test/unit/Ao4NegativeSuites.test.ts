import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '@alembic/core/daemon';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cancelDaemonJob } from '../../lib/daemon/DaemonJobRunner.js';
import type { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { DecisionRegisterStore } from '../../lib/service/task/DecisionRegisterStore.js';
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

import authRouter from '../../lib/http/routes/auth.js';
import decisionRegisterRouter from '../../lib/http/routes/decision-register.js';
import knowledgeRouter from '../../lib/http/routes/knowledge.js';
import { submitKnowledgeBatch } from '../../lib/resident/tool-handlers/knowledge.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const tempRoots: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.knowledgeService.create.mockReset();
  const decisionStore = new DecisionRegisterStore({
    dataRoot: tempRoot('alembic-ao4-decision-store-'),
    now: () => new Date('2026-06-12T00:00:00.000Z'),
    workspace: {
      dataRootSource: 'ghost-registry',
      projectId: 'project-ao4',
      projectScopeId: 'scope-ao4',
      workspaceMode: 'ghost',
    },
  });
  mocks.container.get.mockImplementation((name: string) => {
    if (name === 'auditLogger') {
      return mocks.auditLogger;
    }
    if (name === 'decisionRegisterStore') {
      return decisionStore;
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
  test('HTTP auth me endpoint is retired', async () => {
    const response = await invokeRouter(authRouter, {
      method: 'GET',
      mountPath: '/api/v1/auth',
      path: '/api/v1/auth/me',
    });

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({
      error: { code: 'AUTH_MODEL_RETIRED' },
      success: false,
    });
  });

  test('HTTP auth login endpoint is retired after request validation', async () => {
    const response = await invokeRouter(authRouter, {
      body: {
        password: 'wrong-password',
        username: 'legacy-user',
      },
      method: 'POST',
      mountPath: '/api/v1/auth',
      path: '/api/v1/auth/login',
    });

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({
      error: { code: 'AUTH_MODEL_RETIRED' },
      success: false,
    });
  });

  test('HTTP auth rejects invalid login bodies before credential checks', async () => {
    const response = await invokeRouter(authRouter, {
      body: {},
      method: 'POST',
      mountPath: '/api/v1/auth',
      path: '/api/v1/auth/login',
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
      success: false,
    });
  });

  test('HTTP auth does not issue tokens for valid legacy credentials', async () => {
    const loginResponse = await invokeRouter(authRouter, {
      body: {
        password: 'alembic',
        username: 'legacy-user',
      },
      method: 'POST',
      mountPath: '/api/v1/auth',
      path: '/api/v1/auth/login',
    });
    expect(loginResponse.status).toBe(410);
    expect(loginResponse.body).toMatchObject({
      error: { code: 'AUTH_MODEL_RETIRED' },
      success: false,
    });
  });

  test('HTTP auth retirement does not create a process token secret', async () => {
    const originalSecret = process.env.ALEMBIC_AUTH_SECRET;
    try {
      delete process.env.ALEMBIC_AUTH_SECRET;

      const response = await invokeRouter(authRouter, {
        body: { password: 'alembic', username: 'legacy-user' },
        method: 'POST',
        mountPath: '/api/v1/auth',
        path: '/api/v1/auth/login',
      });

      expect(response.status).toBe(410);
      expect(process.env.ALEMBIC_AUTH_SECRET).toBeUndefined();
    } finally {
      if (originalSecret === undefined) {
        delete process.env.ALEMBIC_AUTH_SECRET;
      } else {
        process.env.ALEMBIC_AUTH_SECRET = originalSecret;
      }
    }
  });

  test('HTTP auth ignores malformed bearer tokens because the model is retired', async () => {
    const response = await invokeRouter(authRouter, {
      headers: {
        authorization: 'Bearer not-a-token',
      },
      method: 'GET',
      mountPath: '/api/v1/auth',
      path: '/api/v1/auth/me',
    });

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({
      error: { code: 'AUTH_MODEL_RETIRED' },
      success: false,
    });
  });

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
      container: makeContainer(store, { bootstrapTaskManager: taskManager }),
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

  test('wrong ProjectScope is rejected with a structured blocker', async () => {
    const response = await invokeRouter(decisionRegisterRouter, {
      body: {
        decision: 'wrong scope must not write',
        scope: { projectScopeId: 'other-scope' },
        title: 'AO4 wrong scope',
      },
      method: 'POST',
      mountPath: '/api/v1/decision-register',
      path: '/api/v1/decision-register',
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      reasonCode: 'project-scope-mismatch',
      success: false,
    });
  });

  test('resident batch submission rejects invalid item arguments before persistence', async () => {
    await expect(
      submitKnowledgeBatch(
        {
          container: {
            get: vi.fn(),
          },
          logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        } as never,
        { items: [null as never], target_name: 'AO4' }
      )
    ).rejects.toThrow('items[0] must be an object');
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
