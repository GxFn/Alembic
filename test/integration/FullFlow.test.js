import path from 'path';
import { fileURLToPath } from 'url';
import Bootstrap from '../../lib/bootstrap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Integration: Complete Gateway Flow', () => {
  let bootstrap;
  let components;

  beforeAll(async () => {
    bootstrap = new Bootstrap({ env: 'test' });
    components = await bootstrap.initialize();
  });

  afterAll(async () => {
    await bootstrap.shutdown();
  });

  describe('Full request flow', () => {
    test('should handle complete read operation', async () => {
      const { gateway } = components;

      gateway.register('read_recipes', async (context) => {
        return [
          { id: '1', name: 'Recipe 1' },
          { id: '2', name: 'Recipe 2' },
        ];
      });

      const result = await gateway.execute({
        actor: 'external_agent',
        action: 'read_recipes',
        resource: '/recipes',
      });

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.requestId).toBeDefined();
    });

    test('should block unauthorized creation', async () => {
      const { gateway } = components;

      gateway.register('create_recipe', async (context) => {
        return { recipeId: '123' };
      });

      const result = await gateway.execute({
        actor: 'external_agent',
        action: 'create_recipe',
        resource: '/recipes',
      });

      expect(result.success).toBe(false);
      expect(result.error.statusCode).toBe(403);
    });

    test('should enforce constitution validation', async () => {
      const { gateway } = components;

      gateway.register('create', async (context) => {
        return { candidateId: '456' };
      });

      // 没有 code 和 reasoning
      const result = await gateway.execute({
        actor: 'external_agent',
        action: 'create',
        resource: '/candidates',
        data: { name: 'Test' },
      });

      expect(result.success).toBe(false);
      expect(result.error.message).toContain('Constitution');
    });

    test('should allow admin to create recipes', async () => {
      const { gateway } = components;

      gateway.register('admin_create_recipe', async (context) => {
        return { recipeId: 'new-123' };
      });

      const result = await gateway.execute({
        actor: 'developer',
        action: 'admin_create_recipe',
        resource: '/recipes',
        data: {
          name: 'New Recipe',
          code: 'function example() {}',
        },
      });

      expect(result.success).toBe(true);
      expect(result.data.recipeId).toBe('new-123');
    });

    test('should allow candidate creation with complete data', async () => {
      const { gateway } = components;

      gateway.register('submit_knowledge', async (context) => {
        return { candidateId: 'cand-123' };
      });

      const result = await gateway.execute({
        actor: 'external_agent',
        action: 'submit_knowledge',
        resource: '/candidates',
        data: {
          name: 'Good Candidate',
          code: 'function helper() { return true; }',
          reasoning: {
            whyStandard: 'Following best practices',
            sources: ['documentation', 'code review guidelines'],
            qualitySignals: { clarity: 0.95, reusability: 0.9 },
            alternatives: ['inline approach'],
            confidence: 0.92,
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.data.candidateId).toBe('cand-123');
    });
  });

  describe('Audit integration', () => {
    test('should record successful operations', async () => {
      const { gateway, auditStore } = components;

      gateway.register('audit_success_test', async () => {
        return { status: 'ok' };
      });

      const result = await gateway.execute({
        actor: 'developer',
        action: 'audit_success_test',
        resource: '/test',
      });

      expect(result.success).toBe(true);

      // 查询审计日志
      const logs = await auditStore.query({ action: 'audit_success_test' });
      expect(logs.length).toBeGreaterThan(0);
      const log = logs[0];
      expect(log.result).toBe('success');
    });

    test('should record failed operations', async () => {
      const { gateway, auditStore } = components;

      gateway.register('audit_fail_test', async () => {
        throw new Error('Intentional failure');
      });

      const result = await gateway.execute({
        actor: 'developer',
        action: 'audit_fail_test',
        resource: '/test',
      });

      expect(result.success).toBe(false);

      // 查询审计日志
      const logs = await auditStore.query({ action: 'audit_fail_test' });
      expect(logs.length).toBeGreaterThan(0);
      const log = logs[0];
      expect(log.result).toBe('failure');
      expect(log.error_message).toBeDefined();
    });

    test('should track operation duration', async () => {
      const { gateway, auditStore } = components;

      gateway.register('audit_duration_test', async () => {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true }), 20);
        });
      });

      const result = await gateway.execute({
        actor: 'developer',
        action: 'audit_duration_test',
        resource: '/test',
      });

      expect(result.success).toBe(true);
      expect(result.duration).toBeGreaterThanOrEqual(20);

      const logs = await auditStore.query({ action: 'audit_duration_test' });
      expect(logs[0].duration).toBeGreaterThanOrEqual(20);
    });
  });

  describe('Permission matrix verification', () => {
    const testCases = [
      // (actor, action, resource, shouldSucceed)
      ['developer', 'read', '/recipes', true],
      ['developer', 'create', '/recipes', true],
      ['developer', 'delete', '/candidates', true],
      ['external_agent', 'read', '/recipes', true],
      ['external_agent', 'create', '/candidates', true], // external_agent 有 create:candidates 权限
      ['external_agent', 'create', '/recipes', false],
      ['external_agent', 'delete', '/candidates', false],
      ['chat_agent', 'read', '/candidates', true],
      ['chat_agent', 'create', '/recipes', false],
    ];

    testCases.forEach(([actor, action, resource, shouldSucceed]) => {
      test(`${actor} should ${shouldSucceed ? 'be able' : 'NOT be able'} to ${action} ${resource}`, async () => {
        const { gateway } = components;
        
        // 创建唯一的 action 名称，包含 resource 以避免重复注册
        const resourceKey = resource.replace(/\//g, '_').substring(1);
        const actionName = `perm_${actor}_${action}_${resourceKey}`;

        gateway.register(actionName, async () => {
          return { success: true };
        });

        const result = await gateway.execute({
          actor,
          action: actionName,
          resource,
          data: {
            code: 'test code',
            confirmed: true,
            reasoning: {
              whyStandard: 'test',
              sources: ['test'],
              qualitySignals: {},
              alternatives: [],
              confidence: 0.8,
            },
          },
        });

        if (shouldSucceed) {
          expect(result.success).toBe(true);
        } else {
          expect(result.success).toBe(false);
          // 可能是权限错误 (403) 或宪法错误 (400)
          expect([400, 403]).toContain(result.error.statusCode);
        }
      });
    });
  });

  describe('Constitution rule verification', () => {
    test('should require confirmation for delete', async () => {
      const { gateway } = components;

      gateway.register('const_delete', async () => {
        return { deleted: true };
      });

      const result = await gateway.execute({
        actor: 'developer',
        action: 'const_delete',
        resource: '/candidates/123',
        data: {},
      });

      expect(result.success).toBe(false);
      expect(result.error.message).toContain('Constitution');
    });

    test('should allow delete with confirmation', async () => {
      const { gateway } = components;

      gateway.register('const_delete_confirmed', async () => {
        return { deleted: true };
      });

      const result = await gateway.execute({
        actor: 'developer',
        action: 'const_delete_confirmed',
        resource: '/candidates/123',
        data: { confirmed: true },
      });

      expect(result.success).toBe(true);
    });
  });

  describe('Error recovery', () => {
    test('should continue operation after handler error', async () => {
      const { gateway } = components;

      // 第一个操作失败
      gateway.register('error_action', async () => {
        throw new Error('Handler crashed');
      });

      const result1 = await gateway.execute({
        actor: 'developer',
        action: 'error_action',
        resource: '/test',
      });

      expect(result1.success).toBe(false);

      // 第二个操作应该成功
      gateway.register('success_action', async () => {
        return { ok: true };
      });

      const result2 = await gateway.execute({
        actor: 'developer',
        action: 'success_action',
        resource: '/test',
      });

      expect(result2.success).toBe(true);
    });
  });
});
