/**
 * HTTP 服务器集成测试
 */

import assert from 'node:assert';
import { test } from 'node:test';
import HttpServer from '../../lib/http/HttpServer.js';

test('HTTP Server - Health Check', async (t) => {
  const httpServer = new HttpServer({ port: 3001 });
  httpServer.initialize();

  const _server = await httpServer.start();

  await t.test('GET /api/v1/health - should return healthy status', async () => {
    const response = await fetch('http://localhost:3001/api/v1/health');
    const data = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.status, 'healthy');
    assert(data.timestamp);
    assert(typeof data.uptime === 'number');
  });

  await t.test('GET /api/v1/health/ready - should return ready status', async () => {
    const response = await fetch('http://localhost:3001/api/v1/health/ready');
    const data = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.ready, true);
  });

  await t.test('GET /api/v1/undefined - should return 404', async () => {
    const response = await fetch('http://localhost:3001/api/v1/undefined');
    const data = await response.json();

    assert.strictEqual(response.status, 404);
    assert.strictEqual(data.success, false);
    assert(data.error.message.includes('Route not found'));
  });

  await httpServer.stop();
});

test('HTTP Server - Request Logging', async (t) => {
  const httpServer = new HttpServer({ port: 3002 });
  httpServer.initialize();

  const _server = await httpServer.start();

  await t.test('should log incoming requests', async () => {
    const response = await fetch('http://localhost:3002/api/v1/health');
    assert.strictEqual(response.status, 200);
  });

  await httpServer.stop();
});

test('HTTP Server - CORS Headers', async (t) => {
  const httpServer = new HttpServer({ port: 3003 });
  httpServer.initialize();

  const _server = await httpServer.start();

  await t.test('should include CORS headers in response', async () => {
    const response = await fetch('http://localhost:3003/api/v1/health');

    assert(response.headers.get('access-control-allow-origin'));
    assert(response.headers.get('access-control-allow-methods'));
    assert(response.headers.get('access-control-allow-headers'));
  });

  await httpServer.stop();
});
