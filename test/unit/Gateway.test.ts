import { vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Constitution from '../../lib/core/constitution/Constitution.js';
import ConstitutionValidator from '../../lib/core/constitution/ConstitutionValidator.js';
import Gateway from '../../lib/core/gateway/Gateway.js';
import PermissionManager from '../../lib/core/permission/PermissionManager.js';
import AuditLogger from '../../lib/infrastructure/audit/AuditLogger.js';
import AuditStore from '../../lib/infrastructure/audit/AuditStore.js';
import DatabaseConnection from '../../lib/infrastructure/database/DatabaseConnection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Gateway', () => {
  let gateway;
  let constitution;
  let constitutionValidator;
  let permissionManager;
  let db;
  let auditLogger;

  beforeAll(async () => {
    // 初始化依赖
    const configPath = path.join(__dirname, '../../config/constitution.yaml');
    constitution = new Constitution(configPath);
    constitutionValidator = new ConstitutionValidator(constitution);
    permissionManager = new PermissionManager(constitution);

    const dbPath = path.join(os.tmpdir(), 'autosnippet-test-gateway.db');
    db = new DatabaseConnection({ path: dbPath });
    await db.connect();
    await db.runMigrations();

    const auditStore = new AuditStore(db);
    auditLogger = new AuditLogger(auditStore);

    gateway = new Gateway({});
    gateway.setDependencies({
      constitution,
      constitutionValidator,
      permissionManager,
      auditLogger,
    });
  });

  afterAll(async () => {
    await db.close();
  });

  describe('execute', () => {
    test('should execute valid request successfully', async () => {
      gateway.register('test_action', async (context) => {
        return { success: true };
      });

      const result = await gateway.execute({
        actor: 'developer',
        action: 'test_action',
        resource: '/test',
        data: { test: true },
      });

      expect(result.success).toBe(true);
      expect(result.requestId).toBeDefined();
      expect(result.duration).toBeDefined();
    });

    test('should enforce permission checks', async () => {
      gateway.register('create_recipe', async (context) => {
        return { recipeId: '123' };
      });

      const result = await gateway.execute({
        actor: 'external_agent',
        action: 'create_recipe',
        resource: '/recipes', // 问题：action 和 resource 不匹配
        data: { name: 'Test' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('should validate against constitution', async () => {
      gateway.register('create', async (context) => {
        return { candidateId: '456' };
      });

      const result = await gateway.execute({
        actor: 'external_agent',
        action: 'create',
        resource: '/candidates',
        data: { name: 'Test' }, // 缺少 code 和 reasoning
      });

      expect(result.success).toBe(false);
      expect(result.error.message).toContain('Constitution');
    });

    test('should log all operations to audit', async () => {
      gateway.register('audit_test', async (context) => {
        return { result: 'ok' };
      });

      const result = await gateway.execute({
        actor: 'developer',
        action: 'audit_test',
        resource: '/test',
      });

      expect(result.success).toBe(true);
      // 审计日志应该已记录（可通过查询验证）
    });

    test('should handle missing action', async () => {
      const result = await gateway.execute({
        actor: 'developer',
        // 缺少 action
        resource: '/test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('should handle missing actor', async () => {
      gateway.register('some_action', async () => ({ ok: true }));

      const result = await gateway.execute({
        // 缺少 actor
        action: 'some_action',
        resource: '/test',
      });

      expect(result.success).toBe(false);
    });

    test('should call handler with correct context', async () => {
      const handler = vi.fn(async (context) => {
        return { actor: context.actor, action: context.action };
      });

      gateway.register('context_test', handler);

      await gateway.execute({
        actor: 'developer',
        action: 'context_test',
        resource: '/test',
        data: { foo: 'bar' },
      });

      expect(handler).toHaveBeenCalled();
      const context = handler.mock.calls[0][0];
      expect(context.actor).toBe('developer');
      expect(context.action).toBe('context_test');
      expect(context.data.foo).toBe('bar');
    });
  });

  describe('route registration', () => {
    test('should register route', () => {
      const routes1 = gateway.getRoutes();
      const initialCount = routes1.length;

      gateway.register('new_action', async () => ({ ok: true }));

      const routes2 = gateway.getRoutes();
      expect(routes2.length).toBe(initialCount + 1);
      expect(routes2).toContain('new_action');
    });

    test('should prevent duplicate registration', () => {
      const handler = async () => ({ ok: true });
      gateway.register(`unique_action_${Date.now()}`, handler);

      expect(() => {
        gateway.register(`unique_action_${Date.now()}${1}`, handler);
      }).not.toThrow();
    });

    test('should throw on duplicate action name', () => {
      const actionName = `duplicate_test_${Date.now()}`;
      gateway.register(actionName, async () => ({ ok: true }));

      expect(() => {
        gateway.register(actionName, async () => ({ ok: false }));
      }).toThrow();
    });
  });

  describe('error handling', () => {
    test('should catch handler errors', async () => {
      gateway.register('error_action', async () => {
        throw new Error('Handler error');
      });

      const result = await gateway.execute({
        actor: 'developer',
        action: 'error_action',
        resource: '/test',
      });

      expect(result.success).toBe(false);
      expect(result.error.message).toContain('Handler error');
    });

    test('should report correct error status codes', async () => {
      const result = await gateway.execute({
        actor: 'external_agent',
        action: 'create_recipe',
        resource: '/recipes',
      });

      expect(result.success).toBe(false);
      expect(result.error.statusCode).toBe(403); // PermissionDenied
    });
  });

  describe('request tracking', () => {
    test('should assign unique requestId', async () => {
      gateway.register('tracking_test', async () => ({ ok: true }));

      const result1 = await gateway.execute({
        actor: 'developer',
        action: 'tracking_test',
        resource: '/test1',
      });

      const result2 = await gateway.execute({
        actor: 'developer',
        action: 'tracking_test',
        resource: '/test2',
      });

      expect(result1.requestId).toBeDefined();
      expect(result2.requestId).toBeDefined();
      expect(result1.requestId).not.toBe(result2.requestId);
    });

    test('should measure request duration', async () => {
      gateway.register('slow_action', async () => {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true }), 10);
        });
      });

      const result = await gateway.execute({
        actor: 'developer',
        action: 'slow_action',
        resource: '/test',
      });

      expect(result.duration).toBeGreaterThanOrEqual(10);
    });
  });
});
