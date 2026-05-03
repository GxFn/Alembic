/**
 * ExplorationStrategies 单元测试
 *
 * 覆盖范围:
 *   - STRATEGY_ANALYST 阶段序列与转换条件
 *   - STRATEGY_ANALYST getToolChoice 动态切换（40% 预算后 required→auto）
 *   - STRATEGY_ANALYST EXPLORE→VERIFY 多条件触发
 *   - STRATEGY_ANALYST VERIFY→RECORD→SUMMARIZE 松弛退出
 *   - createBootstrapStrategy 正常 / skill-only 模式
 *   - STRATEGY_PRODUCER 基本行为
 */
import { describe, expect, test } from 'vitest';
import {
  createBootstrapStrategy,
  type ExplorationBudget,
  type ExplorationMetrics,
  type ExplorationPhase,
  STRATEGY_ANALYST,
  STRATEGY_PRODUCER,
  type TransitionRule,
} from '../../lib/agent/context/exploration/ExplorationStrategies.js';

function makeBudget(overrides: Partial<ExplorationBudget> = {}): ExplorationBudget {
  return {
    searchBudget: 10,
    maxSubmits: 8,
    idleRoundsToExit: 3,
    searchBudgetGrace: 2,
    softSubmitLimit: 4,
    maxIterations: 34,
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<ExplorationMetrics> = {}): ExplorationMetrics {
  return {
    iteration: 0,
    submitCount: 0,
    memoryFindingCount: 0,
    searchRoundsInPhase: 0,
    phaseRounds: 0,
    roundsSinceSubmit: 0,
    roundsSinceNewInfo: 0,
    consecutiveIdleRounds: 0,
    ...overrides,
  };
}

function getTransition(strategy: typeof STRATEGY_ANALYST, key: string): TransitionRule {
  return strategy.transitions[key] as TransitionRule;
}

describe('STRATEGY_ANALYST', () => {
  test('has correct phase sequence', () => {
    expect(STRATEGY_ANALYST.phases).toEqual(['SCAN', 'EXPLORE', 'VERIFY', 'RECORD', 'SUMMARIZE']);
  });

  test('enables reflection and planning', () => {
    expect(STRATEGY_ANALYST.enableReflection).toBe(true);
    expect(STRATEGY_ANALYST.enablePlanning).toBe(true);
  });

  describe('getToolChoice', () => {
    const budget = makeBudget({ maxIterations: 34 });

    test('SCAN phase always returns required', () => {
      expect(STRATEGY_ANALYST.getToolChoice('SCAN', makeMetrics(), budget)).toBe('required');
    });

    test('EXPLORE phase returns required before 40% budget', () => {
      const metrics = makeMetrics({ iteration: 5 }); // 5/34 ≈ 15%
      expect(STRATEGY_ANALYST.getToolChoice('EXPLORE', metrics, budget)).toBe('required');
    });

    test('EXPLORE phase returns auto after 40% budget', () => {
      const metrics = makeMetrics({ iteration: 14 }); // 14/34 ≈ 41%
      expect(STRATEGY_ANALYST.getToolChoice('EXPLORE', metrics, budget)).toBe('auto');
    });

    test('VERIFY phase returns auto', () => {
      expect(STRATEGY_ANALYST.getToolChoice('VERIFY', makeMetrics(), budget)).toBe('auto');
    });

    test('RECORD phase returns required for analyst memory-only finalization', () => {
      expect(STRATEGY_ANALYST.getToolChoice('RECORD', makeMetrics(), budget)).toBe('required');
    });

    test('SUMMARIZE phase returns none', () => {
      expect(STRATEGY_ANALYST.getToolChoice('SUMMARIZE', makeMetrics(), budget)).toBe('none');
    });
  });

  describe('EXPLORE→VERIFY transition', () => {
    const budget = makeBudget({ maxIterations: 34 });
    const transition = getTransition(STRATEGY_ANALYST, 'EXPLORE→VERIFY');

    test('triggers when searchRoundsInPhase >= 60% of maxIterations', () => {
      const metrics = makeMetrics({ searchRoundsInPhase: 21 }); // 21 >= floor(34*0.6)=20
      expect(transition.onMetrics!(metrics, budget)).toBe(true);
    });

    test('triggers when roundsSinceNewInfo >= 3', () => {
      const metrics = makeMetrics({ roundsSinceNewInfo: 3 });
      expect(transition.onMetrics!(metrics, budget)).toBe(true);
    });

    test('triggers when past 40% budget and roundsSinceNewInfo >= 2', () => {
      const metrics = makeMetrics({ iteration: 14, roundsSinceNewInfo: 2 });
      expect(transition.onMetrics!(metrics, budget)).toBe(true);
    });

    test('triggers when consecutiveIdleRounds >= 2', () => {
      const metrics = makeMetrics({ consecutiveIdleRounds: 2 });
      expect(transition.onMetrics!(metrics, budget)).toBe(true);
    });

    test('does not trigger early with low activity', () => {
      const metrics = makeMetrics({ iteration: 5, searchRoundsInPhase: 5, roundsSinceNewInfo: 1 });
      expect(transition.onMetrics!(metrics, budget)).toBe(false);
    });

    test('onTextResponse triggers after 40% budget', () => {
      const fn = transition.onTextResponse as (
        m: ExplorationMetrics,
        b: ExplorationBudget
      ) => boolean;
      expect(fn(makeMetrics({ iteration: 14 }), budget)).toBe(true);
    });

    test('onTextResponse does not trigger before 40% budget', () => {
      const fn = transition.onTextResponse as (
        m: ExplorationMetrics,
        b: ExplorationBudget
      ) => boolean;
      expect(fn(makeMetrics({ iteration: 10 }), budget)).toBe(false);
    });
  });

  describe('VERIFY→RECORD transition', () => {
    const budget = makeBudget({ maxIterations: 34 });
    const transition = getTransition(STRATEGY_ANALYST, 'VERIFY→RECORD');

    test('triggers when past 75% budget', () => {
      const metrics = makeMetrics({ iteration: 26 }); // 26 >= floor(34*0.75)=25
      expect(transition.onMetrics!(metrics, budget)).toBe(true);
    });

    test('triggers when roundsSinceNewInfo >= 2', () => {
      const metrics = makeMetrics({ roundsSinceNewInfo: 2 });
      expect(transition.onMetrics!(metrics, budget)).toBe(true);
    });

    test('triggers when consecutiveIdleRounds >= 1', () => {
      const metrics = makeMetrics({ consecutiveIdleRounds: 1 });
      expect(transition.onMetrics!(metrics, budget)).toBe(true);
    });

    test('onTextResponse is always true (any text = record)', () => {
      expect(transition.onTextResponse).toBe(true);
    });
  });

  describe('RECORD→SUMMARIZE transition', () => {
    const budget = makeBudget({ maxIterations: 34 });
    const transition = getTransition(STRATEGY_ANALYST, 'RECORD→SUMMARIZE');

    test('triggers after at least three memory findings are recorded', () => {
      expect(transition.onMetrics!(makeMetrics({ memoryFindingCount: 3 }), budget)).toBe(true);
    });

    test('does not trigger before enough memory findings are recorded', () => {
      expect(
        transition.onMetrics!(makeMetrics({ phaseRounds: 1, memoryFindingCount: 2 }), budget)
      ).toBe(false);
    });

    test('does not fall through by record rounds alone', () => {
      expect(
        transition.onMetrics!(makeMetrics({ phaseRounds: 3, memoryFindingCount: 0 }), budget)
      ).toBe(false);
    });

    test('onTextResponse waits for enough memory findings', () => {
      const fn = transition.onTextResponse as (
        m: ExplorationMetrics,
        b: ExplorationBudget
      ) => boolean;
      expect(fn(makeMetrics({ memoryFindingCount: 2 }), budget)).toBe(false);
      expect(fn(makeMetrics({ memoryFindingCount: 3 }), budget)).toBe(true);
    });
  });

  describe('SCAN→EXPLORE transition', () => {
    const transition = getTransition(STRATEGY_ANALYST, 'SCAN→EXPLORE');

    test('triggers after 2 iterations', () => {
      expect(transition.onMetrics!(makeMetrics({ iteration: 2 }), makeBudget())).toBe(true);
    });

    test('does not trigger at iteration 1', () => {
      expect(transition.onMetrics!(makeMetrics({ iteration: 1 }), makeBudget())).toBe(false);
    });

    test('onTextResponse is false (SCAN never exits on text)', () => {
      expect(transition.onTextResponse).toBe(false);
    });
  });
});

describe('createBootstrapStrategy', () => {
  test('normal mode has EXPLORE→PRODUCE→SUMMARIZE', () => {
    const strategy = createBootstrapStrategy(false);
    expect(strategy.phases).toEqual(['EXPLORE', 'PRODUCE', 'SUMMARIZE']);
    expect(strategy.transitions).toHaveProperty('EXPLORE→PRODUCE');
    expect(strategy.transitions).toHaveProperty('PRODUCE→SUMMARIZE');
  });

  test('skill-only mode has EXPLORE→SUMMARIZE', () => {
    const strategy = createBootstrapStrategy(true);
    expect(strategy.phases).toEqual(['EXPLORE', 'SUMMARIZE']);
    expect(strategy.transitions).toHaveProperty('EXPLORE→SUMMARIZE');
    expect(strategy.transitions).not.toHaveProperty('EXPLORE→PRODUCE');
  });

  test('getToolChoice SUMMARIZE returns none', () => {
    const strategy = createBootstrapStrategy();
    expect(
      strategy.getToolChoice('SUMMARIZE' as ExplorationPhase, makeMetrics(), makeBudget())
    ).toBe('none');
  });

  test('getToolChoice EXPLORE returns required until near searchBudget', () => {
    const budget = makeBudget({ searchBudget: 10 });
    const strategy = createBootstrapStrategy();
    expect(
      strategy.getToolChoice(
        'EXPLORE' as ExplorationPhase,
        makeMetrics({ searchRoundsInPhase: 5 }),
        budget
      )
    ).toBe('required');
    expect(
      strategy.getToolChoice(
        'EXPLORE' as ExplorationPhase,
        makeMetrics({ searchRoundsInPhase: 9 }),
        budget
      )
    ).toBe('auto');
  });
});

describe('STRATEGY_PRODUCER', () => {
  test('has PRODUCE→SUMMARIZE phases', () => {
    expect(STRATEGY_PRODUCER.phases).toEqual(['PRODUCE', 'SUMMARIZE']);
  });

  test('does not enable reflection or planning', () => {
    expect(STRATEGY_PRODUCER.enableReflection).toBe(false);
    expect(STRATEGY_PRODUCER.enablePlanning).toBe(false);
  });

  test('getToolChoice SUMMARIZE returns none', () => {
    expect(
      STRATEGY_PRODUCER.getToolChoice('SUMMARIZE' as ExplorationPhase, makeMetrics(), makeBudget())
    ).toBe('none');
  });

  test('getToolChoice PRODUCE returns auto', () => {
    expect(
      STRATEGY_PRODUCER.getToolChoice('PRODUCE' as ExplorationPhase, makeMetrics(), makeBudget())
    ).toBe('auto');
  });
});
