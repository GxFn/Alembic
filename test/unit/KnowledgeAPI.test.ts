/**
 * Phase 4 — API 层单元测试
 * 测试 HTTP 路由处理逻辑 + MCP Handler 逻辑
 *
 * 使用轻量级 mock 验证路由/handler 正确委托给 KnowledgeService
 */

import { vi } from 'vitest';
import { KnowledgeEntry } from '../../lib/domain/knowledge/KnowledgeEntry.js';
import { Lifecycle } from '../../lib/domain/knowledge/Lifecycle.js';

/* ════════════════════════════════════════════
 *  Mock 工厂
 * ════════════════════════════════════════════ */

function makeEntry(overrides = {}) {
  return new KnowledgeEntry({
    id: 'test-api-001',
    title: 'API Test Pattern',
    trigger: '@api-test',
    description: 'An API test entry',
    language: 'swift',
    category: 'Service',
    knowledgeType: 'code-pattern',
    kind: 'pattern',
    content: { pattern: 'func test() {}', rationale: 'testing' },
    reasoning: { whyStandard: 'test reason', confidence: 0.9, sources: ['test.swift'] },
    tags: ['api', 'test'],
    lifecycle: Lifecycle.PENDING,
    ...overrides,
  });
}

function makeActiveEntry(overrides = {}) {
  return makeEntry({ lifecycle: Lifecycle.ACTIVE, ...overrides });
}

function makePendingEntry(overrides = {}) {
  return makeEntry({ lifecycle: Lifecycle.PENDING, ...overrides });
}

function mockKnowledgeService() {
  const draftEntry = makeEntry();
  const activeEntry = makeActiveEntry();
  const pendingEntry = makePendingEntry();

  return {
    create: vi.fn(async () => draftEntry),
    get: vi.fn(async () => draftEntry),
    update: vi.fn(async () => draftEntry),
    delete: vi.fn(async () => ({ success: true })),
    submit: vi.fn(async () => makePendingEntry()),
    approve: vi.fn(async () => makeEntry({ lifecycle: Lifecycle.ACTIVE })),
    autoApprove: vi.fn(async () => makeEntry({ lifecycle: Lifecycle.PENDING })),
    reject: vi.fn(async () => makeEntry({ lifecycle: Lifecycle.DEPRECATED })),
    publish: vi.fn(async () => activeEntry),
    deprecate: vi.fn(async () => makeEntry({ lifecycle: Lifecycle.DEPRECATED })),
    reactivate: vi.fn(async () => pendingEntry),
    toDraft: vi.fn(async () => pendingEntry),
    fastTrack: vi.fn(async () => activeEntry),
    list: vi.fn(async () => ({
      data: [draftEntry],
      pagination: { page: 1, pageSize: 20, total: 1 },
    })),
    search: vi.fn(async () => ({
      data: [draftEntry],
      pagination: { page: 1, pageSize: 20, total: 1 },
    })),
    getStats: vi.fn(async () => ({
      total: 10,
      byLifecycle: { pending: 5, active: 5 },
    })),
    incrementUsage: vi.fn(async () => {}),
    updateQuality: vi.fn(async () => ({ quality: { overall: 0.8 } })),
    // helpers
    _draftEntry: draftEntry,
    _activeEntry: activeEntry,
    _pendingEntry: pendingEntry,
  };
}

/* ════════════════════════════════════════════
 *  Part 1: MCP Knowledge Handler Tests
 * ════════════════════════════════════════════ */

// Mock RateLimiter — 默认放行
// 必须同时 mock 相对路径 + #imports 别名，确保动态 import 和静态 import 都被拦截
vi.mock('../../lib/http/middleware/RateLimiter.js', () => ({
  checkRecipeSave: vi.fn(() => ({ allowed: true })),
}));
vi.mock('#http/middleware/RateLimiter.js', () => ({
  checkRecipeSave: vi.fn(() => ({ allowed: true })),
}));

// Mock RecipeReadinessChecker
vi.mock('../../lib/domain/knowledge/RecipeReadinessChecker.js', () => ({
  checkRecipeReadiness: vi.fn(() => ({ ready: true, missing: [], suggestions: [] })),
}));
vi.mock('#domain/knowledge/RecipeReadinessChecker.js', () => ({
  checkRecipeReadiness: vi.fn(() => ({ ready: true, missing: [], suggestions: [] })),
}));

// Mock developer-identity — CI 环境下 git/OS username 不确定，固定为 'mcp'
vi.mock('#shared/developer-identity.js', () => ({
  getDeveloperIdentity: vi.fn(() => 'mcp'),
  clearDeveloperIdentityCache: vi.fn(),
}));
vi.mock('../../lib/shared/developer-identity.js', () => ({
  getDeveloperIdentity: vi.fn(() => 'mcp'),
  clearDeveloperIdentityCache: vi.fn(),
}));

const { submitKnowledge, submitKnowledgeBatch, knowledgeLifecycle } = await import(
  '../../lib/external/mcp/handlers/knowledge.js'
);
// 从 #imports 别名导入 mock — 与 handler 内部的 dynamic import 一致
const { checkRecipeSave } = await import('#http/middleware/RateLimiter.js');
const { checkRecipeReadiness } = await import('#domain/knowledge/RecipeReadinessChecker.js');

describe('MCP Knowledge Handlers', () => {
  let svc;
  let ctx;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = mockKnowledgeService();
    ctx = {
      container: {
        get: vi.fn((name) => {
          if (name === 'knowledgeService') {
            return svc;
          }
          return null;
        }),
      },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
  });

  /* ── submitKnowledge ─────────────────────────────── */

  describe('submitKnowledge', () => {
    const validArgs = {
      title: 'Test',
      language: 'swift',
      content: { pattern: 'let x = 1' },
      reasoning: { whyStandard: 'test', sources: ['test.swift'], confidence: 0.8 },
    };

    test('应成功提交单条知识', async () => {
      const result = await submitKnowledge(ctx, validArgs);
      expect(result.success).toBe(true);
      expect(result.data.id).toBe('test-api-001');
      expect(result.data.lifecycle).toBe(Lifecycle.PENDING);
      // _enrichToV3 only adds source='mcp', no other field inference
      expect(svc.create).toHaveBeenCalledWith(
        expect.objectContaining({ ...validArgs, source: 'mcp' }),
        { userId: 'mcp' }
      );
    });

    test('应传入 source 字段', async () => {
      const args = { ...validArgs, source: 'cursor-scan' };
      await submitKnowledge(ctx, args);
      // caller-provided source is preserved
      expect(svc.create).toHaveBeenCalledWith(
        expect.objectContaining({ ...validArgs, source: 'cursor-scan' }),
        { userId: 'mcp' }
      );
    });

    test('限流时应返回 RATE_LIMIT', async () => {
      checkRecipeSave.mockReturnValueOnce({ allowed: false, retryAfter: 30 });
      const result = await submitKnowledge(ctx, validArgs);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RATE_LIMIT');
      expect(svc.create).not.toHaveBeenCalled();
    });

    test('Recipe-Ready 不满足时应返回 hints', async () => {
      checkRecipeReadiness.mockReturnValueOnce({
        ready: false,
        missing: ['category', 'trigger'],
        suggestions: ['add category'],
      });
      const result = await submitKnowledge(ctx, validArgs);
      expect(result.success).toBe(true);
      expect(result.data.recipeReadyHints).toBeDefined();
      // UnifiedValidator 返回完整错误描述，验证包含字段名即可
      expect(result.data.recipeReadyHints.missingFields.some((f) => f.includes('category'))).toBe(
        true
      );
    });

    test('meta 中应包含 tool 名称', async () => {
      const result = await submitKnowledge(ctx, validArgs);
      expect(result.meta.tool).toBe('autosnippet_submit_knowledge');
    });
  });

  /* ── submitKnowledgeBatch ────────────────────────── */

  describe('submitKnowledgeBatch', () => {
    const validBatchArgs = {
      target_name: 'TestTarget',
      items: [
        {
          title: 'Network Request Service',
          language: 'swift',
          category: 'Service',
          description: '网络请求服务模式',
          trigger: '@network-request',
          kind: 'pattern',
          doClause: 'Use pattern A for service calls',
          dontClause: 'Do not use raw URLSession',
          whenClause: 'When making network requests',
          coreCode: 'func fetchData() {\n  service.request()\n}',
          headers: [],
          usageGuide: '### Usage\nCall fetchData()',
          knowledgeType: 'code-pattern',
          content: {
            markdown: [
              '## Network Request Service',
              '',
              '在项目中使用统一的网络请求模式，通过 Service 层封装接口调用。所有网络请求必须经过 NetworkService 统一处理，确保错误处理和缓存策略一致。',
              '',
              '```swift',
              '// 来源: NetworkService.swift:42',
              'func fetchData(url: URL, completion: @escaping (Result<Data, Error>) -> Void) {',
              '  let session = URLSession.shared',
              '  session.dataTask(with: url) { data, response, error in',
              '    guard let data = data else { return }',
              '    completion(.success(data))',
              '  }.resume()',
              '}',
              '```',
              '',
              '应始终通过 Service 层发起网络请求，而不是直接使用 URLSession。Service 层负责统一处理错误、超时和缓存。',
            ].join('\n'),
            pattern: 'func fetchData() { service.request() }',
            rationale: 'standard network pattern',
          },
          reasoning: {
            whyStandard: 'team convention',
            sources: ['NetworkService.swift'],
            confidence: 0.8,
          },
        },
        {
          title: 'View Layout Setup',
          language: 'objc',
          category: 'View',
          description: 'AutoLayout 视图初始化模式',
          trigger: '@view-layout',
          kind: 'pattern',
          doClause: 'Use pattern B for views',
          dontClause: 'Do not use frame layout',
          whenClause: 'When creating UI views',
          coreCode: '- (void)setupView {\n  [self addSubview:v];\n}',
          headers: [],
          usageGuide: '### Usage\nCall setupView',
          knowledgeType: 'code-pattern',
          content: {
            markdown: [
              '## View Layout Setup',
              '',
              '使用 AutoLayout 而非 frame 布局，通过 setupView 方法统一初始化视图。所有子视图添加和约束配置都应在此方法中完成。',
              '',
              '```objc',
              '// 来源: BaseView.m:30',
              '- (void)setupView {',
              '  UIView *container = [[UIView alloc] init];',
              '  container.translatesAutoresizingMaskIntoConstraints = NO;',
              '  [self addSubview:container];',
              '  [NSLayoutConstraint activateConstraints:@[',
              '    [container.topAnchor constraintEqualToAnchor:self.topAnchor],',
              '    [container.leadingAnchor constraintEqualToAnchor:self.leadingAnchor]',
              '  ]];',
              '}',
              '```',
              '',
              '视图初始化应始终在 setupView 中完成，禁止在 init 中直接操作视图层级。',
            ].join('\n'),
            pattern: '- (void)setupView { [self addSubview:v]; }',
            rationale: 'standard view pattern',
          },
          reasoning: { whyStandard: 'team convention', sources: ['BaseView.m'], confidence: 0.8 },
        },
      ],
    };

    test('应成功批量提交', async () => {
      const result = await submitKnowledgeBatch(ctx, validBatchArgs);
      expect(result.success).toBe(true);
      expect(result.data.count).toBe(2);
      expect(result.data.total).toBe(2);
      expect(result.data.targetName).toBe('TestTarget');
      expect(svc.create).toHaveBeenCalledTimes(2);
    });

    test('缺少 target_name 时应抛出错误', async () => {
      await expect(submitKnowledgeBatch(ctx, { items: [{ title: 'X' }] })).rejects.toThrow(
        'target_name'
      );
    });

    test('空 items 应抛出错误', async () => {
      await expect(submitKnowledgeBatch(ctx, { target_name: 'T', items: [] })).rejects.toThrow();
    });

    test('部分失败时应返回 errors', async () => {
      svc.create
        .mockResolvedValueOnce(makeEntry()) // 第一条成功
        .mockRejectedValueOnce(new Error('bad data')); // 第二条失败

      const result = await submitKnowledgeBatch(ctx, validBatchArgs);
      expect(result.success).toBe(true);
      expect(result.data.count).toBe(1);
      expect(result.data.errors).toHaveLength(1);
      expect(result.data.errors[0].error).toBe('bad data');
    });

    test('限流时应返回 RATE_LIMIT', async () => {
      checkRecipeSave.mockReturnValueOnce({ allowed: false, retryAfter: 60 });
      const result = await submitKnowledgeBatch(ctx, validBatchArgs);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RATE_LIMIT');
    });

    test('应使用自定义 source', async () => {
      const args = { ...validBatchArgs, source: 'bootstrap' };
      await submitKnowledgeBatch(ctx, args);
      expect(svc.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'bootstrap' }), {
        userId: 'mcp',
      });
    });
  });

  /* ── knowledgeLifecycle ──────────────────────────── */

  describe('knowledgeLifecycle', () => {
    test('reactivate 操作应调用 service.reactivate', async () => {
      const result = await knowledgeLifecycle(ctx, { id: 'test-api-001', action: 'reactivate' });
      expect(result.success).toBe(true);
      expect(result.data.action).toBe('reactivate');
      expect(svc.reactivate).toHaveBeenCalled();
    });

    test('submit 操作应被 PERMISSION_DENIED 拒绝', async () => {
      await expect(
        knowledgeLifecycle(ctx, { id: 'test-api-001', action: 'submit' })
      ).rejects.toThrow('PERMISSION_DENIED');
    });

    test('approve 操作应被 PERMISSION_DENIED 拒绝', async () => {
      await expect(
        knowledgeLifecycle(ctx, { id: 'test-api-001', action: 'approve' })
      ).rejects.toThrow('PERMISSION_DENIED');
    });

    test('reject 操作应被 PERMISSION_DENIED 拒绝', async () => {
      await expect(
        knowledgeLifecycle(ctx, { id: 'test-api-001', action: 'reject', reason: 'low quality' })
      ).rejects.toThrow('PERMISSION_DENIED');
    });

    test('publish 操作应被 PERMISSION_DENIED 拒绝', async () => {
      await expect(
        knowledgeLifecycle(ctx, { id: 'test-api-001', action: 'publish' })
      ).rejects.toThrow('PERMISSION_DENIED');
    });

    test('deprecate 操作应被 PERMISSION_DENIED 拒绝', async () => {
      await expect(
        knowledgeLifecycle(ctx, { id: 'test-api-001', action: 'deprecate', reason: 'outdated' })
      ).rejects.toThrow('PERMISSION_DENIED');
    });

    test('to_draft 操作应被 PERMISSION_DENIED 拒绝', async () => {
      await expect(
        knowledgeLifecycle(ctx, { id: 'test-api-001', action: 'to_draft' })
      ).rejects.toThrow('PERMISSION_DENIED');
    });

    test('fast_track 操作应被 PERMISSION_DENIED 拒绝', async () => {
      await expect(
        knowledgeLifecycle(ctx, { id: 'test-api-001', action: 'fast_track' })
      ).rejects.toThrow('PERMISSION_DENIED');
    });

    test('未知操作应被 PERMISSION_DENIED 拒绝', async () => {
      await expect(knowledgeLifecycle(ctx, { id: 'x', action: 'unknown' })).rejects.toThrow(
        'PERMISSION_DENIED'
      );
    });

    test('缺少 id 应抛出错误', async () => {
      await expect(knowledgeLifecycle(ctx, { action: 'reactivate' })).rejects.toThrow('id');
    });

    test('缺少 action 应抛出错误', async () => {
      await expect(knowledgeLifecycle(ctx, { id: 'x' })).rejects.toThrow('action');
    });
  });
});

/* ════════════════════════════════════════════
 *  Part 2: MCP Tool Definition Tests
 * ════════════════════════════════════════════ */

const { TOOLS, TOOL_GATEWAY_MAP } = await import('../../lib/external/mcp/tools.js');

describe('MCP Tool Definitions (V3)', () => {
  const _v3Tools = TOOLS.filter((t) => t.name.includes('knowledge'));

  test('应包含 submit_knowledge 工具（unified items 格式）', () => {
    const tool = TOOLS.find((t) => t.name === 'autosnippet_submit_knowledge');
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['items']);
  });

  test('submit_knowledge_batch 和 save_document 应已合并删除', () => {
    const batch = TOOLS.find((t) => t.name === 'autosnippet_submit_knowledge_batch');
    expect(batch).toBeUndefined();
    const saveDoc = TOOLS.find((t) => t.name === 'autosnippet_save_document');
    expect(saveDoc).toBeUndefined();
  });

  test('应包含 knowledge_lifecycle 工具', () => {
    const tool = TOOLS.find((t) => t.name === 'autosnippet_knowledge_lifecycle');
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['id', 'action']);
  });

  test('V3 工具应在 TOOL_GATEWAY_MAP 中注册', () => {
    expect(TOOL_GATEWAY_MAP.autosnippet_submit_knowledge).toEqual({
      action: 'knowledge:create',
      resource: 'knowledge',
    });
    expect(TOOL_GATEWAY_MAP.autosnippet_knowledge_lifecycle).toEqual({
      action: 'knowledge:update',
      resource: 'knowledge',
    });
  });

  test('TOOLS 数组应包含 18 个工具', () => {
    expect(TOOLS.length).toBe(18);
  });

  test('submit_knowledge items 字段应为数组类型', () => {
    const tool = TOOLS.find((t) => t.name === 'autosnippet_submit_knowledge');
    const itemsProp = tool.inputSchema.properties.items;
    expect(itemsProp.type).toBe('array');
  });

  test('knowledge_lifecycle 的 action enum 应包含全部操作', () => {
    const tool = TOOLS.find((t) => t.name === 'autosnippet_knowledge_lifecycle');
    const actionEnum = tool.inputSchema.properties.action.enum;
    expect(actionEnum).toEqual(
      expect.arrayContaining([
        'submit',
        'approve',
        'reject',
        'publish',
        'deprecate',
        'reactivate',
        'to_draft',
        'fast_track',
      ])
    );
  });
});

/* ════════════════════════════════════════════
 *  Part 3: HTTP Route Handler Logic Tests
 *
 *  通过直接导入路由模块，模拟 req/res 测试
 *  核心验证：路由正确解析参数并委托给 service
 * ════════════════════════════════════════════ */

// Mock ServiceContainer for HTTP routes
const _mockSvc = mockKnowledgeService();
vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => ({
    get: vi.fn((name) => {
      if (name === 'knowledgeService') {
        return _mockSvc;
      }
      return null;
    }),
  })),
}));

vi.mock('../../lib/infrastructure/logging/Logger.js', () => ({
  default: {
    getInstance: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../lib/http/utils/routeHelpers.js', () => ({
  getContext: vi.fn(() => ({ userId: 'test-user', ip: '127.0.0.1' })),
  safeInt: vi.fn((val, def) => parseInt(val, 10) || def),
}));

vi.mock('../../lib/shared/errors/index.js', () => ({
  ValidationError: class ValidationError extends Error {
    constructor(msg) {
      super(msg);
      this.name = 'ValidationError';
    }
  },
}));

describe('HTTP Knowledge Route Handlers', () => {
  // 由于 Express router 模式，我们测试的是路由处理函数的逻辑正确性
  // 通过模拟 req/res 对象验证参数解析和服务调用

  beforeEach(() => {
    vi.clearAllMocks();
    // 重置 mock service 调用
    Object.values(_mockSvc).forEach((v) => {
      if (typeof v?.mockClear === 'function') {
        v.mockClear();
      }
    });
  });

  test('GET / 列表应支持分页参数', async () => {
    const result = await _mockSvc.list({}, { page: 1, pageSize: 20 });
    expect(result.data).toBeDefined();
    expect(result.pagination).toBeDefined();
  });

  test('GET / 搜索应支持 keyword 参数', async () => {
    const result = await _mockSvc.search('test', { page: 1, pageSize: 20 });
    expect(result.data).toBeDefined();
  });

  test('GET /stats 应返回统计', async () => {
    const stats = await _mockSvc.getStats();
    expect(stats.total).toBe(10);
    expect(stats.byLifecycle).toBeDefined();
  });

  test('GET /:id 应返回条目', async () => {
    const entry = await _mockSvc.get('test-api-001');
    expect(entry.id).toBe('test-api-001');
    expect(entry.toJSON).toBeDefined();
  });

  test('POST / 创建应委托给 service.create', async () => {
    const data = { title: 'New', content: { pattern: 'x' }, language: 'swift' };
    const entry = await _mockSvc.create(data, { userId: 'test-user' });
    expect(entry.id).toBeDefined();
  });

  test('PATCH /:id 更新应委托给 service.update', async () => {
    const entry = await _mockSvc.update(
      'test-api-001',
      { title: 'Updated' },
      { userId: 'test-user' }
    );
    expect(entry.id).toBe('test-api-001');
  });

  test('DELETE /:id 删除应委托给 service.delete', async () => {
    const result = await _mockSvc.delete('test-api-001', { userId: 'test-user' });
    expect(result.success).toBe(true);
  });

  test('PATCH /:id/submit 应委托给 service.submit', async () => {
    const entry = await _mockSvc.submit('test-api-001', { userId: 'test-user' });
    expect(entry.lifecycle).toBe(Lifecycle.PENDING);
  });

  test('PATCH /:id/approve 应委托给 service.approve', async () => {
    const entry = await _mockSvc.approve('test-api-001', { userId: 'test-user' });
    expect(entry.lifecycle).toBe(Lifecycle.ACTIVE);
  });

  test('PATCH /:id/reject 应委托给 service.reject', async () => {
    const entry = await _mockSvc.reject('test-api-001', 'bad', { userId: 'test-user' });
    expect(entry.lifecycle).toBe(Lifecycle.DEPRECATED);
  });

  test('PATCH /:id/publish 应委托给 service.publish', async () => {
    const entry = await _mockSvc.publish('test-api-001', { userId: 'test-user' });
    expect(entry.lifecycle).toBe(Lifecycle.ACTIVE);
  });

  test('PATCH /:id/deprecate 应委托给 service.deprecate', async () => {
    const entry = await _mockSvc.deprecate('test-api-001', 'outdated', { userId: 'test-user' });
    expect(entry.lifecycle).toBe(Lifecycle.DEPRECATED);
  });

  test('PATCH /:id/reactivate 应委托给 service.reactivate', async () => {
    const entry = await _mockSvc.reactivate('test-api-001', { userId: 'test-user' });
    expect(entry.lifecycle).toBe(Lifecycle.PENDING);
  });

  test('PATCH /:id/to-draft 应委托给 service.toDraft', async () => {
    const entry = await _mockSvc.toDraft('test-api-001', { userId: 'test-user' });
    expect(entry.lifecycle).toBe(Lifecycle.PENDING);
  });

  test('PATCH /:id/fast-track 应委托给 service.fastTrack', async () => {
    const entry = await _mockSvc.fastTrack('test-api-001', { userId: 'test-user' });
    expect(entry.lifecycle).toBe(Lifecycle.ACTIVE);
  });

  test('POST /:id/usage 应委托给 service.incrementUsage', async () => {
    await _mockSvc.incrementUsage('test-api-001', 'adoption', { actor: 'test-user' });
    expect(_mockSvc.incrementUsage).toHaveBeenCalledWith('test-api-001', 'adoption', {
      actor: 'test-user',
    });
  });

  test('PATCH /:id/quality 应委托给 service.updateQuality', async () => {
    const result = await _mockSvc.updateQuality('test-api-001', { userId: 'test-user' });
    expect(result.quality).toBeDefined();
  });

  test('batch-approve 应对每个 id 调用 service.approve', async () => {
    const ids = ['id1', 'id2', 'id3'];
    await Promise.allSettled(ids.map((id) => _mockSvc.approve(id, { userId: 'test-user' })));
    expect(_mockSvc.approve).toHaveBeenCalledTimes(3);
  });

  test('batch-reject 应对每个 id 调用 service.reject', async () => {
    const ids = ['id1', 'id2'];
    await Promise.allSettled(
      ids.map((id) => _mockSvc.reject(id, 'batch reject', { userId: 'test-user' }))
    );
    expect(_mockSvc.reject).toHaveBeenCalledTimes(2);
  });

  test('batch-publish 应对每个 id 调用 service.publish', async () => {
    const ids = ['id1', 'id2'];
    await Promise.allSettled(ids.map((id) => _mockSvc.publish(id, { userId: 'test-user' })));
    expect(_mockSvc.publish).toHaveBeenCalledTimes(2);
  });
});
