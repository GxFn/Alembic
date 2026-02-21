/**
 * Integration: KnowledgeService CRUD + Lifecycle
 *
 * 使用真实 Bootstrap（内存 SQLite）+ KnowledgeRepositoryImpl，
 * 测试知识条目的完整生命周期：
 *   创建 → 查询 → 更新 → 发布 → 弃用 → 重新激活 → 删除
 */

import { KnowledgeEntry } from '../../lib/domain/knowledge/KnowledgeEntry.js';
import { Lifecycle } from '../../lib/domain/knowledge/Lifecycle.js';
import { KnowledgeRepositoryImpl } from '../../lib/repository/knowledge/KnowledgeRepository.impl.js';
import { KnowledgeService } from '../../lib/service/knowledge/KnowledgeService.js';
import { createTestBootstrap } from '../fixtures/factory.js';

describe('Integration: KnowledgeService CRUD + Lifecycle', () => {
  let bootstrap, components, db, repo, service;

  /** 创建 wire format 测试数据 */
  function makeWireData(overrides = {}) {
    return {
      title: 'URLSession 网络请求指南',
      description: '使用 URLSession 进行 HTTP 请求的最佳实践',
      trigger: 'urlsession',
      language: 'swift',
      category: 'networking',
      knowledgeType: 'best-practice',
      content: {
        pattern: 'let task = URLSession.shared.dataTask(with: url) { data, response, error in }',
        rationale: '使用 Foundation 原生网络 API，无需第三方库依赖',
      },
      tags: ['networking', 'swift', 'ios'],
      ...overrides,
    };
  }

  const ctx = { userId: 'developer' };

  beforeAll(async () => {
    ({ bootstrap, components } = await createTestBootstrap());
    db = components.db;
    repo = new KnowledgeRepositoryImpl(db);
    service = new KnowledgeService(
      repo,
      components.auditLogger,
      components.gateway,
      null, // knowledgeGraphService — 不需要
      {
        fileWriter: null, // 禁用 .md 落盘
        skillHooks: null, // 禁用 SkillHooks
        confidenceRouter: null, // 禁用 AI 路由
        qualityScorer: null, // 禁用质量评分
      }
    );
  });

  afterAll(async () => {
    await bootstrap.shutdown();
  });

  // ── 创建 ──────────────────────────────────────────────

  describe('create', () => {
    it('应创建知识条目并返回 KnowledgeEntry', async () => {
      const entry = await service.create(makeWireData(), ctx);
      expect(entry).toBeInstanceOf(KnowledgeEntry);
      expect(entry.id).toBeDefined();
      expect(entry.title).toBe('URLSession 网络请求指南');
      expect(entry.lifecycle).toBe(Lifecycle.PENDING);
      expect(entry.language).toBe('swift');
    });

    it('创建后可通过 get 获取', async () => {
      const created = await service.create(makeWireData({ trigger: 'get-test' }), ctx);
      const fetched = await service.get(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.title).toBe(created.title);
    });

    it('缺少 title 应抛出 ValidationError', async () => {
      await expect(service.create({ ...makeWireData(), title: '' }, ctx)).rejects.toThrow(/Title/i);
    });

    it('缺少 content 应抛出 ValidationError', async () => {
      await expect(service.create({ ...makeWireData(), content: {} }, ctx)).rejects.toThrow(
        /Content/i
      );
    });

    it('source 默认为 manual', async () => {
      const entry = await service.create(makeWireData(), ctx);
      expect(entry.source).toBe('manual');
    });

    it('自定义 source 被保留', async () => {
      const entry = await service.create(makeWireData({ source: 'ai-scan' }), ctx);
      expect(entry.source).toBe('ai-scan');
    });
  });

  // ── 查询 ──────────────────────────────────────────────

  describe('list / search / stats', () => {
    let _entryIds;

    beforeAll(async () => {
      // 清理之前的数据
      const rawDb = db.getDb();
      rawDb.prepare('DELETE FROM knowledge_entries').run();

      // 插入多条数据
      const entries = await Promise.all([
        service.create(
          makeWireData({ title: 'URLSession 基础', language: 'swift', category: 'networking' }),
          ctx
        ),
        service.create(
          makeWireData({ title: 'Alamofire 封装', language: 'swift', category: 'networking' }),
          ctx
        ),
        service.create(
          makeWireData({ title: 'UITableView 代理', language: 'swift', category: 'ui' }),
          ctx
        ),
        service.create(
          makeWireData({
            title: 'dispatch_sync 检查',
            language: 'objc',
            category: 'threading',
            knowledgeType: 'boundary-constraint',
          }),
          ctx
        ),
      ]);
      _entryIds = entries.map((e) => e.id);
    });

    it('list 无过滤条件应返回全部', async () => {
      const result = await service.list();
      expect(result.data.length).toBe(4);
    });

    it('list 按语言过滤', async () => {
      const result = await service.list({ language: 'objc' });
      expect(result.data.length).toBe(1);
      expect(result.data[0].language).toBe('objc');
    });

    it('list 按 category 过滤', async () => {
      const result = await service.list({ category: 'networking' });
      expect(result.data.length).toBe(2);
    });

    it('list 分页', async () => {
      const page1 = await service.list({}, { page: 1, pageSize: 2 });
      expect(page1.data.length).toBe(2);
      expect(page1.pagination.page).toBe(1);
      expect(page1.pagination.total).toBe(4);
    });

    it('search 关键词搜索', async () => {
      const result = await service.search('URLSession');
      expect(result.data.length).toBeGreaterThanOrEqual(1);
      const titles = result.data.map((e) => e.title);
      expect(titles.some((t) => t.includes('URLSession'))).toBe(true);
    });

    it('getStats 返回统计信息', async () => {
      const stats = await service.getStats();
      expect(stats).toHaveProperty('total');
      expect(stats.total).toBe(4);
    });
  });

  // ── 更新 ──────────────────────────────────────────────

  describe('update', () => {
    let entryId;

    beforeAll(async () => {
      const entry = await service.create(makeWireData({ trigger: 'update-test' }), ctx);
      entryId = entry.id;
    });

    it('更新标量字段', async () => {
      const updated = await service.update(
        entryId,
        {
          title: '更新后的标题',
          description: '更新后的描述',
        },
        ctx
      );
      expect(updated.title).toBe('更新后的标题');
      expect(updated.description).toBe('更新后的描述');
    });

    it('更新 tags（JSON 数组）', async () => {
      const updated = await service.update(
        entryId,
        {
          tags: ['new-tag', 'updated'],
        },
        ctx
      );
      expect(updated.tags).toContain('new-tag');
      expect(updated.tags).toContain('updated');
    });

    it('更新 content（值对象）', async () => {
      const updated = await service.update(
        entryId,
        {
          content: { pattern: 'new pattern', rationale: 'new rationale' },
        },
        ctx
      );
      expect(updated.content).toBeDefined();
    });

    it('无可更新字段应抛出 ValidationError', async () => {
      await expect(service.update(entryId, { nonExistentField: 'value' }, ctx)).rejects.toThrow(
        /No updatable fields/i
      );
    });

    it('更新不存在的 ID 应抛出 NotFoundError', async () => {
      await expect(service.update('non-existent-id', { title: 'new' }, ctx)).rejects.toThrow();
    });
  });

  // ── 生命周期 ──────────────────────────────────────────

  describe('Lifecycle: pending → active → deprecated → pending', () => {
    let entryId;

    beforeAll(async () => {
      const entry = await service.create(makeWireData({ trigger: 'lifecycle-test' }), ctx);
      entryId = entry.id;
    });

    it('新条目处于 pending 状态', async () => {
      const entry = await service.get(entryId);
      expect(entry.lifecycle).toBe(Lifecycle.PENDING);
    });

    it('publish: pending → active', async () => {
      const entry = await service.publish(entryId, ctx);
      expect(entry.lifecycle).toBe(Lifecycle.ACTIVE);
    });

    it('重复 publish 应失败', async () => {
      await expect(service.publish(entryId, ctx)).rejects.toThrow();
    });

    it('deprecate: active → deprecated', async () => {
      const entry = await service.deprecate(entryId, '过时的做法', ctx);
      expect(entry.lifecycle).toBe(Lifecycle.DEPRECATED);
    });

    it('deprecate 无 reason 应抛出 ValidationError', async () => {
      // 先创建一个新的 active 条目
      const newEntry = await service.create(makeWireData({ trigger: 'no-reason' }), ctx);
      await service.publish(newEntry.id, ctx);
      await expect(service.deprecate(newEntry.id, '', ctx)).rejects.toThrow(/reason/i);
    });

    it('reactivate: deprecated → pending', async () => {
      const entry = await service.reactivate(entryId, ctx);
      expect(entry.lifecycle).toBe(Lifecycle.PENDING);
    });
  });

  // ── 删除 ──────────────────────────────────────────────

  describe('delete', () => {
    it('应成功删除条目', async () => {
      const entry = await service.create(makeWireData({ trigger: 'delete-test' }), ctx);
      const result = await service.delete(entry.id, ctx);
      expect(result.success).toBe(true);
      expect(result.id).toBe(entry.id);
    });

    it('删除后 get 应抛出 NotFoundError', async () => {
      const entry = await service.create(makeWireData({ trigger: 'delete-then-get' }), ctx);
      await service.delete(entry.id, ctx);
      await expect(service.get(entry.id)).rejects.toThrow();
    });

    it('删除不存在的 ID 应抛出 NotFoundError', async () => {
      await expect(service.delete('non-existent-id', ctx)).rejects.toThrow();
    });
  });

  // ── 使用计数 ──────────────────────────────────────────

  describe('incrementUsage', () => {
    it('应增加 adoption 使用计数', async () => {
      const entry = await service.create(makeWireData({ trigger: 'usage-test' }), ctx);
      const updated = await service.incrementUsage(entry.id, 'adoption');
      expect(updated).toBeDefined();
    });

    it('不存在的 ID 应抛出错误', async () => {
      await expect(service.incrementUsage('non-existent-id', 'adoption')).rejects.toThrow();
    });
  });

  // ── 向后兼容别名 ──────────────────────────────────────

  describe('向后兼容', () => {
    it('approve = publish', async () => {
      const entry = await service.create(makeWireData({ trigger: 'approve-alias' }), ctx);
      const result = await service.approve(entry.id, ctx);
      // approve 现在等同于 publish
      expect(result.lifecycle).toBe(Lifecycle.ACTIVE);
    });

    it('reject = deprecate', async () => {
      const entry = await service.create(makeWireData({ trigger: 'reject-alias' }), ctx);
      await service.publish(entry.id, ctx);
      const result = await service.reject(entry.id, '不符合标准', ctx);
      expect(result.lifecycle).toBe(Lifecycle.DEPRECATED);
    });
  });

  // ── 批量操作 ──────────────────────────────────────────

  describe('批量创建和查询', () => {
    it('应支持创建多条并按 kind 查询', async () => {
      const rawDb = db.getDb();
      rawDb.prepare('DELETE FROM knowledge_entries').run();

      await service.create(
        makeWireData({
          title: '代码模式 1',
          knowledgeType: 'code-pattern',
        }),
        ctx
      );
      await service.create(
        makeWireData({
          title: '约束规则 1',
          knowledgeType: 'boundary-constraint',
        }),
        ctx
      );
      await service.create(
        makeWireData({
          title: '代码模式 2',
          knowledgeType: 'architecture',
        }),
        ctx
      );

      const patterns = await service.listByKind('pattern');
      const rules = await service.listByKind('rule');

      expect(patterns.data.length).toBeGreaterThanOrEqual(2);
      expect(rules.data.length).toBeGreaterThanOrEqual(1);
    });
  });
});
