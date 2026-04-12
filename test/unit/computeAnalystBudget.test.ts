import { describe, expect, it } from 'vitest';
import { ANALYST_BUDGET, computeAnalystBudget } from '#agent/domain/insight-analyst.js';

describe('computeAnalystBudget', () => {
  it('returns baseline budget for ≤40 files', () => {
    expect(computeAnalystBudget(0).maxIterations).toBe(24);
    expect(computeAnalystBudget(20).maxIterations).toBe(24);
    expect(computeAnalystBudget(40).maxIterations).toBe(24);
  });

  it('scales linearly for 41-100 files (24→32)', () => {
    const b70 = computeAnalystBudget(70);
    expect(b70.maxIterations).toBeGreaterThan(24);
    expect(b70.maxIterations).toBeLessThanOrEqual(32);

    expect(computeAnalystBudget(100).maxIterations).toBe(32);
  });

  it('scales linearly for 101-200 files (32→40)', () => {
    const b150 = computeAnalystBudget(150);
    expect(b150.maxIterations).toBeGreaterThan(32);
    expect(b150.maxIterations).toBeLessThanOrEqual(40);

    expect(computeAnalystBudget(200).maxIterations).toBe(40);
  });

  it('caps at 40 for >200 files', () => {
    expect(computeAnalystBudget(500).maxIterations).toBe(40);
    expect(computeAnalystBudget(1000).maxIterations).toBe(40);
  });

  it('keeps searchBudget at 75% of maxIterations', () => {
    for (const fc of [0, 40, 70, 100, 150, 200, 500]) {
      const b = computeAnalystBudget(fc);
      expect(b.searchBudget).toBe(Math.round(b.maxIterations * 0.75));
    }
  });

  it('scales timeoutMs proportionally to maxIterations', () => {
    const base = computeAnalystBudget(0);
    expect(base.timeoutMs).toBe(300_000);

    const large = computeAnalystBudget(200);
    expect(large.timeoutMs).toBe(Math.round((40 / 24) * 300_000));
  });

  it('preserves non-scaled fields from ANALYST_BUDGET', () => {
    const b = computeAnalystBudget(100);
    expect(b.maxSubmits).toBe(ANALYST_BUDGET.maxSubmits);
    expect(b.softSubmitLimit).toBe(ANALYST_BUDGET.softSubmitLimit);
    expect(b.idleRoundsToExit).toBe(ANALYST_BUDGET.idleRoundsToExit);
    expect(b.searchBudgetGrace).toBe(ANALYST_BUDGET.searchBudgetGrace);
  });

  it('handles negative file count gracefully', () => {
    expect(computeAnalystBudget(-10).maxIterations).toBe(24);
  });
});
