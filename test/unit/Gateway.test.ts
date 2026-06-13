import os from 'node:os';
import path from 'node:path';
import { DatabaseConnection } from '@alembic/core/database';
import { vi } from 'vitest';
import Gateway from '../../lib/governance/gateway/Gateway.js';
import AuditLogger from '../../lib/infrastructure/audit/AuditLogger.js';
import AuditStore from '../../lib/infrastructure/audit/AuditStore.js';

describe('Gateway', () => {
  let gateway: Gateway;
  let db: DatabaseConnection;

  beforeAll(async () => {
    const dbPath = path.join(os.tmpdir(), `alembic-test-gateway-${Date.now()}.db`);
    db = new DatabaseConnection({ path: dbPath });
    await db.connect();
    await db.runMigrations();

    const auditStore = new AuditStore(db);
    const auditLogger = new AuditLogger(auditStore);

    gateway = new Gateway({});
    gateway.setDependencies({ auditLogger });
  });

  afterAll(async () => {
    await db.close();
  });

  describe('execute', () => {
    test('executes a registered request successfully', async () => {
      gateway.register('test_action', async () => ({ success: true }));

      const result = await gateway.execute({
        actor: 'http-request',
        action: 'test_action',
        resource: '/test',
        data: { test: true },
      });

      expect(result.success).toBe(true);
      expect(result.requestId).toBeDefined();
      expect(result.duration).toBeDefined();
    });

    test('does not apply central permission checks before route execution', async () => {
      gateway.register('create_recipe', async () => ({ recipeId: '123' }));

      const result = await gateway.execute({
        actor: 'external-agent',
        action: 'create_recipe',
        resource: '/recipes',
        data: { name: 'Test' },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ recipeId: '123' });
    });

    test('does not apply central content validation before route execution', async () => {
      gateway.register('create_candidate_without_content', async () => ({ candidateId: '456' }));

      const result = await gateway.execute({
        actor: 'http-request',
        action: 'create_candidate_without_content',
        resource: '/candidates',
        data: { name: 'Test' },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ candidateId: '456' });
    });

    test('handles missing action', async () => {
      const result = await gateway.execute({
        actor: 'http-request',
        resource: '/test',
      } as never);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('handles missing actor', async () => {
      gateway.register('some_action', async () => ({ ok: true }));

      const result = await gateway.execute({
        action: 'some_action',
        resource: '/test',
      } as never);

      expect(result.success).toBe(false);
    });

    test('calls handler with correct context', async () => {
      const handler = vi.fn(async (context) => ({
        actor: context.actor,
        action: context.action,
      }));

      gateway.register('context_test', handler);

      await gateway.execute({
        actor: 'http-request',
        action: 'context_test',
        resource: '/test',
        data: { foo: 'bar' },
      });

      expect(handler).toHaveBeenCalled();
      const context = handler.mock.calls[0][0];
      expect(context.actor).toBe('http-request');
      expect(context.action).toBe('context_test');
      expect(context.data.foo).toBe('bar');
    });
  });

  describe('route registration', () => {
    test('registers route', () => {
      const initialCount = gateway.getRoutes().length;

      gateway.register('new_action', async () => ({ ok: true }));

      const routes = gateway.getRoutes();
      expect(routes.length).toBe(initialCount + 1);
      expect(routes).toContain('new_action');
    });

    test('throws on duplicate action name', () => {
      const actionName = `duplicate_test_${Date.now()}`;
      gateway.register(actionName, async () => ({ ok: true }));

      expect(() => {
        gateway.register(actionName, async () => ({ ok: false }));
      }).toThrow();
    });
  });

  describe('error handling', () => {
    test('catches handler errors', async () => {
      gateway.register('error_action', async () => {
        throw new Error('Handler error');
      });

      const result = await gateway.execute({
        actor: 'http-request',
        action: 'error_action',
        resource: '/test',
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Handler error');
    });

    test('reports missing handlers as internal route errors', async () => {
      const result = await gateway.execute({
        actor: 'http-request',
        action: 'missing_gateway_route',
        resource: '/recipes',
      });

      expect(result.success).toBe(false);
      expect(result.error?.statusCode).toBe(500);
    });
  });

  describe('request tracking', () => {
    test('assigns unique requestId', async () => {
      gateway.register('tracking_test', async () => ({ ok: true }));

      const result1 = await gateway.execute({
        actor: 'http-request',
        action: 'tracking_test',
        resource: '/test1',
      });

      const result2 = await gateway.execute({
        actor: 'http-request',
        action: 'tracking_test',
        resource: '/test2',
      });

      expect(result1.requestId).toBeDefined();
      expect(result2.requestId).toBeDefined();
      expect(result1.requestId).not.toBe(result2.requestId);
    });

    test('measures request duration', async () => {
      gateway.register('slow_action', async () => {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true }), 10);
        });
      });

      const result = await gateway.execute({
        actor: 'http-request',
        action: 'slow_action',
        resource: '/test',
      });

      expect(result.duration).toBeGreaterThanOrEqual(10);
    });
  });
});
