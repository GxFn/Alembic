/**
 * RedundancyAnalyzer 单元测试
 */
import { describe, expect, it } from 'vitest';
import { RedundancyAnalyzer } from '../../lib/service/evolution/RedundancyAnalyzer.js';

function mockRepo(rows: Record<string, unknown>[] = []) {
  return {
    findAllByLifecycles: async () => rows,
  };
}

function makeRecipe(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    title: 'Test Recipe',
    doClause: null,
    dontClause: null,
    coreCode: null,
    guardPattern: null,
    ...overrides,
  } as Parameters<RedundancyAnalyzer['analyzePair']>[0];
}

describe('RedundancyAnalyzer', () => {
  it('should return null for dissimilar recipes', () => {
    const analyzer = new RedundancyAnalyzer(mockRepo() as any);
    const a = makeRecipe({ id: 'r1', title: 'Use SnapKit for layout' });
    const b = makeRecipe({ id: 'r2', title: 'Implement network caching' });

    const result = analyzer.analyzePair(a, b);
    expect(result).toBeNull();
  });

  it('should detect redundancy with high title similarity', () => {
    const analyzer = new RedundancyAnalyzer(mockRepo() as any);
    const a = makeRecipe({
      id: 'r1',
      title: 'Use NSTimer invalidation in dealloc method',
      doClause: 'Always invalidate NSTimer in dealloc to prevent retain cycles',
      coreCode: '[self.timer invalidate]; self.timer = nil;',
    });
    const b = makeRecipe({
      id: 'r2',
      title: 'NSTimer invalidation required in dealloc method',
      doClause: 'Make sure to invalidate NSTimer in dealloc to prevent retain cycles',
      coreCode: '[self.timer invalidate]; self.timer = nil;',
    });

    const result = analyzer.analyzePair(a, b);
    expect(result).not.toBeNull();
    expect(result!.similarity).toBeGreaterThanOrEqual(0.65);
  });

  it('should detect identical guard regex as full match', () => {
    const analyzer = new RedundancyAnalyzer(mockRepo() as any);
    const a = makeRecipe({
      id: 'r1',
      title: 'Use weakify self capture in blocks',
      doClause: 'Always use @weakify(self) and @strongify(self) inside blocks',
      coreCode: '@weakify(self); @strongify(self);',
      guardPattern: '@weakify\\(self\\)',
    });
    const b = makeRecipe({
      id: 'r2',
      title: 'Use weakify self capture in blocks pattern',
      doClause: 'Use @weakify(self) and @strongify(self) inside all blocks',
      coreCode: '@weakify(self); @strongify(self);',
      guardPattern: '@weakify\\(self\\)',
    });

    const result = analyzer.analyzePair(a, b);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.dimensions.guard).toBe(1);
    }
  });

  it('should detect code similarity', () => {
    const analyzer = new RedundancyAnalyzer(mockRepo() as any);
    const a = makeRecipe({
      id: 'r1',
      title: 'Dispatch main queue for UI updates pattern',
      doClause: 'Always dispatch UI updates to the main queue',
      coreCode: 'dispatch_async(dispatch_get_main_queue(), ^{ [self updateUI]; });',
    });
    const b = makeRecipe({
      id: 'r2',
      title: 'Dispatch main queue for UI updates rule',
      doClause: 'Dispatch all UI updates to the main queue',
      coreCode: 'dispatch_async(dispatch_get_main_queue(), ^{ [self updateUI]; });',
    });

    const result = analyzer.analyzePair(a, b);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.dimensions.code).toBeGreaterThan(0.8);
    }
  });

  it('should return 0 code similarity for null coreCode', () => {
    const analyzer = new RedundancyAnalyzer(mockRepo() as any);
    const a = makeRecipe({ id: 'r1', title: 'Rule A', coreCode: null });
    const b = makeRecipe({ id: 'r2', title: 'Rule B', coreCode: 'some code' });

    const result = analyzer.analyzePair(a, b);
    // Without code similarity, unlikely to reach threshold
    if (result) {
      expect(result.dimensions.code).toBe(0);
    }
  });

  it('should use n-gram similarity for large code', () => {
    const analyzer = new RedundancyAnalyzer(mockRepo() as any);
    const largeCode = 'a'.repeat(2500);
    const a = makeRecipe({
      id: 'r1',
      title: 'Same large code pattern A',
      doClause: 'Same clause for testing',
      coreCode: largeCode,
    });
    const b = makeRecipe({
      id: 'r2',
      title: 'Same large code pattern B',
      doClause: 'Same clause for testing',
      coreCode: largeCode,
    });

    const result = analyzer.analyzePair(a, b);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.dimensions.code).toBeGreaterThan(0.9);
    }
  });

  it('analyzeAll emits signals', async () => {
    const rows = [
      {
        id: 'r1',
        title: 'Use timer invalidation in dealloc',
        doClause: 'Invalidate timer in dealloc',
        dontClause: null,
        guardPattern: 'invalidate.*timer',
        coreCode: '[self.timer invalidate]',
      },
      {
        id: 'r2',
        title: 'Timer invalidation required in dealloc',
        doClause: 'Must invalidate timer in dealloc',
        dontClause: null,
        guardPattern: 'invalidate.*timer',
        coreCode: '[self.timer invalidate]',
      },
    ];

    const signals: unknown[] = [];
    const signalBus = { send: (...args: unknown[]) => signals.push(args) };
    const analyzer = new RedundancyAnalyzer(mockRepo(rows) as any, {
      signalBus: signalBus as never,
    });

    const results = await analyzer.analyzeAll();
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(signals.length).toBeGreaterThanOrEqual(1);
  });
});
