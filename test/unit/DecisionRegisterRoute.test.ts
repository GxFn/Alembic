import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { invokeRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => {
  return {
    container: {
      get: vi.fn(),
    },
  };
});

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

import decisionRegisterRouter, {
  buildDecisionRegisterCapability,
} from '../../lib/http/routes/decision-register.js';
import { DecisionRegisterStore } from '../../lib/service/task/DecisionRegisterStore.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'alembic-decision-register-route-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('decision register route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const store = new DecisionRegisterStore({
      dataRoot: tempRoot(),
      now: () => new Date('2026-06-05T03:45:00.000Z'),
      workspace: {
        dataRootSource: 'ghost-registry',
        projectId: 'project-route',
        projectScopeId: 'scope-route',
        workspaceMode: 'ghost',
      },
    });
    mocks.container.get.mockImplementation((name: string) => {
      if (name === 'decisionRegisterStore') {
        return store;
      }
      throw new Error(`unexpected service: ${name}`);
    });
  });

  test('creates, updates, revokes, deletes, reads, and lists decisions through resident API', async () => {
    const capability = await invokeRouter(decisionRegisterRouter, {
      method: 'GET',
      mountPath: '/api/v1/decision-register',
      path: '/api/v1/decision-register/capability',
    });
    expect(capability.status).toBe(200);
    expect((capability.body.data as Record<string, unknown>).capability).toEqual(
      buildDecisionRegisterCapability()
    );

    const create = await invokeRouter(decisionRegisterRouter, {
      body: {
        decision: 'Use durable route.',
        scope: { projectScopeId: 'scope-route' },
        sessionId: 'route-thread',
        sourceRefs: ['/Users/private/project/src/decision.ts:4'],
        title: 'Route decision',
      },
      method: 'POST',
      mountPath: '/api/v1/decision-register',
      path: '/api/v1/decision-register',
    });
    const created = ((create.body.data as Record<string, unknown>).decision ?? {}) as Record<
      string,
      unknown
    >;
    const decisionId = String(created.decisionId);
    expect(create.status).toBe(201);
    expect(created).toMatchObject({
      projectScopeId: 'scope-route',
      sourceRefs: ['[absolute-path]/decision.ts:4'],
      status: 'active',
      title: 'Route decision',
    });
    expect(JSON.stringify(created)).not.toContain('/Users/private');
    expect(JSON.stringify(created)).not.toContain('route-thread');

    const update = await invokeRouter(decisionRegisterRouter, {
      body: { decision: 'Use durable route with updates.', title: 'Updated route decision' },
      method: 'PATCH',
      mountPath: '/api/v1/decision-register',
      path: `/api/v1/decision-register/${decisionId}`,
    });
    expect(update.status).toBe(200);
    expect((update.body.data as Record<string, unknown>).decision).toMatchObject({
      decision: 'Use durable route with updates.',
      revision: 2,
      title: 'Updated route decision',
    });

    const read = await invokeRouter(decisionRegisterRouter, {
      method: 'GET',
      mountPath: '/api/v1/decision-register',
      path: `/api/v1/decision-register/${decisionId}`,
    });
    expect(read.status).toBe(200);
    expect((read.body.data as Record<string, unknown>).decision).toMatchObject({ decisionId });

    const activeList = await invokeRouter(decisionRegisterRouter, {
      method: 'GET',
      mountPath: '/api/v1/decision-register',
      path: '/api/v1/decision-register?sessionId=route-thread',
    });
    expect((activeList.body.data as Record<string, unknown>).count).toBe(1);

    const revoke = await invokeRouter(decisionRegisterRouter, {
      body: { reason: 'superseded' },
      method: 'POST',
      mountPath: '/api/v1/decision-register',
      path: `/api/v1/decision-register/${decisionId}/revoke`,
    });
    expect(revoke.status).toBe(200);
    expect((revoke.body.data as Record<string, unknown>).decision).toMatchObject({
      revokeReason: 'superseded',
      status: 'revoked',
    });

    const remove = await invokeRouter(decisionRegisterRouter, {
      body: { reason: 'deleted by test' },
      method: 'DELETE',
      mountPath: '/api/v1/decision-register',
      path: `/api/v1/decision-register/${decisionId}`,
    });
    expect(remove.status).toBe(200);
    expect((remove.body.data as Record<string, unknown>).decision).toMatchObject({
      deleteReason: 'deleted by test',
      status: 'deleted',
    });

    const includeDeleted = await invokeRouter(decisionRegisterRouter, {
      method: 'GET',
      mountPath: '/api/v1/decision-register',
      path: '/api/v1/decision-register?includeDeleted=true&status=all',
    });
    expect((includeDeleted.body.data as Record<string, unknown>).count).toBe(1);
  });

  test('returns a structured blocker when request scope does not match ProjectScope', async () => {
    const response = await invokeRouter(decisionRegisterRouter, {
      body: {
        decision: 'wrong scope',
        scope: { projectScopeId: 'other-scope' },
        title: 'Wrong scope',
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
});
