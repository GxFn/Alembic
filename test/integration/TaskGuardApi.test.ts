/**
 * 集成测试：Task HTTP API + Guard HTTP API
 *
 * 覆盖范围：
 *   ✓ POST /api/v1/task — Intent Lifecycle handler (create)
 *   ✓ POST /api/v1/guard/file — Guard 文件检查
 *   ✓ 错误处理
 */

import Bootstrap from '../../lib/bootstrap.js';
import { HttpServer } from '../../lib/http/HttpServer.js';
import { getServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { getTestPort } from '../fixtures/factory.js';

const PORT = getTestPort();
const BASE = `http://localhost:${PORT}/api/v1`;

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

describe('Integration: TaskGraph + Guard HTTP API', () => {
  let bootstrap;
  let httpServer;

  beforeAll(async () => {
    bootstrap = new Bootstrap({ env: 'test' });
    const components = await bootstrap.initialize();

    const container = getServiceContainer();
    await container.initialize(components);

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

  // ── Task HTTP API (v3.3 — Intent Lifecycle) ──────

  describe('POST /task', () => {
    it('should create a task via intent lifecycle handler', async () => {
      const res = await post('/task', { operation: 'create', title: 'test' });
      expect(res.success).toBe(true);
      expect(res.data).toHaveProperty('id');
    });
  });

  // ── Guard 文件检查 ──────────────────────────

  describe('POST /guard/file', () => {
    it('should check a JavaScript file', async () => {
      const res = await post('/guard/file', {
        filePath: '/tmp/test.js',
        content: 'const x = 1;\nconsole.log(x);',
        language: 'javascript',
      });
      expect(res.success).toBe(true);
      expect(res.data).toHaveProperty('violations');
      expect(Array.isArray(res.data.violations)).toBe(true);
    });

    it('should reject missing filePath', async () => {
      const res = await post('/guard/file', {
        content: 'const x = 1;',
      });
      expect(res.success).toBe(false);
    });
  });
});
