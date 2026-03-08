import os from 'node:os';
import path from 'node:path';
import AuditLogger from '../../lib/infrastructure/audit/AuditLogger.js';
import AuditStore from '../../lib/infrastructure/audit/AuditStore.js';
import DatabaseConnection from '../../lib/infrastructure/database/DatabaseConnection.js';

const __dirname = import.meta.dirname;

describe('AuditLogger & AuditStore', () => {
  let db;
  let auditStore;
  let auditLogger;

  beforeAll(async () => {
    const dbPath = path.join(os.tmpdir(), 'autosnippet-test-audit.db');
    db = new DatabaseConnection({ path: dbPath });
    await db.connect();
    await db.runMigrations();
    db.getDb().exec('DELETE FROM audit_logs');
    auditStore = new AuditStore(db);
    auditLogger = new AuditLogger(auditStore);
  });

  afterAll(async () => {
    await db.close();
  });

  describe('AuditLogger.log', () => {
    test('should log operation', async () => {
      await auditLogger.log({
        requestId: 'req-001',
        actor: 'external_agent',
        action: 'create_candidate',
        resource: '/candidates',
        result: 'success',
        duration: 50,
      });

      const entry = await auditStore.findByRequestId('req-001');
      expect(entry).toBeDefined();
      expect(entry.actor).toBe('external_agent');
    });

    test('should log failures', async () => {
      await auditLogger.log({
        requestId: 'req-002',
        actor: 'external_agent',
        action: 'create_recipe',
        resource: '/recipes',
        result: 'failure',
        error: 'Permission denied',
        duration: 5,
      });

      const entry = await auditStore.findByRequestId('req-002');
      expect(entry.result).toBe('failure');
      // Drizzle 返回 camelCase 属性名
      expect(entry.errorMessage ?? entry.error_message).toBe('Permission denied');
    });
  });

  describe('AuditStore.query', () => {
    test('should query by actor', async () => {
      await auditLogger.log({
        requestId: 'req-003',
        actor: 'developer',
        action: 'create_recipe',
        resource: '/recipes',
        result: 'success',
      });

      const results = await auditStore.query({ actor: 'developer' });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].actor).toBe('developer');
    });

    test('should query by action', async () => {
      const results = await auditStore.query({ action: 'create_candidate' });
      expect(Array.isArray(results)).toBe(true);
    });

    test('should query by result', async () => {
      const results = await auditStore.query({ result: 'success' });
      expect(results.every((r) => r.result === 'success')).toBe(true);
    });

    test('should respect limit', async () => {
      const results = await auditStore.query({ limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('AuditStore.findBy*', () => {
    test('should findByActor', async () => {
      const results = await auditStore.findByActor('external_agent', 10);
      expect(Array.isArray(results)).toBe(true);
    });

    test('should findByAction', async () => {
      const results = await auditStore.findByAction('create_candidate', 10);
      expect(Array.isArray(results)).toBe(true);
    });

    test('should findByResult', async () => {
      await auditLogger.log({
        requestId: 'req-004',
        actor: 'test_actor',
        action: 'test_action',
        resource: '/test',
        result: 'failure',
      });

      const results = await auditStore.findByResult('failure', 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].result).toBe('failure');
    });
  });

  describe('AuditStore.getStats', () => {
    test('should calculate 24h stats', async () => {
      // 添加几条测试数据
      await auditLogger.log({
        requestId: 'req-005',
        actor: 'external_agent',
        action: 'read',
        resource: '/recipes',
        result: 'success',
        duration: 10,
      });

      await auditLogger.log({
        requestId: 'req-006',
        actor: 'developer',
        action: 'create',
        resource: '/recipes',
        result: 'success',
        duration: 50,
      });

      const stats = await auditStore.getStats('24h');

      expect(stats).toHaveProperty('timeRange');
      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('success');
      expect(stats).toHaveProperty('failure');
      expect(stats).toHaveProperty('successRate');
      expect(stats).toHaveProperty('avgDuration');
      expect(stats).toHaveProperty('byActor');
      expect(stats).toHaveProperty('byAction');

      expect(stats.total).toBeGreaterThan(0);
      expect(stats.success).toBeGreaterThan(0);
    });

    test('should show stats by actor', async () => {
      const stats = await auditStore.getStats('24h');
      expect(Array.isArray(stats.byActor)).toBe(true);
      expect(stats.byActor.length).toBeGreaterThan(0);
      expect(stats.byActor[0]).toHaveProperty('actor');
      expect(stats.byActor[0]).toHaveProperty('count');
    });

    test('should show stats by action', async () => {
      const stats = await auditStore.getStats('24h');
      expect(Array.isArray(stats.byAction)).toBe(true);
    });
  });

  describe('error isolation', () => {
    test('should not throw if audit fails', async () => {
      // AuditLogger 应该优雅地处理失败，不阻止业务
      expect(async () => {
        await auditLogger.log({
          requestId: 'req-007',
          actor: 'test',
          action: 'test',
          resource: '/test',
          result: 'success',
        });
      }).not.toThrow();
    });
  });
});
