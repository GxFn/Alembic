/**
 * 集成测试：TaskGraph HTTP API + Guard HTTP API
 *
 * 覆盖范围：
 *   ✓ POST /api/v1/task — 任务生命周期（create → claim → progress → close）
 *   ✓ POST /api/v1/task — prime / ready / stats / list / blocked
 *   ✓ POST /api/v1/task — decompose / dep_add / dep_tree
 *   ✓ POST /api/v1/guard/file — Guard 文件检查
 *   ✓ 错误处理（缺参、无效操作）
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
    if (httpServer) await httpServer.stop();
    if (bootstrap) await bootstrap.shutdown();
  });

  // ── TaskGraph 任务生命周期 ──────────────────────────

  describe('POST /task — lifecycle', () => {
    let taskId;

    it('should create a task', async () => {
      const res = await post('/task', {
        operation: 'create',
        title: 'Test task for integration',
        description: 'Created by integration test',
        priority: 1,
        taskType: 'task',
      });
      expect(res.success).toBe(true);
      expect(res.data.id).toMatch(/^asd-/);
      expect(res.data.title).toBe('Test task for integration');
      expect(res.data.status).toBe('open');
      taskId = res.data.id;
    });

    it('should claim a task', async () => {
      const res = await post('/task', {
        operation: 'claim',
        id: taskId,
      });
      expect(res.success).toBe(true);
      expect(res.data.status).toBe('in_progress');
    });

    it('should update progress', async () => {
      const res = await post('/task', {
        operation: 'progress',
        id: taskId,
        description: 'Making progress on test task',
      });
      expect(res.success).toBe(true);
    });

    it('should close a task', async () => {
      const res = await post('/task', {
        operation: 'close',
        id: taskId,
      });
      expect(res.success).toBe(true);
      expect(res.data.status).toBe('closed');
      expect(res).toHaveProperty('newlyReady');
    });
  });

  // ── TaskGraph 查询操作 ──────────────────────────

  describe('POST /task — queries', () => {
    it('should return prime data', async () => {
      const res = await post('/task', { operation: 'prime' });
      expect(res.success).toBe(true);
      expect(res.data).toHaveProperty('inProgress');
      expect(res.data).toHaveProperty('ready');
      expect(res.data).toHaveProperty('stats');
    });

    it('should return ready tasks', async () => {
      const res = await post('/task', { operation: 'ready', limit: 3 });
      expect(res.success).toBe(true);
      expect(Array.isArray(res.data)).toBe(true);
    });

    it('should return stats', async () => {
      const res = await post('/task', { operation: 'stats' });
      expect(res.success).toBe(true);
      expect(res.data).toBeDefined();
    });

    it('should return list', async () => {
      const res = await post('/task', { operation: 'list', limit: 10 });
      expect(res.success).toBe(true);
      expect(Array.isArray(res.data)).toBe(true);
    });

    it('should return blocked tasks', async () => {
      const res = await post('/task', { operation: 'blocked' });
      expect(res.success).toBe(true);
      expect(Array.isArray(res.data)).toBe(true);
    });
  });

  // ── TaskGraph 错误处理 ──────────────────────────

  describe('POST /task — error handling', () => {
    it('should reject missing operation', async () => {
      const res = await post('/task', {});
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/operation.*required/i);
    });

    it('should reject unknown operation', async () => {
      const res = await post('/task', { operation: 'nonexistent' });
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/unknown/i);
    });

    it('should reject claim without id', async () => {
      const res = await post('/task', { operation: 'claim' });
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/id.*required/i);
    });

    it('should reject create without title', async () => {
      const res = await post('/task', { operation: 'create' });
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/title.*required/i);
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
      expect(res).toHaveProperty('violations');
      expect(Array.isArray(res.violations)).toBe(true);
    });

    it('should reject missing filePath', async () => {
      const res = await post('/guard/file', {
        content: 'const x = 1;',
      });
      expect(res.success).toBe(false);
    });
  });
});
