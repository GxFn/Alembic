/**
 * ActiveContext (原 ReasoningTrace) + ExplorationTracker 单元测试
 */
import { jest } from '@jest/globals';

// ── mock Logger ──────────────────────────────────────────
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../lib/infrastructure/logging/Logger.js', () => ({
  default: { getInstance: () => mockLogger },
}));

const { ActiveContext: ReasoningTrace } = await import('../../lib/service/agent/memory/ActiveContext.js');
const { ExplorationTracker } = await import('../../lib/service/agent/context/ExplorationTracker.js');

// ─── ReasoningTrace ─────────────────────────────────────
describe('ReasoningTrace', () => {
  let trace;

  beforeEach(() => {
    trace = new ReasoningTrace();
  });

  test('startRound + endRound 创建一个完整轮次', () => {
    trace.startRound(1);
    trace.setThought('分析项目结构');
    trace.addAction('search_project_code', { query: 'main' });
    trace.addObservation('search_project_code', {
      gotNewInfo: true,
      resultType: 'search',
      keyFacts: ['5 matches'],
      resultSize: 200,
    });
    trace.endRound();

    const json = trace.toJSON();
    expect(json.rounds).toHaveLength(1);
    expect(json.rounds[0].iteration).toBe(1);
    expect(json.rounds[0].thought).toBe('分析项目结构');
    expect(json.rounds[0].actions).toHaveLength(1);
    expect(json.rounds[0].observations).toHaveLength(1);
  });

  test('自动关闭上一轮', () => {
    trace.startRound(1);
    trace.setThought('first');
    trace.startRound(2); // 自动 endRound 第 1 轮
    trace.setThought('second');
    trace.endRound();

    const json = trace.toJSON();
    expect(json.rounds).toHaveLength(2);
    expect(json.rounds[0].thought).toBe('first');
    expect(json.rounds[1].thought).toBe('second');
  });

  test('setThought 对 null/空值跳过', () => {
    trace.startRound(1);
    trace.setThought(null);
    trace.setThought('');
    trace.endRound();

    expect(trace.getThoughts()).toHaveLength(0);
  });

  test('getThoughts 仅返回有 thought 的轮次', () => {
    trace.startRound(1);
    trace.setThought('有推理');
    trace.endRound();

    trace.startRound(2);
    // 无 thought
    trace.endRound();

    trace.startRound(3);
    trace.setThought('再次推理');
    trace.endRound();

    const thoughts = trace.getThoughts();
    expect(thoughts).toEqual([
      { iteration: 1, thought: '有推理' },
      { iteration: 3, thought: '再次推理' },
    ]);
  });

  test('getRecentSummary 正确汇总最近 N 轮', () => {
    for (let i = 1; i <= 5; i++) {
      trace.startRound(i);
      if (i % 2 === 1) {
        trace.setThought(`想法 ${i}`);
      }
      trace.addAction(`tool_${i}`, {});
      trace.addObservation(`tool_${i}`, { gotNewInfo: i <= 3 });
      trace.endRound();
    }

    const summary = trace.getRecentSummary(3);
    expect(summary.roundCount).toBe(3);
    expect(summary.lastIteration).toBe(5);
    expect(summary.thoughts).toHaveLength(2); // 轮 3 和 5 有 thought
    expect(summary.newInfoRatio).toBeCloseTo(1 / 3); // 3 obs 中 1 个有 newInfo (第3轮)
  });

  test('getRecentSummary 空 trace 返回 null', () => {
    expect(trace.getRecentSummary()).toBeNull();
  });

  test('getStats 正确统计指标', () => {
    trace.startRound(1);
    trace.setThought('思考');
    trace.addAction('a', {});
    trace.addAction('b', {});
    trace.addObservation('a', { gotNewInfo: true });
    trace.setReflection('反思内容');
    trace.endRound();

    trace.startRound(2);
    trace.addAction('c', {});
    trace.endRound();

    const stats = trace.getStats();
    expect(stats.totalRounds).toBe(2);
    expect(stats.thoughtCount).toBe(1);
    expect(stats.totalActions).toBe(3);
    expect(stats.totalObservations).toBe(1);
    expect(stats.reflectionCount).toBe(1);
    expect(stats.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  test('toJSON 包含 rounds 和 stats', () => {
    trace.startRound(1);
    trace.endRound();

    const json = trace.toJSON();
    expect(json).toHaveProperty('rounds');
    expect(json).toHaveProperty('stats');
    expect(json.rounds).toHaveLength(1);
  });

  test('addAction 无当前轮次时安全跳过', () => {
    // 未 startRound 直接 addAction 不应抛错
    trace.addAction('dangling', {});
    expect(trace.getStats().totalActions).toBe(0);
  });

  // ─── Planning 方法 ─────────────────────────────────────
  describe('Planning', () => {
    test('setPlan 解析编号列表步骤', () => {
      const planText = [
        '1. 获取项目概览和目录结构，识别核心模块',
        '2. 搜索 BDBaseRequest 子类，分析网络请求模式',
        '3. 深入阅读典型实现文件，确认关键细节',
        '4. 总结分析发现',
      ].join('\n');

      trace.setPlan(planText, 1);
      const plan = trace.getPlan();

      expect(plan).not.toBeNull();
      expect(plan.steps).toHaveLength(4);
      expect(plan.steps[0].description).toContain('项目概览');
      expect(plan.steps[0].status).toBe('pending');
      expect(plan.createdAtIteration).toBe(1);
    });

    test('setPlan 提取 CamelCase 关键词', () => {
      trace.setPlan('1. 搜索 BDBaseRequest 子类', 1);
      const plan = trace.getPlan();

      expect(plan.steps[0].keywords).toContain('BDBaseRequest');
    });

    test('setPlan 提取反引号内的标识符', () => {
      trace.setPlan('1. 分析 `NetworkManager` 的实现逻辑', 1);
      const plan = trace.getPlan();

      expect(plan.steps[0].keywords).toContain('NetworkManager');
    });

    test('getPlan 返回只读副本', () => {
      trace.setPlan('1. 步骤一搜索项目结构\n2. 步骤二分析代码模式', 1);
      const plan1 = trace.getPlan();
      plan1.steps[0].status = 'done';

      const plan2 = trace.getPlan();
      expect(plan2.steps[0].status).toBe('pending'); // 原始未被修改
    });

    test('getPlanStepsMutable 返回可变引用', () => {
      trace.setPlan('1. 步骤一搜索项目结构\n2. 步骤二分析代码模式', 1);
      const steps = trace.getPlanStepsMutable();
      steps[0].status = 'done';

      const plan = trace.getPlan();
      expect(plan.steps[0].status).toBe('done'); // 原始被修改
    });

    test('updatePlan 保留旧 plan 到 history', () => {
      trace.setPlan('1. 旧步骤一搜索基础结构\n2. 旧步骤二查看依赖', 1);
      trace.updatePlan('1. 新步骤一深入网络层\n2. 新步骤二分析缓存策略', 5);

      const plan = trace.getPlan();
      expect(plan.steps[0].description).toContain('网络层');
      expect(plan.lastUpdatedAtIteration).toBe(5);

      const history = trace.getPlanHistory();
      expect(history).toHaveLength(1);
      expect(history[0].steps[0].description).toContain('基础结构');
    });

    test('updatePlan 无现有 plan 时等同 setPlan', () => {
      trace.updatePlan('1. 步骤一查看项目文件\n2. 步骤二分析模块结构', 3);

      const plan = trace.getPlan();
      expect(plan).not.toBeNull();
      expect(plan.createdAtIteration).toBe(3);
    });

    test('getPlan 无 plan 返回 null', () => {
      expect(trace.getPlan()).toBeNull();
    });

    test('getCurrentRoundActions 返回当前轮次的 actions', () => {
      trace.startRound(1);
      trace.addAction('search_project_code', { query: 'main' });
      trace.addAction('read_project_file', { filePath: 'a.js' });

      const actions = trace.getCurrentRoundActions();
      expect(actions).toHaveLength(2);
      expect(actions[0].tool).toBe('search_project_code');
    });

    test('getCurrentIteration 返回当前轮次编号', () => {
      trace.startRound(5);
      expect(trace.getCurrentIteration()).toBe(5);
    });

    test('toJSON 包含 plan 信息', () => {
      trace.startRound(1);
      trace.endRound();
      trace.setPlan('1. 获取概览了解项目\n2. 搜索核心类进行分析', 1);

      const json = trace.toJSON();
      expect(json).toHaveProperty('plan');
      expect(json.plan.steps).toHaveLength(2);
      expect(json).toHaveProperty('planHistory', 0);
    });

    test('过短的步骤被过滤（<= 5 字符）', () => {
      trace.setPlan('1. 做A\n2. 获取项目概览和目录结构', 1);
      const plan = trace.getPlan();
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].description).toContain('概览');
    });
  });
});

// ─── ReasoningTrace 新增方法 ────────────────────────────
describe('ReasoningTrace — 迁入方法', () => {
  let trace;

  beforeEach(() => {
    trace = new ReasoningTrace();
  });

  describe('extractAndSetPlan', () => {
    test('从包含计划标记的文本中提取 plan', () => {
      const text = [
        '我的探索计划：',
        '1. 获取项目概览和目录结构，识别核心模块',
        '2. 搜索网络请求相关类，分析请求模式',
        '3. 深入阅读关键文件，确认实现细节',
        '4. 总结分析发现',
        '',
        '让我先从概览开始。',
      ].join('\n');

      const result = trace.extractAndSetPlan(text, 1);
      expect(result).toBe(true);

      const plan = trace.getPlan();
      expect(plan).not.toBeNull();
      expect(plan.steps.length).toBeGreaterThanOrEqual(3);
      expect(plan.createdAtIteration).toBe(1);
    });

    test('从无标记但有编号列表的文本中提取 plan', () => {
      const text = [
        '好的，我来分析这个项目。',
        '',
        '1. 先获取项目概览了解整体结构',
        '2. 搜索关键模块和类的实现',
        '3. 深入核心文件验证细节',
        '4. 汇总分析结果',
        '',
        '开始执行...',
      ].join('\n');

      expect(trace.extractAndSetPlan(text, 2)).toBe(true);
      expect(trace.getPlan()).not.toBeNull();
    });

    test('更新已有 plan（调用 updatePlan）', () => {
      trace.setPlan('1. 旧步骤获取项目概览和目录结构信息\n2. 旧步骤搜索代码库中的关键实现', 1);

      const newText = [
        '更新探索计划如下：',
        '1. 新步骤深入分析网络模块的设计和实现',
        '2. 新步骤验证缓存策略和数据持久化逻辑',
      ].join('\n');

      expect(trace.extractAndSetPlan(newText, 5)).toBe(true);

      const plan = trace.getPlan();
      expect(plan.steps[0].description).toContain('网络模块');
      expect(plan.lastUpdatedAtIteration).toBe(5);

      const history = trace.getPlanHistory();
      expect(history).toHaveLength(1);
    });

    test('无计划文本返回 false', () => {
      expect(trace.extractAndSetPlan('让我直接开始搜索。', 1)).toBe(false);
      expect(trace.getPlan()).toBeNull();
    });

    test('过短的文本返回 false', () => {
      expect(trace.extractAndSetPlan('短文本', 1)).toBe(false);
    });
  });

  describe('buildObservationMeta (static)', () => {
    test('search_project_code — isNew=true', () => {
      const meta = ReasoningTrace.buildObservationMeta(
        'search_project_code',
        { query: 'test' },
        { matches: [{ file: 'a.js' }, { file: 'b.js' }] },
        true
      );
      expect(meta.resultType).toBe('search');
      expect(meta.gotNewInfo).toBe(true);
      expect(meta.keyFacts).toContain('2 matches found');
      expect(meta.keyFacts).toContain('new files discovered');
    });

    test('search_project_code — isNew=false', () => {
      const meta = ReasoningTrace.buildObservationMeta(
        'search_project_code',
        { query: 'test' },
        { matches: [{ file: 'a.js' }] },
        false
      );
      expect(meta.gotNewInfo).toBe(false);
      expect(meta.keyFacts).not.toContain('new files discovered');
    });

    test('read_project_file', () => {
      const meta = ReasoningTrace.buildObservationMeta(
        'read_project_file',
        { filePath: 'src/main.js' },
        'content…',
        true
      );
      expect(meta.resultType).toBe('file_content');
      expect(meta.gotNewInfo).toBe(true);
    });

    test('submit_knowledge 总是 gotNewInfo=true', () => {
      const meta = ReasoningTrace.buildObservationMeta(
        'submit_knowledge',
        { title: '测试' },
        { status: 'accepted' },
        false
      );
      expect(meta.resultType).toBe('submit');
      expect(meta.gotNewInfo).toBe(true);
      expect(meta.keyFacts[0]).toContain('测试');
    });

    test('list_project_structure', () => {
      const meta = ReasoningTrace.buildObservationMeta(
        'list_project_structure',
        { directory: '/src' },
        ['a.js', 'b.js'],
        true
      );
      expect(meta.resultType).toBe('structure');
    });

    test('AST 查询工具', () => {
      const meta = ReasoningTrace.buildObservationMeta(
        'get_class_info',
        { className: 'MyClass' },
        { methods: [] },
        true
      );
      expect(meta.resultType).toBe('ast_query');
      expect(meta.keyFacts[0]).toContain('MyClass');
    });

    test('未知工具保守假设', () => {
      const meta = ReasoningTrace.buildObservationMeta(
        'custom_tool',
        {},
        'result',
        true
      );
      expect(meta.resultType).toBe('other');
      expect(meta.gotNewInfo).toBe(true);
    });
  });
});

// ─── ExplorationTracker ─────────────────────────────────
describe('ExplorationTracker', () => {
  const DEFAULT_BUDGET = {
    maxIterations: 30,
    searchBudget: 8,
    searchBudgetGrace: 4,
    maxSubmits: 6,
    softSubmitLimit: 4,
    idleRoundsToExit: 2,
  };

  /** 快速创建 bootstrap tracker */
  function createTracker(strategyName = 'bootstrap', budgetOverrides = {}) {
    const budget = { ...DEFAULT_BUDGET, ...budgetOverrides };
    return ExplorationTracker.resolve(
      { source: 'system', strategy: strategyName },
      budget
    );
  }

  beforeEach(() => {
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
  });

  // ─── 静态工厂 resolve() ─────────────────────────────
  describe('resolve()', () => {
    test('source=user 返回 null', () => {
      const tracker = ExplorationTracker.resolve(
        { source: 'user' },
        DEFAULT_BUDGET
      );
      expect(tracker).toBeNull();
    });

    test('strategy=bootstrap 创建 bootstrap 策略', () => {
      const tracker = createTracker('bootstrap');
      expect(tracker).toBeInstanceOf(ExplorationTracker);
      expect(tracker.strategyName).toBe('bootstrap');
      expect(tracker.phase).toBe('EXPLORE');
    });

    test('strategy=analyst 创建 analyst 策略', () => {
      const tracker = createTracker('analyst');
      expect(tracker.strategyName).toBe('analyst');
      expect(tracker.phase).toBe('SCAN');
    });

    test('strategy=producer 创建 producer 策略', () => {
      const tracker = createTracker('producer');
      expect(tracker.strategyName).toBe('producer');
      expect(tracker.phase).toBe('PRODUCE');
    });

    test('skill-only 模式 → bootstrap 无 PRODUCE 阶段', () => {
      const tracker = ExplorationTracker.resolve(
        { source: 'system', dimensionMeta: { outputType: 'skill' } },
        DEFAULT_BUDGET
      );
      expect(tracker.strategyName).toBe('bootstrap');
      // skill-only 的 EXPLORE 应直接转到 SUMMARIZE，而非 PRODUCE
      // 通过 getToolChoice 测试: 不应出现 PRODUCE 阶段行为
      expect(tracker.phase).toBe('EXPLORE');
    });
  });

  // ─── tick / rollbackTick ──────────────────────────────
  describe('tick / rollbackTick', () => {
    test('tick 递增 iteration', () => {
      const tracker = createTracker();
      expect(tracker.iteration).toBe(0);
      tracker.tick();
      expect(tracker.iteration).toBe(1);
      tracker.tick();
      expect(tracker.iteration).toBe(2);
    });

    test('rollbackTick 撤销', () => {
      const tracker = createTracker();
      tracker.tick();
      tracker.tick();
      expect(tracker.iteration).toBe(2);
      tracker.rollbackTick();
      expect(tracker.iteration).toBe(1);
    });

    test('rollbackTick 安全 — 未 tick 时不操作', () => {
      const tracker = createTracker();
      tracker.tick();
      tracker.rollbackTick();
      tracker.rollbackTick(); // 重复 rollback
      expect(tracker.iteration).toBe(0);
    });
  });

  // ─── recordToolCall ────────────────────────────────────
  describe('recordToolCall', () => {
    test('search_project_code 新文件 → isNew=true', () => {
      const tracker = createTracker();
      tracker.tick();
      const { isNew } = tracker.recordToolCall(
        'search_project_code',
        { pattern: 'BDRequest' },
        { matches: [{ file: 'a.js' }, { file: 'b.js' }] }
      );
      expect(isNew).toBe(true);
    });

    test('search_project_code 重复模式+文件 → isNew=false', () => {
      const tracker = createTracker();
      tracker.tick();
      tracker.recordToolCall(
        'search_project_code',
        { pattern: 'BDRequest' },
        { matches: [{ file: 'a.js' }] }
      );
      const { isNew } = tracker.recordToolCall(
        'search_project_code',
        { pattern: 'BDRequest' },
        { matches: [{ file: 'a.js' }] }
      );
      expect(isNew).toBe(false);
    });

    test('read_project_file 首次 → isNew=true', () => {
      const tracker = createTracker();
      tracker.tick();
      const { isNew } = tracker.recordToolCall(
        'read_project_file',
        { filePath: 'src/main.js' },
        'content'
      );
      expect(isNew).toBe(true);
    });

    test('submit_knowledge 成功 → 增加 submitCount', () => {
      const tracker = createTracker();
      tracker.tick();
      expect(tracker.totalSubmits).toBe(0);
      tracker.recordToolCall(
        'submit_knowledge',
        { title: '测试' },
        { status: 'accepted' }
      );
      expect(tracker.totalSubmits).toBe(1);
    });

    test('submit_knowledge rejected → 不增加 submitCount', () => {
      const tracker = createTracker();
      tracker.tick();
      tracker.recordToolCall(
        'submit_knowledge',
        { title: '测试' },
        { status: 'rejected' }
      );
      expect(tracker.totalSubmits).toBe(0);
    });
  });

  // ─── shouldExit ──────────────────────────────────────
  describe('shouldExit', () => {
    test('初始状态不退出', () => {
      const tracker = createTracker();
      tracker.tick();
      expect(tracker.shouldExit()).toBe(false);
    });

    test('maxIterations+2 硬上限退出', () => {
      const tracker = createTracker('bootstrap', { maxIterations: 3 });
      // 迭代到 maxIterations+2 = 5
      for (let i = 0; i < 5; i++) {
        tracker.tick();
        if (tracker.shouldExit()) return; // 允许提前退出
        tracker.endRound({ hasNewInfo: true, submitCount: 0, toolNames: ['search_project_code'] });
      }
      tracker.tick();
      expect(tracker.shouldExit()).toBe(true);
    });

    test('终结阶段 + 2 轮 grace → 退出', () => {
      const tracker = createTracker('producer');
      // 推进到 SUMMARIZE: 提交足够多次
      tracker.tick();
      for (let i = 0; i < 7; i++) {
        tracker.recordToolCall('submit_knowledge', { title: `t${i}` }, { status: 'ok' });
      }
      tracker.endRound({ hasNewInfo: false, submitCount: 7, toolNames: ['submit_knowledge'] });
      // 此时应该转到 SUMMARIZE
      expect(tracker.phase).toBe('SUMMARIZE');

      // Grace 轮次
      tracker.tick();
      expect(tracker.shouldExit()).toBe(false); // phaseRounds=1
      tracker.endRound();
      tracker.tick();
      expect(tracker.shouldExit()).toBe(true);  // phaseRounds=2
    });
  });

  // ─── endRound ─────────────────────────────────────────
  describe('endRound', () => {
    test('hasNewInfo=false 增加 roundsSinceNewInfo', () => {
      const tracker = createTracker();
      tracker.tick();
      tracker.endRound({ hasNewInfo: false, submitCount: 0 });
      const metrics = tracker.getMetrics();
      expect(metrics.roundsSinceNewInfo).toBe(1);
    });

    test('hasNewInfo=true 重置 roundsSinceNewInfo', () => {
      const tracker = createTracker();
      tracker.tick();
      tracker.endRound({ hasNewInfo: false, submitCount: 0 });
      tracker.tick();
      tracker.endRound({ hasNewInfo: true, submitCount: 0 });
      const metrics = tracker.getMetrics();
      expect(metrics.roundsSinceNewInfo).toBe(0);
    });

    test('满足阶段转换条件时返回 nudge', () => {
      const tracker = createTracker('bootstrap');
      // 模拟搜索到 searchBudget 轮次 → EXPLORE→PRODUCE 转换
      for (let i = 0; i < 8; i++) {
        tracker.tick();
        tracker.endRound({ hasNewInfo: true, submitCount: 0, toolNames: ['search_project_code'] });
      }
      // 到达 searchBudget=8，应触发 EXPLORE→PRODUCE
      expect(tracker.phase).toBe('PRODUCE');
    });

    test('skipped=true 不更新指标', () => {
      const tracker = createTracker();
      tracker.tick();
      const result = tracker.endRound({ skipped: true });
      expect(result).toBeNull();
      const metrics = tracker.getMetrics();
      expect(metrics.roundsSinceNewInfo).toBe(0);
    });
  });

  // ─── getNudge ─────────────────────────────────────────
  describe('getNudge', () => {
    test('第 1 轮触发 planning nudge (bootstrap)', () => {
      const tracker = createTracker('bootstrap');
      tracker.tick();
      const trace = new ReasoningTrace();
      const nudge = tracker.getNudge(trace);
      expect(nudge).not.toBeNull();
      expect(nudge.type).toBe('planning');
      expect(nudge.text).toContain('探索计划');
      expect(nudge.text).toContain('30 轮');
    });

    test('周期性反思 — 第 5 轮触发', () => {
      const tracker = createTracker('bootstrap');
      const trace = new ReasoningTrace();

      // 填充 1-4 轮
      for (let i = 1; i <= 4; i++) {
        tracker.tick();
        trace.startRound(i);
        tracker.recordToolCall('search_project_code', { pattern: `p${i}` }, { matches: [{ file: `f${i}.js` }] });
        trace.addAction('search_project_code', { pattern: `p${i}` });
        trace.addObservation('search_project_code', { gotNewInfo: true, resultType: 'search', keyFacts: [], resultSize: 100 });
        trace.endRound();
        tracker.endRound({ hasNewInfo: true, submitCount: 0, toolNames: ['search_project_code'] });
      }

      // 第 5 轮
      tracker.tick();
      trace.startRound(5);
      const nudge = tracker.getNudge(trace);
      expect(nudge).not.toBeNull();
      expect(nudge.type).toBe('reflection');
      expect(nudge.text).toContain('中期反思');
    });

    test('停滞反思 — 连续无新信息', () => {
      const tracker = createTracker('bootstrap');
      const trace = new ReasoningTrace();

      // 填充 4 轮无新信息（需要 MIN_ITERS_FOR_STALE_REFLECTION=4）
      for (let i = 1; i <= 4; i++) {
        tracker.tick();
        trace.startRound(i);
        trace.addAction('search_project_code', { pattern: `p${i}` });
        trace.addObservation('search_project_code', { gotNewInfo: false, resultType: 'search', keyFacts: [], resultSize: 100 });
        trace.endRound();
        tracker.endRound({ hasNewInfo: false, submitCount: 0, toolNames: ['search_project_code'] });
      }

      // 第 5 轮 — 应出现停滞反思（iteration>=4, roundsSinceNewInfo>=2, reflection interval=5）
      tracker.tick();
      trace.startRound(5);
      const nudge = tracker.getNudge(trace);
      expect(nudge).not.toBeNull();
      // 可能是停滞反思或周期反思（iter=5 同时命中两个条件）
      expect(nudge.type).toBe('reflection');
    });

    test('预算警告 — 75% 时触发一次', () => {
      const tracker = createTracker('bootstrap', { maxIterations: 8 });
      const trace = new ReasoningTrace();

      // 填充到第 6 轮（75% of 8 = 6）
      for (let i = 1; i <= 5; i++) {
        tracker.tick();
        trace.startRound(i);
        trace.addAction('search_project_code', { pattern: `p${i}` });
        trace.endRound();
        tracker.endRound({ hasNewInfo: true, submitCount: 0, toolNames: ['search_project_code'] });
      }

      // 第 6 轮 — reflection interval=5 也会命中
      tracker.tick();
      trace.startRound(6);
      const nudge6 = tracker.getNudge(trace);
      // 反思优先级高于 budget_warning，第 5 轮命中反思，第 6 轮可能是 budget_warning
      // 实际：第 5 轮是 nudge 在第 5 轮 tick 后获取，第 6 轮 tick 后检查
      // iteration=6, 6 >= floor(8*0.75)=6 → budget_warning
      // 但 reflection: 6 % 5 != 0 → 不触发
      expect(nudge6).not.toBeNull();
      expect(nudge6.type).toBe('budget_warning');
    });

    test('producer 策略不触发反思和规划', () => {
      const tracker = createTracker('producer');
      const trace = new ReasoningTrace();
      tracker.tick();
      trace.startRound(1);
      const nudge = tracker.getNudge(trace);
      expect(nudge).toBeNull(); // producer 禁用 reflection + planning
    });
  });

  // ─── onTextResponse ───────────────────────────────────
  describe('onTextResponse', () => {
    test('终结阶段 → isFinalAnswer=true', () => {
      const tracker = createTracker('producer');
      // 推进到 SUMMARIZE
      tracker.tick();
      for (let i = 0; i < 7; i++) {
        tracker.recordToolCall('submit_knowledge', { title: `t${i}` }, { status: 'ok' });
      }
      tracker.endRound({ hasNewInfo: false, submitCount: 7, toolNames: ['submit_knowledge'] });
      expect(tracker.phase).toBe('SUMMARIZE');

      // SUMMARIZE 阶段收到文本
      tracker.tick();
      const result = tracker.onTextResponse();
      // 刚转入 → needsDigestNudge
      // 但由于 endRound 时已经 justTransitioned=false 了，所以这里 onTextResponse 会检查 checkTextTransition
      // 实际上 onTextResponse 先调 checkTextTransition，此时 phase 已经是 SUMMARIZE 且没有下一阶段
      // 所以 transitioned=false, isTerminal=true → isFinalAnswer=true
      expect(result.isFinalAnswer).toBe(true);
      expect(result.shouldContinue).toBe(false);
    });

    test('非终结阶段-EXPLORE → shouldContinue=true', () => {
      const tracker = createTracker('bootstrap');
      tracker.tick();
      const result = tracker.onTextResponse();
      // EXPLORE 阶段文本 → 转到 PRODUCE(因为onTextResponse=true)
      // 刚转入终结？不，PRODUCE 不是终结
      // 先看 checkTextTransition: EXPLORE→PRODUCE 的 onTextResponse=true → 转了
      // isTerminal(PRODUCE)? No → isTerminal && transitioned → false
      // phase === 'PRODUCE' → nudge 注入提交引导
      expect(result.shouldContinue).toBe(true);
    });

    test('PRODUCE 阶段文本 + softSubmitLimit 未达 → 继续', () => {
      const tracker = createTracker('bootstrap');
      // 先手动推进到 PRODUCE
      for (let i = 0; i < 8; i++) {
        tracker.tick();
        tracker.endRound({ hasNewInfo: true, submitCount: 0, toolNames: ['search_project_code'] });
      }
      expect(tracker.phase).toBe('PRODUCE');

      tracker.tick();
      const result = tracker.onTextResponse();
      // PRODUCE→SUMMARIZE 的 onTextResponse 条件: submitCount >= softSubmitLimit(4)
      // 当前 submitCount=0 < 4 → 不转
      // phase='PRODUCE' → nudge 注入提交引导
      expect(result.shouldContinue).toBe(true);
      expect(result.nudge).not.toBeNull();
      expect(result.nudge).toContain('submit_knowledge');
    });
  });

  // ─── getToolChoice ────────────────────────────────────
  describe('getToolChoice', () => {
    test('EXPLORE → required', () => {
      const tracker = createTracker('bootstrap');
      expect(tracker.getToolChoice()).toBe('required');
    });

    test('PRODUCE → auto', () => {
      const tracker = createTracker('producer');
      expect(tracker.getToolChoice()).toBe('auto');
    });

    test('SUMMARIZE → none', () => {
      const tracker = createTracker('producer');
      // 推进到 SUMMARIZE
      tracker.tick();
      for (let i = 0; i < 7; i++) {
        tracker.recordToolCall('submit_knowledge', { title: `t${i}` }, { status: 'ok' });
      }
      tracker.endRound({ hasNewInfo: false, submitCount: 7, toolNames: ['submit_knowledge'] });
      expect(tracker.phase).toBe('SUMMARIZE');
      expect(tracker.getToolChoice()).toBe('none');
    });
  });

  // ─── getPhaseContext ──────────────────────────────────
  describe('getPhaseContext', () => {
    test('返回包含进度信息的字符串', () => {
      const tracker = createTracker();
      tracker.tick();
      const ctx = tracker.getPhaseContext();
      expect(ctx).toContain('1/30');
    });

    test('接近上限时包含紧急警告', () => {
      const tracker = createTracker('bootstrap', { maxIterations: 4 });
      tracker.tick();
      tracker.endRound({ hasNewInfo: true, submitCount: 0, toolNames: ['search_project_code'] });
      tracker.tick();
      tracker.endRound({ hasNewInfo: true, submitCount: 0, toolNames: ['search_project_code'] });
      tracker.tick();
      const ctx = tracker.getPhaseContext();
      // iteration=3, remaining=1 → ⚠️ 紧急
      expect(ctx).toContain('⚠️');
    });
  });

  // ─── graceful exit ────────────────────────────────────
  describe('graceful exit', () => {
    test('初始 isGracefulExit=false', () => {
      const tracker = createTracker();
      expect(tracker.isGracefulExit).toBe(false);
      expect(tracker.isHardExit).toBe(false);
    });

    test('maxIterations 到达时标记 graceful exit', () => {
      const tracker = createTracker('bootstrap', { maxIterations: 3 });
      for (let i = 0; i < 3; i++) {
        tracker.tick();
        tracker.endRound({ hasNewInfo: true, submitCount: 0, toolNames: ['search_project_code'] });
      }
      // iteration=3 = maxIterations → shouldExit 中强制转入终结阶段
      tracker.tick(); // iteration=4 > maxIterations → 但先检查 shouldExit
      // 此处 shouldExit 会检查 iteration >= maxIterations 且非终结 → 强制转入 SUMMARIZE
      const shouldExit = tracker.shouldExit();
      expect(tracker.isGracefulExit).toBe(true);
      expect(shouldExit).toBe(false); // grace 轮次还未耗尽
    });
  });

  // ─── Planning 功能 ────────────────────────────────────
  describe('Planning', () => {
    test('第 1 轮注入 plan elicitation', () => {
      const tracker = createTracker('bootstrap');
      tracker.tick();
      const trace = new ReasoningTrace();
      const nudge = tracker.getNudge(trace);
      expect(nudge).not.toBeNull();
      expect(nudge.type).toBe('planning');
      expect(nudge.text).toContain('📋');
      expect(nudge.text).toContain('30 轮');
    });

    test('第 2 轮不重复注入 plan prompt', () => {
      const tracker = createTracker('bootstrap');
      const trace = new ReasoningTrace();

      // 第 1 轮
      tracker.tick();
      trace.startRound(1);
      tracker.getNudge(trace); // 消耗 planning nudge
      trace.endRound();
      tracker.endRound({ hasNewInfo: true, submitCount: 0, toolNames: ['search_project_code'] });

      // 第 2 轮
      tracker.tick();
      trace.startRound(2);
      const nudge = tracker.getNudge(trace);
      expect(nudge).toBeNull(); // 无 nudge
    });

    test('updatePlanProgress 追踪匹配步骤', () => {
      const tracker = createTracker('bootstrap');
      const trace = new ReasoningTrace();

      // 设置 plan
      trace.setPlan(
        '1. 获取项目概览和结构信息，了解核心模块\n2. 搜索网络请求相关类的实现代码\n3. 总结分析发现并提交候选',
        1
      );

      // 模拟执行 get_project_overview
      trace.startRound(1);
      trace.addAction('get_project_overview', {});

      tracker.updatePlanProgress(trace);
      const progress = tracker.getPlanProgress();
      expect(progress.coveredSteps).toBe(1); // 匹配第 1 步
      expect(progress.consecutiveOffPlan).toBe(0);
    });

    test('updatePlanProgress 追踪计划外行为', () => {
      const tracker = createTracker('bootstrap');
      const trace = new ReasoningTrace();

      trace.setPlan(
        '1. 获取项目概览和目录结构，识别核心模块\n2. 搜索核心类的实现和分析模式',
        1
      );

      // 第 1 轮：匹配
      trace.startRound(1);
      trace.addAction('get_project_overview', {});
      tracker.updatePlanProgress(trace);
      trace.endRound();

      // 第 2 轮：不匹配
      trace.startRound(2);
      trace.addAction('completely_unknown_tool_xyz', { random: true });
      tracker.updatePlanProgress(trace);

      const progress = tracker.getPlanProgress();
      expect(progress.unplannedActions).toBeGreaterThan(0);
    });

    test('关键词匹配', () => {
      const tracker = createTracker('bootstrap');
      const trace = new ReasoningTrace();

      trace.setPlan(
        '1. 搜索 `BDBaseRequest` 子类，分析网络请求模式和继承关系\n2. 获取项目概览，了解整体结构和模块划分',
        1
      );

      trace.startRound(1);
      trace.addAction('search_project_code', { query: 'BDBaseRequest' });
      tracker.updatePlanProgress(trace);

      const progress = tracker.getPlanProgress();
      expect(progress.coveredSteps).toBe(1);
    });

    test('周期性 replan 触发', () => {
      const tracker = createTracker('bootstrap', { maxIterations: 30 });
      const trace = new ReasoningTrace();

      // 第 1 轮：设置 plan
      tracker.tick();
      trace.startRound(1);
      trace.extractAndSetPlan(
        '好的，我来制定一个详细的探索计划：\n1. 获取项目概览，识别核心模块和依赖关系\n2. 搜索核心类的实现，进行模式分析',
        1
      );
      trace.endRound();
      tracker.endRound({ hasNewInfo: true, submitCount: 0, toolNames: ['search_project_code'] });

      // 填充 2-8 轮
      for (let i = 2; i <= 8; i++) {
        tracker.tick();
        trace.startRound(i);
        trace.addAction('search_project_code', { pattern: `p${i}` });
        trace.endRound();
        tracker.endRound({ hasNewInfo: true, submitCount: 0, toolNames: ['search_project_code'] });
      }

      // 第 9 轮应触发 replan（距 plan 创建于第 1 轮已过 8 轮）
      tracker.tick();
      trace.startRound(9);
      const nudge = tracker.getNudge(trace);
      expect(nudge).not.toBeNull();
      expect(nudge.type).toBe('planning');
      expect(nudge.text).toContain('计划');
    });
  });

  // ─── 质量评分 ──────────────────────────────────────────
  describe('getQualityMetrics', () => {
    test('完整 ReAct 周期得到高分', () => {
      const tracker = createTracker('bootstrap');
      const trace = new ReasoningTrace();

      for (let i = 1; i <= 3; i++) {
        tracker.tick();
        trace.startRound(i);
        trace.setThought('长推理文本足够20字符以上的内容用于测试');
        trace.addAction('submit_knowledge', { title: `t${i}` });
        trace.addObservation('submit_knowledge', {
          gotNewInfo: true,
          resultType: 'submit',
          keyFacts: [`submit "${i}": ok`],
          resultSize: 100,
        });
        tracker.recordToolCall('submit_knowledge', { title: `t${i}` }, { status: 'ok' });
        trace.endRound();
        tracker.endRound({ hasNewInfo: true, submitCount: 1, toolNames: ['submit_knowledge'] });
      }

      const metrics = tracker.getQualityMetrics(trace);
      expect(metrics.score).toBeGreaterThan(50);
      expect(metrics.breakdown.thoughtRatio).toBe(100);
    });

    test('空 trace 返回 0 分', () => {
      const tracker = createTracker();
      const trace = new ReasoningTrace();
      const metrics = tracker.getQualityMetrics(trace);
      expect(metrics.score).toBe(0);
    });

    test('有 plan 时包含 planScore', () => {
      const tracker = createTracker('bootstrap');
      const trace = new ReasoningTrace();

      trace.setPlan(
        '1. 获取项目概览和目录结构，识别核心模块\n2. 搜索网络请求模式和接口设计',
        1
      );

      // 执行 1 轮匹配 plan
      tracker.tick();
      trace.startRound(1);
      trace.setThought('先获取概览');
      trace.addAction('get_project_overview', {});
      trace.addObservation('get_project_overview', {
        gotNewInfo: true,
        resultType: 'overview',
        keyFacts: ['project overview'],
        resultSize: 500,
      });
      tracker.recordToolCall('get_project_overview', {}, { files: 10 });
      tracker.updatePlanProgress(trace);
      trace.endRound();
      tracker.endRound({ hasNewInfo: true, submitCount: 0, toolNames: ['get_project_overview'] });

      const metrics = tracker.getQualityMetrics(trace);
      expect(metrics.breakdown).toHaveProperty('planCompletion');
      expect(metrics.breakdown).toHaveProperty('planAdherence');
      expect(metrics.breakdown).toHaveProperty('planScore');
      expect(metrics.breakdown.planCompletion).toBe(50); // 1/2 步骤
    });
  });

  // ─── Analyst 策略特定 ─────────────────────────────────
  describe('Analyst 策略', () => {
    test('SCAN → EXPLORE 在 iteration>=3 时转换', () => {
      const tracker = createTracker('analyst');
      expect(tracker.phase).toBe('SCAN');

      for (let i = 0; i < 3; i++) {
        tracker.tick();
        tracker.endRound({ hasNewInfo: true, submitCount: 0, toolNames: ['get_project_overview'] });
      }
      expect(tracker.phase).toBe('EXPLORE');
    });

    test('SCAN 阶段 toolChoice=required', () => {
      const tracker = createTracker('analyst');
      expect(tracker.getToolChoice()).toBe('required');
    });

    test('SCAN 阶段 onTextResponse 不触发转换', () => {
      const tracker = createTracker('analyst');
      tracker.tick();
      const result = tracker.onTextResponse();
      expect(tracker.phase).toBe('SCAN'); // 仍在 SCAN
      expect(result.shouldContinue).toBe(true);
    });
  });
});
