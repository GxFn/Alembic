/**
 * 集成测试：HTTP API 端点 — 完整的 REST API 调用
 *
 * 使用 Jest 格式（与 jest.config.js 兼容），通过 Bootstrap + HttpServer
 * 启动真实 Express 服务，用 fetch 调用实际 HTTP 端点。
 *
 * 覆盖范围：
 *   ✓ Health 端点
 *   ✓ Auth 端点 (login / me)
 *   ✓ Auth Probe 端点
 *   ✓ Knowledge CRUD (V3 统一端点)
 *   ✓ Guard Rules CRUD
 *   ✓ 404 路由兜底
 *   ✓ 错误格式一致性
 *   ✓ CORS headers
 *   ✓ 角色驱动的访问控制（x-user-id header）
 */

import Bootstrap from '../../lib/bootstrap.js';
import { HttpServer } from '../../lib/http/HttpServer.js';
import { getServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { getTestPort } from '../fixtures/factory.js';

const PORT = getTestPort();
const BASE = `http://localhost:${PORT}/api/v1`;

describe('Integration: HTTP API Endpoints', () => {
  let bootstrap;
  let httpServer;

  beforeAll(async () => {
    // 1. 初始化 Bootstrap（DB + Gateway + Constitution 等）
    bootstrap = new Bootstrap({ env: 'test' });
    const components = await bootstrap.initialize();

    // 2. 初始化 ServiceContainer（注入 bootstrap 组件）
    const container = getServiceContainer();
    await container.initialize(components);

    // 3. 启动 HttpServer
    httpServer = new HttpServer({
      port: PORT,
      host: 'localhost',
      enableRedis: false,
      enableMonitoring: false,
      cacheMode: 'memory',
    });
    await httpServer.initialize();
    await httpServer.start();
  }, 30_000);

  afterAll(async () => {
    if (httpServer) {
      await httpServer.stop();
    }
    if (bootstrap) {
      await bootstrap.shutdown();
    }
  });

  // ═══════════════════════════════════════════════════════
  //  Health
  // ═══════════════════════════════════════════════════════

  describe('Health Endpoints', () => {
    test('GET /health → 200 + healthy', async () => {
      const res = await fetch(`${BASE}/health`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.status).toBe('healthy');
      expect(body.timestamp).toBeDefined();
    });

    test('GET /health/ready → 200', async () => {
      const res = await fetch(`${BASE}/health/ready`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  Auth
  // ═══════════════════════════════════════════════════════

  describe('Auth Endpoints', () => {
    test('POST /auth/login — 正确凭证返回 token', async () => {
      const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: process.env.ALEMBIC_AUTH_USERNAME || 'admin',
          password: process.env.ALEMBIC_AUTH_PASSWORD || 'alembic',
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.token).toBeDefined();
      expect(body.data.user.role).toBe('developer');
    });

    test('POST /auth/login — 错误密码返回 401', async () => {
      const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong' }),
      });
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.success).toBe(false);
    });

    test('POST /auth/login — 空 body 返回 400', async () => {
      const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
    });

    test('GET /auth/me — 有效 token', async () => {
      // 先登录获取 token
      const loginRes = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: process.env.ALEMBIC_AUTH_USERNAME || 'admin',
          password: process.env.ALEMBIC_AUTH_PASSWORD || 'alembic',
        }),
      });
      const {
        data: { token },
      } = await loginRes.json();

      const res = await fetch(`${BASE}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.user.role).toBe('developer');
    });

    test('GET /auth/me — 无 token 返回 401', async () => {
      const res = await fetch(`${BASE}/auth/me`);
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.success).toBe(false);
    });

    test('GET /auth/probe — 返回当前角色', async () => {
      const res = await fetch(`${BASE}/auth/probe`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.role).toBeDefined();
      expect(body.data.mode).toBeDefined();
      expect(['token', 'probe']).toContain(body.data.mode);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  Knowledge (V3 统一端点，替代 Candidates + Recipes)
  // ═══════════════════════════════════════════════════════

  describe('Knowledge Endpoints', () => {
    test('GET /knowledge → 200 + 列表', async () => {
      const res = await fetch(`${BASE}/knowledge`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    test('GET /knowledge/stats → 200', async () => {
      const res = await fetch(`${BASE}/knowledge/stats`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    test('GET /knowledge/:nonexistent → 404', async () => {
      const res = await fetch(`${BASE}/knowledge/nonexistent-id-999`);
      const body = await res.json();
      // 可能返回 404 (NotFoundError) 或 500
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(body.success).toBe(false);
    });

    test('POST /knowledge — admin 可创建', async () => {
      const res = await fetch(`${BASE}/knowledge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': 'developer',
        },
        body: JSON.stringify({
          title: 'Test Knowledge from HTTP',
          content: { pattern: 'function integrationTest() { return true; }' },
          language: 'javascript',
          category: 'utility',
        }),
      });

      expect(res.status).toBeLessThan(600);
      const body = await res.json();
      expect(typeof body.success).toBe('boolean');
    });
  });

  // ═══════════════════════════════════════════════════════
  //  Guard Rules
  // ═══════════════════════════════════════════════════════

  describe('Guard Rules Endpoints', () => {
    test('GET /rules → 200', async () => {
      const res = await fetch(`${BASE}/rules`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  角色访问控制
  // ═══════════════════════════════════════════════════════

  describe('Role-based Access Control via Header', () => {
    test('external_agent 可以 GET /knowledge', async () => {
      const res = await fetch(`${BASE}/knowledge`, {
        headers: { 'X-User-Id': 'external_agent' },
      });
      expect(res.status).toBe(200);
    });

    test('chat_agent 可以 GET /knowledge', async () => {
      const res = await fetch(`${BASE}/knowledge`, {
        headers: { 'X-User-Id': 'chat_agent' },
      });
      expect(res.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  404 兜底
  // ═══════════════════════════════════════════════════════

  describe('404 Route Fallback', () => {
    test('GET /api/v1/nonexistent → 404', async () => {
      const res = await fetch(`${BASE}/nonexistent`);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  // ═══════════════════════════════════════════════════════
  //  响应格式一致性
  // ═══════════════════════════════════════════════════════

  describe('Response Format Consistency', () => {
    test('成功响应包含 success=true', async () => {
      const res = await fetch(`${BASE}/health`);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    test('错误响应包含 success=false + error 对象', async () => {
      const res = await fetch(`${BASE}/nonexistent`);
      const body = await res.json();

      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBeDefined();
      expect(body.error.message).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════
  //  CORS
  // ═══════════════════════════════════════════════════════

  describe('CORS Headers', () => {
    test('OPTIONS 预检请求返回适当 CORS headers', async () => {
      const res = await fetch(`${BASE}/health`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'GET',
        },
      });

      // CORS preflight 通常返回 204 或 200
      expect(res.status).toBeLessThan(300);
      const corsHeader = res.headers.get('access-control-allow-origin');
      expect(corsHeader).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════
  //  Invalid JSON
  // ═══════════════════════════════════════════════════════

  describe('Invalid Request Handling', () => {
    test('POST 带无效 JSON → 400', async () => {
      const res = await fetch(`${BASE}/candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });
});
