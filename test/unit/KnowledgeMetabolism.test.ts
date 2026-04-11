/**
 * KnowledgeMetabolism 单元测试
 */
import { describe, expect, it, vi } from 'vitest';
import type { ContradictionResult } from '../../lib/service/evolution/ContradictionDetector.js';
import type { DecayScoreResult } from '../../lib/service/evolution/DecayDetector.js';
import { KnowledgeMetabolism } from '../../lib/service/evolution/KnowledgeMetabolism.js';
import type { RedundancyResult } from '../../lib/service/evolution/RedundancyAnalyzer.js';

/* ── Mock factories ── */

function mockContradictionDetector(results: ContradictionResult[] = []) {
  return { detectAll: async () => results } as never;
}

function mockRedundancyAnalyzer(results: RedundancyResult[] = []) {
  return { analyzeAll: async () => results } as never;
}

function mockDecayDetector(results: DecayScoreResult[] = []) {
  return { scanAll: async () => results } as never;
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('KnowledgeMetabolism', () => {
  it('runFullCycle returns empty report when no issues', async () => {
    const metabolism = new KnowledgeMetabolism({
      contradictionDetector: mockContradictionDetector(),
      redundancyAnalyzer: mockRedundancyAnalyzer(),
      decayDetector: mockDecayDetector(),
    });

    const report = await metabolism.runFullCycle();
    expect(report.contradictions).toHaveLength(0);
    expect(report.redundancies).toHaveLength(0);
    expect(report.decayResults).toHaveLength(0);
    expect(report.proposals).toHaveLength(0);
    expect(report.summary.proposalCount).toBe(0);
  });

  it('generates merge proposal from hard contradiction', async () => {
    const contradiction: ContradictionResult = {
      recipeA: 'r1',
      recipeB: 'r2',
      confidence: 0.85,
      type: 'hard',
      evidence: ['Negation pattern conflict'],
    };

    const metabolism = new KnowledgeMetabolism({
      contradictionDetector: mockContradictionDetector([contradiction]),
      redundancyAnalyzer: mockRedundancyAnalyzer(),
      decayDetector: mockDecayDetector(),
    });

    const report = await metabolism.runFullCycle();
    expect(report.proposals).toHaveLength(1);
    expect(report.proposals[0].type).toBe('contradiction');
    expect(report.proposals[0].source).toBe('contradiction');
    expect(report.proposals[0].targetRecipeId).toBe('r1');
    expect(report.proposals[0].relatedRecipeIds).toEqual(['r2']);
  });

  it('generates review proposal from soft contradiction', async () => {
    const contradiction: ContradictionResult = {
      recipeA: 'r1',
      recipeB: 'r2',
      confidence: 0.5,
      type: 'soft',
      evidence: ['Clause cross-reference'],
    };

    const metabolism = new KnowledgeMetabolism({
      contradictionDetector: mockContradictionDetector([contradiction]),
      redundancyAnalyzer: mockRedundancyAnalyzer(),
      decayDetector: mockDecayDetector(),
    });

    const report = await metabolism.runFullCycle();
    expect(report.proposals).toHaveLength(1);
    expect(report.proposals[0].type).toBe('correction');
  });

  it('generates merge proposal from redundancy', async () => {
    const redundancy: RedundancyResult = {
      recipeA: 'r1',
      recipeB: 'r2',
      similarity: 0.78,
      dimensions: { title: 0.8, clause: 0.9, code: 0.7, guard: 1 },
    };

    const metabolism = new KnowledgeMetabolism({
      contradictionDetector: mockContradictionDetector(),
      redundancyAnalyzer: mockRedundancyAnalyzer([redundancy]),
      decayDetector: mockDecayDetector(),
    });

    const report = await metabolism.runFullCycle();
    expect(report.proposals).toHaveLength(1);
    expect(report.proposals[0].type).toBe('merge');
    expect(report.proposals[0].source).toBe('redundancy');
    expect(report.proposals[0].confidence).toBe(0.78);
  });

  it('generates deprecate proposal from decaying recipe', async () => {
    const decayResult: DecayScoreResult = {
      recipeId: 'r1',
      title: 'Old recipe',
      decayScore: 30,
      level: 'severe',
      signals: [{ recipeId: 'r1', strategy: 'no_recent_usage', detail: 'No usage in 150 days' }],
      dimensions: { freshness: 0.1, usage: 0, quality: 0.5, authority: 0.3 },
      suggestedGracePeriod: 15 * DAY_MS,
    };

    const metabolism = new KnowledgeMetabolism({
      contradictionDetector: mockContradictionDetector(),
      redundancyAnalyzer: mockRedundancyAnalyzer(),
      decayDetector: mockDecayDetector([decayResult]),
    });

    const report = await metabolism.runFullCycle();
    expect(report.proposals).toHaveLength(1);
    expect(report.proposals[0].type).toBe('deprecate');
    expect(report.proposals[0].source).toBe('decay');
    expect(report.proposals[0].targetRecipeId).toBe('r1');
    expect(report.summary.decayingCount).toBe(1);
  });

  it('does NOT generate deprecate for healthy or watch recipes', async () => {
    const healthyResult: DecayScoreResult = {
      recipeId: 'r1',
      title: 'Healthy recipe',
      decayScore: 90,
      level: 'healthy',
      signals: [],
      dimensions: { freshness: 0.9, usage: 0.8, quality: 0.9, authority: 0.8 },
      suggestedGracePeriod: 30 * DAY_MS,
    };
    const watchResult: DecayScoreResult = {
      recipeId: 'r2',
      title: 'Watch recipe',
      decayScore: 65,
      level: 'watch',
      signals: [],
      dimensions: { freshness: 0.6, usage: 0.5, quality: 0.7, authority: 0.6 },
      suggestedGracePeriod: 30 * DAY_MS,
    };

    const metabolism = new KnowledgeMetabolism({
      contradictionDetector: mockContradictionDetector(),
      redundancyAnalyzer: mockRedundancyAnalyzer(),
      decayDetector: mockDecayDetector([healthyResult, watchResult]),
    });

    const report = await metabolism.runFullCycle();
    expect(report.proposals).toHaveLength(0);
    expect(report.summary.decayingCount).toBe(0);
  });

  it('proposals have valid TTL (7 days)', async () => {
    const contradiction: ContradictionResult = {
      recipeA: 'r1',
      recipeB: 'r2',
      confidence: 0.9,
      type: 'hard',
      evidence: ['test'],
    };

    const metabolism = new KnowledgeMetabolism({
      contradictionDetector: mockContradictionDetector([contradiction]),
      redundancyAnalyzer: mockRedundancyAnalyzer(),
      decayDetector: mockDecayDetector(),
    });

    const report = await metabolism.runFullCycle();
    const proposal = report.proposals[0];
    const ttl = proposal.expiresAt - proposal.proposedAt;
    expect(ttl).toBe(7 * DAY_MS);
  });

  it('writes governance report when proposals are generated', async () => {
    const contradiction: ContradictionResult = {
      recipeA: 'r1',
      recipeB: 'r2',
      confidence: 0.8,
      type: 'hard',
      evidence: ['test'],
    };

    const writeMock = vi.fn().mockResolvedValue({
      id: 'rpt-test',
      category: 'governance',
      type: 'metabolism_cycle',
      producer: 'KnowledgeMetabolism',
      data: {},
      timestamp: Date.now(),
    });
    const reportStore = { write: writeMock };

    const metabolism = new KnowledgeMetabolism({
      contradictionDetector: mockContradictionDetector([contradiction]),
      redundancyAnalyzer: mockRedundancyAnalyzer(),
      decayDetector: mockDecayDetector(),
      reportStore: reportStore as never,
    });

    await metabolism.runFullCycle();
    expect(writeMock).toHaveBeenCalledTimes(1);
    const entry = writeMock.mock.calls[0][0] as { type: string; category: string };
    expect(entry.category).toBe('governance');
    expect(entry.type).toBe('metabolism_cycle');
  });

  it('does NOT write governance report when no proposals', async () => {
    const writeMock = vi.fn();
    const reportStore = { write: writeMock };

    const metabolism = new KnowledgeMetabolism({
      contradictionDetector: mockContradictionDetector(),
      redundancyAnalyzer: mockRedundancyAnalyzer(),
      decayDetector: mockDecayDetector(),
      reportStore: reportStore as never,
    });

    await metabolism.runFullCycle();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('convenience methods delegate to detectors', async () => {
    const decay: DecayScoreResult = {
      recipeId: 'r1',
      title: 'test',
      decayScore: 50,
      level: 'decaying',
      signals: [],
      dimensions: { freshness: 0.3, usage: 0.3, quality: 0.3, authority: 0.3 },
      suggestedGracePeriod: 30 * DAY_MS,
    };

    const metabolism = new KnowledgeMetabolism({
      contradictionDetector: mockContradictionDetector([]),
      redundancyAnalyzer: mockRedundancyAnalyzer([]),
      decayDetector: mockDecayDetector([decay]),
    });

    expect(await metabolism.checkDecay()).toHaveLength(1);
    expect(await metabolism.checkContradictions()).toHaveLength(0);
    expect(await metabolism.checkRedundancy()).toHaveLength(0);
  });

  it('combines proposals from all sources in full cycle', async () => {
    const contradiction: ContradictionResult = {
      recipeA: 'r1',
      recipeB: 'r2',
      confidence: 0.9,
      type: 'hard',
      evidence: ['c'],
    };
    const redundancy: RedundancyResult = {
      recipeA: 'r3',
      recipeB: 'r4',
      similarity: 0.75,
      dimensions: { title: 0.8, clause: 0.7, code: 0.8, guard: 0 },
    };
    const decay: DecayScoreResult = {
      recipeId: 'r5',
      title: 'dead',
      decayScore: 10,
      level: 'dead',
      signals: [{ recipeId: 'r5', strategy: 'no_recent_usage', detail: 'No usage in 400 days' }],
      dimensions: { freshness: 0, usage: 0, quality: 0, authority: 0 },
      suggestedGracePeriod: 0,
    };

    const metabolism = new KnowledgeMetabolism({
      contradictionDetector: mockContradictionDetector([contradiction]),
      redundancyAnalyzer: mockRedundancyAnalyzer([redundancy]),
      decayDetector: mockDecayDetector([decay]),
    });

    const report = await metabolism.runFullCycle();
    expect(report.proposals).toHaveLength(3);
    expect(report.proposals.map((p) => p.type).sort()).toEqual([
      'contradiction',
      'deprecate',
      'merge',
    ]);
    expect(report.summary.contradictionCount).toBe(1);
    expect(report.summary.redundancyCount).toBe(1);
    expect(report.summary.decayingCount).toBe(1);
    expect(report.summary.proposalCount).toBe(3);
  });
});
