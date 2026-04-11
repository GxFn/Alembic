/**
 * Knowledge Governance 集成冒烟测试
 *
 * 验证 Phase 3 新增的治理组件能正确组装并协同工作：
 *   - Lifecycle 6 态状态机
 *   - ConfidenceRouter 升级 (targetState + gracePeriod)
 *   - ContradictionDetector + RedundancyAnalyzer + DecayDetector
 *   - KnowledgeMetabolism 编排
 */
import { describe, expect, it } from 'vitest';
import { KnowledgeEntry } from '../../lib/domain/knowledge/KnowledgeEntry.js';
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
import type KnowledgeRepositoryImpl from '../../lib/repository/knowledge/KnowledgeRepository.impl.js';
import { ContradictionDetector } from '../../lib/service/evolution/ContradictionDetector.js';
import { DecayDetector } from '../../lib/service/evolution/DecayDetector.js';
import { KnowledgeMetabolism } from '../../lib/service/evolution/KnowledgeMetabolism.js';
import { RedundancyAnalyzer } from '../../lib/service/evolution/RedundancyAnalyzer.js';
import { ConfidenceRouter } from '../../lib/service/knowledge/ConfidenceRouter.js';

/* ── Mocks ── */

const DAY_MS = 24 * 60 * 60 * 1000;

function makeMockRepo(options: { entries?: KnowledgeEntry[] } = {}): KnowledgeRepositoryImpl {
  const allEntries = options.entries ?? [];
  return {
    findAllByLifecycles: async (lifecycles: readonly string[]) =>
      allEntries.filter((e) => lifecycles.includes(e.lifecycle)),
  } as unknown as KnowledgeRepositoryImpl;
}

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

  describe('Full metabolism cycle', () => {
    it('end-to-end governance with mixed signals', async () => {
      const entries = [
        new KnowledgeEntry({
          id: 'r1',
          title: 'Use dispatch_async for UI updates',
          lifecycle: 'active',
          doClause: 'Always use dispatch_async to main queue for UI updates',
          content: { pattern: 'dispatch_async.*main_queue' },
        }),
        new KnowledgeEntry({
          id: 'r2',
          title: 'Never use dispatch_async for UI updates',
          lifecycle: 'active',
          dontClause: 'Do not use dispatch_async to main queue for UI updates',
          content: { pattern: 'dispatch_async.*main_queue' },
        }),
        new KnowledgeEntry({
          id: 'r3',
          title: 'BD prefix for all classes requirement',
          lifecycle: 'active',
          doClause: 'Use BD prefix for all custom classes',
          coreCode: '@interface BDMyClass : NSObject',
          content: { pattern: 'class BD\\w+' },
        }),
        new KnowledgeEntry({
          id: 'r4',
          title: 'BD prefix for all classes standard',
          lifecycle: 'active',
          doClause: 'All custom classes must use BD prefix',
          coreCode: '@interface BDMyClass : NSObject',
          content: { pattern: 'class BD\\w+' },
        }),
        new KnowledgeEntry({
          id: 'r5',
          title: 'Legacy pattern',
          lifecycle: 'active',
          stats: {
            lastHitAt: Date.now() - 200 * DAY_MS,
            hitsLast90d: 0,
            authority: 10,
          },
          quality: { grade: 'C', overall: 0.2 },
          createdAt: Math.floor((Date.now() - 300 * DAY_MS) / 1000),
        }),
      ];

      const knowledgeRepo = makeMockRepo({ entries });

      const signals: unknown[] = [];
      const signalBus = {
        send: (...args: unknown[]) => signals.push(args),
        subscribe: () => () => {},
      } as never;

      const contradictionDetector = new ContradictionDetector(knowledgeRepo, { signalBus });
      const redundancyAnalyzer = new RedundancyAnalyzer(knowledgeRepo, { signalBus });
      const decayDetector = new DecayDetector(knowledgeRepo, { signalBus });

      const metabolism = new KnowledgeMetabolism({
        contradictionDetector,
        redundancyAnalyzer,
        decayDetector,
        signalBus,
      });

      const report = await metabolism.runFullCycle();

      // Should have proposals from decay (legacy pattern)
      expect(report.decayResults.length).toBeGreaterThanOrEqual(1);

      // Summary should account for all
      expect(report.summary.totalScanned).toBeGreaterThanOrEqual(1);
      expect(report.summary.proposalCount).toBeGreaterThanOrEqual(1);

      // Proposals should have valid structure
      for (const p of report.proposals) {
        expect(p.proposedAt).toBeGreaterThan(0);
        expect(p.expiresAt).toBeGreaterThan(p.proposedAt);
        expect(p.targetRecipeId).toBeTruthy();
        expect([
          'merge',
          'enhance',
          'supersede',
          'deprecate',
          'contradiction',
          'correction',
          'reorganize',
        ]).toContain(p.type);
      }

      // SignalBus should have received signals
      expect(signals.length).toBeGreaterThan(0);
    });
  });

  describe('Module instantiation smoke', () => {
    it('all governance classes can be instantiated', () => {
      const repo = makeMockRepo();
      expect(() => new ContradictionDetector(repo)).not.toThrow();
      expect(() => new RedundancyAnalyzer(repo)).not.toThrow();
      expect(() => new DecayDetector(repo)).not.toThrow();
      expect(
        () =>
          new KnowledgeMetabolism({
            contradictionDetector: new ContradictionDetector(repo),
            redundancyAnalyzer: new RedundancyAnalyzer(repo),
            decayDetector: new DecayDetector(repo),
          })
      ).not.toThrow();
    });

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
