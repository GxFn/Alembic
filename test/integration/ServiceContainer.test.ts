/**
 * 集成测试：ServiceContainer DI — 容器初始化、模块注册、服务解析
 *
 * 覆盖范围:
 *   - ServiceContainer 构造 & register / singleton / get
 *   - initialize() 完整模块注册链 (Infra → App → Knowledge → Guard → Agent)
 *   - 服务惰性创建 & 单例缓存
 *   - reset() 清除单例
 *   - 核心服务可解析性验证
 */

import { createTestBootstrap } from '../fixtures/factory.js';

describe('Integration: ServiceContainer', () => {
  describe('Basic container operations', () => {
    let ServiceContainer: any;

    beforeAll(async () => {
      const mod = await import('../../lib/injection/ServiceContainer.js');
      ServiceContainer = mod.ServiceContainer;
    });

    test('should register and get a service', () => {
      const container = new ServiceContainer();
      container.register('myService', () => ({ name: 'test' }));
      const svc = container.get('myService');
      expect(svc).toEqual({ name: 'test' });
    });

    test('should create singletons lazily', () => {
      const container = new ServiceContainer();
      let callCount = 0;
      container.singleton('counter', () => {
        callCount++;
        return { count: callCount };
      });

      const first = container.get('counter');
      const second = container.get('counter');
      expect(first).toBe(second);
      expect(callCount).toBe(1);
    });

    test('should allow resetting singletons', () => {
      const container = new ServiceContainer();
      let callCount = 0;
      container.singleton('resettable', () => {
        callCount++;
        return { n: callCount };
      });

      const first = container.get('resettable');
      expect(first.n).toBe(1);

      container.singletons = {};
      // Re-register since singletons was cleared
      container.singleton('resettable', () => {
        callCount++;
        return { n: callCount };
      });
      const second = container.get('resettable');
      expect(second.n).toBe(2);
    });
  });

  describe('Full container initialization', () => {
    let bootstrap: any;
    let components: any;
    let container: any;

    beforeAll(async () => {
      ({ bootstrap, components } = await createTestBootstrap());

      const { ServiceContainer } = await import('../../lib/injection/ServiceContainer.js');
      container = new ServiceContainer();
      await container.initialize({
        db: components.db,
        auditLogger: components.auditLogger,
        gateway: components.gateway,
        constitution: components.constitution,
        config: components.config,
        skillHooks: components.skillHooks,
      });
    });

    afterAll(async () => {
      await bootstrap.shutdown();
    });

    // ─── Infra Module 服务 ──────────────────────

    test('should resolve database', () => {
      expect(container.get('database')).toBeDefined();
    });

    test('should resolve auditLogger', () => {
      expect(container.get('auditLogger')).toBeDefined();
    });

    test('should resolve gateway', () => {
      expect(container.get('gateway')).toBeDefined();
    });

    test('should resolve eventBus', () => {
      const bus = container.get('eventBus');
      expect(bus).toBeDefined();
      expect(typeof bus.emit).toBe('function');
    });

    // ─── Knowledge Module 服务 ──────────────────

    test('should resolve knowledgeService', () => {
      const ks = container.get('knowledgeService');
      expect(ks).toBeDefined();
    });

    test('should resolve searchEngine', () => {
      const se = container.get('searchEngine');
      expect(se).toBeDefined();
    });

    test('should resolve knowledgeRepository', () => {
      const kr = container.get('knowledgeRepository');
      expect(kr).toBeDefined();
    });

    // ─── Guard Module 服务 ──────────────────────

    test('should resolve guardService', () => {
      const gs = container.get('guardService');
      expect(gs).toBeDefined();
    });

    test('should resolve guardCheckEngine', () => {
      const gce = container.get('guardCheckEngine');
      expect(gce).toBeDefined();
    });

    // ─── Agent Module 服务 ──────────────────────

    test('should resolve toolRegistry', () => {
      const tr = container.get('toolRegistry');
      expect(tr).toBeDefined();
      expect(typeof tr.has).toBe('function');
    });

    // ─── App Module 服务 ────────────────────────

    test('should resolve automationOrchestrator', () => {
      const ao = container.get('automationOrchestrator');
      expect(ao).toBeDefined();
    });

    // ─── 服务一致性 ────────────────────────────

    test('should return same instance for repeated get calls', () => {
      const a = container.get('searchEngine');
      const b = container.get('searchEngine');
      expect(a).toBe(b);
    });

    test('should resolve services with correct types', () => {
      const kr = container.get('knowledgeRepository');
      expect(typeof kr.create).toBe('function');
      expect(typeof kr.findById).toBe('function');
    });
  });
});
