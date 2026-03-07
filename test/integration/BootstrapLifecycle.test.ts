/**
 * 集成测试：Bootstrap 生命周期 — 初始化/关闭 + 组件一致性
 *
 * 覆盖范围:
 *   - Bootstrap 完整初始化链路 (config → logger → db → constitution → core → gateway)
 *   - 组件依赖注入完整性
 *   - 多次 initialize/shutdown 稳定性
 *   - PathGuard 配置
 */

import { createTestBootstrap } from '../fixtures/factory.js';

describe('Integration: Bootstrap Lifecycle', () => {
  describe('Full initialization', () => {
    let bootstrap: any;
    let components: any;

    beforeAll(async () => {
      ({ bootstrap, components } = await createTestBootstrap());
    });

    afterAll(async () => {
      await bootstrap.shutdown();
    });

    test('should initialize all components', () => {
      expect(components).toBeDefined();
      expect(components.config).toBeDefined();
      expect(components.logger).toBeDefined();
      expect(components.db).toBeDefined();
      expect(components.constitution).toBeDefined();
      expect(components.constitutionValidator).toBeDefined();
      expect(components.permissionManager).toBeDefined();
      expect(components.auditStore).toBeDefined();
      expect(components.auditLogger).toBeDefined();
      expect(components.gateway).toBeDefined();
      expect(components.skillHooks).toBeDefined();
    });

    test('should have functional gateway', async () => {
      const { gateway } = components;
      gateway.register('lifecycle_test', async () => ({ alive: true }));

      const result = await gateway.execute({
        actor: 'developer',
        action: 'lifecycle_test',
        resource: '/test',
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ alive: true });
    });

    test('should have functional database', () => {
      const { db } = components;
      expect(db).toBeDefined();
      // DB 应该已经连接并迁移
      const dbInstance = db.getDb?.() || db;
      expect(dbInstance).toBeDefined();
    });

    test('should have functional constitution', () => {
      const { constitution } = components;
      expect(constitution).toBeDefined();
      const json = constitution.toJSON();
      expect(json).toBeDefined();
    });

    test('should have functional audit system', async () => {
      const { auditStore, auditLogger } = components;
      expect(auditStore).toBeDefined();
      expect(auditLogger).toBeDefined();
    });
  });

  describe('Multiple lifecycle cycles', () => {
    test('should support sequential init/shutdown', async () => {
      const { Bootstrap } = await import('../../lib/bootstrap.js');

      // 第一个实例
      const b1 = new Bootstrap({ env: 'test' });
      const c1 = await b1.initialize();
      expect(c1.gateway).toBeDefined();
      await b1.shutdown();

      // 第二个实例
      const b2 = new Bootstrap({ env: 'test' });
      const c2 = await b2.initialize();
      expect(c2.gateway).toBeDefined();
      await b2.shutdown();
    });
  });

  describe('PathGuard configuration', () => {
    test('should configure PathGuard with project root', async () => {
      const { Bootstrap } = await import('../../lib/bootstrap.js');
      // Static method should not throw
      expect(() => {
        Bootstrap.configurePathGuard('/tmp/test-project');
      }).not.toThrow();
    });

    test('should accept knowledge base dir', async () => {
      const { Bootstrap } = await import('../../lib/bootstrap.js');
      expect(() => {
        Bootstrap.configurePathGuard('/tmp/test-project', 'AutoSnippet');
      }).not.toThrow();
    });
  });
});
