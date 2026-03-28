/**
 * ConfidenceRouter 升级 — 分级 Grace Period 测试
 */
import { describe, expect, it } from 'vitest';
import { ConfidenceRouter } from '../../lib/service/knowledge/ConfidenceRouter.js';

/** 最小有效 KnowledgeEntry mock */
function mockEntry(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Test Rule',
    description: 'A test rule for unit testing',
    language: 'swift',
    category: 'code-standard',
    source: 'bootstrap',
    trigger: '@test-rule',
    content: {
      pattern: 'some pattern code here that is long enough',
      markdown: 'markdown content',
    },
    reasoning: { confidence: 0.9, isValid: () => true },
    isValid: () => true,
    usageGuide: 'Use this for testing',
    headers: [],
    tags: [],
    ...overrides,
  } as never;
}

describe('ConfidenceRouter — 分级 Grace Period', () => {
  it('should return targetState=staging for high confidence', async () => {
    const router = new ConfidenceRouter();
    const result = await router.route(
      mockEntry({ reasoning: { confidence: 0.92, isValid: () => true } })
    );

    expect(result.action).toBe('auto_approve');
    expect(result.targetState).toBe('staging');
    expect(result.gracePeriod).toBeDefined();
  });

  it('should use 24h grace for confidence >= 0.90', async () => {
    const router = new ConfidenceRouter();
    const result = await router.route(
      mockEntry({ reasoning: { confidence: 0.95, isValid: () => true } })
    );

    expect(result.targetState).toBe('staging');
    expect(result.gracePeriod).toBe(24 * 60 * 60 * 1000);
  });

  it('should use 72h grace for confidence 0.85-0.89 (non-trusted)', async () => {
    const router = new ConfidenceRouter();
    const result = await router.route(
      mockEntry({ source: 'manual', reasoning: { confidence: 0.87, isValid: () => true } })
    );

    expect(result.targetState).toBe('staging');
    expect(result.gracePeriod).toBe(72 * 60 * 60 * 1000);
  });

  it('should use 24h grace for trusted source >= 0.90', async () => {
    const router = new ConfidenceRouter();
    const result = await router.route(
      mockEntry({ source: 'bootstrap', reasoning: { confidence: 0.91, isValid: () => true } })
    );

    expect(result.gracePeriod).toBe(24 * 60 * 60 * 1000);
  });

  it('should return targetState=deprecated for reject', async () => {
    const router = new ConfidenceRouter();
    const result = await router.route(
      mockEntry({ reasoning: { confidence: 0.1, isValid: () => true } })
    );

    expect(result.action).toBe('reject');
    expect(result.targetState).toBe('deprecated');
  });

  it('should return pending with targetState for low quality score', async () => {
    const mockScorer = {
      score: () => ({ score: 0.2, grade: 'F', details: {} }),
    };
    const router = new ConfidenceRouter({}, mockScorer as never);
    const result = await router.route(
      mockEntry({ reasoning: { confidence: 0.9, isValid: () => true } })
    );

    expect(result.action).toBe('pending');
    expect(result.targetState).toBe('pending');
  });

  it('should support custom grace period configuration', async () => {
    const router = new ConfidenceRouter({
      standardGracePeriod: 48 * 60 * 60 * 1000,
      highConfidenceGracePeriod: 12 * 60 * 60 * 1000,
    });
    const result = await router.route(
      mockEntry({ source: 'manual', reasoning: { confidence: 0.87, isValid: () => true } })
    );

    expect(result.gracePeriod).toBe(48 * 60 * 60 * 1000);
  });
});
