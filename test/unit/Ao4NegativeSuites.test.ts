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

// ── validate 中间件工厂三分支直测（AO4 覆盖地板配套，2026-07-06） ──
// W5 期间 validate.ts 增加了 query/params 变体与 Express 5 defineProperty 路径，
// 覆盖地板跌破阈值——此段对 validate/validateQuery/validateParams 的成功与
// 失败分支做直测（fake req/res/next），把地板拉回而不改被测行为。

import { z } from 'zod';
import { validate, validateParams, validateQuery } from '../../lib/http/middleware/validate.js';

interface FakeRes {
  statusCode: number | null;
  body: unknown;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
}

function makeRes(): FakeRes {
  return {
    statusCode: null,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

describe('validate middleware factories (AO4 floor)', () => {
  const schema = z.object({ name: z.string().min(1), count: z.coerce.number().default(1) });

  test('validate: invalid body → 400 VALIDATION_ERROR; valid body → parsed + next', () => {
    const mw = validate(schema);
    const bad = { body: { name: '' } } as never;
    const badRes = makeRes();
    const badNext = vi.fn();
    mw(bad, badRes as never, badNext);
    expect(badRes.statusCode).toBe(400);
    expect((badRes.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect(badNext).not.toHaveBeenCalled();

    const good = { body: { name: 'ok' } } as { body: { name: string; count?: number } };
    const goodRes = makeRes();
    const goodNext = vi.fn();
    mw(good as never, goodRes as never, goodNext);
    expect(goodNext).toHaveBeenCalledOnce();
    expect(good.body.count).toBe(1); // default 回填证明 body 已被 parsed 数据替换
  });

  test('validateQuery: invalid query → 400; valid query → defineProperty 覆写 + next', () => {
    const mw = validateQuery(schema);
    const badRes = makeRes();
    const badNext = vi.fn();
    mw({ query: { name: '' } } as never, badRes as never, badNext);
    expect(badRes.statusCode).toBe(400);
    expect(badNext).not.toHaveBeenCalled();

    const goodReq = { query: { name: 'ok', count: '5' } } as { query: Record<string, unknown> };
    const goodRes = makeRes();
    const goodNext = vi.fn();
    mw(goodReq as never, goodRes as never, goodNext);
    expect(goodNext).toHaveBeenCalledOnce();
    expect(goodReq.query.count).toBe(5); // coerce 证明 query 已被覆写为 parsed 数据
  });

  test('validateParams: invalid params → 400; valid params → 覆写 + next', () => {
    const mw = validateParams(z.object({ id: z.string().uuid() }));
    const badRes = makeRes();
    const badNext = vi.fn();
    mw({ params: { id: 'not-a-uuid' } } as never, badRes as never, badNext);
    expect(badRes.statusCode).toBe(400);
    expect(badNext).not.toHaveBeenCalled();

    const goodReq = { params: { id: '123e4567-e89b-42d3-a456-426614174000' } };
    const goodRes = makeRes();
    const goodNext = vi.fn();
    mw(goodReq as never, goodRes as never, goodNext);
    expect(goodNext).toHaveBeenCalledOnce();
  });
});
