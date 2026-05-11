/**
 * EvolutionPolicy 单元测试
 *
 * 纯函数策略类，测试所有 8 个静态方法的边界条件。
 */
import { describe, expect, it } from 'vitest';
import { EvolutionPolicy } from '../../lib/domain/evolution/EvolutionPolicy.js';

describe('EvolutionPolicy', () => {
  describe('assessRisk', () => {
    it('deprecate is always high risk', () => {
      expect(EvolutionPolicy.assessRisk('deprecate', 0.99)).toBe('high');
      expect(EvolutionPolicy.assessRisk('deprecate', 0.1)).toBe('high');
    });

    it('update with high confidence is low risk', () => {
      expect(EvolutionPolicy.assessRisk('update', 0.8)).toBe('low');
      expect(EvolutionPolicy.assessRisk('update', 0.95)).toBe('low');
    });

    it('update with lower confidence is medium risk', () => {
      expect(EvolutionPolicy.assessRisk('update', 0.79)).toBe('medium');
      expect(EvolutionPolicy.assessRisk('update', 0.5)).toBe('medium');
    });
  });

  describe('observationWindow', () => {
    it('returns 24h for low risk', () => {
      expect(EvolutionPolicy.observationWindow('low')).toBe(24 * 60 * 60 * 1000);
    });

    it('returns 72h for medium risk', () => {
      expect(EvolutionPolicy.observationWindow('medium')).toBe(72 * 60 * 60 * 1000);
    });

    it('returns 7d for high risk', () => {
      expect(EvolutionPolicy.observationWindow('high')).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });

  describe('shouldImmediateExecute', () => {
    it('returns true for high-confidence deprecate from agent', () => {
      expect(EvolutionPolicy.shouldImmediateExecute('deprecate', 0.8, 'agent')).toBe(true);
    });

    it('returns false for metabolism source even with high confidence', () => {
      expect(EvolutionPolicy.shouldImmediateExecute('deprecate', 0.9, 'metabolism')).toBe(false);
    });

    it('returns false for low-confidence deprecate', () => {
      expect(EvolutionPolicy.shouldImmediateExecute('deprecate', 0.7, 'agent')).toBe(false);
    });

    it('returns false for update action', () => {
      expect(EvolutionPolicy.shouldImmediateExecute('update', 0.95, 'agent')).toBe(false);
    });
  });

  describe('resolveInitialStatus', () => {
    it('update >= 0.7 starts as observing', () => {
      expect(EvolutionPolicy.resolveInitialStatus('update', 0.7)).toBe('observing');
      expect(EvolutionPolicy.resolveInitialStatus('update', 0.9)).toBe('observing');
    });

    it('update < 0.7 starts as pending', () => {
      expect(EvolutionPolicy.resolveInitialStatus('update', 0.69)).toBe('pending');
    });

    it('deprecate always starts as observing (threshold 0.0)', () => {
      expect(EvolutionPolicy.resolveInitialStatus('deprecate', 0.1)).toBe('observing');
      expect(EvolutionPolicy.resolveInitialStatus('deprecate', 0.0)).toBe('observing');
    });
  });

  describe('evaluateUpdate', () => {
    it('passes when FP rate is low and has usage', () => {
      const result = EvolutionPolicy.evaluateUpdate({
        ruleFalsePositiveRate: 0.1,
        guardHits: 3,
        searchHits: 0,
      });
      expect(result.pass).toBe(true);
    });

    it('fails when FP rate is too high', () => {
      const result = EvolutionPolicy.evaluateUpdate({
        ruleFalsePositiveRate: 0.5,
        guardHits: 10,
        searchHits: 5,
      });
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('FP rate');
    });

    it('fails when no usage during observation', () => {
      const result = EvolutionPolicy.evaluateUpdate({
        ruleFalsePositiveRate: 0.1,
        guardHits: 0,
        searchHits: 0,
      });
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('no usage');
    });

    it('passes with search hits only', () => {
      const result = EvolutionPolicy.evaluateUpdate({
        ruleFalsePositiveRate: 0.0,
        guardHits: 0,
        searchHits: 1,
      });
      expect(result.pass).toBe(true);
    });
  });

  describe('evaluateDeprecate', () => {
    it('rejects when decay recovered significantly', () => {
      const result = EvolutionPolicy.evaluateDeprecate(60, 40);
      expect(result.action).toBe('reject');
      expect(result.reason).toContain('recovered');
    });

    it('returns deprecated for dead scores (<=19)', () => {
      const result = EvolutionPolicy.evaluateDeprecate(15, 20);
      expect(result.action).toBe('deprecated');
      expect(result.reason).toContain('dead');
    });

    it('returns decaying for severe scores (20-40)', () => {
      const result = EvolutionPolicy.evaluateDeprecate(30, 35);
      expect(result.action).toBe('decaying');
      expect(result.reason).toContain('severe');
    });

    it('rejects when decay only slowed (>40, no recovery)', () => {
      const result = EvolutionPolicy.evaluateDeprecate(45, 50);
      expect(result.action).toBe('reject');
      expect(result.reason).toContain('slowed');
    });

    it('boundary: exactly 19 is deprecated', () => {
      const result = EvolutionPolicy.evaluateDeprecate(19, 25);
      expect(result.action).toBe('deprecated');
    });

    it('boundary: exactly 40 is decaying', () => {
      const result = EvolutionPolicy.evaluateDeprecate(40, 45);
      expect(result.action).toBe('decaying');
    });
  });

  describe('classifyRelevance', () => {
    it('healthy (>=80)', () => {
      const r = EvolutionPolicy.classifyRelevance(85);
      expect(r.verdict).toBe('healthy');
      expect(r.confidence).toBe(0);
    });

    it('watch (60-79)', () => {
      const r = EvolutionPolicy.classifyRelevance(65);
      expect(r.verdict).toBe('watch');
      expect(r.confidence).toBe(0);
    });

    it('decay (40-59)', () => {
      const r = EvolutionPolicy.classifyRelevance(45);
      expect(r.verdict).toBe('decay');
      expect(r.confidence).toBe(0.4);
    });

    it('severe (20-39)', () => {
      const r = EvolutionPolicy.classifyRelevance(25);
      expect(r.verdict).toBe('severe');
      expect(r.confidence).toBe(0.6);
    });

    it('dead (<20)', () => {
      const r = EvolutionPolicy.classifyRelevance(10);
      expect(r.verdict).toBe('dead');
      expect(r.confidence).toBe(0.95);
    });

    it('boundary: exactly 80 is healthy', () => {
      expect(EvolutionPolicy.classifyRelevance(80).verdict).toBe('healthy');
    });

    it('boundary: exactly 60 is watch', () => {
      expect(EvolutionPolicy.classifyRelevance(60).verdict).toBe('watch');
    });

    it('boundary: exactly 40 is decay', () => {
      expect(EvolutionPolicy.classifyRelevance(40).verdict).toBe('decay');
    });

    it('boundary: exactly 20 is severe', () => {
      expect(EvolutionPolicy.classifyRelevance(20).verdict).toBe('severe');
    });
  });

  describe('shouldExpirePending', () => {
    it('returns true after 14 days', () => {
      const now = Date.now();
      const fifteenDaysAgo = now - 15 * 24 * 60 * 60 * 1000;
      expect(EvolutionPolicy.shouldExpirePending(fifteenDaysAgo, now)).toBe(true);
    });

    it('returns false within 14 days', () => {
      const now = Date.now();
      const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
      expect(EvolutionPolicy.shouldExpirePending(tenDaysAgo, now)).toBe(false);
    });

    it('returns false at exactly 14 days', () => {
      const now = Date.now();
      const exactlyFourteenDays = now - 14 * 24 * 60 * 60 * 1000;
      expect(EvolutionPolicy.shouldExpirePending(exactlyFourteenDays, now)).toBe(false);
    });
  });
});
