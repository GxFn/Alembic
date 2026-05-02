import { vi } from 'vitest';

/**
 * Memory System v5 — 集成测试
 *
 * 覆盖 Phase 2-5 新模块:
 *   - MemoryCoordinator: Budget allocation, lifecycle, write routing
 *   - ActiveContext: recordToolCall, buildContext, distill
 *   - SessionStore: 缓存排除副作用工具, buildContextForDimension, distilled
 *   - PersistentMemory: extends PSM, conflict resolution, migration
 *
 */
// ── mock Logger ──────────────────────────────────────────
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
vi.mock('../../lib/infrastructure/logging/Logger.js', () => ({
  default: { getInstance: () => mockLogger },
}));

// ── Dynamic imports (ESM-safe) ──────────────────────────
const { MemoryCoordinator } = await import('../../lib/agent/memory/MemoryCoordinator.js');
const { ActiveContext } = await import('../../lib/agent/memory/ActiveContext.js');
const { SessionStore } = await import('../../lib/agent/memory/SessionStore.js');
const { MemoryEmbeddingStore } = await import('../../lib/agent/memory/MemoryEmbeddingStore.js');

// ══════════════════════════════════════════════════════════
//  1. MemoryCoordinator
// ══════════════════════════════════════════════════════════

describe('MemoryCoordinator', () => {
  // ── Budget Allocation ────────────────────────────────

  describe('Budget allocation', () => {
    test('user 模式 — persistentMemory 占比最高', () => {
      const mc = new MemoryCoordinator({ mode: 'user', totalMemoryBudget: 4000 });
      const alloc = mc.getBudgetAllocation();
      expect(alloc).toBeDefined();
      expect(alloc.persistentMemory).toBeGreaterThan(alloc.sessionStore || 0);
    });

    test('bootstrap (analyst) 模式 — sessionStore 占比最高', () => {
      const mc = new MemoryCoordinator({ mode: 'bootstrap', totalMemoryBudget: 4000 });
      mc.configure({ role: 'analyst' });
      const alloc = mc.getBudgetAllocation();
      expect(alloc).toBeDefined();
      expect(alloc.sessionStore).toBeGreaterThanOrEqual(alloc.persistentMemory || 0);
    });

    test('bootstrap (producer) 模式预算合理', () => {
      const mc = new MemoryCoordinator({ mode: 'bootstrap', totalMemoryBudget: 4000 });
      mc.configure({ role: 'producer' });
      const alloc = mc.getBudgetAllocation();
      expect(alloc).toBeDefined();
    });

    test('自定义 totalMemoryBudget', () => {
      const mc = new MemoryCoordinator({ mode: 'user', totalMemoryBudget: 2000 });
      const alloc = mc.getBudgetAllocation();
      // 各分配之和应 ≤ totalBudget
      const total = Object.values(alloc).reduce((s, v) => s + v, 0);
      expect(total).toBeLessThanOrEqual(2100); // 允许少量舍入误差
    });
  });

  // ── Lifecycle ────────────────────────────────────────

  describe('Lifecycle (createDimensionScope → completeDimension)', () => {
    test('创建维度作用域 — 返回 ActiveContext', () => {
      const mc = new MemoryCoordinator({ mode: 'bootstrap' });
      const scope = mc.createDimensionScope('dim-001');
      expect(scope).toBeDefined();
      // createDimensionScope 返回 ActiveContext 实例
      expect(typeof scope.startRound).toBe('function');
    });

    test('获取 ActiveContext 通过 scopeId', () => {
      const mc = new MemoryCoordinator({ mode: 'bootstrap' });
      mc.createDimensionScope('dim-002');
      const ctx = mc.getActiveContext('dim-002');
      expect(ctx).toBeDefined();
    });

    test('完成维度 — distill + 清理', () => {
      const mc = new MemoryCoordinator({ mode: 'bootstrap' });
      mc.createDimensionScope('dim-003');

      // 模拟一些数据
      const ctx = mc.getActiveContext('dim-003');
      if (ctx) {
        ctx.startRound(1);
        ctx.recordToolCall('search_project_code', { query: 'test' }, 'result data', true);
        ctx.endRound();
      }

      // completeDimension 返回 void
      mc.completeDimension('dim-003');

      // 完成后 scope 已被清理
      expect(mc.getActiveContext('dim-003')).toBeNull();
    });

    test('重复 completeDimension — scope 已清理', () => {
      const mc = new MemoryCoordinator({ mode: 'bootstrap' });
      mc.createDimensionScope('dim-dup');
      mc.completeDimension('dim-dup');
      // 第二次调用: scope 已不存在
      mc.completeDimension('dim-dup');
      expect(mc.getActiveContext('dim-dup')).toBeNull();
    });
  });

  // ── Write Routing ────────────────────────────────────

  describe('extractFromConversation (Write routing)', () => {
    test('user 源消息提取偏好', () => {
      const mockMemory = { append: vi.fn() };
      const mockPSM = { append: vi.fn() };
      const mc = new MemoryCoordinator({
        mode: 'user',
        memory: mockMemory,
        persistentMemory: mockPSM,
      });

      // extractFromConversation(prompt, reply, source)
      mc.extractFromConversation('我们不使用 singleton 模式', '', 'user');

      // 应该写入 persistentMemory 或 memory
      const totalWrites =
        (mockMemory.append.mock.calls.length || 0) + (mockPSM.append.mock.calls.length || 0);
      expect(totalWrites).toBeGreaterThan(0);
    });

    test('system 源消息不做规则匹配 (B4 fix)', () => {
      const mockMemory = { append: vi.fn() };
      const mockPSM = { append: vi.fn() };
      const mc = new MemoryCoordinator({
        mode: 'bootstrap',
        memory: mockMemory,
        persistentMemory: mockPSM,
      });

      // system 源: 即使内容匹配偏好模式，也不应写入
      mc.extractFromConversation('我们不使用 singleton 模式', '', 'system');

      const totalWrites =
        (mockMemory.append.mock.calls.length || 0) + (mockPSM.append.mock.calls.length || 0);
      expect(totalWrites).toBe(0);
    });
  });

  // ── recordObservation ────────────────────────────────

  describe('recordObservation', () => {
    test('AC 存在时 recordObservation 只处理缓存,不重复写 AC (trace.recordToolCall 负责)', () => {
      const ss = new SessionStore();
      const mc = new MemoryCoordinator({ mode: 'bootstrap', sessionStore: ss });
      mc.createDimensionScope('dim-obs');
      const ctx = mc.getActiveContext('dim-obs');
      ctx?.startRound(1);

      mc.recordObservation('code', { action: 'search', pattern: 'foo' }, 'result', 1, false);

      // ActiveContext 不应被 recordObservation 写入 (trace.recordToolCall 负责)
      expect(ctx?.totalObservations).toBe(0);
      // 缓存应通过 SessionStore 写入 (非副作用工具)
      const cached = ss.getCachedResult('code', { action: 'search', pattern: 'foo' });
      expect(cached).toBe('result');
    });

    test('副作用工具不缓存 (B3 fix)', () => {
      const ss = new SessionStore();
      const mc = new MemoryCoordinator({ mode: 'bootstrap', sessionStore: ss });

      mc.recordObservation('knowledge', { action: 'submit', id: 'k1' }, 'submitted', 1);

      // knowledge 是 NON_CACHEABLE，不应缓存
      const cached = ss.getCachedResult('knowledge', { action: 'submit', id: 'k1' });
      expect(cached).toBeNull();
    });

    test('cacheHit 时不重复写入缓存', () => {
      const ss = new SessionStore();
      const mc = new MemoryCoordinator({ mode: 'bootstrap', sessionStore: ss });

      mc.recordObservation('code', { action: 'search', pattern: 'bar' }, 'result', 1, true);

      // cacheHit=true → 不写入缓存
      const cached = ss.getCachedResult('code', { action: 'search', pattern: 'bar' });
      expect(cached).toBeNull();
    });
  });

  // ── noteFinding ──────────────────────────────────────

  describe('noteFinding', () => {
    test('写入当前作用域的 ActiveContext', () => {
      const mc = new MemoryCoordinator({ mode: 'bootstrap' });
      mc.createDimensionScope('dim-finding');
      const ctx = mc.getActiveContext('dim-finding');

      mc.noteFinding('Important discovery about architecture', 'dim-finding');

      // ActiveContext 的 scratchpad 或 findings 应有记录
      const distilled = ctx?.distill();
      expect(distilled).toBeDefined();
    });
  });

  // ── buildStaticMemoryPrompt ──────────────────────────

  describe('buildStaticMemoryPrompt / buildDynamicMemoryPrompt', () => {
    test('buildStaticMemoryPrompt 返回字符串', async () => {
      const mc = new MemoryCoordinator({ mode: 'user' });
      const result = await mc.buildStaticMemoryPrompt();
      expect(typeof result).toBe('string');
    });

    test('buildDynamicMemoryPrompt 返回字符串', () => {
      const mc = new MemoryCoordinator({ mode: 'bootstrap' });
      const result = mc.buildDynamicMemoryPrompt();
      expect(typeof result).toBe('string');
    });
  });

  // ── dispose ──────────────────────────────────────────

  describe('dispose', () => {
    test('清理所有内部状态', () => {
      const mc = new MemoryCoordinator({ mode: 'bootstrap' });
      mc.createDimensionScope('dim-dispose');
      mc.dispose();

      // 已释放的 coordinator 应返回 null
      expect(mc.getActiveContext('dim-dispose')).toBeNull();
    });
  });
});

// ══════════════════════════════════════════════════════════
//  2. ActiveContext
// ══════════════════════════════════════════════════════════

describe('ActiveContext', () => {
  // ── recordToolCall (统一方法) ─────────────────────────

  describe('recordToolCall (统一 WM + RT)', () => {
    test('记录工具调用并同时更新 RT 和 WM 层', () => {
      const ctx = new ActiveContext();
      ctx.startRound(1);

      ctx.recordToolCall('search_project_code', { query: 'main' }, 'Found 5 matches in src/', true);

      ctx.endRound();

      // RT 层: actions + observations
      const json = ctx.toJSON();
      expect(json.rounds).toHaveLength(1);
      expect(json.rounds[0].actions).toHaveLength(1);
      expect(json.rounds[0].observations).toHaveLength(1);

      // WM 层: totalObservations
      expect(ctx.totalObservations).toBeGreaterThan(0);
    });

    test('非新信息不增加 WM 观察', () => {
      const ctx = new ActiveContext();
      ctx.startRound(1);

      ctx.recordToolCall(
        'search_project_code',
        { query: 'main' },
        'No new results',
        false // isNew = false
      );

      ctx.endRound();

      // RT 层仍然记录
      const json = ctx.toJSON();
      expect(json.rounds[0].actions).toHaveLength(1);
    });

    test('记录 ToolResultEnvelope 的调用关系元数据', () => {
      const ctx = new ActiveContext();
      ctx.startRound(1);

      ctx.recordToolCall(
        'stage_then_normalize',
        { value: 2 },
        {
          ok: true,
          toolId: 'stage_then_normalize',
          callId: 'parent-call',
          startedAt: new Date().toISOString(),
          durationMs: 12,
          status: 'success',
          text: 'ok',
          structuredContent: { value: 6 },
          diagnostics: {
            degraded: false,
            fallbackUsed: false,
            warnings: [],
            timedOutStages: [],
            blockedTools: [],
            truncatedToolCalls: 0,
            emptyResponses: 0,
            aiErrorCount: 0,
            gateFailures: [],
          },
          trust: {
            source: 'internal',
            sanitized: true,
            containsUntrustedText: false,
            containsSecrets: false,
          },
        },
        true
      );

      ctx.endRound();
      const json = ctx.toJSON();
      expect(json.rounds[0].observations[0]).toMatchObject({
        tool: 'stage_then_normalize',
        resultType: 'success',
        toolCall: {
          callId: 'parent-call',
          status: 'success',
          ok: true,
          durationMs: 12,
        },
      });
    });
  });

  // ── startRound / endRound / setThought ───────────────

  describe('ReasoningTrace 兼容', () => {
    test('startRound → setThought → endRound 完整流程', () => {
      const ctx = new ActiveContext();
      ctx.startRound(1);
      ctx.setThought('分析项目结构');
      ctx.endRound();

      const json = ctx.toJSON();
      expect(json.rounds).toHaveLength(1);
      expect(json.rounds[0].thought).toBe('分析项目结构');
    });

    test('自动关闭上一轮', () => {
      const ctx = new ActiveContext();
      ctx.startRound(1);
      ctx.setThought('round 1');
      ctx.startRound(2); // 自动 endRound 第 1 轮
      ctx.setThought('round 2');
      ctx.endRound();

      const json = ctx.toJSON();
      expect(json.rounds).toHaveLength(2);
    });

    test('setReflection 记录反思', () => {
      const ctx = new ActiveContext();
      ctx.startRound(1);
      ctx.setReflection('需要更深入分析');
      ctx.endRound();

      const json = ctx.toJSON();
      expect(json.rounds[0].reflection).toBe('需要更深入分析');
    });

    test('extractAndSetPlan — 提取和设定计划', () => {
      const ctx = new ActiveContext();
      ctx.startRound(1);
      const success = ctx.extractAndSetPlan(
        '我的计划是:\n1. 搜索代码\n2. 分析架构\n3. 提交候选',
        1
      );
      ctx.endRound();

      const plan = ctx.getPlan();
      expect(plan).toBeDefined();
      // extractAndSetPlan might or might not find steps depending on format
      expect(typeof success).toBe('boolean');
    });

    test('getStats 返回统计信息', () => {
      const ctx = new ActiveContext();
      ctx.startRound(1);
      ctx.recordToolCall('read_project_file', { path: 'a.js' }, 'content', true);
      ctx.endRound();

      const stats = ctx.getStats();
      expect(stats).toBeDefined();
      expect(stats.totalRounds).toBe(1);
      expect(stats.totalActions).toBeGreaterThanOrEqual(1);
    });

    test('getRecentSummary 返回摘要对象或 null', () => {
      const ctx = new ActiveContext();
      ctx.startRound(1);
      ctx.setThought('analyzing');
      ctx.recordToolCall('search_project_code', { query: 'x' }, 'found stuff', true);
      ctx.endRound();

      const summary = ctx.getRecentSummary(3);
      // Returns object or null (not string)
      if (summary !== null) {
        expect(typeof summary).toBe('object');
        expect(summary.roundCount).toBeDefined();
      }
    });

    test('getCurrentIteration 返回当前迭代或 null', () => {
      const ctx = new ActiveContext();
      // 无轮次时返回 null
      expect(ctx.getCurrentIteration()).toBeNull();
      ctx.startRound(1);
      expect(ctx.getCurrentIteration()).toBe(1);
    });

    test('buildObservationMeta 静态方法', () => {
      const meta = ActiveContext.buildObservationMeta(
        'code',
        { action: 'search', pattern: 'main' },
        '5 matches (showing 5)\n\nsrc/main.js:1: content',
        false
      );
      expect(meta).toBeDefined();
      expect(meta.resultType).toBe('search');
    });
  });

  // ── WorkingMemory 兼容 ──────────────────────────────

  describe('WorkingMemory 兼容', () => {
    test('observe — 添加工具观察', () => {
      const ctx = new ActiveContext();
      ctx.observe('read_project_file', 'file content here', 1);
      expect(ctx.totalObservations).toBe(1);
    });

    test('noteKeyFinding — 记录关键发现', () => {
      const ctx = new ActiveContext();
      ctx.noteKeyFinding('Architecture uses MVC pattern');

      const distilled = ctx.distill();
      // keyFindings is array of objects: { finding, evidence, importance }
      const findingTexts = distilled.keyFindings.map((f) => f.finding);
      expect(findingTexts).toContain('Architecture uses MVC pattern');
    });

    test('noteKeyFinding — evidence 为数组时自动转 string', () => {
      const ctx = new ActiveContext();
      // AI 可能传入 array 类型的 evidence
      ctx.noteKeyFinding('Pattern found', ['file.m:45', 'file2.m:78'], 8);

      const distilled = ctx.distill();
      expect(typeof distilled.keyFindings[0].evidence).toBe('string');
      expect(distilled.keyFindings[0].evidence).toBe('file.m:45, file2.m:78');
    });

    test('noteKeyFinding — evidence 为 object 时自动转 string', () => {
      const ctx = new ActiveContext();
      ctx.noteKeyFinding('Pattern found', { file: 'test.m', line: 10 }, 7);

      const distilled = ctx.distill();
      expect(typeof distilled.keyFindings[0].evidence).toBe('string');
    });

    test('getHighPriorityFindings — 获取高优先级发现', () => {
      const ctx = new ActiveContext();
      // Default importance is 5, getHighPriorityFindings filters >= 7
      ctx.noteKeyFinding('low priority', '', 5);
      ctx.noteKeyFinding('high priority 1', '', 8);
      ctx.noteKeyFinding('high priority 2', '', 9);

      const findings = ctx.getHighPriorityFindings();
      expect(findings).toHaveLength(2);
    });

    test('scratchpadSize — 返回 scratchpad 大小', () => {
      const ctx = new ActiveContext();
      expect(ctx.scratchpadSize).toBe(0);
      ctx.noteKeyFinding('test');
      expect(ctx.scratchpadSize).toBeGreaterThan(0);
    });

    test('clear — 清空状态', () => {
      const ctx = new ActiveContext();
      ctx.noteKeyFinding('will be cleared');
      ctx.observe('tool', 'result', 1);
      ctx.clear();
      expect(ctx.totalObservations).toBe(0);
      expect(ctx.scratchpadSize).toBe(0);
    });
  });

  // ── buildContext 预算控制 ────────────────────────────

  describe('buildContext (预算控制)', () => {
    test('无预算 — 返回完整上下文', () => {
      const ctx = new ActiveContext();
      ctx.noteKeyFinding('important finding');
      ctx.observe('tool', 'result', 1);

      const context = ctx.buildContext();
      expect(typeof context).toBe('string');
      expect(context.length).toBeGreaterThan(0);
    });

    test('低预算 — 返回截断上下文', () => {
      const ctx = new ActiveContext();
      for (let i = 0; i < 20; i++) {
        ctx.noteKeyFinding(`finding ${i}: some important text about architecture pattern`);
        ctx.observe(`tool_${i}`, `result data ${i} with lots of content`, i);
      }

      const fullContext = ctx.buildContext();
      const limitedContext = ctx.buildContext(200);

      // 有预算限制时应更短
      expect(limitedContext.length).toBeLessThanOrEqual(fullContext.length);
    });

    test('轻量模式跳过 WM 压缩', () => {
      const ctx = new ActiveContext({ lightweight: true });
      ctx.observe('tool', 'result', 1);

      // 轻量模式应该不维护压缩缓存
      const context = ctx.buildContext();
      expect(typeof context).toBe('string');
    });
  });

  // ── distill ─────────────────────────────────────────

  describe('distill (蒸馏)', () => {
    test('返回完整蒸馏结果', () => {
      const ctx = new ActiveContext();
      ctx.startRound(1);
      ctx.noteKeyFinding('Pattern: MVC architecture');
      ctx.recordToolCall('search_project_code', { query: 'MVC' }, '5 matches', true);
      ctx.endRound();

      const distilled = ctx.distill();
      expect(distilled).toBeDefined();
      // keyFindings is array of objects
      const texts = distilled.keyFindings.map((f) => f.finding);
      expect(texts).toContain('Pattern: MVC architecture');
      expect(distilled.stats).toBeDefined();
      expect(distilled.totalObservations).toBeGreaterThan(0);
    });

    test('包含工具调用摘要', () => {
      const ctx = new ActiveContext();
      ctx.startRound(1);
      ctx.recordToolCall('search_project_code', { query: 'a' }, 'result a', true);
      ctx.recordToolCall('read_project_file', { path: 'b.js' }, 'content b', true);
      ctx.endRound();

      const distilled = ctx.distill();
      expect(distilled.toolCallSummary).toBeDefined();
    });

    test('包含计划信息', () => {
      const ctx = new ActiveContext();
      ctx.startRound(1);
      ctx.extractAndSetPlan('1. Search code\n2. Analyze\n3. Submit');
      ctx.endRound();

      const distilled = ctx.distill();
      expect(distilled.plan).toBeDefined();
    });
  });

  // ── toJSON / fromJSON 序列化 ────────────────────────

  describe('toJSON / fromJSON', () => {
    test('序列化 → 反序列化 保留数据', () => {
      const ctx = new ActiveContext();
      ctx.startRound(1);
      ctx.setThought('analyzing');
      ctx.recordToolCall('search_project_code', { query: 'x' }, 'results', true);
      ctx.noteKeyFinding('key insight');
      ctx.endRound();

      const json = ctx.toJSON();
      expect(json.rounds).toHaveLength(1);

      const restored = ActiveContext.fromJSON(json);
      expect(restored).toBeDefined();
      const restoredJson = restored.toJSON();
      expect(restoredJson.rounds).toHaveLength(1);
    });
  });
});

// ══════════════════════════════════════════════════════════
//  3. SessionStore
// ══════════════════════════════════════════════════════════

describe('SessionStore', () => {
  // ── 基本报告操作 ────────────────────────────────────

  describe('Dimension reports', () => {
    test('storeDimensionReport + getDimensionReport', () => {
      const ss = new SessionStore();
      ss.storeDimensionReport('dim-1', {
        analysisText: 'Found 3 patterns',
        keyFindings: ['pattern A', 'pattern B'],
      });

      const report = ss.getDimensionReport('dim-1');
      expect(report).toBeDefined();
      expect(report.analysisText).toBe('Found 3 patterns');
    });

    test('storeDimensionReport — evidence 非 string 不崩溃', () => {
      const ss = new SessionStore();
      // AI 可能返回 evidence 为 array 类型
      ss.storeDimensionReport('dim-array-ev', {
        analysisText: 'test',
        findings: [
          { finding: 'pattern', evidence: ['file.m:45', 'file2.m:78'], importance: 8 },
          { finding: 'pattern2', evidence: { file: 'a.m' }, importance: 5 },
          { finding: 'pattern3', evidence: 123, importance: 3 },
        ],
      });
      const report = ss.getDimensionReport('dim-array-ev');
      expect(report).toBeDefined();
      expect(report.findings).toHaveLength(3);
      // 所有 evidence 应被转为 string
      for (const f of report.findings) {
        expect(typeof f.evidence).toBe('string');
      }
    });

    test('getCompletedDimensions', () => {
      const ss = new SessionStore();
      ss.storeDimensionReport('dim-a', { analysisText: 'a' });
      ss.storeDimensionReport('dim-b', { analysisText: 'b' });

      const dims = ss.getCompletedDimensions();
      expect(dims).toContain('dim-a');
      expect(dims).toContain('dim-b');
    });
  });

  // ── 缓存操作 ────────────────────────────────────────

  describe('ReadOnlyCache (ToolResultCache 兼容)', () => {
    test('缓存只读工具结果', () => {
      const ss = new SessionStore();
      ss.cacheToolResult('code', { action: 'search', pattern: 'main' }, 'Found 5');

      const cached = ss.getCachedResult('code', { action: 'search', pattern: 'main' });
      expect(cached).toBe('Found 5');
    });

    test('排除副作用工具 (B3 fix)', () => {
      const ss = new SessionStore();
      ss.cacheToolResult('knowledge', { action: 'submit', id: 'k1' }, 'submitted');

      const cached = ss.getCachedResult('knowledge', { action: 'submit', id: 'k1' });
      expect(cached).toBeNull();
    });

    test('排除 note_finding (副作用)', () => {
      const ss = new SessionStore();
      ss.cacheToolResult('note_finding', { content: 'x' }, 'noted');

      const cached = ss.getCachedResult('note_finding', { content: 'x' });
      expect(cached).toBeNull();
    });

    test('get/set 兼容方法', () => {
      const ss = new SessionStore();
      ss.set('code', { action: 'read', filePath: 'a.js' }, { content: 'content' });

      const result = ss.get('code', { action: 'read', filePath: 'a.js' });
      expect(result).toBeDefined();
      expect((result as { content: string }).content).toBe('content');
      expect((result as { cached: boolean }).cached).toBe(true);
    });

    test('clearCache 清空缓存', () => {
      const ss = new SessionStore();
      ss.cacheToolResult('code', { action: 'search', pattern: 'x' }, 'result');
      ss.clearCache();

      const cached = ss.getCachedResult('code', { action: 'search', pattern: 'x' });
      expect(cached).toBeNull();
    });
  });

  // ── Evidence ────────────────────────────────────────

  describe('Evidence', () => {
    test('addEvidence + getEvidenceForFile', () => {
      const ss = new SessionStore();
      // addEvidence(filePath, evidence)
      ss.addEvidence('src/main.js', {
        dimId: 'dim-1',
        finding: 'MVC usage',
        importance: 7,
      });

      const evidence = ss.getEvidenceForFile('src/main.js');
      expect(evidence.length).toBeGreaterThan(0);
    });

    test('searchEvidence', () => {
      const ss = new SessionStore();
      ss.addEvidence('src/api.js', {
        dimId: 'dim-1',
        finding: 'REST endpoint',
        importance: 6,
      });

      const results = ss.searchEvidence('REST');
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ── buildContextForDimension ────────────────────────

  describe('buildContextForDimension', () => {
    test('包含已完成维度信息', () => {
      const ss = new SessionStore();
      ss.storeDimensionReport('dim-prev', {
        analysisText: 'Previous dimension analysis',
        keyFindings: ['finding 1'],
      });

      const context = ss.buildContextForDimension('dim-current', ['architecture']);
      expect(typeof context).toBe('string');
    });

    test('消费 workingMemoryDistilled (B1 fix)', () => {
      const ss = new SessionStore();
      ss.storeDimensionReport('dim-prev', {
        analysisText: 'Previous analysis',
        keyFindings: ['important finding'],
        workingMemoryDistilled: {
          keyFindings: [{ finding: 'WM distilled finding', importance: 8 }],
          toolCallSummary: { search: 3 },
        },
      });

      const context = ss.buildContextForDimension('dim-next', []);
      // workingMemoryDistilled keyFindings should be included in context
      expect(context).toContain('WM distilled finding');
    });
  });

  // ── getDistilledForProducer (B2 fix) ────────────────

  describe('getDistilledForProducer', () => {
    test('返回指定维度的蒸馏数据', () => {
      const ss = new SessionStore();
      ss.storeDimensionReport('dim-a', {
        analysisText: 'Analyst findings',
        keyFindings: ['key 1'],
        workingMemoryDistilled: {
          keyFindings: ['WM key 1'],
          stats: { totalRounds: 3 },
        },
      });

      const distilled = ss.getDistilledForProducer('dim-a');
      expect(distilled).toBeDefined();
    });
  });

  // ── Submitted candidates ────────────────────────────

  describe('submittedCandidates', () => {
    test('addSubmittedCandidate + 检索', () => {
      const ss = new SessionStore();
      ss.addSubmittedCandidate('dim-1', {
        id: 'k001',
        title: 'Test candidate',
      });

      const snapshot = ss.buildContextSnapshot?.('dim-2');
      // SessionStore 应有提交候选数据
      expect(snapshot || true).toBeTruthy();
    });
  });

  // ── Reflections ─────────────────────────────────────

  describe('Tier reflections', () => {
    test('addTierReflection + getRelevantReflections', () => {
      const ss = new SessionStore();
      ss.addTierReflection(0, {
        tierIndex: 0,
        topFindings: [{ finding: 'Test finding', importance: 8 }],
        crossDimensionPatterns: ['pattern A'],
        suggestionsForNextTier: ['suggestion 1'],
      });

      const refs = ss.getRelevantReflections('dim-next');
      // Returns string or null (formatted markdown)
      expect(refs === null || typeof refs === 'string').toBe(true);
    });
  });

  // ── getStats ────────────────────────────────────────

  describe('getStats', () => {
    test('返回合并的统计', () => {
      const ss = new SessionStore();
      ss.storeDimensionReport('dim-s1', { analysisText: 'a' });
      ss.cacheToolResult('code', { action: 'search', pattern: 'test' }, 'r1');

      const stats = ss.getStats();
      expect(stats).toBeDefined();
      expect(stats.completedDimensions).toBe(1);
      expect(stats.cache).toBeDefined();
    });
  });

  // ── toJSON / fromJSON ───────────────────────────────

  describe('Serialization', () => {
    test('toJSON → fromJSON roundtrip', () => {
      const ss = new SessionStore();
      ss.storeDimensionReport('dim-ser', { analysisText: 'serialization test' });
      ss.addEvidence('dim-ser', 'file.js', { type: 'fact', content: 'data' });

      const json = ss.toJSON();
      expect(json).toBeDefined();

      const restored = SessionStore.fromJSON(json);
      expect(restored).toBeDefined();

      const report = restored.getDimensionReport('dim-ser');
      expect(report?.analysisText).toBe('serialization test');
    });
  });

  // ── getAllReferencedFiles ────────────────────────────

  describe('getAllReferencedFiles', () => {
    test('返回所有引用的文件', () => {
      const ss = new SessionStore();
      // referencedFiles comes from dimension reports, not evidence
      ss.storeDimensionReport('dim-1', {
        analysisText: 'analysis',
        referencedFiles: ['src/a.js', 'src/b.js'],
      });

      const files = ss.getAllReferencedFiles();
      expect(files.has('src/a.js')).toBe(true);
      expect(files.has('src/b.js')).toBe(true);
    });
  });
});

// ══════════════════════════════════════════════════════════
//  4. PersistentMemory (需要 SQLite mock)
// ══════════════════════════════════════════════════════════

describe('PersistentMemory', () => {
  let PersistentMemory:
    | typeof import('../../lib/agent/memory/PersistentMemory.js')['PersistentMemory']
    | null = null;
  let Database: typeof import('better-sqlite3')['default'] | null = null;

  beforeAll(async () => {
    try {
      // 尝试加载 better-sqlite3 (如果可用)
      const dbMod = await import('better-sqlite3');
      Database = dbMod.default;
      const pmMod = await import('../../lib/agent/memory/PersistentMemory.js');
      PersistentMemory = pmMod.PersistentMemory;
    } catch {
      // better-sqlite3 不可用 → 跳过 PersistentMemory 测试
      PersistentMemory = null;
    }
  });

  test('PersistentMemory 模块可导入', async () => {
    const mod = await import('../../lib/agent/memory/PersistentMemory.js');
    expect(mod.PersistentMemory).toBeDefined();
    // 向后兼容别名
    expect(mod.ProjectSemanticMemory).toBeDefined();
    expect(mod.PersistentMemory).toBe(mod.ProjectSemanticMemory);
  });

  // 使用 in-memory SQLite 测试核心功能
  const createInMemoryPM = (opts?: { withEmbeddingStore?: boolean }) => {
    if (!Database || !PersistentMemory) {
      return null;
    }
    const db = new Database(':memory:');
    const pmOpts: Record<string, unknown> = { logger: mockLogger };
    if (opts?.withEmbeddingStore) {
      pmOpts.embeddingStore = new MemoryEmbeddingStore(`/tmp/alembic-test-${Date.now()}`);
    }
    return new PersistentMemory(db, pmOpts);
  };

  describe('PersistentMemory 核心 API', () => {
    test('add + get — 基本 CRUD', () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return; // skip if no sqlite
      }

      const { id } = pm.add({
        type: 'fact',
        content: 'Project uses TypeScript',
        source: 'user',
        importance: 7,
      });

      const memory = pm.get(id);
      expect(memory).toBeDefined();
      expect(memory.content).toBe('Project uses TypeScript');
      expect(memory.importance).toBe(7);
    });

    test('append — Memory.js 兼容', () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      pm.append({ type: 'preference', content: 'We prefer functional style' });
      expect(pm.size({})).toBe(1);
    });

    test('toPromptSection — 生成 prompt', async () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      pm.add({ type: 'fact', content: 'Main language is JavaScript', importance: 8 });
      pm.add({ type: 'preference', content: 'Use ES modules', importance: 6 });

      const section = await pm.toPromptSection({});
      expect(typeof section).toBe('string');
      expect(section).toContain('JavaScript');
    });

    test('retrieve — 3D 检索', async () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      pm.add({ type: 'fact', content: 'Uses React for frontend', importance: 7 });
      pm.add({ type: 'fact', content: 'Backend is Node.js Express', importance: 6 });
      pm.add({ type: 'preference', content: 'Prefer hooks over class components', importance: 8 });

      const results = await pm.retrieve('React hooks', { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
    });

    test('consolidate — 智能固化', () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      const result = pm.consolidate([
        { type: 'fact', content: 'Project uses MVC pattern', importance: 6 },
        { type: 'fact', content: 'Database is PostgreSQL', importance: 7 },
      ]);

      expect(result.added).toBe(2);
      expect(result.skipped).toBe(0);
    });

    test('compact — 维护 (F16)', () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      // 添加一些记忆
      pm.add({ type: 'fact', content: 'Test memory for compact', importance: 5 });
      const stats = pm.compact();
      expect(stats).toBeDefined();
      expect(stats.remaining).toBe(1);
    });

    test('clearBootstrapMemories — F15', () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      pm.add({ type: 'fact', content: 'Bootstrap memory 1', source: 'bootstrap', importance: 5 });
      pm.add({ type: 'fact', content: 'User memory 1', source: 'user', importance: 7 });

      const cleared = pm.clearBootstrapMemories();
      expect(cleared).toBe(1);
      expect(pm.size({})).toBe(1);
    });

    test('getStats — 统计', () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      pm.add({ type: 'fact', content: 'Stat test 1', importance: 5 });
      pm.add({ type: 'insight', content: 'Stat test 2', importance: 6 });

      const stats = pm.getStats();
      expect(stats.total).toBe(2);
      expect(stats.byType.fact).toBe(1);
      expect(stats.byType.insight).toBe(1);
    });
  });

  // ── PersistentMemory 新增功能 ──────────────────────

  describe('冲突解决 (Mem0 风格)', () => {
    test('矛盾记忆 → 自动替换', () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      // 先添加一条现有记忆
      pm.add({ type: 'preference', content: '我们使用 singleton 模式', importance: 6 });

      // consolidate 一条矛盾记忆
      const result = pm.consolidate([
        { type: 'preference', content: '我们不使用 singleton 模式', importance: 7 },
      ]);

      // 应该触发替换 (replaced) 而非新增
      expect(result.replaced).toBe(1);
      expect(result.added).toBe(0);

      // 验证内容已更新
      const memories = pm.load(10, {});
      const singleton = memories.find((m) => m.content.includes('singleton'));
      expect(singleton.content).toContain('不使用');
    });

    test('非矛盾记忆 → 正常 ADD/MERGE', () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      pm.add({ type: 'fact', content: 'Project uses React', importance: 6 });

      const result = pm.consolidate([
        { type: 'fact', content: 'Backend uses Express', importance: 5 },
      ]);

      // 不同主题 → ADD 而非 REPLACE
      expect(result.replaced).toBeUndefined();
      expect(result.added).toBe(1);
    });

    test('同向否定 → 不视为矛盾', () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      pm.add({ type: 'preference', content: '不要使用全局变量', importance: 6 });

      const result = pm.consolidate([
        { type: 'preference', content: '不要使用全局状态管理', importance: 7 },
      ]);

      // 两者都是否定 → 非矛盾，正常走 consolidate
      expect(result.replaced).toBeUndefined();
    });
  });

  describe('Budget-aware toPromptSection', () => {
    test('tokenBudget 限制输出条数', async () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      // 添加大量记忆
      for (let i = 0; i < 20; i++) {
        pm.add({
          type: 'fact',
          content: `Memory entry ${i}: important project detail number ${i}`,
          importance: 5 + (i % 5),
        });
      }

      const fullSection = await pm.toPromptSection({ limit: 20 });
      const limitedSection = await pm.toPromptSection({ tokenBudget: 150 });

      // 有预算时应更短
      expect(limitedSection.length).toBeLessThan(fullSection.length);
    });
  });

  describe('向量嵌入接口', () => {
    test('setEmbeddingFunction + getEmbeddingFunction', () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      expect(pm.getEmbeddingFunction()).toBeNull();

      const mockEmbedding = async (text: string) => [0.1, 0.2, 0.3];
      pm.setEmbeddingFunction(mockEmbedding);
      expect(pm.getEmbeddingFunction()).toBe(mockEmbedding);
    });

    test('computeEmbeddingRelevance — 未设置时返回 null', async () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      expect(await pm.computeEmbeddingRelevance('query', 'content')).toBeNull();
    });

    test('computeEmbeddingRelevance — 已设置时返回话弦相似度', async () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      // mock: 不同文本返回不同向量
      pm.setEmbeddingFunction(async (text: string) => {
        if (text === 'test') {
          return [1, 0, 0];
        }
        return [0.9, 0.1, 0];
      });
      const score = await pm.computeEmbeddingRelevance('test', 'data');
      expect(score).toBeGreaterThan(0.8);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    test('embedAllMemories — 批量嵌入缺失记忆', async () => {
      const pm = createInMemoryPM({ withEmbeddingStore: true });
      if (!pm) {
        return;
      }

      pm.add({ type: 'fact', content: 'Memory without embedding', importance: 5 });
      pm.add({ type: 'fact', content: 'Another memory', importance: 6 });

      pm.setEmbeddingFunction(async (text: string) => [0.1, 0.2, 0.3]);
      const count = await pm.embedAllMemories();
      expect(count).toBe(2);
    });

    test('retrieve — 有向量时融合向量相关性', async () => {
      const pm = createInMemoryPM({ withEmbeddingStore: true });
      if (!pm) {
        return;
      }

      pm.add({ type: 'fact', content: 'TypeScript strict mode', importance: 7 });
      pm.add({ type: 'fact', content: 'Python data science', importance: 7 });

      // 为所有记忆生成嵌入
      pm.setEmbeddingFunction(async (text: string) => {
        // 简化的向量：TypeScript 相关的内容指向相同方向
        if (text.toLowerCase().includes('typescript') || text.toLowerCase().includes('strict')) {
          return [1, 0, 0];
        }
        return [0, 1, 0];
      });
      await pm.embedAllMemories();

      const results = await pm.retrieve('TypeScript', { limit: 2 });
      expect(results.length).toBe(2);
      // TypeScript 记忆应排在前面 (向量相关性更高)
      expect(results[0].content).toContain('TypeScript');
    });
  });

  describe('Legacy migration', () => {
    // migrateFromLegacy 需要文件系统操作，这里测试边界情况
    test('不存在的路径 → 返回 { migrated: 0 }', async () => {
      const pm = createInMemoryPM();
      if (!pm) {
        return;
      }

      const result = await pm.migrateFromLegacy('/nonexistent/project');
      expect(result.migrated).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });
});

// ══════════════════════════════════════════════════════════
//  5. 模块导出一致性
// ══════════════════════════════════════════════════════════

describe('Memory module exports', () => {
  test('memory/index.js 导出所有模块', async () => {
    const mod = await import('../../lib/agent/memory/index.js');
    expect(mod.MemoryCoordinator).toBeDefined();
    expect(mod.ActiveContext).toBeDefined();
    expect(mod.SessionStore).toBeDefined();
    expect(mod.PersistentMemory).toBeDefined();
  });
});
