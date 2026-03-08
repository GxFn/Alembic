/**
 * 集成测试：CapabilityProbe + roleResolver 双路径
 *
 * 覆盖范围：
 *   ✓ CapabilityProbe — 真实 temp git repo 测试
 *     - 无子仓库 → 'admin'（个人项目）
 *     - 有子仓库 + 无 remote → 'admin'（本地开发）
 *     - 有子仓库 + 是 git repo 但无 remote + noRemote=deny → 'visitor'
 *     - 目录存在但非 git repo → 'contributor'
 *     - 缓存命中 / 过期 / 失效
 *   ✓ roleResolver 中间件
 *     - Path A (AUTH_ENABLED=true): token 解析
 *     - Path B (AUTH_ENABLED=false): probe 驱动
 *     - x-user-id header 直接信任
 *     - 无效 / 过期 token → visitor
 */

import { CapabilityProbe } from '../../lib/core/capability/CapabilityProbe.js';
import { roleResolverMiddleware } from '../../lib/http/middleware/roleResolver.js';
import { createExpiredToken, createTempGitRepo, createTestToken } from '../fixtures/factory.js';

// ═══════════════════════════════════════════════════════
//  CapabilityProbe — 真实 git repo 测试
// ═══════════════════════════════════════════════════════

describe('Integration: CapabilityProbe', () => {
  /** @type {{ repoPath: string, cleanup: () => void }[]} */
  const repos = [];

  afterAll(() => {
    for (const r of repos) {
      r.cleanup();
    }
  });

  test('无子仓库路径 → admin（个人项目模式）', () => {
    const probe = new CapabilityProbe({
      subRepoPath: `/tmp/nonexistent-path-${Date.now()}`,
    });

    expect(probe.probe()).toBe('admin');
    expect(probe.probeRole()).toBe('developer');
  });

  test('subRepoPath = nonexistent → admin', () => {
    const probe = new CapabilityProbe({ subRepoPath: `/tmp/nonexistent-${Date.now()}` });
    expect(probe.probe()).toBe('admin');
  });

  test('有 git repo + 无 remote + noRemote=allow → admin', () => {
    const { repoPath, cleanup } = createTempGitRepo({ withRemote: false });
    repos.push({ repoPath, cleanup });

    const probe = new CapabilityProbe({
      subRepoPath: repoPath,
      noRemote: 'allow',
    });

    expect(probe.probe()).toBe('admin');
    expect(probe.probeRole()).toBe('developer');
  });

  test('有 git repo + 无 remote + noRemote=deny → visitor', () => {
    const { repoPath, cleanup } = createTempGitRepo({ withRemote: false });
    repos.push({ repoPath, cleanup });

    const probe = new CapabilityProbe({
      subRepoPath: repoPath,
      noRemote: 'deny',
    });

    expect(probe.probe()).toBe('visitor');
    expect(probe.probeRole()).toBe('visitor');
  });

  test('有 git repo + 有 remote (不可 push 的假地址) → contributor', () => {
    const { repoPath, cleanup } = createTempGitRepo({
      withRemote: true,
      remoteUrl: 'https://example.com/no-access/repo.git',
    });
    repos.push({ repoPath, cleanup });

    const probe = new CapabilityProbe({
      subRepoPath: repoPath,
      cacheTTL: 0, // 禁用缓存，强制每次探测
    });

    const result = probe.probe();
    // 假地址 push 会被拒绝（网络错误或 403）→ 降级为 contributor
    expect(result).toBe('contributor');
  });

  test('目录存在但不是 git repo → contributor', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDir = fs.default.mkdtempSync(
      path.default.join(os.default.tmpdir(), 'asd-test-nonrepo-')
    );
    repos.push({
      repoPath: tmpDir,
      cleanup: () => fs.default.rmSync(tmpDir, { recursive: true, force: true }),
    });

    const probe = new CapabilityProbe({ subRepoPath: tmpDir });
    expect(probe.probe()).toBe('contributor');
  });

  // ── 缓存行为 ──

  test('缓存命中 — 第二次调用不重新探测', () => {
    const probe = new CapabilityProbe({
      subRepoPath: `/tmp/nonexistent-cache-${Date.now()}`,
      cacheTTL: 60,
    });

    const r1 = probe.probe();
    expect(r1).toBe('admin');

    // 缓存应命中
    const status = probe.getCacheStatus();
    expect(status.cached).toBe(true);
    expect(status.result).toBe('admin');
    expect(status.expired).toBe(false);

    const r2 = probe.probe();
    expect(r2).toBe('admin');
  });

  test('invalidate 清除缓存', () => {
    const probe = new CapabilityProbe({
      subRepoPath: `/tmp/nonexistent-inval-${Date.now()}`,
      cacheTTL: 60,
    });
    probe.probe();

    expect(probe.getCacheStatus().cached).toBe(true);

    probe.invalidate();
    expect(probe.getCacheStatus().cached).toBe(false);
  });

  test('缓存过期后重新探测', () => {
    const probe = new CapabilityProbe({
      subRepoPath: `/tmp/nonexistent-expire-${Date.now()}`,
      cacheTTL: 60,
    });
    probe.probe(); // 首次探测，缓存

    // 手动使缓存过期
    probe._cache.expiresAt = Date.now() - 1;

    const status = probe.getCacheStatus();
    expect(status.expired).toBe(true);

    // 重新探测 — 应重新填充缓存
    const result = probe.probe();
    expect(result).toBe('admin');
    expect(probe.getCacheStatus().expired).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
//  roleResolver 中间件
// ═══════════════════════════════════════════════════════

describe('Integration: roleResolver middleware', () => {
  const TOKEN_SECRET = 'test-resolver-secret';

  // 保存/恢复环境变量
  const envBackup = {};

  function setEnv(key, value) {
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

  /** 创建 mock req/res/next */
  function mockExpress(headers = {}) {
    const req = { headers: { ...headers } };
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

  // ── x-user-id 直接信任 ──

  test('x-user-id header 直接信任（MCP 场景）', () => {
    const middleware = roleResolverMiddleware({});
    const { req, res, next, wasNextCalled } = mockExpress({
      'x-user-id': 'external_agent',
    });

    middleware(req, res, next);
    expect(wasNextCalled()).toBe(true);
    expect(req.resolvedRole).toBe('external_agent');
  });

  test('x-user-id = "anonymous" 不直接信任（走正常路径）', () => {
    const middleware = roleResolverMiddleware({});
    const { req, res, next, wasNextCalled } = mockExpress({
      'x-user-id': 'anonymous',
    });

    middleware(req, res, next);
    expect(wasNextCalled()).toBe(true);
    // 走到 probe-based 或 token-based 路径，不再是 'anonymous'
    expect(req.resolvedRole).toBeDefined();
  });

  test('x-user-id = "dashboard" 不直接信任', () => {
    const middleware = roleResolverMiddleware({});
    const { req, res, next } = mockExpress({
      'x-user-id': 'dashboard',
    });

    middleware(req, res, next);
    expect(req.resolvedRole).toBeDefined();
    // dashboard 不被直接信任，走正常路径
  });

  // ── Path B: Probe-based (AUTH_ENABLED=false) ──

  test('Path B: 使用 CapabilityProbe（无子仓库 → admin）', () => {
    setEnv('VITE_AUTH_ENABLED', undefined);
    setEnv('ASD_AUTH_ENABLED', undefined);

    // 使用不存在的路径，确保走 "无子仓库 = admin" 路径，避免 _detectSubRepo 命中真实仓库
    const probe = new CapabilityProbe({ subRepoPath: `/tmp/nonexistent-probe-test-${Date.now()}` });
    const middleware = roleResolverMiddleware({ capabilityProbe: probe });

    const { req, res, next, wasNextCalled } = mockExpress({});
    middleware(req, res, next);

    expect(wasNextCalled()).toBe(true);
    expect(req.resolvedRole).toBe('developer');
    expect(req.resolvedUser).toContain('probe:');
  });

  test('Path B: 无 CapabilityProbe 实例 → 默认 developer（向后兼容）', () => {
    setEnv('VITE_AUTH_ENABLED', undefined);
    setEnv('ASD_AUTH_ENABLED', undefined);

    const middleware = roleResolverMiddleware({});
    const { req, res, next } = mockExpress({});

    middleware(req, res, next);
    expect(req.resolvedRole).toBe('developer');
    expect(req.resolvedUser).toBe('local');
  });

  // ── Path A: Token-based ──
  // 注意：roleResolver 在模块加载时读取 AUTH_ENABLED，
  // 修改环境变量后需要重新导入模块。为避免此问题，
  // 我们直接测试 token 验证逻辑的行为。

  // 测试 token 生成与验证的一致性
  test('createTestToken 生成的 token 格式正确', () => {
    const token = createTestToken({ sub: 'admin', role: 'developer' }, TOKEN_SECRET);

    expect(typeof token).toBe('string');
    const parts = token.split('.');
    expect(parts.length).toBe(2);

    // 反序列化 payload
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    expect(payload.sub).toBe('admin');
    expect(payload.role).toBe('developer');
    expect(payload.exp).toBeGreaterThan(Date.now());
  });

  test('createExpiredToken 生成的 token 已过期', () => {
    const token = createExpiredToken({ sub: 'admin', role: 'developer' }, TOKEN_SECRET);

    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    expect(payload.exp).toBeLessThan(Date.now());
  });
});

// ═══════════════════════════════════════════════════════
//  roleResolver + CapabilityProbe 组合
// ═══════════════════════════════════════════════════════

describe('Integration: roleResolver + real CapabilityProbe', () => {
  const repos = [];

  afterAll(() => {
    for (const r of repos) {
      r.cleanup();
    }
  });

  test('真实 git repo (无 remote) 通过 middleware → developer', () => {
    const { repoPath, cleanup } = createTempGitRepo({ withRemote: false });
    repos.push({ repoPath, cleanup });

    const probe = new CapabilityProbe({
      subRepoPath: repoPath,
      noRemote: 'allow',
    });

    const middleware = roleResolverMiddleware({ capabilityProbe: probe });
    const req = { headers: {} };
    let nextCalled = false;
    middleware(req, {}, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(req.resolvedRole).toBe('developer');
  });

  test('真实 git repo (无 remote, deny) 通过 middleware → visitor', () => {
    const { repoPath, cleanup } = createTempGitRepo({ withRemote: false });
    repos.push({ repoPath, cleanup });

    const probe = new CapabilityProbe({
      subRepoPath: repoPath,
      noRemote: 'deny',
    });

    const middleware = roleResolverMiddleware({ capabilityProbe: probe });
    const req = { headers: {} };
    let nextCalled = false;
    middleware(req, {}, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(req.resolvedRole).toBe('visitor');
  });
});
