/**
 * SearchRanking.test.js — Ranking 组件单元测试
 *
 * 覆盖:
 *  - CoarseRanker           (5维粗排、动态权重、边界)
 *  - MultiSignalRanker      (6信号、场景权重、向后兼容)
 *  - Individual Signals      (RelevanceSignal, PopularitySignal, ContextMatchSignal, etc.)
 *  - CrossEncoderReranker   (Jaccard fallback — 无 AI)
 *  - contextBoost           (共享上下文加成)
 *  - BM25Scorer             (增量 remove/update/compact)
 */

import { CoarseRanker } from '../../lib/service/search/CoarseRanker.js';
import { CrossEncoderReranker } from '../../lib/service/search/CrossEncoderReranker.js';
import { contextBoost } from '../../lib/service/search/contextBoost.js';
import {
  AuthoritySignal,
  ContextMatchSignal,
  DifficultySignal,
  MultiSignalRanker,
  PopularitySignal,
  RecencySignal,
  RelevanceSignal,
} from '../../lib/service/search/MultiSignalRanker.js';
import { BM25Scorer } from '../../lib/service/search/SearchEngine.js';

/* ════════════════════════════════════════════════════════════════════
 *  CoarseRanker
 * ════════════════════════════════════════════════════════════════════ */

describe('CoarseRanker', () => {
  const ranker = new CoarseRanker();

  const makeCandidates = (overrides = []) =>
    overrides.map((o, i) => ({
      id: `c${i}`,
      title: `Candidate ${i}`,
      content: 'some code',
      description: 'desc',
      category: 'patterns',
      language: 'javascript',
      tags: ['tag'],
      bm25Score: 1,
      semanticScore: 0.5,
      usageCount: 10,
      updatedAt: new Date().toISOString(),
      ...o,
    }));

  test('returns empty for empty input', () => {
    expect(ranker.rank([])).toEqual([]);
    expect(ranker.rank(null)).toEqual([]);
  });

  test('adds coarseScore and coarseSignals to each candidate', () => {
    const result = ranker.rank(makeCandidates([{ bm25Score: 5 }, { bm25Score: 3 }]));
    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(r).toHaveProperty('coarseScore');
      expect(r.coarseSignals).toHaveProperty('bm25');
      expect(r.coarseSignals).toHaveProperty('semantic');
      expect(r.coarseSignals).toHaveProperty('quality');
      expect(r.coarseSignals).toHaveProperty('freshness');
      expect(r.coarseSignals).toHaveProperty('popularity');
    }
  });

  test('sorts by coarseScore descending', () => {
    const result = ranker.rank(makeCandidates([{ bm25Score: 10 }, { bm25Score: 1 }]));
    expect(result[0].bm25Score).toBe(10);
    expect(result[0].coarseScore).toBeGreaterThanOrEqual(result[1].coarseScore);
  });

  test('dynamic weight redistribution when semantic scores are all zero', () => {
    const candidates = makeCandidates([
      { bm25Score: 5, semanticScore: 0 },
      { bm25Score: 3, semanticScore: 0 },
    ]);
    const result = ranker.rank(candidates);
    // semanticScore 全 0 → semantic 维度被 redistribute
    expect(result[0].coarseSignals.semantic).toBe(0);
    // 分数应 > 0（来自其他维度）
    expect(result[0].coarseScore).toBeGreaterThan(0);
  });

  test('higher quality score for candidates with richer metadata', () => {
    const rich = makeCandidates([
      {
        title: 'Title',
        content: '// comment\nline1\nline2\nline3',
        description: 'desc',
        category: 'cat',
        language: 'js',
        tags: ['a'],
        bm25Score: 1,
        semanticScore: 0,
      },
    ]);
    const poor = makeCandidates([
      {
        title: '',
        content: '',
        description: '',
        category: '',
        language: '',
        tags: [],
        bm25Score: 1,
        semanticScore: 0,
      },
    ]);
    const richResult = ranker.rank(rich);
    const poorResult = ranker.rank(poor);
    expect(richResult[0].coarseSignals.quality).toBeGreaterThan(
      poorResult[0].coarseSignals.quality
    );
  });

  test('freshness exponential decay — newer items score higher', () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 365 * 86400000).toISOString();
    const candidates = makeCandidates([
      { bm25Score: 1, semanticScore: 0, updatedAt: now },
      { bm25Score: 1, semanticScore: 0, updatedAt: old },
    ]);
    const result = ranker.rank(candidates);
    const newer = result.find((r) => r.updatedAt === now);
    const older = result.find((r) => r.updatedAt === old);
    expect(newer.coarseSignals.freshness).toBeGreaterThan(older.coarseSignals.freshness);
  });

  test('popularity: higher usageCount → higher signal', () => {
    const candidates = makeCandidates([
      { bm25Score: 1, semanticScore: 0, usageCount: 1000 },
      { bm25Score: 1, semanticScore: 0, usageCount: 1 },
    ]);
    const result = ranker.rank(candidates);
    const popular = result.find((r) => r.usageCount === 1000);
    const unpopular = result.find((r) => r.usageCount === 1);
    expect(popular.coarseSignals.popularity).toBeGreaterThan(unpopular.coarseSignals.popularity);
  });

  test('respects custom weights from constructor', () => {
    const bm25Heavy = new CoarseRanker({
      bm25Weight: 1.0,
      semanticWeight: 0,
      qualityWeight: 0,
      freshnessWeight: 0,
      popularityWeight: 0,
    });
    const result = bm25Heavy.rank(
      makeCandidates([
        { bm25Score: 10, semanticScore: 0.9 },
        { bm25Score: 1, semanticScore: 0.9 },
      ])
    );
    expect(result[0].bm25Score).toBe(10);
  });
});

/* ════════════════════════════════════════════════════════════════════
 *  Individual Signals
 * ════════════════════════════════════════════════════════════════════ */

describe('RelevanceSignal', () => {
  const signal = new RelevanceSignal();

  test('returns capped score for exact title match', () => {
    const s = signal.compute(
      { title: 'react hooks', trigger: '', bm25Score: 0.3, content: '' },
      { query: 'react hooks' }
    );
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThanOrEqual(1.0);
  });

  test('trigger match gives strongest boost', () => {
    const withTrigger = signal.compute(
      { title: 'something', trigger: 'useState', bm25Score: 0.1, content: '' },
      { query: 'useState' }
    );
    const withoutTrigger = signal.compute(
      { title: 'something', trigger: '', bm25Score: 0.1, content: '' },
      { query: 'useState' }
    );
    expect(withTrigger).toBeGreaterThan(withoutTrigger);
  });

  test('returns score even without query', () => {
    const s = signal.compute({ bm25Score: 0.5 }, {});
    expect(s).toBeGreaterThanOrEqual(0);
  });
});

describe('AuthoritySignal', () => {
  const signal = new AuthoritySignal();

  test('high quality + high usage → high authority', () => {
    const s = signal.compute({ qualityScore: 90, authorityScore: 0.8, usageCount: 100 });
    expect(s).toBeGreaterThan(0.5);
  });

  test('returns 0.5 baseline when no signals', () => {
    const s = signal.compute({});
    expect(s).toBe(0.5);
  });
});

describe('RecencySignal', () => {
  const signal = new RecencySignal();

  test('recent item → score near 1.0', () => {
    const s = signal.compute({ updatedAt: new Date().toISOString() });
    expect(s).toBeGreaterThan(0.9);
  });

  test('very old item → score near 0', () => {
    const s = signal.compute({ updatedAt: '2020-01-01' });
    expect(s).toBeLessThan(0.3);
  });

  test('no date → 0.5 baseline', () => {
    expect(signal.compute({})).toBe(0.5);
  });

  test('Unix timestamp (seconds) handled correctly', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const s = signal.compute({ updatedAt: nowSec });
    expect(s).toBeGreaterThan(0.9);
  });
});

describe('PopularitySignal', () => {
  const signal = new PopularitySignal();

  test('usageCount 0 → 0', () => {
    expect(signal.compute({ usageCount: 0 })).toBe(0);
  });

  test('usageCount 10 → moderate score', () => {
    const s = signal.compute({ usageCount: 10 });
    expect(s).toBeGreaterThan(0.1);
    expect(s).toBeLessThan(0.8);
  });

  test('usageCount 1000+ → capped at 1.0', () => {
    expect(signal.compute({ usageCount: 10000 })).toBeLessThanOrEqual(1.0);
  });
});

describe('DifficultySignal', () => {
  const signal = new DifficultySignal();

  test('exact match → 1.0', () => {
    expect(signal.compute({ difficulty: 'intermediate' }, { userLevel: 'intermediate' })).toBe(1.0);
  });

  test('one level off → 0.7', () => {
    expect(signal.compute({ difficulty: 'beginner' }, { userLevel: 'intermediate' })).toBe(0.7);
  });

  test('defaults to intermediate when missing', () => {
    expect(signal.compute({}, {})).toBe(1.0); // both default to intermediate
  });
});

describe('ContextMatchSignal', () => {
  const signal = new ContextMatchSignal();

  test('language match → 0.4', () => {
    const s = signal.compute({ language: 'javascript' }, { language: 'javascript' });
    expect(s).toBeGreaterThanOrEqual(0.4);
  });

  test('related language → partial score', () => {
    const s = signal.compute({ language: 'typescript' }, { language: 'javascript' });
    expect(s).toBeGreaterThanOrEqual(0.15);
    expect(s).toBeLessThan(0.4);
  });

  test('baseline 0.1 when no context', () => {
    expect(signal.compute({}, {})).toBe(0.1);
  });

  test('category match → score includes 0.25', () => {
    const s = signal.compute({ category: 'patterns' }, { category: 'patterns' });
    expect(s).toBeGreaterThanOrEqual(0.25);
  });

  test('tag overlap → additional score', () => {
    const s = signal.compute({ tags: ['react', 'hooks'] }, { tags: ['react', 'hooks', 'state'] });
    expect(s).toBeGreaterThan(0.1);
  });
});

/* ════════════════════════════════════════════════════════════════════
 *  MultiSignalRanker
 * ════════════════════════════════════════════════════════════════════ */

describe('MultiSignalRanker', () => {
  const ranker = new MultiSignalRanker();

  test('returns empty for empty/null input', () => {
    expect(ranker.rank([])).toEqual([]);
    expect(ranker.rank(null)).toEqual([]);
  });

  test('adds rankerScore and signals to each candidate', () => {
    const result = ranker.rank([{ id: 'a', bm25Score: 0.5, title: 'test' }], {
      query: 'test',
      scenario: 'search',
    });
    expect(result[0]).toHaveProperty('rankerScore');
    expect(result[0]).toHaveProperty('signals');
    expect(result[0].signals).toHaveProperty('relevance');
    expect(result[0].signals).toHaveProperty('contextMatch');
  });

  test('different scenarios produce different scores', () => {
    const candidate = {
      id: 'a',
      bm25Score: 0.5,
      title: 'react',
      difficulty: 'beginner',
      usageCount: 100,
    };
    const lintResult = ranker.rank([candidate], { query: 'react', scenario: 'lint' });
    const learningResult = ranker.rank([candidate], { query: 'react', scenario: 'learning' });
    // Lint scenario weights authority more, learning weights difficulty more
    // Scores should differ
    expect(lintResult[0].rankerScore).not.toBe(learningResult[0].rankerScore);
  });

  test('backward compatible with seasonality key', () => {
    const custom = new MultiSignalRanker({
      scenarioWeights: {
        custom: {
          relevance: 0.5,
          authority: 0.1,
          recency: 0.1,
          popularity: 0.1,
          difficulty: 0.1,
          seasonality: 0.1, // old key
        },
      },
    });
    const result = custom.rank([{ id: 'a', bm25Score: 0.5, language: 'javascript' }], {
      query: 'test',
      scenario: 'custom',
      language: 'javascript',
    });
    expect(result[0].signals).toHaveProperty('contextMatch');
    expect(result[0].rankerScore).toBeGreaterThan(0);
  });

  test('sorts by rankerScore descending', () => {
    const result = ranker.rank(
      [
        { id: 'low', bm25Score: 0.1, title: 'unrelated' },
        { id: 'high', bm25Score: 0.9, title: 'exact match query' },
      ],
      { query: 'exact match query' }
    );
    expect(result[0].id).toBe('high');
  });
});

/* ════════════════════════════════════════════════════════════════════
 *  CrossEncoderReranker (Jaccard fallback — no AI)
 * ════════════════════════════════════════════════════════════════════ */

describe('CrossEncoderReranker', () => {
  const reranker = new CrossEncoderReranker({
    aiProvider: null,
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
  });

  test('returns empty for empty input', async () => {
    expect(await reranker.rerank('query', [])).toEqual([]);
  });

  test('falls back to Jaccard when no AI provider', async () => {
    const candidates = [
      { id: 'a', title: 'react hooks guide', content: 'useState useEffect' },
      { id: 'b', title: 'vue composition', content: 'ref reactive' },
    ];
    const result = await reranker.rerank('react hooks', candidates);
    expect(result).toHaveLength(2);
    // 'react hooks' overlaps more with candidate 'a'
    expect(result[0].id).toBe('a');
    expect(result[0]).toHaveProperty('semanticScore');
  });

  test('preserves original fields', async () => {
    const candidates = [{ id: 'x', title: 'test', content: 'test code', extra: 42 }];
    const result = await reranker.rerank('test', candidates);
    expect(result[0].extra).toBe(42);
  });

  test('handles candidates exceeding MAX_CANDIDATES', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`,
      title: `candidate ${i}`,
      content: `content ${i}`,
    }));
    const result = await reranker.rerank('candidate', many);
    expect(result).toHaveLength(50);
  });
});

/* ════════════════════════════════════════════════════════════════════
 *  contextBoost (shared)
 * ════════════════════════════════════════════════════════════════════ */

describe('contextBoost', () => {
  test('returns items unchanged when no sessionHistory', () => {
    const items = [{ id: 'a', rankerScore: 0.8, title: 'test' }];
    const result = contextBoost(items, {});
    // No contextScore added
    expect(result).toEqual(items);
  });

  test('applies session keyword overlap boost', () => {
    const items = [
      { id: 'a', rankerScore: 0.5, title: 'react hooks guide', trigger: '', content: '' },
      { id: 'b', rankerScore: 0.5, title: 'vue setup', trigger: '', content: '' },
    ];
    const context = {
      sessionHistory: [{ content: 'I am learning react hooks and useState' }],
    };
    const result = contextBoost(items, context);
    const reactItem = result.find((r) => r.id === 'a');
    const vueItem = result.find((r) => r.id === 'b');
    expect(reactItem.contextScore).toBeGreaterThan(vueItem.contextScore);
  });

  test('applies language match boost', () => {
    const items = [
      { id: 'a', rankerScore: 0.5, language: 'javascript', title: 'a' },
      { id: 'b', rankerScore: 0.5, language: 'python', title: 'b' },
    ];
    const context = {
      sessionHistory: [{ content: 'test context' }],
      language: 'javascript',
    };
    const result = contextBoost(items, context);
    const jsItem = result.find((r) => r.id === 'a');
    const pyItem = result.find((r) => r.id === 'b');
    expect(jsItem.contextBoost).toBeGreaterThan(pyItem.contextBoost);
  });

  test('sorts by contextScore descending', () => {
    const items = [
      { id: 'low', rankerScore: 0.3, title: 'unrelated', language: 'go' },
      { id: 'high', rankerScore: 0.3, title: 'react hooks', language: 'javascript' },
    ];
    const context = {
      sessionHistory: [{ content: 'react hooks help' }],
      language: 'javascript',
    };
    const result = contextBoost(items, context);
    expect(result[0].id).toBe('high');
  });
});

/* ════════════════════════════════════════════════════════════════════
 *  BM25Scorer — incremental operations
 * ════════════════════════════════════════════════════════════════════ */

describe('BM25Scorer incremental', () => {
  let scorer;

  beforeEach(() => {
    scorer = new BM25Scorer();
    scorer.addDocument('d1', 'react hooks useState');
    scorer.addDocument('d2', 'vue composition ref');
    scorer.addDocument('d3', 'angular signals effect');
  });

  test('addDocument with duplicate id replaces old document', () => {
    expect(scorer.totalDocs).toBe(3);
    scorer.addDocument('d1', 'new content for d1');
    expect(scorer.totalDocs).toBe(3);
    // old tokens should be removed
    const result = scorer.search('react hooks', 5);
    const d1Match = result.find((r) => r.id === 'd1');
    expect(d1Match).toBeUndefined(); // 'react hooks' no longer in d1
  });

  test('removeDocument reduces totalDocs', () => {
    expect(scorer.removeDocument('d2')).toBe(true);
    expect(scorer.totalDocs).toBe(2);
    expect(scorer.hasDocument('d2')).toBe(false);
  });

  test('removeDocument returns false for non-existent id', () => {
    expect(scorer.removeDocument('nonexistent')).toBe(false);
  });

  test('removeDocument updates docFreq correctly', () => {
    // 'vue' should have df=1
    expect(scorer.docFreq['vue']).toBe(1);
    scorer.removeDocument('d2');
    // 'vue' df should drop to 0 and be deleted
    expect(scorer.docFreq['vue']).toBeUndefined();
  });

  test('search correctly skips tombstones', () => {
    scorer.removeDocument('d1');
    const result = scorer.search('react', 10);
    expect(result.find((r) => r.id === 'd1')).toBeUndefined();
  });

  test('updateDocument replaces content', () => {
    scorer.updateDocument('d1', 'python django flask');
    const reactResult = scorer.search('react', 10);
    expect(reactResult.find((r) => r.id === 'd1')).toBeUndefined();
    const pythonResult = scorer.search('python', 10);
    expect(pythonResult.find((r) => r.id === 'd1')).toBeDefined();
  });

  test('hasDocument tracks correctly', () => {
    expect(scorer.hasDocument('d1')).toBe(true);
    scorer.removeDocument('d1');
    expect(scorer.hasDocument('d1')).toBe(false);
  });

  test('compact triggers when nullRatio > 30% and docs > 100', () => {
    // Build up > 100 docs then remove > 30%
    scorer.clear();
    for (let i = 0; i < 110; i++) {
      scorer.addDocument(`doc${i}`, `content number ${i}`);
    }
    expect(scorer.totalDocs).toBe(110);
    // Remove 40 docs (>30%) — compact triggers mid-way, so check final state
    for (let i = 0; i < 40; i++) {
      scorer.removeDocument(`doc${i}`);
    }
    expect(scorer.totalDocs).toBe(70);
    // After at least one compact, array should be shorter than original 110
    expect(scorer.documents.length).toBeLessThan(110);
  });

  test('avgLength recalculates after remove', () => {
    const avgBefore = scorer.avgLength;
    scorer.removeDocument('d1');
    // avgLength should change (d1 had 3 tokens, removed from 9 total across 3 docs)
    expect(scorer.avgLength).not.toBe(avgBefore);
    expect(scorer.totalDocs).toBe(2);
  });

  test('clear resets everything including _idIndex', () => {
    scorer.clear();
    expect(scorer.totalDocs).toBe(0);
    expect(scorer.hasDocument('d1')).toBe(false);
    expect(scorer.documents).toHaveLength(0);
  });
});
