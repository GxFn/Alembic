/**
 * 集成测试：Gateway route/audit chain
 *
 * Gateway 的主线职责是请求格式检查、路由执行、审计封装和错误恢复。
 * 具体写入保护由 HTTP route/service entrypoint 自己实现。
 */

import { createTestBootstrap } from '../fixtures/factory.js';

describe('Integration: Gateway Full Chain', () => {
  let bootstrap;
  let components;

  beforeAll(async () => {
    ({ bootstrap, components } = await createTestBootstrap());
  });

  afterAll(async () => {
    await bootstrap.shutdown();
  });

  describe('Route execution', () => {
    test('runs a registered handler with neutral request context', async () => {
      const { gateway } = components;

      gateway.register('chain_read_recipes', async (context) => ({
        ok: true,
        actor: context.actor,
        resource: context.resource,
      }));

      const result = await gateway.execute({
        actor: 'http-request',
        action: 'chain_read_recipes',
        resource: '/recipes',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        ok: true,
        actor: 'http-request',
        resource: '/recipes',
      });
    });

    test('does not turn source labels into route authority', async () => {
      const { gateway } = components;
      const actors = ['http-request', 'dashboard-source', 'batch-runner'];

      gateway.register('chain_source_label_invariance', async (context) => ({
        actor: context.actor,
      }));

      for (const actor of actors) {
        const result = await gateway.execute({
          actor,
          action: 'chain_source_label_invariance',
          resource: '/recipes',
          data: { confirmed: true },
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual({ actor });
      }
    });

    test('rejects malformed requests before handler lookup', async () => {
      const { gateway } = components;
      const result = await gateway.execute({
        actor: '',
        action: 'chain_missing_actor',
        resource: '/test',
      });

      expect(result.success).toBe(false);
      expect(result.error.statusCode).toBe(500);
      expect(result.error.message).toContain('Missing required field: actor');
    });
  });

  describe('Audit Logging', () => {
    test('records successful operations', async () => {
      const { gateway, auditStore } = components;
      const actionName = 'audit_chain_success';

      gateway.register(actionName, async () => ({ status: 'ok' }));

      const result = await gateway.execute({
        actor: 'http-request',
        action: actionName,
        resource: '/test',
      });

      expect(result.success).toBe(true);

      const logs = await auditStore.query({ action: actionName });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].result).toBe('success');
      expect(logs[0].actor).toBe('http-request');
    });

    test('records handler failures', async () => {
      const { gateway, auditStore } = components;
      const actionName = 'audit_chain_failure';

      gateway.register(actionName, async () => {
        throw new Error('Handler intentionally failed');
      });

      const result = await gateway.execute({
        actor: 'http-request',
        action: actionName,
        resource: '/test',
      });

      expect(result.success).toBe(false);

      const logs = await auditStore.query({ action: actionName });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].result).toBe('failure');
      expect(logs[0].errorMessage).toBeDefined();
    });

    test('tracks operation duration', async () => {
      const { gateway, auditStore } = components;
      const actionName = 'audit_chain_duration';

      gateway.register(actionName, async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { ok: true };
      });

      const result = await gateway.execute({
        actor: 'http-request',
        action: actionName,
        resource: '/test',
      });

      expect(result.success).toBe(true);
      expect(result.duration).toBeGreaterThanOrEqual(10);

      const logs = await auditStore.query({ action: actionName });
      expect(logs[0].duration).toBeGreaterThanOrEqual(10);
    });
  });

  describe('Error Recovery', () => {
    test('continues after a handler crash', async () => {
      const { gateway } = components;

      gateway.register('recovery_crash', async () => {
        throw new Error('Boom!');
      });

      const r1 = await gateway.execute({
        actor: 'http-request',
        action: 'recovery_crash',
        resource: '/test',
      });
      expect(r1.success).toBe(false);

      gateway.register('recovery_ok', async () => ({ ok: true }));

      const r2 = await gateway.execute({
        actor: 'http-request',
        action: 'recovery_ok',
        resource: '/test',
      });
      expect(r2.success).toBe(true);
    });
  });

  describe('Request ID Uniqueness', () => {
    test('consecutive requests have different requestId values', async () => {
      const { gateway } = components;
      const ids = new Set();

      gateway.register('reqid_unique', async () => ({ ok: true }));

      for (let i = 0; i < 5; i++) {
        const r = await gateway.execute({
          actor: 'http-request',
          action: 'reqid_unique',
          resource: '/test',
        });
        expect(r.requestId).toBeDefined();
        ids.add(r.requestId);
      }

      expect(ids.size).toBe(5);
    });
  });
});
