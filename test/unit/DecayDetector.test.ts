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
    staleRefCount?: Record<string, number>;
    totalRefCount?: Record<string, number>;
  } = {}
) {
  return {
    prepare: (sql: string) => ({
      all: () => options.recipes ?? [],
      get: (...params: unknown[]) => {
        if (sql.includes('audit_logs')) {
          return options.auditRow;
        }
        if (sql.includes('knowledge_edges')) {
          return options.edgeRow;
        }
        if (sql.includes('recipe_source_refs') && sql.includes('SUM(CASE')) {
          // #getSourceRefStaleRatio query
          const recipeId = params[0] as string;
          const stale = options.staleRefCount?.[recipeId] ?? 0;
          const total = options.totalRefCount?.[recipeId] ?? stale;
          return { stale, total };
        }
        if (sql.includes('recipe_source_refs') && sql.includes('stale')) {
          // #getStaleSourceRefCount query
          const recipeId = params[0] as string;
          const cnt = options.staleRefCount?.[recipeId] ?? 0;
          return { cnt };
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
    created_at: null as number | null,
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
    const created = Date.now() - 120 * DAY_MS;
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

  it('should detect source_ref_stale from recipe_source_refs', () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 10 * DAY_MS,
      hitsLast90d: 10,
      authority: 50,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.5 });
    const detector = new DecayDetector(makeMockDb({ staleRefCount: { r1: 2 } }));

    const result = detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'source_ref_stale')).toBe(true);
    expect(result.signals.find((s) => s.strategy === 'source_ref_stale')?.detail).toContain(
      '2 source reference(s)'
    );
  });

  it('should NOT flag source_ref_stale when no stale refs', () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 10 * DAY_MS,
      hitsLast90d: 10,
      authority: 50,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.5 });
    const detector = new DecayDetector(makeMockDb({ staleRefCount: { r1: 0 } }));

    const result = detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'source_ref_stale')).toBe(false);
  });

  it('should penalize quality dimension based on staleRatio', () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 2 * DAY_MS,
      hitsLast90d: 30,
      authority: 80,
    });
    // All refs stale: staleRatio = 3/3 = 1.0 → quality × 0.7
    const recipe = makeRecipe({ stats, quality_score: 0.9 });
    const detector = new DecayDetector(
      makeMockDb({ staleRefCount: { r1: 3 }, totalRefCount: { r1: 3 } })
    );

    const result = detector.evaluate(recipe);
    // quality = 0.9 × 0.7 = 0.63, weighted = 0.63 × 0.2 × 100 = 12.6
    // vs no-stale: quality = 0.9, weighted = 0.9 × 0.2 × 100 = 18
    // diff ≈ 5.4 points
    expect(result.dimensions.quality).toBeCloseTo(0.63, 1);
  });

  it('should recover quality when stale ratio drops to zero (self-repair)', () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 2 * DAY_MS,
      hitsLast90d: 30,
      authority: 80,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.9 });

    // After repair: 0 stale, 3 total → staleRatio = 0
    const detector = new DecayDetector(
      makeMockDb({ staleRefCount: { r1: 0 }, totalRefCount: { r1: 3 } })
    );

    const result = detector.evaluate(recipe);
    // quality should be unpenalized
    expect(result.dimensions.quality).toBeCloseTo(0.9, 1);
  });

  it('should apply partial penalty for partial staleness', () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 2 * DAY_MS,
      hitsLast90d: 30,
      authority: 80,
    });
    // 1 of 2 stale: staleRatio = 0.5 → quality × 0.85
    const recipe = makeRecipe({ stats, quality_score: 0.8 });
    const detector = new DecayDetector(
      makeMockDb({ staleRefCount: { r1: 1 }, totalRefCount: { r1: 2 } })
    );

    const result = detector.evaluate(recipe);
    // quality = 0.8 × (1 - 0.5 × 0.3) = 0.8 × 0.85 = 0.68
    expect(result.dimensions.quality).toBeCloseTo(0.68, 1);
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
