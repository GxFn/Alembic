import { jest } from '@jest/globals';
import { KnowledgeService } from '../../lib/service/knowledge/KnowledgeService.js';
import { ConfidenceRouter } from '../../lib/service/knowledge/ConfidenceRouter.js';
import { KnowledgeEntry } from '../../lib/domain/knowledge/KnowledgeEntry.js';
import { Lifecycle } from '../../lib/domain/knowledge/Lifecycle.js';

/* ════════════════════════════════════════════
 *  Mock 工厂
 * ════════════════════════════════════════════ */

function makeEntry(overrides = {}) {
  return new KnowledgeEntry({
    id: 'test-id-001',
    title: 'Test Pattern',
    trigger: '@test',
    description: 'A test knowledge entry',
    language: 'objc',
    category: 'View',
    knowledgeType: 'code-pattern',
    kind: 'pattern',
    content: { pattern: 'let x = 1;', rationale: 'idiomatic' },
    reasoning: { whyStandard: 'because', confidence: 0.9, sources: ['doc'] },
    tags: ['test'],
    lifecycle: Lifecycle.PENDING,
    ...overrides,
  });
}

function makeWireData(overrides = {}) {
  return {
    title: 'Test Pattern',
    trigger: '@test',
    description: 'A test knowledge entry',
    language: 'objc',
    category: 'View',
    knowledgeType: 'code-pattern',
    content: { pattern: 'let x = 1;', rationale: 'idiomatic' },
    reasoning: { whyStandard: 'because', confidence: 0.9, sources: ['doc'] },
    tags: ['test'],
    ...overrides,
  };
}

function mockRepository() {
  let _store = new Map();
  return {
    create: jest.fn(async (entry) => {
      _store.set(entry.id, entry);
      return entry;
    }),
    findById: jest.fn(async (id) => {
      return _store.get(id) || null;
    }),
    findWithPagination: jest.fn(async (filters, opts) => ({
      data: [..._store.values()],
      pagination: { page: opts?.page || 1, pageSize: opts?.pageSize || 20, total: _store.size },
    })),
    findByKind: jest.fn(async (kind, opts) => ({
      data: [..._store.values()].filter(e => e.kind === kind),
      pagination: { page: 1, pageSize: 20, total: 0 },
    })),
    search: jest.fn(async (keyword, opts) => ({
      data: [..._store.values()].filter(e => e.title.includes(keyword)),
      pagination: { page: 1, pageSize: 20, total: 0 },
    })),
    update: jest.fn(async (id, updates) => {
      const entry = _store.get(id);
      if (!entry) return null;
      // 模拟 DB 更新后重新加载
      if (updates.lifecycle) entry.lifecycle = updates.lifecycle;
      if (updates.reviewed_by) entry.reviewedBy = updates.reviewed_by;
      if (updates.reviewedBy) entry.reviewedBy = updates.reviewedBy;
      if (updates.reviewed_at) entry.reviewedAt = updates.reviewed_at;
      if (updates.reviewedAt) entry.reviewedAt = updates.reviewedAt;
      if (updates.rejection_reason !== undefined) entry.rejectionReason = updates.rejection_reason;
      if (updates.rejectionReason !== undefined) entry.rejectionReason = updates.rejectionReason;
      if (updates.published_at) entry.publishedAt = updates.published_at;
      if (updates.publishedAt) entry.publishedAt = updates.publishedAt;
      if (updates.published_by) entry.publishedBy = updates.published_by;
      if (updates.publishedBy) entry.publishedBy = updates.publishedBy;
      if (updates.probation !== undefined) entry.probation = !!updates.probation;
      if (updates.lifecycle_history_json) {
        entry.lifecycleHistory = JSON.parse(updates.lifecycle_history_json);
      }
      if (updates.lifecycleHistory) {
        const lh = typeof updates.lifecycleHistory === 'string' ? JSON.parse(updates.lifecycleHistory) : updates.lifecycleHistory;
        entry.lifecycleHistory = lh;
      }
      entry.updatedAt = updates.updated_at || updates.updatedAt || entry.updatedAt;
      return entry;
    }),
    delete: jest.fn(async (id) => {
      return _store.delete(id);
    }),
    getStats: jest.fn(async () => ({
      total: _store.size,
      byLifecycle: {},
      byKind: {},
    })),
    _store,
    _seed(entry) {
      _store.set(entry.id, entry);
    },
  };
}

function mockAuditLogger() {
  return {
    log: jest.fn(async () => {}),
  };
}

function mockGateway() {
  return {};
}

function mockGraphService() {
  return {
    db: {
      prepare: jest.fn(() => ({
        run: jest.fn(),
      })),
    },
    addEdge: jest.fn(),
  };
}

function mockFileWriter() {
  return {
    persist: jest.fn(),
    remove: jest.fn(),
    moveOnLifecycleChange: jest.fn(),
  };
}

function mockSkillHooks() {
  return {
    run: jest.fn(async () => null),
  };
}

function createService(overrides = {}) {
  const repo = overrides.repository || mockRepository();
  const audit = overrides.auditLogger || mockAuditLogger();
  const gateway = overrides.gateway || mockGateway();
  const graph = overrides.graphService || mockGraphService();
  const fileWriter = overrides.fileWriter || mockFileWriter();
  const skillHooks = overrides.skillHooks || mockSkillHooks();
  const confidenceRouter = overrides.confidenceRouter || null;
  const qualityScorer = overrides.qualityScorer || null;

  const service = new KnowledgeService(repo, audit, gateway, graph, {
    fileWriter,
    skillHooks,
    confidenceRouter,
    qualityScorer,
  });

  return { service, repo, audit, gateway, graph, fileWriter, skillHooks };
}

/* ════════════════════════════════════════════
 *  KnowledgeService 测试
 * ════════════════════════════════════════════ */

describe('KnowledgeService', () => {
  /* ─── create ─── */

  describe('create()', () => {
    test('创建条目 — 无 ConfidenceRouter 时默认进入 pending', async () => {
      const { service, repo, fileWriter, audit } = createService();

      const result = await service.create(makeWireData(), { userId: 'user1' });

      expect(result).toBeInstanceOf(KnowledgeEntry);
      expect(result.lifecycle).toBe(Lifecycle.PENDING);
      expect(result.title).toBe('Test Pattern');
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(fileWriter.persist).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalled();
    });

    test('创建条目 — ConfidenceRouter auto_approve 时标记 autoApprovable', async () => {
      const router = { route: jest.fn(async () => ({ action: 'auto_approve', reason: 'high confidence' })) };
      const { service } = createService({ confidenceRouter: router });

      const result = await service.create(makeWireData(), { userId: 'user1' });

      expect(result.lifecycle).toBe(Lifecycle.PENDING);
      expect(result.autoApprovable).toBe(true);
      expect(router.route).toHaveBeenCalledTimes(1);
    });

    test('创建条目 — ConfidenceRouter reject 时保持 pending 等待人工审核', async () => {
      const router = { route: jest.fn(async () => ({ action: 'reject', reason: 'too low' })) };
      const { service } = createService({ confidenceRouter: router });

      const result = await service.create(makeWireData(), { userId: 'user1' });

      expect(result.lifecycle).toBe(Lifecycle.PENDING);
    });

    test('创建条目 — ConfidenceRouter pending 时进入人工审核', async () => {
      const router = { route: jest.fn(async () => ({ action: 'pending', reason: 'need review' })) };
      const { service } = createService({ confidenceRouter: router });

      const result = await service.create(makeWireData(), { userId: 'user1' });

      expect(result.lifecycle).toBe(Lifecycle.PENDING);
    });

    test('创建条目 — 缺少 title 抛出 ValidationError', async () => {
      const { service } = createService();

      await expect(
        service.create({ ...makeWireData(), title: '' }, { userId: 'user1' })
      ).rejects.toThrow('Title is required');
    });

    test('创建条目 — 缺少 content 抛出 ValidationError', async () => {
      const { service } = createService();

      await expect(
        service.create({ ...makeWireData(), content: {} }, { userId: 'user1' })
      ).rejects.toThrow('Content is required');
    });

    test('创建条目 — SkillHooks block 时抛出 ValidationError', async () => {
      const hooks = { run: jest.fn(async () => ({ block: true, reason: 'forbidden' })) };
      const { service } = createService({ skillHooks: hooks });

      await expect(
        service.create(makeWireData(), { userId: 'user1' })
      ).rejects.toThrow('SkillHook blocked: forbidden');
    });

    test('创建条目 — 同步 relations 到 graph', async () => {
      const graph = mockGraphService();
      const { service } = createService({ graphService: graph });

      await service.create(makeWireData({
        relations: { extends: [{ target: 'other-id', description: 'base' }] },
      }), { userId: 'user1' });

      expect(graph.addEdge).toHaveBeenCalledTimes(1);
    });
  });

  /* ─── get ─── */

  describe('get()', () => {
    test('获取存在的条目', async () => {
      const { service, repo } = createService();
      const entry = makeEntry();
      repo._seed(entry);

      const result = await service.get('test-id-001');
      expect(result.id).toBe('test-id-001');
    });

    test('获取不存在的条目抛出 NotFoundError', async () => {
      const { service } = createService();

      await expect(service.get('nonexistent')).rejects.toThrow('Knowledge entry not found');
    });
  });

  /* ─── update ─── */

  describe('update()', () => {
    test('更新白名单字段', async () => {
      const { service, repo, fileWriter } = createService();
      repo._seed(makeEntry());

      const result = await service.update('test-id-001', {
        title: 'Updated Title',
        tags: ['new-tag'],
      }, { userId: 'user1' });

      expect(repo.update).toHaveBeenCalled();
      expect(fileWriter.persist).toHaveBeenCalled();
    });

    test('更新 knowledgeType 联动更新 kind', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry());

      await service.update('test-id-001', {
        knowledgeType: 'boundary-constraint',
      }, { userId: 'user1' });

      const updateCall = repo.update.mock.calls[0][1];
      expect(updateCall.knowledgeType).toBe('boundary-constraint');
      expect(updateCall.kind).toBe('rule');
    });

    test('无可更新字段抛出 ValidationError', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry());

      await expect(
        service.update('test-id-001', { nonexistent: 'value' }, { userId: 'user1' })
      ).rejects.toThrow('No updatable fields');
    });

    test('更新不存在的条目抛出 NotFoundError', async () => {
      const { service } = createService();

      await expect(
        service.update('nonexistent', { title: 'x' }, { userId: 'user1' })
      ).rejects.toThrow('Knowledge entry not found');
    });
  });

  /* ─── delete ─── */

  describe('delete()', () => {
    test('删除条目 + 文件 + edges', async () => {
      const graph = mockGraphService();
      const { service, repo, fileWriter } = createService({ graphService: graph });
      repo._seed(makeEntry());

      const result = await service.delete('test-id-001', { userId: 'user1' });

      expect(result.success).toBe(true);
      expect(fileWriter.remove).toHaveBeenCalledTimes(1);
      expect(repo.delete).toHaveBeenCalledWith('test-id-001');
      expect(graph.db.prepare).toHaveBeenCalled();
    });

    test('删除不存在的条目抛出 NotFoundError', async () => {
      const { service } = createService();

      await expect(
        service.delete('nonexistent', { userId: 'user1' })
      ).rejects.toThrow('Knowledge entry not found');
    });
  });

  /* ─── 生命周期操作 ─── */

  describe('lifecycle transitions', () => {
    test('submit: pending → pending (no-op, returns entry)', async () => {
      const { service, repo, fileWriter } = createService();
      repo._seed(makeEntry({ lifecycle: Lifecycle.PENDING }));

      const result = await service.submit('test-id-001', { userId: 'user1' });

      expect(result.lifecycle).toBe(Lifecycle.PENDING);
    });

    test('approve: pending → active (alias for publish)', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry({ lifecycle: Lifecycle.PENDING }));

      const result = await service.approve('test-id-001', { userId: 'reviewer1' });

      expect(result.lifecycle).toBe(Lifecycle.ACTIVE);
    });

    test('autoApprove: pending → pending (no-op)', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry({ lifecycle: Lifecycle.PENDING }));

      const result = await service.autoApprove('test-id-001', { userId: 'system' });

      expect(result.lifecycle).toBe(Lifecycle.PENDING);
    });

    test('reject: pending → deprecated (需要 reason)', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry({ lifecycle: Lifecycle.PENDING }));

      const result = await service.reject('test-id-001', 'Invalid pattern', { userId: 'reviewer1' });

      expect(result.lifecycle).toBe(Lifecycle.DEPRECATED);
      expect(result.rejectionReason).toBe('Invalid pattern');
    });

    test('reject: 空 reason 抛出 ValidationError', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry({ lifecycle: Lifecycle.PENDING }));

      await expect(
        service.reject('test-id-001', '', { userId: 'reviewer1' })
      ).rejects.toThrow('Deprecation reason is required');
    });

    test('publish: pending → active', async () => {
      const { service, repo } = createService();
      const entry = makeEntry({ lifecycle: Lifecycle.PENDING });
      repo._seed(entry);

      const result = await service.publish('test-id-001', { userId: 'publisher1' });

      expect(result.lifecycle).toBe(Lifecycle.ACTIVE);
      expect(result.publishedBy).toBe('publisher1');
    });

    test('deprecate: active → deprecated (需要 reason)', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry({ lifecycle: Lifecycle.ACTIVE }));

      const result = await service.deprecate('test-id-001', 'Outdated', { userId: 'user1' });

      expect(result.lifecycle).toBe(Lifecycle.DEPRECATED);
    });

    test('deprecate: 空 reason 抛出 ValidationError', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry({ lifecycle: Lifecycle.ACTIVE }));

      await expect(
        service.deprecate('test-id-001', '', { userId: 'user1' })
      ).rejects.toThrow('Deprecation reason is required');
    });

    test('reactivate: deprecated → pending', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry({ lifecycle: Lifecycle.DEPRECATED }));

      const result = await service.reactivate('test-id-001', { userId: 'user1' });

      expect(result.lifecycle).toBe(Lifecycle.PENDING);
    });

    test('toDraft: deprecated → pending (alias for reactivate)', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry({ lifecycle: Lifecycle.DEPRECATED }));

      const result = await service.toDraft('test-id-001', { userId: 'user1' });

      expect(result.lifecycle).toBe(Lifecycle.PENDING);
    });

    test('fastTrack: pending → active (alias for publish)', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry({ lifecycle: Lifecycle.PENDING }));

      const result = await service.fastTrack('test-id-001', { userId: 'auto' });

      expect(result.lifecycle).toBe(Lifecycle.ACTIVE);
    });

    test('非法状态转换抛出 ConflictError', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry({ lifecycle: Lifecycle.ACTIVE }));

      await expect(
        service.reactivate('test-id-001', { userId: 'user1' })
      ).rejects.toThrow();
    });
  });

  /* ─── 查询 ─── */

  describe('query operations', () => {
    test('list 返回分页结果', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry());

      const result = await service.list({}, { page: 1, pageSize: 10 });

      expect(result.data).toHaveLength(1);
      expect(repo.findWithPagination).toHaveBeenCalled();
    });

    test('list 传递 filters', async () => {
      const { service, repo } = createService();

      await service.list({ lifecycle: 'active', kind: 'rule', language: 'objc' });

      const [filters] = repo.findWithPagination.mock.calls[0];
      expect(filters.lifecycle).toBe('active');
      expect(filters.kind).toBe('rule');
      expect(filters.language).toBe('objc');
    });

    test('search 返回搜索结果', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry());

      const result = await service.search('Test');

      expect(result.data).toHaveLength(1);
      expect(repo.search).toHaveBeenCalledWith('Test', { page: 1, pageSize: 20 });
    });

    test('getStats 返回统计', async () => {
      const { service, repo } = createService();

      const result = await service.getStats();

      expect(repo.getStats).toHaveBeenCalled();
      expect(result).toHaveProperty('total');
    });
  });

  /* ─── 使用/质量 ─── */

  describe('incrementUsage', () => {
    test('增加 adoption 计数', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry());

      const result = await service.incrementUsage('test-id-001', 'adoption');

      expect(repo.update).toHaveBeenCalled();
      const [, updates] = repo.update.mock.calls[0];
      expect(updates.stats).toBeDefined();
    });
  });

  describe('updateQuality', () => {
    test('无 QualityScorer 时抛出 ValidationError', async () => {
      const { service, repo } = createService();
      repo._seed(makeEntry());

      await expect(
        service.updateQuality('test-id-001')
      ).rejects.toThrow('QualityScorer not configured');
    });

    test('有 QualityScorer 时计算并更新', async () => {
      const scorer = {
        score: jest.fn(() => ({
          score: 0.85,
          grade: 'B',
          dimensions: { completeness: 0.9, format: 0.8, codeQuality: 0.7, metadata: 0.6, engagement: 0 },
        })),
      };
      const { service, repo } = createService({ qualityScorer: scorer });
      repo._seed(makeEntry());

      const result = await service.updateQuality('test-id-001', { userId: 'user1' });

      expect(scorer.score).toHaveBeenCalledTimes(1);
      expect(result.score).toBe(0.85);
      expect(result.grade).toBe('B');
      expect(repo.update).toHaveBeenCalled();
    });
  });
});

/* ════════════════════════════════════════════
 *  ConfidenceRouter 测试
 * ════════════════════════════════════════════ */

describe('ConfidenceRouter', () => {
  test('高置信度 → auto_approve', async () => {
    const router = new ConfidenceRouter();
    const entry = makeEntry({
      content: { pattern: 'code pattern here for testing', rationale: 'good reason' },
      reasoning: { whyStandard: 'standard', confidence: 0.95, sources: ['doc'] },
    });

    const result = await router.route(entry);

    expect(result.action).toBe('auto_approve');
    expect(result.confidence).toBe(0.95);
  });

  test('低置信度 → reject', async () => {
    const router = new ConfidenceRouter({ rejectThreshold: 0.2 });
    const entry = makeEntry({
      content: { pattern: 'code pattern here for testing', rationale: 'reason' },
      reasoning: { whyStandard: 'standard', confidence: 0.1, sources: ['doc'] },
    });

    const result = await router.route(entry);

    expect(result.action).toBe('reject');
    expect(result.confidence).toBe(0.1);
  });

  test('中等置信度 → pending', async () => {
    const router = new ConfidenceRouter();
    const entry = makeEntry({
      content: { pattern: 'code pattern here for testing', rationale: 'reason' },
      reasoning: { whyStandard: 'standard', confidence: 0.6, sources: ['doc'] },
    });

    const result = await router.route(entry);

    expect(result.action).toBe('pending');
  });

  test('置信度 = 0 且无 reasoning → pending (不 reject)', async () => {
    const router = new ConfidenceRouter();
    const entry = makeEntry({
      content: { pattern: 'code goes here in the pattern', rationale: 'reason' },
      reasoning: { confidence: 0 },
    });

    const result = await router.route(entry);

    expect(result.action).toBe('pending');
  });

  test('可信来源使用更低阈值', async () => {
    const router = new ConfidenceRouter({
      autoApproveThreshold: 0.85,
      trustedAutoApproveThreshold: 0.7,
      trustedSources: ['bootstrap'],
    });
    const entry = makeEntry({
      source: 'bootstrap',
      content: { pattern: 'code pattern here for testing', rationale: 'reason' },
      reasoning: { whyStandard: 'standard', confidence: 0.75, sources: ['doc'] },
    });

    const result = await router.route(entry);

    expect(result.action).toBe('auto_approve');
  });

  test('内容不完整 → pending', async () => {
    const router = new ConfidenceRouter();
    const entry = makeEntry({
      title: '',  // 不完整
      content: { pattern: '', rationale: '' },
    });

    const result = await router.route(entry);

    expect(result.action).toBe('pending');
    expect(result.reason).toContain('incomplete');
  });

  test('内容过短 → pending', async () => {
    const router = new ConfidenceRouter({ minContentLength: 50 });
    const entry = makeEntry({
      content: { pattern: 'x', rationale: '' },
      reasoning: { whyStandard: 'standard', confidence: 0.95, sources: ['doc'] },
    });

    const result = await router.route(entry);

    expect(result.action).toBe('pending');
    expect(result.reason).toContain('too short');
  });

  test('有 QualityScorer 且质量过低 → 降级为 pending', async () => {
    const scorer = {
      score: jest.fn(() => ({ score: 0.1, grade: 'F', dimensions: {} })),
    };
    const router = new ConfidenceRouter({}, scorer);
    const entry = makeEntry({
      content: { pattern: 'code pattern here for testing', rationale: 'reason' },
      reasoning: { whyStandard: 'standard', confidence: 0.95, sources: ['doc'] },
    });

    const result = await router.route(entry);

    expect(result.action).toBe('pending');
    expect(result.reason).toContain('quality low');
  });

  test('有 QualityScorer 且质量 OK → auto_approve', async () => {
    const scorer = {
      score: jest.fn(() => ({ score: 0.8, grade: 'B', dimensions: {} })),
    };
    const router = new ConfidenceRouter({}, scorer);
    const entry = makeEntry({
      content: { pattern: 'code pattern here for testing', rationale: 'reason' },
      reasoning: { whyStandard: 'standard', confidence: 0.95, sources: ['doc'] },
    });

    const result = await router.route(entry);

    expect(result.action).toBe('auto_approve');
  });

  test('默认配置值', () => {
    const router = new ConfidenceRouter();
    expect(router._config.autoApproveThreshold).toBe(0.85);
    expect(router._config.rejectThreshold).toBe(0.2);
    expect(router._config.minContentLength).toBe(20);
  });

  test('自定义配置覆盖', () => {
    const router = new ConfidenceRouter({ autoApproveThreshold: 0.5, minContentLength: 100 });
    expect(router._config.autoApproveThreshold).toBe(0.5);
    expect(router._config.minContentLength).toBe(100);
    // 未覆盖的字段保持默认
    expect(router._config.rejectThreshold).toBe(0.2);
  });
});
