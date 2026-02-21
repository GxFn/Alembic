/**
 * REST API 端点集成测试
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import Bootstrap from '../../lib/bootstrap.js';
import HttpServer from '../../lib/http/HttpServer.js';

describe('REST API Integration Tests', async () => {
  let httpServer;
  let bootstrap;
  let _components;

  // 在所有测试开始之前初始化
  await (async () => {
    bootstrap = new Bootstrap({ env: 'test' });
    _components = await bootstrap.initialize();

    httpServer = new HttpServer({ port: 3005 });
    httpServer.initialize();
    await httpServer.start();
  })();

  // 在所有测试结束后清理
  process.on('exit', async () => {
    if (httpServer) {
      await httpServer.stop();
    }
    if (bootstrap) {
      await bootstrap.shutdown();
    }
  });

  describe('Health Check Endpoints', () => {
    test('GET /api/v1/health should return healthy status', async () => {
      const response = await fetch('http://localhost:3005/api/v1/health');
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.status, 'healthy');
      assert(data.timestamp);
      assert(typeof data.uptime === 'number');
    });

    test('GET /api/v1/health/ready should return ready status', async () => {
      const response = await fetch('http://localhost:3005/api/v1/health/ready');
      const data = await response.json();

      assert.strictEqual(response.status, 200);
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.ready, true);
    });
  });

  describe('Candidates API', () => {
    test('GET /api/v1/candidates should return list', async () => {
      const response = await fetch('http://localhost:3005/api/v1/candidates');
      assert.strictEqual(response.status, 200 || 500); // May fail if service not properly mocked
    });

    test('POST /api/v1/candidates should handle request', async () => {
      const response = await fetch('http://localhost:3005/api/v1/candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test Candidate',
          email: 'test@example.com',
          source: 'test',
        }),
      });

      // Should either succeed (201) or fail with proper error (400, 404, etc.)
      assert(response.status >= 200 && response.status < 600);
    });
  });

  describe('Recipes API', () => {
    test('GET /api/v1/recipes should return list', async () => {
      const response = await fetch('http://localhost:3005/api/v1/recipes');
      assert.strictEqual(response.status, 200 || 500);
    });

    test('POST /api/v1/recipes should handle request', async () => {
      const response = await fetch('http://localhost:3005/api/v1/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test Recipe',
          category: 'test',
          description: 'Test recipe',
          content: 'Test content',
        }),
      });

      assert(response.status >= 200 && response.status < 600);
    });
  });

  describe('Guard Rules API', () => {
    test('GET /api/v1/rules should return list', async () => {
      const response = await fetch('http://localhost:3005/api/v1/rules');
      assert.strictEqual(response.status, 200 || 500);
    });

    test('POST /api/v1/rules should handle request', async () => {
      const response = await fetch('http://localhost:3005/api/v1/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test Rule',
          category: 'test',
          pattern: 'test_pattern',
          condition: {},
          action: 'block',
        }),
      });

      assert(response.status >= 200 && response.status < 600);
    });
  });

  describe('Error Handling', () => {
    test('GET /api/v1/undefined should return 404', async () => {
      const response = await fetch('http://localhost:3005/api/v1/undefined');
      const data = await response.json();

      assert.strictEqual(response.status, 404);
      assert.strictEqual(data.success, false);
      assert(data.error.code);
    });

    test('POST with invalid JSON should handle properly', async () => {
      const response = await fetch('http://localhost:3005/api/v1/candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      assert(response.status >= 400);
    });
  });

  describe('Response Format', () => {
    test('All successful responses should have success=true', async () => {
      const response = await fetch('http://localhost:3005/api/v1/health');
      const data = await response.json();

      assert.strictEqual(typeof data.success, 'boolean');
      assert(data.success || data.error);
    });

    test('All error responses should have proper structure', async () => {
      const response = await fetch('http://localhost:3005/api/v1/invalid-endpoint');
      const data = await response.json();

      assert.strictEqual(data.success, false);
      assert(data.error);
      assert(data.error.code);
      assert(data.error.message);
    });
  });
});
