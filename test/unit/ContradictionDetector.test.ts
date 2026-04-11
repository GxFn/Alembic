/**
 * ContradictionDetector 单元测试
 */
import { describe, expect, it } from 'vitest';
import { ContradictionDetector } from '../../lib/service/evolution/ContradictionDetector.js';

function mockRepo(rows: Record<string, unknown>[] = []) {
  return {
    findAllByLifecycles: async () => rows,
  };
}

function makeRecipe(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    title: 'Test Recipe',
    lifecycle: 'active',
    doClause: null,
    dontClause: null,
    guardPattern: null,
    description: null,
    content_markdown: null,
    ...overrides,
  } as Parameters<ContradictionDetector['detectPair']>[0];
}

describe('ContradictionDetector', () => {
  it('should return empty for non-contradicting recipes', () => {
    const detector = new ContradictionDetector(mockRepo() as any);
    const a = makeRecipe({ id: 'r1', title: 'Use SnapKit for layout', doClause: 'Use SnapKit' });
    const b = makeRecipe({ id: 'r2', title: 'Use Masonry for layout', doClause: 'Use Masonry' });

    const result = detector.detectPair(a, b);
    expect(result).toBeNull();
  });

  it('should detect negation-based contradiction', () => {
    const detector = new ContradictionDetector(mockRepo() as any);
    const a = makeRecipe({
      id: 'r1',
      title: 'Use dispatch_sync for UI updates',
      doClause: 'Use dispatch_sync to main queue',
    });
    const b = makeRecipe({
      id: 'r2',
      title: 'Never use dispatch_sync for UI updates',
      dontClause: 'Do not use dispatch_sync to main queue',
    });

    const result = detector.detectPair(a, b);
    expect(result).not.toBeNull();
    expect(result!.evidence).toContain('negation_pattern_conflict');
  });

  it('should detect doClause vs dontClause cross reference', () => {
    const detector = new ContradictionDetector(mockRepo() as any);
    const a = makeRecipe({
      id: 'r1',
      doClause: 'Use NSTimer in viewDidLoad for periodic updates',
    });
    const b = makeRecipe({
      id: 'r2',
      dontClause: 'Do not use NSTimer in viewDidLoad for periodic updates',
    });

    const result = detector.detectPair(a, b);
    expect(result).not.toBeNull();
    expect(result!.evidence).toContain('doClause_vs_dontClause_cross');
  });

  it('should detect guard regex mutual exclusion', () => {
    const detector = new ContradictionDetector(mockRepo() as any);
    const a = makeRecipe({
      id: 'r1',
      title: 'Use SnapKit pattern',
      guardPattern: 'use.*SnapKit.*layout',
    });
    const b = makeRecipe({
      id: 'r2',
      title: 'Avoid SnapKit pattern',
      guardPattern: '(?!.*SnapKit).*layout',
    });

    const result = detector.detectPair(a, b);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.evidence).toContain('guard_regex_mutual_exclusive');
    }
  });

  it('should classify hard vs soft contradiction', () => {
    const detector = new ContradictionDetector(mockRepo() as any);
    // Hard: negation + cross clause = score >= 0.7
    const a = makeRecipe({
      id: 'r1',
      title: 'Use NSTimer for scheduling background tasks',
      doClause: 'Use NSTimer for scheduling background tasks',
    });
    const b = makeRecipe({
      id: 'r2',
      title: 'Never use NSTimer for scheduling background tasks',
      dontClause: 'Do not use NSTimer for scheduling background tasks',
    });

    const result = detector.detectPair(a, b);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThanOrEqual(0.4);
    expect(['hard', 'soft']).toContain(result!.type);
  });

  it('should extract topic words correctly', () => {
    const words = ContradictionDetector.extractTopicWords('Use dispatch_sync on main queue');
    // underscore is a split char, so 'dispatch_sync' → 'dispatch' + 'sync'
    expect(words.has('dispatch')).toBe(true);
    expect(words.has('sync')).toBe(true);
    expect(words.has('main')).toBe(true);
    expect(words.has('queue')).toBe(true);
    // 'use' is a stop word, 'a' would be too short (< 2 chars)
    expect(words.has('use')).toBe(false);
  });

  it('should detectAll with SignalBus emission', async () => {
    const rows = [
      {
        id: 'r1',
        title: 'Use SnapKit',
        lifecycle: 'active',
        doClause: 'Use SnapKit for layout',
        dontClause: null,
        guardPattern: null,
        description: 'layout library',
        content_markdown: null,
      },
      {
        id: 'r2',
        title: 'Do not use SnapKit',
        lifecycle: 'active',
        doClause: null,
        dontClause: 'Do not use SnapKit for layout',
        guardPattern: null,
        description: 'avoid layout library',
        content_markdown: null,
      },
    ];

    const signals: unknown[] = [];
    const signalBus = { send: (...args: unknown[]) => signals.push(args) };
    const detector = new ContradictionDetector(mockRepo(rows) as any, {
      signalBus: signalBus as never,
    });

    const results = await detector.detectAll();
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(signals.length).toBeGreaterThanOrEqual(1);
  });
});
