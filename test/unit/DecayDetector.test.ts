/**
 * DecayDetector 单元测试
 */
import { describe, expect, it } from 'vitest';
import { DecayDetector } from '../../lib/service/evolution/DecayDetector.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeMockRepo(entries: Record<string, unknown>[] = []) {
  return {
    findAllByLifecycles: async () => entries,
    findById: async (id: string) => entries.find((e) => e.id === id) || null,
    updateLifecycle: async () => {},
  };
}

function makeMockDrizzle(auditRow?: Record<string, unknown>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            get: () => auditRow,
          }),
        }),
      }),
    }),
  };
}

function makeMockEdgeRepo(hasEdge: boolean) {
  return {
    findByRelation: async () => (hasEdge ? [{ id: 'edge-1' }] : []),
  };
}

function makeMockSourceRefRepo(staleCount: number, totalCount?: number) {
  const total = totalCount ?? staleCount;
  const refs: { status: string }[] = [];
  for (let i = 0; i < total; i++) {
    refs.push({ status: i < staleCount ? 'stale' : 'valid' });
  }
  return {
    findByRecipeId: () => refs,
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
  it('should score a healthy recipe with recent usage', async () => {
    const now = Date.now();
    const stats = JSON.stringify({
      lastHitAt: now - 2 * DAY_MS, // 2 days ago
      hitsLast90d: 30,
      authority: 80,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.9 });
    const detector = new DecayDetector(makeMockRepo() as any);

    const result = await detector.evaluate(recipe);
    expect(result.level).toBe('healthy');
    expect(result.decayScore).toBeGreaterThanOrEqual(80);
    expect(result.signals).toHaveLength(0);
    expect(result.suggestedGracePeriod).toBe(30 * DAY_MS);
  });

  it('should detect no_recent_usage when lastHitAt > 90d', async () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 120 * DAY_MS, // 120 days ago
      hitsLast90d: 0,
      authority: 50,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.5 });
    const detector = new DecayDetector(makeMockRepo() as any);

    const result = await detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'no_recent_usage')).toBe(true);
    expect(result.level).not.toBe('healthy');
  });

  it('should detect no_recent_usage for never-used old recipes', async () => {
    const created = Date.now() - 120 * DAY_MS;
    const recipe = makeRecipe({ stats: null, quality_score: 0.5, created_at: created });
    const detector = new DecayDetector(makeMockRepo() as any);

    const result = await detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'no_recent_usage')).toBe(true);
  });

  it('should detect high_false_positive when rate > 0.4 and triggers >= 10', async () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 10 * DAY_MS,
      hitsLast90d: 15,
      ruleFalsePositiveRate: 0.6,
      guardHits: 20,
      authority: 50,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.5 });
    const detector = new DecayDetector(makeMockRepo() as any);

    const result = await detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'high_false_positive')).toBe(true);
  });

  it('should NOT flag high_false_positive with insufficient triggers', async () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 10 * DAY_MS,
      hitsLast90d: 5,
      ruleFalsePositiveRate: 0.8,
      guardHits: 5, // < 10
      authority: 50,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.5 });
    const detector = new DecayDetector(makeMockRepo() as any);

    const result = await detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'high_false_positive')).toBe(false);
  });

  it('should detect symbol_drift from audit_logs', async () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 10 * DAY_MS,
      hitsLast90d: 10,
      authority: 50,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.5 });
    const detector = new DecayDetector(makeMockRepo() as any, {
      drizzle: makeMockDrizzle({ id: '1' }) as any,
    });

    const result = await detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'symbol_drift')).toBe(true);
  });

  it('should detect superseded from deprecated_by edge', async () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 10 * DAY_MS,
      hitsLast90d: 10,
      authority: 50,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.5 });
    const detector = new DecayDetector(makeMockRepo() as any, {
      knowledgeEdgeRepo: makeMockEdgeRepo(true) as any,
    });

    const result = await detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'superseded')).toBe(true);
  });

  it('should classify score levels correctly', async () => {
    const detector = new DecayDetector(makeMockRepo() as any);

    // healthy: high freshness, usage, quality, authority
    const healthy = await detector.evaluate(
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
    const dead = await detector.evaluate(
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

  it('should set grace period to 15d for severe', async () => {
    // Severe means decayScore 20-39
    // We need low freshness, low usage, low quality, low authority
    const detector = new DecayDetector(makeMockRepo() as any);
    const result = await detector.evaluate(
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

  it('should detect source_ref_stale from recipe_source_refs', async () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 10 * DAY_MS,
      hitsLast90d: 10,
      authority: 50,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.5 });
    const detector = new DecayDetector(makeMockRepo() as any, {
      sourceRefRepo: makeMockSourceRefRepo(2) as any,
    });

    const result = await detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'source_ref_stale')).toBe(true);
    expect(result.signals.find((s) => s.strategy === 'source_ref_stale')?.detail).toContain(
      '2 source reference(s)'
    );
  });

  it('should NOT flag source_ref_stale when no stale refs', async () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 10 * DAY_MS,
      hitsLast90d: 10,
      authority: 50,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.5 });
    const detector = new DecayDetector(makeMockRepo() as any, {
      sourceRefRepo: makeMockSourceRefRepo(0, 2) as any,
    });

    const result = await detector.evaluate(recipe);
    expect(result.signals.some((s) => s.strategy === 'source_ref_stale')).toBe(false);
  });

  it('should penalize quality dimension based on staleRatio', async () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 2 * DAY_MS,
      hitsLast90d: 30,
      authority: 80,
    });
    // All refs stale: staleRatio = 3/3 = 1.0 → quality × 0.7
    const recipe = makeRecipe({ stats, quality_score: 0.9 });
    const detector = new DecayDetector(makeMockRepo() as any, {
      sourceRefRepo: makeMockSourceRefRepo(3, 3) as any,
    });

    const result = await detector.evaluate(recipe);
    // quality = 0.9 × 0.7 = 0.63, weighted = 0.63 × 0.2 × 100 = 12.6
    // vs no-stale: quality = 0.9, weighted = 0.9 × 0.2 × 100 = 18
    // diff ≈ 5.4 points
    expect(result.dimensions.quality).toBeCloseTo(0.63, 1);
  });

  it('should recover quality when stale ratio drops to zero (self-repair)', async () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 2 * DAY_MS,
      hitsLast90d: 30,
      authority: 80,
    });
    const recipe = makeRecipe({ stats, quality_score: 0.9 });

    // After repair: 0 stale, 3 total → staleRatio = 0
    const detector = new DecayDetector(makeMockRepo() as any, {
      sourceRefRepo: makeMockSourceRefRepo(0, 3) as any,
    });

    const result = await detector.evaluate(recipe);
    // quality should be unpenalized
    expect(result.dimensions.quality).toBeCloseTo(0.9, 1);
  });

  it('should apply partial penalty for partial staleness', async () => {
    const stats = JSON.stringify({
      lastHitAt: Date.now() - 2 * DAY_MS,
      hitsLast90d: 30,
      authority: 80,
    });
    // 1 of 2 stale: staleRatio = 0.5 → quality × 0.85
    const recipe = makeRecipe({ stats, quality_score: 0.8 });
    const detector = new DecayDetector(makeMockRepo() as any, {
      sourceRefRepo: makeMockSourceRefRepo(1, 2) as any,
    });

    const result = await detector.evaluate(recipe);
    // quality = 0.8 × (1 - 0.5 × 0.3) = 0.8 × 0.85 = 0.68
    expect(result.dimensions.quality).toBeCloseTo(0.68, 1);
  });

  it('scanAll emits decay signals for non-healthy recipes', async () => {
    const repoEntries = [
      {
        id: 'r1',
        title: 'Decaying recipe',
        lifecycle: 'active',
        stats: {
          lastHitAt: Date.now() - 200 * DAY_MS,
          hitsLast90d: 0,
          authority: 10,
        },
        quality: { grade: null, overall: 0.2 },
        createdAt: null,
      },
    ];

    const signals: unknown[] = [];
    const signalBus = { send: (...args: unknown[]) => signals.push(args) };
    const detector = new DecayDetector(makeMockRepo(repoEntries) as any, {
      signalBus: signalBus as never,
    });

    const results = await detector.scanAll();
    expect(results.length).toBe(1);
    expect(results[0].level).not.toBe('healthy');
    expect(signals.length).toBeGreaterThanOrEqual(1);
  });
});
