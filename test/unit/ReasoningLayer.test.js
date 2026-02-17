/**
 * ReasoningTrace + ReasoningLayer 单元测试
 */
import { jest } from '@jest/globals';

// ── mock Logger ──────────────────────────────────────────
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../lib/infrastructure/logging/Logger.js', () => ({
  default: { getInstance: () => mockLogger },
}));

const { ReasoningTrace } = await import('../../lib/service/chat/ReasoningTrace.js');
const { ReasoningLayer }  = await import('../../lib/service/chat/ReasoningLayer.js');

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
    trace.addObservation('search_project_code', { gotNewInfo: true, resultType: 'search', keyFacts: ['5 matches'], resultSize: 200 });
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
      if (i % 2 === 1) trace.setThought(`想法 ${i}`);
      trace.addAction('tool_' + i, {});
      trace.addObservation('tool_' + i, { gotNewInfo: i <= 3 });
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

// ─── ReasoningLayer ─────────────────────────────────────
describe('ReasoningLayer', () => {
  let layer;

  beforeEach(() => {
    mockLogger.info.mockClear();
    layer = new ReasoningLayer();
  });

  describe('生命周期 hooks', () => {
    test('beforeAICall 开始新轮次', () => {
      const nudge = layer.beforeAICall(1);
      expect(nudge).toBeNull(); // 第 1 轮不触发反思
      expect(layer.trace).toBeInstanceOf(ReasoningTrace);
    });

    test('afterAICall native 模式提取 thought', () => {
      layer.beforeAICall(1);
      layer.afterAICall({ text: '我需要先了解项目的整体结构，然后深入关键模块', functionCalls: [{ name: 'tool' }] }, 'native');
      layer.afterRound();

      const thoughts = layer.trace.getThoughts();
      expect(thoughts).toHaveLength(1);
      expect(thoughts[0].thought).toContain('项目的整体结构');
    });

    test('afterAICall native 模式 — 仅文本、无 functionCalls 时不记录 thought', () => {
      layer.beforeAICall(1);
      layer.afterAICall({ text: '纯文本回复' }, 'native');

      expect(layer.trace.getThoughts()).toHaveLength(0);
    });

    test('afterAICall text 模式提取 thought', () => {
      layer.beforeAICall(1);
      layer.afterAICall(
        '我先搜索一下关键文件来了解整体架构，看看有哪些核心模块。\n\n```action\nsearch_project_code\n{"query":"main"}\n```',
        'text'
      );
      layer.afterRound();

      const thoughts = layer.trace.getThoughts();
      expect(thoughts).toHaveLength(1);
      expect(thoughts[0].thought).toContain('搜索一下关键文件');
    });

    test('afterAICall text 模式 — 过短文本不记录', () => {
      layer.beforeAICall(1);
      layer.afterAICall('OK\n```action\ntool\n```', 'text');

      expect(layer.trace.getThoughts()).toHaveLength(0);
    });

    test('afterToolExec 记录 action + observation', () => {
      layer.beforeAICall(1);
      layer.afterToolExec('search_project_code', { query: 'main' }, { matches: [{ file: 'a.js' }] }, null);
      layer.afterRound();

      const json = layer.trace.toJSON();
      expect(json.rounds[0].actions).toHaveLength(1);
      expect(json.rounds[0].observations).toHaveLength(1);
      expect(json.rounds[0].observations[0].resultType).toBe('search');
    });

    test('afterRound 关闭轮次并写入摘要', () => {
      layer.beforeAICall(1);
      layer.afterRound({ newInfoCount: 2, totalCalls: 3, submitCount: 1 });

      const json = layer.trace.toJSON();
      expect(json.rounds[0].roundSummary).toEqual({
        newInfoCount: 2,
        totalCalls: 3,
        submits: 1,
        cumulativeFiles: 0,
        cumulativePatterns: 0,
      });
    });
  });

  describe('观察构建 (#buildObservationMeta)', () => {
    test('search_project_code 检测新文件', () => {
      const uniqueFiles = new Set(['existing.js']);
      layer.beforeAICall(1);
      layer.afterToolExec(
        'search_project_code',
        { query: 'test' },
        { matches: [{ file: 'existing.js' }, { file: 'new.js' }] },
        { uniqueFiles },
      );
      layer.afterRound();

      const obs = layer.trace.toJSON().rounds[0].observations[0];
      expect(obs.gotNewInfo).toBe(true);
      expect(obs.keyFacts).toContain('2 matches found');
      expect(obs.keyFacts).toContain('1 new files');
    });

    test('search_project_code 无新文件', () => {
      const uniqueFiles = new Set(['a.js']);
      layer.beforeAICall(1);
      layer.afterToolExec(
        'search_project_code',
        { query: 'test' },
        { matches: [{ file: 'a.js' }] },
        { uniqueFiles },
      );
      layer.afterRound();

      const obs = layer.trace.toJSON().rounds[0].observations[0];
      expect(obs.gotNewInfo).toBe(false);
    });

    test('read_project_file 记录读取操作', () => {
      layer.beforeAICall(1);
      layer.afterToolExec('read_project_file', { filePath: 'src/main.js' }, 'content…', null);
      layer.afterRound();

      const obs = layer.trace.toJSON().rounds[0].observations[0];
      expect(obs.resultType).toBe('file_content');
      expect(obs.gotNewInfo).toBe(true);
    });

    test('submit_knowledge 总是 gotNewInfo', () => {
      layer.beforeAICall(1);
      layer.afterToolExec('submit_knowledge', { title: '测试' }, { status: 'accepted' }, null);
      layer.afterRound();

      const obs = layer.trace.toJSON().rounds[0].observations[0];
      expect(obs.resultType).toBe('submit');
      expect(obs.gotNewInfo).toBe(true);
      expect(obs.keyFacts[0]).toContain('测试');
    });

    test('list_project_structure', () => {
      layer.beforeAICall(1);
      layer.afterToolExec('list_project_structure', { directory: '/src' }, ['a.js', 'b.js'], null);
      layer.afterRound();

      const obs = layer.trace.toJSON().rounds[0].observations[0];
      expect(obs.resultType).toBe('structure');
    });

    test('AST 查询工具', () => {
      layer.beforeAICall(1);
      layer.afterToolExec('get_class_info', { className: 'MyClass' }, { methods: [] }, null);
      layer.afterRound();

      const obs = layer.trace.toJSON().rounds[0].observations[0];
      expect(obs.resultType).toBe('ast_query');
      expect(obs.keyFacts[0]).toContain('MyClass');
    });

    test('未知工具保守假设 gotNewInfo=true', () => {
      layer.beforeAICall(1);
      layer.afterToolExec('custom_tool', {}, 'result', null);
      layer.afterRound();

      const obs = layer.trace.toJSON().rounds[0].observations[0];
      expect(obs.resultType).toBe('other');
      expect(obs.gotNewInfo).toBe(true);
    });
  });

  describe('反思触发', () => {
    test('第 1 轮不触发反思', () => {
      const nudge = layer.beforeAICall(1);
      expect(nudge).toBeNull();
    });

    test('周期性反思 — 第 5 轮触发', () => {
      // 先填充 4 轮历史
      for (let i = 1; i <= 4; i++) {
        layer.beforeAICall(i);
        layer.afterToolExec('tool', {}, 'res', null);
        layer.afterRound();
      }

      // 第 5 轮应触发
      const nudge = layer.beforeAICall(5);
      expect(nudge).not.toBeNull();
      expect(nudge).toContain('中期反思');
    });

    test('停滞反思 — staleRounds 达到阈值', () => {
      // 填充 4 轮（满足 MIN_ITERS_FOR_STALE_REFLECTION）
      for (let i = 1; i <= 3; i++) {
        layer.beforeAICall(i);
        layer.afterRound();
      }

      // 第 4 轮，staleRounds >= 2
      const nudge = layer.beforeAICall(4, {
        explorationMetrics: { staleRounds: 3 },
      });
      expect(nudge).not.toBeNull();
      expect(nudge).toContain('停滞反思');
    });

    test('反思禁用时不触发', () => {
      const disabled = new ReasoningLayer({ reflectionEnabled: false });
      for (let i = 1; i <= 4; i++) {
        disabled.beforeAICall(i);
        disabled.afterRound();
      }
      const nudge = disabled.beforeAICall(5);
      expect(nudge).toBeNull();
    });
  });

  describe('质量评分', () => {
    test('完整 ReAct 周期得到高分', () => {
      for (let i = 1; i <= 3; i++) {
        layer.beforeAICall(i);
        layer.afterAICall({ text: '长推理文本足够20字符以上的内容', functionCalls: [{ name: 't' }] }, 'native');
        layer.afterToolExec('submit_knowledge', { title: `t${i}` }, { status: 'ok' }, null);
        layer.afterRound({ newInfoCount: 1, totalCalls: 1, submitCount: 1 });
      }

      const metrics = layer.getQualityMetrics();
      expect(metrics.score).toBeGreaterThan(50);
      expect(metrics.breakdown.thoughtRatio).toBe(100);
    });

    test('空 trace 返回 0 分', () => {
      const metrics = layer.getQualityMetrics();
      expect(metrics.score).toBe(0);
    });
  });

  describe('enabled=false 全禁用', () => {
    let disabled;

    beforeEach(() => {
      disabled = new ReasoningLayer({ enabled: false });
    });

    test('所有 hooks 静默跳过', () => {
      const nudge = disabled.beforeAICall(1);
      expect(nudge).toBeNull();

      disabled.afterAICall({ text: 'hello', functionCalls: [{ name: 't' }] }, 'native');
      disabled.afterToolExec('tool', {}, 'result', null);
      disabled.afterRound();

      const stats = disabled.trace.getStats();
      expect(stats.totalRounds).toBe(0);
      expect(stats.totalActions).toBe(0);
    });
  });

  // ─── Planning 功能 ─────────────────────────────────────
  describe('Planning', () => {
    let planLayer;

    beforeEach(() => {
      mockLogger.info.mockClear();
      planLayer = new ReasoningLayer({
        planningEnabled: true,
        reflectionEnabled: false,
        replanInterval: 8,
        deviationThreshold: 0.6,
      });
    });

    test('第 1 轮注入 plan elicitation prompt', () => {
      const nudge = planLayer.beforeAICall(1, { budget: { maxIterations: 24 } });
      expect(nudge).not.toBeNull();
      expect(nudge).toContain('📋');
      expect(nudge).toContain('24 轮');
      expect(nudge).toContain('探索计划');
    });

    test('第 2 轮不注入 plan prompt（已经要求过）', () => {
      planLayer.beforeAICall(1, { budget: { maxIterations: 24 } });
      planLayer.afterAICall({ text: '短回复', functionCalls: [{ name: 't' }] }, 'native');
      planLayer.afterRound();

      const nudge = planLayer.beforeAICall(2);
      expect(nudge).toBeNull();
    });

    test('afterAICall 提取 plan 文本', () => {
      planLayer.beforeAICall(1, { budget: { maxIterations: 24 } });

      const aiText = [
        '我的探索计划：',
        '1. 获取项目概览和目录结构，识别核心模块',
        '2. 搜索网络请求相关类如 BDBaseRequest',
        '3. 深入阅读关键文件，分析错误处理模式',
        '4. 总结分析发现',
        '',
        '让我先从概览开始。',
      ].join('\n');

      planLayer.afterAICall({ text: aiText, functionCalls: [{ name: 'get_project_overview' }] }, 'native');

      const plan = planLayer.trace.getPlan();
      expect(plan).not.toBeNull();
      expect(plan.steps.length).toBeGreaterThanOrEqual(3);
      expect(plan.createdAtIteration).toBe(1);
    });

    test('afterAICall 无 plan 标记时回退到编号列表', () => {
      planLayer.beforeAICall(1, { budget: { maxIterations: 24 } });

      const aiText = [
        '好的，我来分析这个项目。',
        '',
        '1. 先获取项目概览了解整体结构',
        '2. 搜索关键模块和类的实现',
        '3. 深入核心文件验证细节',
        '4. 汇总分析结果',
        '',
        '开始执行...',
      ].join('\n');

      planLayer.afterAICall({ text: aiText, functionCalls: [{ name: 'get_project_overview' }] }, 'native');

      expect(planLayer.trace.getPlan()).not.toBeNull();
    });

    test('afterRound 更新 plan progress — 匹配到 plan 步骤', () => {
      // 设置 plan
      planLayer.beforeAICall(1, { budget: { maxIterations: 24 } });
      planLayer.afterAICall({
        text: '好的，我来制定一个详细的探索计划：\n1. 获取项目概览和结构信息，了解核心模块\n2. 搜索网络请求相关类的实现代码\n3. 总结分析发现并提交候选\n\n让我开始执行第一步。',
        functionCalls: [{ name: 'get_project_overview' }]
      }, 'native');
      planLayer.afterToolExec('get_project_overview', {}, { files: 100 }, null);
      planLayer.afterRound();

      const progress = planLayer.getPlanProgress();
      expect(progress.coveredSteps).toBe(1); // get_project_overview 匹配第 1 步
      expect(progress.consecutiveOffPlan).toBe(0);
    });

    test('afterRound 追踪计划外行为', () => {
      planLayer.beforeAICall(1);
      planLayer.afterAICall({
        text: '我来制定探索计划：\n1. 获取项目概览和目录结构，识别核心模块\n2. 搜索核心类的实现和分析模式\n\n让我从概览开始执行。',
        functionCalls: [{ name: 'get_project_overview' }]
      }, 'native');
      planLayer.afterToolExec('get_project_overview', {}, {}, null);
      planLayer.afterRound();

      // 第 2 轮: 执行一个完全不匹配的工具
      planLayer.beforeAICall(2);
      planLayer.afterToolExec('custom_unknown_tool', {}, 'result', null);
      planLayer.afterRound();

      const progress = planLayer.getPlanProgress();
      expect(progress.unplannedActions).toBeGreaterThan(0);
    });

    test('周期性 replan 触发', () => {
      // 设置 plan
      planLayer.beforeAICall(1, { budget: { maxIterations: 24 } });
      planLayer.afterAICall({
        text: '好的，我来制定一个详细的探索计划：\n1. 获取项目概览，识别核心模块和依赖关系\n2. 搜索核心类的实现，进行模式分析\n\n让我开始执行计划。',
        functionCalls: [{ name: 'tool' }]
      }, 'native');
      planLayer.afterRound();

      // 填充 2-8 轮
      for (let i = 2; i <= 8; i++) {
        planLayer.beforeAICall(i);
        planLayer.afterRound();
      }

      // 第 9 轮（距 plan 创建于第 1 轮已过 8 轮） 应触发 replan
      const nudge = planLayer.beforeAICall(9, { budget: { maxIterations: 24 } });
      expect(nudge).not.toBeNull();
      expect(nudge).toContain('计划');
    });

    test('偏差触发 replan — 连续 3 轮 off-plan', () => {
      const fastLayer = new ReasoningLayer({
        planningEnabled: true,
        reflectionEnabled: false,
        replanInterval: 100, // 禁用周期性 replan
        deviationThreshold: 0.6,
      });

      // 第 1 轮: 设置 plan
      fastLayer.beforeAICall(1);
      fastLayer.afterAICall({
        text: '好的，我来制定一个详细的探索计划：\n1. 获取项目概览，了解整体结构和核心模块\n2. 搜索核心类的实现，分析代码模式和设计\n\n让我从第一步开始。',
        functionCalls: [{ name: 'tool' }]
      }, 'native');
      fastLayer.afterRound();

      // 第 2-4 轮: 连续 off-plan（执行与 plan 不匹配的工具）
      for (let i = 2; i <= 4; i++) {
        fastLayer.beforeAICall(i);
        fastLayer.afterToolExec('completely_unknown_tool_xyz', { random: true }, 'r', null);
        fastLayer.afterRound();
      }

      // 第 5 轮: 应触发偏差 replan
      const nudge = fastLayer.beforeAICall(5);
      expect(nudge).not.toBeNull();
      expect(nudge).toContain('偏差');
    });

    test('replan 后 afterAICall 更新 plan', () => {
      planLayer.beforeAICall(1, { budget: { maxIterations: 24 } });
      planLayer.afterAICall({
        text: '好的，我来制定初始的探索计划：\n1. 旧步骤获取项目概览和目录结构信息\n2. 旧步骤搜索代码库中的关键实现\n\n让我开始执行。',
        functionCalls: [{ name: 'tool' }]
      }, 'native');
      planLayer.afterRound();

      // 填充到触发 replan
      for (let i = 2; i <= 8; i++) {
        planLayer.beforeAICall(i);
        planLayer.afterRound();
      }

      // 第 9 轮: 触发 replan
      planLayer.beforeAICall(9, { budget: { maxIterations: 24 } });

      // AI 返回新 plan
      planLayer.afterAICall({
        text: '根据发现，更新探索计划如下：\n1. 新步骤深入分析网络模块的设计和实现\n2. 新步骤验证缓存策略和数据持久化逻辑\n\n继续执行。',
        functionCalls: [{ name: 'tool' }]
      }, 'native');

      const plan = planLayer.trace.getPlan();
      expect(plan.steps[0].description).toContain('网络模块');
      expect(plan.lastUpdatedAtIteration).toBe(9);

      const history = planLayer.trace.getPlanHistory();
      expect(history).toHaveLength(1);
    });

    test('planningEnabled=false 时完全跳过', () => {
      const noPlan = new ReasoningLayer({ planningEnabled: false });
      const nudge = noPlan.beforeAICall(1);
      expect(nudge).toBeNull();

      noPlan.afterAICall({
        text: '好的，我来制定一个详细的探索计划：\n1. 步骤一搜索项目关键文件\n2. 步骤二分析核心代码模式\n\n开始执行。',
        functionCalls: [{ name: 't' }]
      }, 'native');
      expect(noPlan.trace.getPlan()).toBeNull();
    });

    test('质量评分包含 planScore', () => {
      planLayer.beforeAICall(1);
      planLayer.afterAICall({
        text: '好的，我来制定一个详细的探索计划：\n1. 获取项目概览和目录结构，识别核心模块\n2. 搜索网络请求模式和接口设计\n\n让我开始执行第一步。',
        functionCalls: [{ name: 'get_project_overview' }]
      }, 'native');
      planLayer.afterToolExec('get_project_overview', {}, { files: 10 }, null);
      planLayer.afterRound({ newInfoCount: 1, totalCalls: 1 });

      const metrics = planLayer.getQualityMetrics();
      expect(metrics.breakdown).toHaveProperty('planCompletion');
      expect(metrics.breakdown).toHaveProperty('planAdherence');
      expect(metrics.breakdown).toHaveProperty('planScore');
      expect(metrics.breakdown.planCompletion).toBe(50); // 1/2 步骤完成
    });

    test('Planning + Reflection 同时触发时合并', () => {
      const both = new ReasoningLayer({
        planningEnabled: true,
        reflectionEnabled: true,
        reflectionInterval: 5,
        replanInterval: 5,
      });

      // 第 1 轮设置 plan
      both.beforeAICall(1, { budget: { maxIterations: 24 } });
      both.afterAICall({
        text: '好的，我来制定一个详细的探索计划：\n1. 获取项目概览，识别核心模块和依赖关系\n2. 搜索核心类的实现，进行模式分析\n\n让我开始执行。',
        functionCalls: [{ name: 'tool' }]
      }, 'native');
      both.afterRound();

      // 填充 2-4 轮
      for (let i = 2; i <= 4; i++) {
        both.beforeAICall(i);
        both.afterToolExec('search_project_code', { query: `q${i}` }, { matches: [] }, null);
        both.afterRound();
      }

      // 第 5 轮: replanInterval=5 和 reflectionInterval=5 同时命中
      const nudge = both.beforeAICall(5, { budget: { maxIterations: 24 } });
      expect(nudge).not.toBeNull();
      // 应包含两部分内容
      expect(nudge).toContain('计划');
      expect(nudge).toContain('反思');
    });

    test('#extractPlanFromText — 无计划文本返回 null', () => {
      planLayer.beforeAICall(1);
      planLayer.afterAICall({
        text: '让我直接开始搜索。',
        functionCalls: [{ name: 'tool' }]
      }, 'native');

      expect(planLayer.trace.getPlan()).toBeNull();
    });

    test('#findMatchingStep — 关键词匹配', () => {
      planLayer.beforeAICall(1);
      planLayer.afterAICall({
        text: '好的，我来制定探索计划：\n1. 搜索 `BDBaseRequest` 子类，分析网络请求模式和继承关系\n2. 获取项目概览，了解整体结构和模块划分\n\n让我开始执行第一步。',
        functionCalls: [{ name: 'search_project_code' }]
      }, 'native');
      planLayer.afterToolExec('search_project_code', { query: 'BDBaseRequest' }, { matches: [] }, null);
      planLayer.afterRound();

      const progress = planLayer.getPlanProgress();
      expect(progress.coveredSteps).toBe(1);
    });

    test('text 模式同样支持 plan 提取', () => {
      planLayer.beforeAICall(1, { budget: { maxIterations: 24 } });

      const textResponse = [
        '我来制定一个探索计划：',
        '1. 获取项目概览识别核心模块',
        '2. 搜索网络请求实现代码',
        '3. 总结分析发现',
        '',
        '```action',
        'get_project_overview',
        '{}',
        '```',
      ].join('\n');

      planLayer.afterAICall(textResponse, 'text');

      const plan = planLayer.trace.getPlan();
      expect(plan).not.toBeNull();
      expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    });
  });
});
