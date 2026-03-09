/**
 * SkillRecommendation.test.ts — 信号收集 × Skill 推荐 × SkillHook 系统集成测试
 *
 * 覆盖:
 *   - SkillHooks v2 (4 执行模式、优先级、超时、新旧格式兼容)
 *   - FeedbackStore (记录、采纳率、偏好推导、频繁忽略、JSONL 持久化)
 *   - RecommendationPipeline (多策略召回、评分、排序、去重、过滤、Hook 集成)
 *   - RecommendationMetrics (展示/采纳/忽略计数、会话指标)
 *   - RuleRecallStrategy / AIRecallStrategy (RecallStrategy 接口适配)
 *   - 全链路连通性 (Pipeline → Strategy → Score → Filter → Hook → Feedback)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AIRecallStrategy } from '../../lib/service/skills/AIRecallStrategy.js';
import { FeedbackStore } from '../../lib/service/skills/FeedbackStore.js';
import { RecommendationMetrics } from '../../lib/service/skills/RecommendationMetrics.js';
import { RecommendationPipeline } from '../../lib/service/skills/RecommendationPipeline.js';
import { RuleRecallStrategy } from '../../lib/service/skills/RuleRecallStrategy.js';
import { SkillHooks } from '../../lib/service/skills/SkillHooks.js';
import type {
  RecallStrategy,
  RecommendationCandidate,
  RecommendationContext,
  ScoredRecommendation,
} from '../../lib/service/skills/types.js';

/* ════════════════════════════════════════════════════════════════════
 *  Helpers
 * ════════════════════════════════════════════════════════════════════ */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'asd-test-'));
}

/** 创建一个简单的 RecallStrategy mock */
function mockStrategy(
  name: string,
  candidates: RecommendationCandidate[],
  available = true
): RecallStrategy {
  return {
    name,
    type: 'rule',
    recall: vi.fn().mockResolvedValue(candidates),
    isAvailable: vi.fn().mockReturnValue(available),
  };
}

function makeCandidate(overrides: Partial<RecommendationCandidate> = {}): RecommendationCandidate {
  return {
    name: 'test-skill',
    description: 'A test skill',
    rationale: 'testing',
    source: 'rule:test',
    priority: 'medium',
    signals: {},
    ...overrides,
  };
}

/* ════════════════════════════════════════════════════════════════════
 *  SkillHooks v2
 * ════════════════════════════════════════════════════════════════════ */

describe('SkillHooks v2', () => {
  let hooks: SkillHooks;

  beforeEach(() => {
    hooks = new SkillHooks();
  });

  test('初始化: 所有 registry hooks 都已注册（为空列表）', () => {
    const registry = SkillHooks.getHookRegistry();
    expect(registry.length).toBeGreaterThanOrEqual(16);
    for (const def of registry) {
      expect(hooks.has(def.name)).toBe(false);
      expect(hooks.count(def.name)).toBe(0);
    }
  });

  test('tap: 手动注册 handler', () => {
    const fn = vi.fn();
    hooks.tap('onKnowledgeSubmit', fn, { name: 'test-handler', priority: 10 });
    expect(hooks.has('onKnowledgeSubmit')).toBe(true);
    expect(hooks.count('onKnowledgeSubmit')).toBe(1);
  });

  test('tap: 优先级排序', () => {
    const order: number[] = [];
    hooks.tap('onBootstrapComplete', () => order.push(3), { name: 'h3', priority: 300 });
    hooks.tap('onBootstrapComplete', () => order.push(1), { name: 'h1', priority: 10 });
    hooks.tap('onBootstrapComplete', () => order.push(2), { name: 'h2', priority: 100 });

    // 内部排序验证
    const handlers = hooks.hooks.get('onBootstrapComplete')!;
    expect(handlers.map((h) => h.name)).toEqual(['h1', 'h2', 'h3']);
  });

  test('getRegisteredHooks: 只返回有 handler 的 hooks', () => {
    expect(hooks.getRegisteredHooks()).toEqual([]);
    hooks.tap('onGuardCheck', vi.fn(), { name: 'test' });
    hooks.tap('onSearch', vi.fn(), { name: 'test2' });
    expect(hooks.getRegisteredHooks()).toContain('onGuardCheck');
    expect(hooks.getRegisteredHooks()).toContain('onSearch');
  });

  // ── Bail 模式 ──

  describe('bail 模式 (onKnowledgeSubmit)', () => {
    test('正常执行: 返回最后一个 handler 的返回值', async () => {
      hooks.tap('onKnowledgeSubmit', () => ({ ok: true }), { name: 'h1' });
      const result = await hooks.run('onKnowledgeSubmit', {}, {});
      expect(result).toEqual({ ok: true });
    });

    test('短路: block=true 立即终止', async () => {
      const h2 = vi.fn();
      hooks.tap('onKnowledgeSubmit', () => ({ block: true, reason: 'blocked' }), {
        name: 'h1',
        priority: 10,
      });
      hooks.tap('onKnowledgeSubmit', h2, { name: 'h2', priority: 100 });

      const result = await hooks.run('onKnowledgeSubmit', {}, {});
      expect(result).toEqual({ block: true, reason: 'blocked' });
      expect(h2).not.toHaveBeenCalled();
    });

    test('错误恢复: handler 抛错不阻塞后续', async () => {
      hooks.tap(
        'onKnowledgeSubmit',
        () => {
          throw new Error('boom');
        },
        { name: 'h1', priority: 10 }
      );
      hooks.tap('onKnowledgeSubmit', () => ({ ok: true }), { name: 'h2', priority: 100 });

      const result = await hooks.run('onKnowledgeSubmit', {}, {});
      expect(result).toEqual({ ok: true });
    });

    test('向后兼容 onCandidateSubmit (bail 模式)', async () => {
      hooks.tap('onCandidateSubmit', () => ({ block: true, reason: 'compat test' }), {
        name: 'compat',
      });
      const result = await hooks.run('onCandidateSubmit', {}, {});
      expect(result).toEqual({ block: true, reason: 'compat test' });
    });
  });

  // ── Waterfall 模式 ──

  describe('waterfall 模式 (onGuardCheck)', () => {
    test('传值链: 前一个返回值传给下一个', async () => {
      hooks.tap(
        'onGuardCheck',
        (violation: unknown) => ({
          ...(violation as Record<string, unknown>),
          modified: true,
        }),
        { name: 'h1', priority: 10 }
      );
      hooks.tap(
        'onGuardCheck',
        (violation: unknown) => ({
          ...(violation as Record<string, unknown>),
          severity: 'warning',
        }),
        { name: 'h2', priority: 100 }
      );

      const result = await hooks.run('onGuardCheck', { rule: 'no-var', severity: 'error' }, {});
      expect(result).toEqual({
        rule: 'no-var',
        severity: 'warning',
        modified: true,
      });
    });

    test('handler 返回 undefined 时保持当前值', async () => {
      hooks.tap('onGuardCheck', () => undefined, { name: 'noop' });
      const result = await hooks.run('onGuardCheck', { original: true });
      expect(result).toEqual({ original: true });
    });

    test('handler 抛错时继续传递当前值', async () => {
      hooks.tap(
        'onGuardCheck',
        () => {
          throw new Error('fail');
        },
        { name: 'broken', priority: 10 }
      );
      hooks.tap(
        'onGuardCheck',
        (v: unknown) => v, // 原样返回
        { name: 'passthrough', priority: 100 }
      );
      const result = await hooks.run('onGuardCheck', { severity: 'error' });
      expect(result).toEqual({ severity: 'error' });
    });
  });

  // ── Parallel 模式 ──

  describe('parallel 模式 (onKnowledgeCreated)', () => {
    test('所有 handler 并行执行', async () => {
      const calls: string[] = [];
      hooks.tap('onKnowledgeCreated', async () => calls.push('h1'), { name: 'h1' });
      hooks.tap('onKnowledgeCreated', async () => calls.push('h2'), { name: 'h2' });

      await hooks.run('onKnowledgeCreated', { id: '1' });
      expect(calls).toContain('h1');
      expect(calls).toContain('h2');
    });

    test('返回 undefined (fire-and-forget)', async () => {
      hooks.tap('onKnowledgeCreated', async () => 'some-value', { name: 'h1' });
      const result = await hooks.run('onKnowledgeCreated', {});
      expect(result).toBeUndefined();
    });

    test('单个 handler 抛错不影响其他', async () => {
      const calls: string[] = [];
      hooks.tap(
        'onKnowledgeCreated',
        async () => {
          throw new Error('fail');
        },
        { name: 'broken' }
      );
      hooks.tap('onKnowledgeCreated', async () => calls.push('ok'), { name: 'good' });

      await hooks.run('onKnowledgeCreated', {});
      expect(calls).toEqual(['ok']);
    });
  });

  // ── Series 模式 ──

  describe('series 模式 (onSkillLoad)', () => {
    test('按优先级顺序串行执行', async () => {
      const order: number[] = [];
      hooks.tap('onSkillLoad', async () => order.push(1), { name: 'h1', priority: 10 });
      hooks.tap('onSkillLoad', async () => order.push(2), { name: 'h2', priority: 100 });

      await hooks.run('onSkillLoad', { skillName: 'test' });
      expect(order).toEqual([1, 2]);
    });

    test('返回 undefined (忽略返回值)', async () => {
      hooks.tap('onSkillLoad', async () => 'some-value', { name: 'h1' });
      const result = await hooks.run('onSkillLoad', {});
      expect(result).toBeUndefined();
    });
  });

  // ── 超时 ──

  describe('超时处理', () => {
    test('handler 超时被跳过 (bail 模式)', async () => {
      hooks.tap('onKnowledgeSubmit', () => new Promise((resolve) => setTimeout(resolve, 5000)), {
        name: 'slow',
        timeout: 50,
      });
      hooks.tap('onKnowledgeSubmit', () => ({ ok: true }), { name: 'fast', priority: 200 });

      const result = await hooks.run('onKnowledgeSubmit', {});
      expect(result).toEqual({ ok: true });
    });
  });

  // ── 空 hooks ──

  test('对未注册的 hook 名称调用 run 返回 undefined', async () => {
    const result = await hooks.run('onBootstrapComplete');
    expect(result).toBeUndefined();
  });

  test('对不存在的 hook 名称 has 返回 false', () => {
    expect(hooks.has('nonexistent')).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════
 *  FeedbackStore
 * ════════════════════════════════════════════════════════════════════ */

describe('FeedbackStore', () => {
  let dir: string;
  let store: FeedbackStore;

  beforeEach(() => {
    dir = tmpDir();
    // FeedbackStore 需要 projectRoot，内部拼接 .autosnippet/feedback.jsonl
    fs.mkdirSync(path.join(dir, '.autosnippet'), { recursive: true });
    store = new FeedbackStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('初始状态: size=0, adoptionRate=0', () => {
    expect(store.size).toBe(0);
    expect(store.getAdoptionRate()).toBe(0);
  });

  test('record + size', async () => {
    await store.record({
      recommendationId: 'rec_1',
      action: 'adopted',
      timestamp: new Date().toISOString(),
    });
    expect(store.size).toBe(1);
  });

  test('采纳率计算', async () => {
    await store.record({
      recommendationId: 'r1',
      action: 'adopted',
      timestamp: new Date().toISOString(),
    });
    await store.record({
      recommendationId: 'r2',
      action: 'adopted',
      timestamp: new Date().toISOString(),
    });
    await store.record({
      recommendationId: 'r3',
      action: 'dismissed',
      timestamp: new Date().toISOString(),
    });

    // 2 adopted / (2 adopted + 1 dismissed) = 0.667
    expect(store.getAdoptionRate()).toBeCloseTo(2 / 3, 2);
  });

  test('按来源筛选采纳率', async () => {
    await store.record({
      recommendationId: 'r1',
      action: 'adopted',
      timestamp: '',
      source: 'rule',
    });
    await store.record({
      recommendationId: 'r2',
      action: 'dismissed',
      timestamp: '',
      source: 'rule',
    });
    await store.record({ recommendationId: 'r3', action: 'adopted', timestamp: '', source: 'ai' });

    expect(store.getAdoptionRate('rule')).toBeCloseTo(0.5, 2);
    expect(store.getAdoptionRate('ai')).toBe(1);
  });

  test('用户偏好推导', async () => {
    // 3 adopted + 0 dismissed in 'networking' → preferred
    for (let i = 0; i < 3; i++) {
      await store.record({
        recommendationId: `r_net_${i}`,
        action: 'adopted',
        timestamp: '',
        category: 'networking',
      });
    }
    // 0 adopted + 3 dismissed in 'logging' → avoided
    for (let i = 0; i < 3; i++) {
      await store.record({
        recommendationId: `r_log_${i}`,
        action: 'dismissed',
        timestamp: '',
        category: 'logging',
      });
    }

    const pref = store.getUserPreference();
    expect(pref.preferredCategories).toContain('networking');
    expect(pref.avoidedCategories).toContain('logging');
  });

  test('频繁忽略检测', async () => {
    // 需要至少 5 条且忽略率 >= 70%
    for (let i = 0; i < 5; i++) {
      await store.record({
        recommendationId: `r_${i}`,
        action: 'dismissed',
        timestamp: '',
        category: 'bad-category',
      });
    }
    expect(store.isFrequentlyDismissed('bad-category')).toBe(true);
    expect(store.isFrequentlyDismissed('unknown-category')).toBe(false);
  });

  test('JSONL 持久化 + 重新加载', async () => {
    await store.record({ recommendationId: 'r1', action: 'adopted', timestamp: '2026-01-01' });
    await store.record({ recommendationId: 'r2', action: 'dismissed', timestamp: '2026-01-02' });

    // 创建新实例 — 应从 JSONL 文件重新加载
    const store2 = new FeedbackStore(dir);
    expect(store2.size).toBe(2);
    expect(store2.getAdoptionRate()).toBeCloseTo(0.5, 2);
  });

  test('getFeedbackFor 按 recommendationId 过滤', async () => {
    await store.record({ recommendationId: 'r1', action: 'viewed', timestamp: '' });
    await store.record({ recommendationId: 'r1', action: 'adopted', timestamp: '' });
    await store.record({ recommendationId: 'r2', action: 'dismissed', timestamp: '' });

    const forR1 = store.getFeedbackFor('r1');
    expect(forR1).toHaveLength(2);
    expect(forR1.every((f) => f.recommendationId === 'r1')).toBe(true);
  });

  test('getMetricsSnapshot', async () => {
    await store.record({ recommendationId: 'r1', action: 'viewed', timestamp: '2026-01-01' });
    await store.record({ recommendationId: 'r1', action: 'adopted', timestamp: '2026-01-01' });
    await store.record({ recommendationId: 'r2', action: 'dismissed', timestamp: '2026-01-01' });
    await store.record({ recommendationId: 'r3', action: 'expired', timestamp: '2026-01-01' });

    const snap = store.getMetricsSnapshot();
    expect(snap.totalRecommendations).toBe(4);
    expect(snap.totalViewed).toBe(1);
    expect(snap.totalAdopted).toBe(1);
    expect(snap.totalDismissed).toBe(1);
    expect(snap.totalExpired).toBe(1);
    expect(snap.adoptionRate).toBeCloseTo(0.5, 2);
  });
});

/* ════════════════════════════════════════════════════════════════════
 *  RecommendationPipeline
 * ════════════════════════════════════════════════════════════════════ */

describe('RecommendationPipeline', () => {
  let pipeline: RecommendationPipeline;

  const baseContext: RecommendationContext = {
    projectRoot: '/tmp/test-project',
    existingSkills: new Set(['already-exists']),
  };

  beforeEach(() => {
    pipeline = new RecommendationPipeline();
  });

  test('无策略时返回空列表', async () => {
    const results = await pipeline.recommend(baseContext);
    expect(results).toEqual([]);
  });

  test('单策略召回 + 评分 + 排序', async () => {
    const strategy = mockStrategy('test', [
      makeCandidate({ name: 'high-pri', priority: 'high' }),
      makeCandidate({ name: 'low-pri', priority: 'low' }),
    ]);
    pipeline.addStrategy(strategy);

    const results = await pipeline.recommend(baseContext);
    expect(results).toHaveLength(2);
    // high 应该排在前面
    expect(results[0].name).toBe('high-pri');
    expect(results[1].name).toBe('low-pri');
    // 每个结果都有 score 和 recommendationId
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].recommendationId).toBeTruthy();
    expect(results[0].generatedAt).toBeTruthy();
  });

  test('多策略并行召回', async () => {
    pipeline.addStrategy(mockStrategy('rule', [makeCandidate({ name: 's1' })]));
    pipeline.addStrategy(mockStrategy('ai', [makeCandidate({ name: 's2' })]));

    const results = await pipeline.recommend(baseContext);
    expect(results).toHaveLength(2);
    const names = results.map((r) => r.name);
    expect(names).toContain('s1');
    expect(names).toContain('s2');
  });

  test('已有 Skill 被过滤', async () => {
    pipeline.addStrategy(
      mockStrategy('test', [
        makeCandidate({ name: 'already-exists' }),
        makeCandidate({ name: 'new-skill' }),
      ])
    );

    const results = await pipeline.recommend(baseContext);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('new-skill');
  });

  test('同名推荐去重', async () => {
    pipeline.addStrategy(mockStrategy('rule', [makeCandidate({ name: 'dup', priority: 'high' })]));
    pipeline.addStrategy(mockStrategy('ai', [makeCandidate({ name: 'dup', priority: 'low' })]));

    const results = await pipeline.recommend(baseContext);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('dup');
  });

  test('topK 截断', async () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ name: `skill-${i}`, priority: 'medium' })
    );
    pipeline.addStrategy(mockStrategy('test', candidates));

    const results = await pipeline.recommend(baseContext, 3);
    expect(results).toHaveLength(3);
  });

  test('不可用的策略被跳过', async () => {
    pipeline.addStrategy(mockStrategy('unavailable', [makeCandidate({ name: 's1' })], false));
    pipeline.addStrategy(mockStrategy('available', [makeCandidate({ name: 's2' })], true));

    const results = await pipeline.recommend(baseContext);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('s2');
  });

  test('策略抛错时静默降级', async () => {
    const failingStrategy: RecallStrategy = {
      name: 'broken',
      type: 'rule',
      recall: vi.fn().mockRejectedValue(new Error('strategy crash')),
      isAvailable: vi.fn().mockReturnValue(true),
    };
    pipeline.addStrategy(failingStrategy);
    pipeline.addStrategy(mockStrategy('good', [makeCandidate({ name: 's1' })]));

    const results = await pipeline.recommend(baseContext);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('s1');
  });

  test('FeedbackStore 集成: 频繁忽略的类别被过滤', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.autosnippet'), { recursive: true });
    const feedbackStore = new FeedbackStore(dir);

    // 填充足够多的忽略记录
    for (let i = 0; i < 5; i++) {
      await feedbackStore.record({
        recommendationId: `r_${i}`,
        action: 'dismissed',
        timestamp: '',
        category: 'spam',
      });
    }

    const pipelineWithFeedback = new RecommendationPipeline({ feedbackStore });
    pipelineWithFeedback.addStrategy(
      mockStrategy('test', [
        makeCandidate({ name: 's1', signals: { category: 'spam' } }),
        makeCandidate({ name: 's2', signals: { category: 'good' } }),
      ])
    );

    const results = await pipelineWithFeedback.recommend(baseContext);
    expect(results.every((r) => r.name !== 's1')).toBe(true);
    expect(results.some((r) => r.name === 's2')).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('SkillHooks onRecommendation 集成: waterfall 可修改结果', async () => {
    const hooks = new SkillHooks();
    hooks.tap(
      'onRecommendation',
      (results: unknown) =>
        (results as ScoredRecommendation[]).filter((r) => r.name !== 'filtered-out'),
      { name: 'filter-hook' }
    );

    const pipelineWithHooks = new RecommendationPipeline({ skillHooks: hooks });
    pipelineWithHooks.addStrategy(
      mockStrategy('test', [
        makeCandidate({ name: 'filtered-out', priority: 'high' }),
        makeCandidate({ name: 'kept', priority: 'medium' }),
      ])
    );

    const results = await pipelineWithHooks.recommend(baseContext);
    expect(results.every((r) => r.name !== 'filtered-out')).toBe(true);
    expect(results.some((r) => r.name === 'kept')).toBe(true);
  });

  test('来源影响评分: ai > rule > vector > unknown', async () => {
    pipeline.addStrategy(
      mockStrategy('test', [
        makeCandidate({ name: 'from-ai', source: 'ai:signal', priority: 'medium' }),
        makeCandidate({ name: 'from-rule', source: 'rule:guard', priority: 'medium' }),
        makeCandidate({ name: 'from-unknown', source: 'custom', priority: 'medium' }),
      ])
    );

    const results = await pipeline.recommend(baseContext);
    const aiScore = results.find((r) => r.name === 'from-ai')!.signalScores!.sourceConfidence;
    const ruleScore = results.find((r) => r.name === 'from-rule')!.signalScores!.sourceConfidence;
    const unknownScore = results.find((r) => r.name === 'from-unknown')!.signalScores!
      .sourceConfidence;
    expect(aiScore).toBeGreaterThan(ruleScore);
    expect(ruleScore).toBeGreaterThan(unknownScore);
  });

  test('getStrategies 返回已注册策略', () => {
    const s = mockStrategy('test', []);
    pipeline.addStrategy(s);
    expect(pipeline.getStrategies()).toHaveLength(1);
    expect(pipeline.getStrategies()[0].name).toBe('test');
  });
});

/* ════════════════════════════════════════════════════════════════════
 *  RecommendationMetrics
 * ════════════════════════════════════════════════════════════════════ */

describe('RecommendationMetrics', () => {
  let dir: string;
  let feedbackStore: FeedbackStore;
  let metrics: RecommendationMetrics;

  beforeEach(() => {
    dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.autosnippet'), { recursive: true });
    feedbackStore = new FeedbackStore(dir);
    metrics = new RecommendationMetrics(feedbackStore);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('初始会话指标为零', () => {
    const session = metrics.getSessionMetrics();
    expect(session.displayed).toBe(0);
    expect(session.adopted).toBe(0);
    expect(session.dismissed).toBe(0);
    expect(session.adoptionRate).toBe(0);
  });

  test('trackAdopted 更新会话 + FeedbackStore', async () => {
    await metrics.trackAdopted('rec_1', 'rule', 'test');
    const session = metrics.getSessionMetrics();
    expect(session.adopted).toBe(1);
    expect(feedbackStore.size).toBe(1);
  });

  test('trackDismissed 更新会话 + FeedbackStore', async () => {
    await metrics.trackDismissed('rec_1', '不相关', 'ai');
    const session = metrics.getSessionMetrics();
    expect(session.dismissed).toBe(1);
  });

  test('会话采纳率计算', async () => {
    await metrics.trackAdopted('rec_1');
    await metrics.trackAdopted('rec_2');
    await metrics.trackDismissed('rec_3');

    const session = metrics.getSessionMetrics();
    expect(session.adoptionRate).toBeCloseTo(2 / 3, 2);
  });

  test('trackDisplayed 记录展示', () => {
    const recs = [
      {
        name: 'test',
        description: '',
        rationale: '',
        source: 'rule',
        priority: 'medium' as const,
        signals: {},
        score: 0.8,
        recommendationId: 'rec_1',
        generatedAt: new Date().toISOString(),
      },
    ];
    metrics.trackDisplayed(recs);
    const session = metrics.getSessionMetrics();
    expect(session.displayed).toBe(1);
  });

  test('全局快照聚合', async () => {
    await metrics.trackAdopted('rec_1');
    await metrics.trackDismissed('rec_2');

    const global = metrics.getGlobalSnapshot();
    expect(global.totalAdopted).toBe(1);
    expect(global.totalDismissed).toBe(1);
    expect(global.adoptionRate).toBeCloseTo(0.5, 2);
  });
});

/* ════════════════════════════════════════════════════════════════════
 *  RuleRecallStrategy
 * ════════════════════════════════════════════════════════════════════ */

describe('RuleRecallStrategy', () => {
  test('始终可用', () => {
    const strategy = new RuleRecallStrategy();
    expect(strategy.isAvailable({ projectRoot: '/tmp' })).toBe(true);
  });

  test('name 和 type', () => {
    const strategy = new RuleRecallStrategy();
    expect(strategy.name).toBe('rule');
    expect(strategy.type).toBe('rule');
  });

  test('recall 返回数组 (可为空)', async () => {
    const strategy = new RuleRecallStrategy();
    // 没有数据库 + 没有 .autosnippet 目录 → 应返回空但不崩溃
    const dir = tmpDir();
    const results = await strategy.recall({ projectRoot: dir });
    expect(Array.isArray(results)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ════════════════════════════════════════════════════════════════════
 *  AIRecallStrategy
 * ════════════════════════════════════════════════════════════════════ */

describe('AIRecallStrategy', () => {
  test('无 signalCollector 时不可用', () => {
    const strategy = new AIRecallStrategy(null);
    expect(strategy.isAvailable({ projectRoot: '/tmp' })).toBe(false);
  });

  test('有 signalCollector 且 mode=suggest 时可用', () => {
    const mock = { getSnapshot: () => ({ pendingSuggestions: [] }), getMode: () => 'suggest' };
    const strategy = new AIRecallStrategy(mock);
    expect(strategy.isAvailable({ projectRoot: '/tmp' })).toBe(true);
  });

  test('mode=off 时不可用', () => {
    const mock = { getSnapshot: () => ({ pendingSuggestions: [] }), getMode: () => 'off' };
    const strategy = new AIRecallStrategy(mock);
    expect(strategy.isAvailable({ projectRoot: '/tmp' })).toBe(false);
  });

  test('recall 从 snapshot.pendingSuggestions 转换候选', async () => {
    const mock = {
      getSnapshot: () => ({
        pendingSuggestions: [
          { name: 'skill-1', description: 'desc', rationale: 'reason', priority: 'high' },
          { name: 'skill-2', description: 'desc2', rationale: 'reason2', priority: 'low' },
        ],
      }),
      getMode: () => 'auto',
    };
    const strategy = new AIRecallStrategy(mock);
    const results = await strategy.recall({ projectRoot: '/tmp' });
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('skill-1');
    expect(results[0].source).toBe('ai:signal_collector');
  });

  test('recall 过滤已有 Skill', async () => {
    const mock = {
      getSnapshot: () => ({
        pendingSuggestions: [
          { name: 'existing', description: '', rationale: '' },
          { name: 'new', description: '', rationale: '' },
        ],
      }),
      getMode: () => 'suggest',
    };
    const strategy = new AIRecallStrategy(mock);
    const results = await strategy.recall({
      projectRoot: '/tmp',
      existingSkills: new Set(['existing']),
    });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('new');
  });

  test('setSignalCollector 延迟注入', () => {
    const strategy = new AIRecallStrategy(null);
    expect(strategy.isAvailable({ projectRoot: '/tmp' })).toBe(false);

    strategy.setSignalCollector({
      getSnapshot: () => ({ pendingSuggestions: [] }),
      getMode: () => 'auto',
    });
    expect(strategy.isAvailable({ projectRoot: '/tmp' })).toBe(true);
  });
});

/* ════════════════════════════════════════════════════════════════════
 *  全链路连通性测试
 * ════════════════════════════════════════════════════════════════════ */

describe('全链路: Pipeline + Strategy + Feedback + Metrics + Hooks', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.autosnippet'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('完整推荐 → 反馈 → 指标 → 偏好调整 闭环', async () => {
    // 1. 构建全链路组件
    const feedbackStore = new FeedbackStore(dir);
    const hooks = new SkillHooks();
    const metricsTracker = new RecommendationMetrics(feedbackStore);
    const pipeline = new RecommendationPipeline({ feedbackStore, skillHooks: hooks });

    // 2. 注册策略
    pipeline.addStrategy(
      mockStrategy('rule', [
        makeCandidate({ name: 'guard-patterns', priority: 'high', signals: { category: 'guard' } }),
        makeCandidate({ name: 'api-docs', priority: 'medium', signals: { category: 'docs' } }),
      ])
    );

    // 3. 执行推荐
    const context: RecommendationContext = {
      projectRoot: dir,
      existingSkills: new Set(),
    };
    const results = await pipeline.recommend(context);
    expect(results.length).toBeGreaterThanOrEqual(2);

    // 4. 记录展示
    metricsTracker.trackDisplayed(results);
    expect(metricsTracker.getSessionMetrics().displayed).toBe(results.length);

    // 5. 模拟反馈
    await metricsTracker.trackAdopted(results[0].recommendationId, results[0].source, 'guard');
    await metricsTracker.trackDismissed(
      results[1].recommendationId,
      '不需要',
      results[1].source,
      'docs'
    );

    // 6. 验证指标
    const session = metricsTracker.getSessionMetrics();
    expect(session.adopted).toBe(1);
    expect(session.dismissed).toBe(1);
    expect(session.adoptionRate).toBeCloseTo(0.5, 2);

    // 7. 验证 FeedbackStore 有持久化
    const store2 = new FeedbackStore(dir);
    // 展示记录 (results.length) + adopted + dismissed
    expect(store2.size).toBe(results.length + 2);

    // 8. 验证偏好
    const pref = store2.getUserPreference();
    // 采纳率 0.5
    expect(pref.adoptionRate).toBeCloseTo(0.5, 2);
  });

  test('Hook 拦截 → Pipeline 结果被修改', async () => {
    const hooks = new SkillHooks();
    const pipeline = new RecommendationPipeline({ skillHooks: hooks });

    // 注册 onRecommendation waterfall hook: 只保留 high priority
    hooks.tap(
      'onRecommendation',
      (recs: unknown) => (recs as ScoredRecommendation[]).filter((r) => r.priority === 'high'),
      { name: 'high-only-filter' }
    );

    pipeline.addStrategy(
      mockStrategy('test', [
        makeCandidate({ name: 'keep', priority: 'high' }),
        makeCandidate({ name: 'remove', priority: 'low' }),
      ])
    );

    const results = await pipeline.recommend({ projectRoot: dir, existingSkills: new Set() });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('keep');
  });

  test('AIRecallStrategy + Pipeline 集成', async () => {
    const mockSC = {
      getSnapshot: () => ({
        pendingSuggestions: [
          {
            name: 'ai-recommended',
            description: 'AI says you need this',
            rationale: 'patterns',
            priority: 'high',
          },
        ],
      }),
      getMode: () => 'suggest',
    };
    const aiStrategy = new AIRecallStrategy(mockSC);
    const pipeline = new RecommendationPipeline();
    pipeline.addStrategy(aiStrategy);

    const results = await pipeline.recommend({ projectRoot: dir, existingSkills: new Set() });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('ai-recommended');
    expect(results[0].source).toBe('ai:signal_collector');
  });

  test('RuleRecall + AIRecall 合并: 去重同名', async () => {
    const mockSC = {
      getSnapshot: () => ({
        pendingSuggestions: [
          { name: 'shared-skill', description: 'from AI', rationale: 'ai', priority: 'medium' },
        ],
      }),
      getMode: () => 'suggest',
    };

    const pipeline = new RecommendationPipeline();
    pipeline.addStrategy(
      mockStrategy('rule', [
        makeCandidate({ name: 'shared-skill', priority: 'high', source: 'rule:guard' }),
      ])
    );
    pipeline.addStrategy(new AIRecallStrategy(mockSC));

    const results = await pipeline.recommend({ projectRoot: dir, existingSkills: new Set() });
    // 同名应去重
    const names = results.map((r) => r.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
    expect(names).toContain('shared-skill');
  });
});
