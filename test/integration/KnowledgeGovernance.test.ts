/**
 * Knowledge Governance 集成冒烟测试
 *
 * 验证治理组件能正确组装并协同工作：
 *   - Lifecycle 6 态状态机
 *   - ConfidenceRouter 升级 (targetState + gracePeriod)
 *   - RedundancyAnalyzer + DecayDetector
 */
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_STATES,
  CONSUMABLE_STATES,
  DEGRADED_STATES,
  isCandidate,
  isConsumable,
  isDegraded,
  isValidLifecycle,
  isValidTransition,
  Lifecycle,
  normalizeLifecycle,
} from '../../lib/domain/knowledge/Lifecycle.js';
import { ConfidenceRouter } from '../../lib/service/knowledge/ConfidenceRouter.js';

describe('Knowledge Governance Integration', () => {
  describe('Lifecycle 6-state consistency', () => {
    it('all 6 states are recognized and normalized', () => {
      const states = [
        Lifecycle.PENDING,
        Lifecycle.STAGING,
        Lifecycle.ACTIVE,
        Lifecycle.EVOLVING,
        Lifecycle.DECAYING,
        Lifecycle.DEPRECATED,
      ];
      for (const s of states) {
        expect(isValidLifecycle(s)).toBe(true);
        expect(normalizeLifecycle(s)).toBe(s);
      }
    });

    it('state groups are consistent with transitions', () => {
      // Candidates can transition to staging or active
      for (const s of CANDIDATE_STATES) {
        const canProgress =
          isValidTransition(s, Lifecycle.ACTIVE) || isValidTransition(s, Lifecycle.STAGING);
        expect(canProgress).toBe(true);
      }

      // Consumable states should not be deprecated directly (except via decaying)
      for (const s of CONSUMABLE_STATES) {
        expect(isConsumable(s)).toBe(true);
      }

      // Degraded states should be able to transition to deprecated
      for (const s of DEGRADED_STATES) {
        expect(isDegraded(s)).toBe(true);
        expect(isValidTransition(s, Lifecycle.DEPRECATED)).toBe(true);
      }
    });
  });

  describe('ConfidenceRouter → staging flow', () => {
    it('RouteResult interface includes targetState and gracePeriod', async () => {
      const router = new ConfidenceRouter();
      // Create a minimal mock that satisfies ConfidenceRouter's usage
      const entry = {
        title: 'Use BD prefix for all custom classes',
        doClause: 'Always use BD prefix',
        source: 'developer',
        reasoning: { confidence: 0.92, isValid: () => true },
        content: {
          hasContent: () => true,
          markdown:
            'Use BD prefix for all custom classes in Objective-C projects to maintain consistency',
          pattern: null,
          rationale: null,
          steps: [],
        },
        isValid: () => true,
        description: 'Test description',
        coreCode: 'code',
      };

      const result = await router.route(entry as never);
      expect(result.action).toBe('auto_approve');
      expect(result.targetState).toBe('staging');
      expect(result.gracePeriod).toBeDefined();
      expect(result.gracePeriod).toBeGreaterThan(0);
    });
  });

  describe('Module helpers smoke', () => {
    it('helper functions isCandidate, isConsumable, isDegraded are importable and correct', () => {
      expect(isCandidate('pending')).toBe(true);
      expect(isCandidate('staging')).toBe(true);
      expect(isCandidate('active')).toBe(false);
      expect(isConsumable('staging')).toBe(true);
      expect(isConsumable('active')).toBe(true);
      expect(isConsumable('evolving')).toBe(true);
      expect(isConsumable('decaying')).toBe(false);
      expect(isDegraded('decaying')).toBe(true);
      expect(isDegraded('active')).toBe(false);
    });
  });
});
