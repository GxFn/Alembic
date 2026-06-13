/**
 * 集成测试：HTTP source resolver
 *
 * 覆盖范围：
 *   - trusted x-user-id header only becomes a neutral source label
 *   - untrusted/default requests use the fallback source label
 *   - CapabilityProbe input is ignored by HTTP runtime source resolution
 *   - test-token helpers keep payload shape compatibility
 */

import { CapabilityProbe } from '@alembic/core/core/capability';
import { sourceResolverMiddleware } from '../../lib/http/middleware/sourceResolver.js';
import { createExpiredToken, createTempGitRepo, createTestToken } from '../fixtures/factory.js';

type RepoHandle = { repoPath: string; cleanup: () => void };
type TestReq = {
  headers: Record<string, string>;
  resolvedSource?: string;
  resolvedSourceActor?: string;
};

describe('Integration: sourceResolver middleware', () => {
  const TOKEN_SECRET = 'test-resolver-secret';
  const envBackup: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string | undefined) {
    envBackup[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  function restoreEnv() {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  function mockExpress(headers: Record<string, string> = {}) {
    const req: TestReq = { headers: { ...headers } };
    const res = {};
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };
    return { req, res, next, wasNextCalled: () => nextCalled };
  }

  afterEach(() => {
    restoreEnv();
  });

  test('trusted x-user-id header becomes a source label', () => {
    setEnv('ALEMBIC_INTERNAL_TOKEN', 'test-internal-token');
    const middleware = sourceResolverMiddleware({});
    const { req, res, next, wasNextCalled } = mockExpress({
      'x-user-id': 'batch-runner',
      'x-alembic-internal-token': 'test-internal-token',
    });

    middleware(req as never, res as never, next as never);
    expect(wasNextCalled()).toBe(true);
    expect(req.resolvedSource).toBe('batch-runner');
    expect(req.resolvedSourceActor).toBe('header:batch-runner');
  });

  test('x-user-id = "anonymous" is not trusted directly', () => {
    const middleware = sourceResolverMiddleware({});
    const { req, res, next, wasNextCalled } = mockExpress({
      'x-user-id': 'anonymous',
    });

    middleware(req as never, res as never, next as never);
    expect(wasNextCalled()).toBe(true);
    expect(req.resolvedSource).toBe('http-request');
  });

  test('x-user-id = "dashboard" is not trusted directly', () => {
    const middleware = sourceResolverMiddleware({});
    const { req, res, next } = mockExpress({
      'x-user-id': 'dashboard',
    });

    middleware(req as never, res as never, next as never);
    expect(req.resolvedSource).toBe('http-request');
  });

  test('CapabilityProbe input does not create a runtime source label', () => {
    setEnv('VITE_AUTH_ENABLED', undefined);
    setEnv('ALEMBIC_AUTH_ENABLED', undefined);

    const probe = new CapabilityProbe({ subRepoPath: `/tmp/nonexistent-probe-test-${Date.now()}` });
    const middleware = sourceResolverMiddleware({ capabilityProbe: probe });

    const { req, res, next, wasNextCalled } = mockExpress({});
    middleware(req as never, res as never, next as never);

    expect(wasNextCalled()).toBe(true);
    expect(req.resolvedSource).toBe('http-request');
    expect(req.resolvedSourceActor).toBe('http-request');
  });

  test('without trusted source headers defaults to neutral request source', () => {
    setEnv('VITE_AUTH_ENABLED', undefined);
    setEnv('ALEMBIC_AUTH_ENABLED', undefined);

    const middleware = sourceResolverMiddleware({});
    const { req, res, next } = mockExpress({});

    middleware(req as never, res as never, next as never);
    expect(req.resolvedSource).toBe('http-request');
    expect(req.resolvedSourceActor).toBe('http-request');
  });

  test('createTestToken emits the expected two-part token shape', () => {
    const token = createTestToken({ sub: 'source', role: 'http-request' }, TOKEN_SECRET);

    expect(typeof token).toBe('string');
    const parts = token.split('.');
    expect(parts.length).toBe(2);

    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    expect(payload.sub).toBe('source');
    expect(payload.role).toBe('http-request');
    expect(payload.exp).toBeGreaterThan(Date.now());
  });

  test('createExpiredToken emits an expired payload', () => {
    const token = createExpiredToken({ sub: 'source', role: 'http-request' }, TOKEN_SECRET);

    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    expect(payload.exp).toBeLessThan(Date.now());
  });
});

describe('Integration: sourceResolver + real CapabilityProbe', () => {
  const repos: RepoHandle[] = [];

  afterAll(() => {
    for (const r of repos) {
      r.cleanup();
    }
  });

  test('real git repo without remote still resolves to the neutral request source', () => {
    const { repoPath, cleanup } = createTempGitRepo({ withRemote: false });
    repos.push({ repoPath, cleanup });

    const probe = new CapabilityProbe({
      subRepoPath: repoPath,
      noRemote: 'allow',
    });

    const middleware = sourceResolverMiddleware({ capabilityProbe: probe });
    const req: TestReq = { headers: {} };
    let nextCalled = false;
    middleware(
      req as never,
      {} as never,
      (() => {
        nextCalled = true;
      }) as never
    );

    expect(nextCalled).toBe(true);
    expect(req.resolvedSource).toBe('http-request');
  });

  test('real git repo with noRemote=deny still resolves to the neutral request source', () => {
    const { repoPath, cleanup } = createTempGitRepo({ withRemote: false });
    repos.push({ repoPath, cleanup });

    const probe = new CapabilityProbe({
      subRepoPath: repoPath,
      noRemote: 'deny',
    });

    const middleware = sourceResolverMiddleware({ capabilityProbe: probe });
    const req: TestReq = { headers: {} };
    let nextCalled = false;
    middleware(
      req as never,
      {} as never,
      (() => {
        nextCalled = true;
      }) as never
    );

    expect(nextCalled).toBe(true);
    expect(req.resolvedSource).toBe('http-request');
  });
});
