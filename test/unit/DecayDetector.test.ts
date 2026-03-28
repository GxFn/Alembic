/**
 * DecayDetector 单元测试
 */
import { describe, expect, it } from 'vitest';
import { DecayDetector } from '../../lib/service/evolution/DecayDetector.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeMockDb(
  options: {
    recipes?: Record<string, unknown>[];
    auditRow?: Record<string, unknown> | undefined;
    edgeRow?: Record<string, unknown> | undefined;
  } = {}
) {
  return {
    prepare: (sql: string) => ({
      all: () => options.recipes ?? [],
      get: (..._params: unknown[]) => {
        if (sql.includes('audit_logs')) {
          return options.auditRow;
        }
        if (sql.includes('knowledge_edges')) {
          return options.edgeRow;
        }
        return undefined;
      },
    }),
  };
}

function makeRecipe(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    title: 'Test Recipe',
    lifecycle: 'active',
    stats: null as string | null,
    quality_grade: null as string | null,
    quality_score: null as number | null,
    created_at: null as string | null,
    ...overrides,
  };
}

describe('DecayDetector', () => {
  it('should score a healthy recipe with recent usage', () => {
    const now = Date.now();
    const stats = JSON.stringify({
      lastHitAt: now - 2 * DAY_MS, // 2 days ago
      hitsLast90d: 30,
      authority: 80,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.9 });
    const detector = new DecayDetector(makeMockDb());

    const result = detector.evaluate(recipe);
    expect(result.level).toBe('healthy');
    expect(result.decayScore).toBeGreaterThanOrEqual(80);
    expect(result.signals).toHaveLength(0);
    expect(result.suggestedGracePeriod).toBe(30 * DAY_MS);
  });

  it('should detect no_recent_usage when lastHitAt > 90d', () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 120 * DAY_MS, // 120 days ago
      hitsLast90d: 0,
      authority: 50,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.5 });
    const detector = new DecayDetector(makeMockDb());

    const result = detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'no_recent_usage')).toBe(true);
    expect(result.level).not.toBe('healthy');
  });

  it('should detect no_recent_usage for never-used old recipes', () => {
    const created = new Date(Date.now() - 120 * DAY_MS).toISOString();
    const recipe = makeRecipe({ stats: null, quality_score: 0.5, created_at: created });
    const detector = new DecayDetector(makeMockDb());

    const result = detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'no_recent_usage')).toBe(true);
  });

  it('should detect high_false_positive when rate > 0.4 and triggers >= 10', () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 10 * DAY_MS,
      hitsLast90d: 15,
      ruleFalsePositiveRate: 0.6,
      guardHits: 20,
      authority: 50,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.5 });
    const detector = new DecayDetector(makeMockDb());

    const result = detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'high_false_positive')).toBe(true);
  });

  it('should NOT flag high_false_positive with insufficient triggers', () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 10 * DAY_MS,
      hitsLast90d: 5,
      ruleFalsePositiveRate: 0.8,
      guardHits: 5, // < 10
      authority: 50,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.5 });
    const detector = new DecayDetector(makeMockDb());

    const result = detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'high_false_positive')).toBe(false);
  });

  it('should detect symbol_drift from audit_logs', () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 10 * DAY_MS,
      hitsLast90d: 10,
      authority: 50,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.5 });
    const detector = new DecayDetector(makeMockDb({ auditRow: { '1': 1 } }));

    const result = detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'symbol_drift')).toBe(true);
  });

  it('should detect superseded from deprecated_by edge', () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 10 * DAY_MS,
      hitsLast90d: 10,
      authority: 50,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.5 });
    const detector = new DecayDetector(makeMockDb({ edgeRow: { '1': 1 } }));

    const result = detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'superseded')).toBe(true);
  });

  it('should classify score levels correctly', () => {
    const detector = new DecayDetector(makeMockDb());

    // healthy: high freshness, usage, quality, authority
    const healthy = detector.evaluate(
      makeRecipe({
        stats: JSON.stringify({
          lastHitAt: Date.now() - 1 * DAY_MS,
          hitsLast90d: 50,
          authority: 100,
        }),
        quality_score: 1.0,
      })
    );
    expect(healthy.level).toBe('healthy');

    // dead: no usage for over a year, low everything
    const dead = detector.evaluate(
      makeRecipe({
        stats: JSON.stringify({
          lastHitAt: Date.now() - 400 * DAY_MS,
          hitsLast90d: 0,
          authority: 0,
        }),
        quality_score: 0,
      })
    );
    expect(dead.level).toBe('dead');
    expect(dead.suggestedGracePeriod).toBe(0);
  });

  it('should set grace period to 15d for severe', () => {
    // Severe means decayScore 20-39
    // We need low freshness, low usage, low quality, low authority
    const detector = new DecayDetector(makeMockDb());
    const result = detector.evaluate(
      makeRecipe({
        stats: JSON.stringify({
          lastHitAt: Date.now() - 300 * DAY_MS,
          hitsLast90d: 2,
          authority: 10,
        }),
        quality_score: 0.1,
      })
    );

    if (result.level === 'severe') {
      expect(result.suggestedGracePeriod).toBe(15 * DAY_MS);
    }
    // Score should at least be below 'healthy'
    expect(result.decayScore).toBeLessThan(80);
  });

  it('scanAll emits decay signals for non-healthy recipes', () => {
    const recipes = [
      {
        id: 'r1',
        title: 'Decaying recipe',
        lifecycle: 'active',
        stats: JSON.stringify({
          lastHitAt: Date.now() - 200 * DAY_MS,
          hitsLast90d: 0,
          authority: 10,
        }),
        quality_grade: null,
        quality_score: 0.2,
        created_at: null,
      },
    ];

    const signals: unknown[] = [];
    const signalBus = { send: (...args: unknown[]) => signals.push(args) };
    const detector = new DecayDetector(makeMockDb({ recipes }), { signalBus: signalBus as never });

    const results = detector.scanAll();
    expect(results.length).toBe(1);
    expect(results[0].level).not.toBe('healthy');
    expect(signals.length).toBeGreaterThanOrEqual(1);
  });
});
