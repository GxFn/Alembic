import { jest } from '@jest/globals';
import { BM25Scorer, SearchEngine, tokenize } from '../../lib/service/search/SearchEngine.js';

/* ────────────────────────────────────────────
 *  tokenize()
 * ──────────────────────────────────────────── */
describe('tokenize', () => {
  test('should return empty array for falsy input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });

  test('should lowercase and split by whitespace', () => {
    const result = tokenize('Hello World');
    expect(result).toContain('hello');
    expect(result).toContain('world');
  });

  test('should split camelCase at lower→upper boundary', () => {
    const result = tokenize('myFunction');
    expect(result).toContain('my');
    expect(result).toContain('function');
  });

  test('should split all-caps prefix from camelCase suffix', () => {
    // 'URLSession' → expanded 'URL Session' → lowered ['url', 'session']
    const result = tokenize('URLSession');
    expect(result).toContain('url');
    expect(result).toContain('session');
  });

  test('should split multi-hump camelCase', () => {
    const result = tokenize('getDataSource');
    expect(result).toContain('get');
    expect(result).toContain('data');
    expect(result).toContain('source');
  });

  test('should deduplicate tokens', () => {
    const result = tokenize('test test test');
    expect(result).toEqual(['test']);
  });

  test('should filter tokens shorter than 2 chars', () => {
    const result = tokenize('a b cd ef');
    expect(result).not.toContain('a');
    expect(result).not.toContain('b');
    expect(result).toContain('cd');
    expect(result).toContain('ef');
  });

  test('should handle Chinese text', () => {
    const result = tokenize('错误处理 网络请求');
    expect(result.length).toBeGreaterThan(0);
  });

  test('should strip punctuation', () => {
    const result = tokenize('hello, world! foo@bar');
    expect(result).toContain('hello');
    expect(result).toContain('world');
  });
});

/* ────────────────────────────────────────────
 *  BM25Scorer
 * ──────────────────────────────────────────── */
describe('BM25Scorer', () => {
  let scorer;

  beforeEach(() => {
    scorer = new BM25Scorer();
  });

  test('should start with 0 documents', () => {
    expect(scorer.totalDocs).toBe(0);
    expect(scorer.documents).toHaveLength(0);
  });

  test('addDocument should increment totals', () => {
    scorer.addDocument('doc1', 'hello world');
    expect(scorer.totalDocs).toBe(1);
    expect(scorer.avgLength).toBeGreaterThan(0);
  });

  test('addDocument should track doc frequency', () => {
    scorer.addDocument('doc1', 'swift networking');
    scorer.addDocument('doc2', 'swift ui');
    expect(scorer.docFreq.swift).toBe(2);
    expect(scorer.docFreq.networking).toBe(1);
  });

  test('search should return empty for empty query', () => {
    scorer.addDocument('doc1', 'hello world');
    const results = scorer.search('');
    expect(results).toEqual([]);
  });

  test('search should return matching documents', () => {
    scorer.addDocument('doc1', 'swift networking URLSession');
    scorer.addDocument('doc2', 'python requests HTTP');
    scorer.addDocument('doc3', 'swift UIKit interface');

    const results = scorer.search('swift');
    expect(results.length).toBe(2);
    expect(results.map((r) => r.id)).toContain('doc1');
    expect(results.map((r) => r.id)).toContain('doc3');
  });

  test('search should rank more relevant documents higher', () => {
    scorer.addDocument('doc1', 'swift swift swift networking');
    scorer.addDocument('doc2', 'swift python java');

    const results = scorer.search('swift');
    expect(results[0].id).toBe('doc1'); // more occurrences → higher BM25
  });

  test('search should respect limit', () => {
    for (let i = 0; i < 30; i++) {
      scorer.addDocument(`doc${i}`, `swift document ${i}`);
    }
    const results = scorer.search('swift', 5);
    expect(results.length).toBe(5);
  });

  test('search should include meta in results', () => {
    scorer.addDocument('doc1', 'swift networking', { type: 'recipe', title: 'Net' });
    const results = scorer.search('swift');
    expect(results[0].meta).toEqual({ type: 'recipe', title: 'Net' });
  });

  test('clear should reset all state', () => {
    scorer.addDocument('doc1', 'hello world');
    scorer.clear();
    expect(scorer.totalDocs).toBe(0);
    expect(scorer.documents).toHaveLength(0);
    expect(scorer.avgLength).toBe(0);
    expect(Object.keys(scorer.docFreq)).toHaveLength(0);
  });
});

/* ────────────────────────────────────────────
 *  SearchEngine
 * ──────────────────────────────────────────── */
describe('SearchEngine', () => {
  /** Create a mock DB compatible with better-sqlite3 style chained calls */
  function makeMockDb(rows = []) {
    return {
      prepare: jest.fn(() => ({
        all: jest.fn((..._args) => rows),
        run: jest.fn(),
        get: jest.fn(),
      })),
    };
  }

  test('constructor should accept plain db object', () => {
    const db = makeMockDb();
    const engine = new SearchEngine(db);
    expect(engine.db).toBe(db);
  });

  test('constructor should unwrap db via getDb()', () => {
    const innerDb = makeMockDb();
    const wrapper = { getDb: () => innerDb };
    const engine = new SearchEngine(wrapper);
    expect(engine.db).toBe(innerDb);
  });

  test('getStats should report initial state', () => {
    const engine = new SearchEngine(makeMockDb());
    const stats = engine.getStats();
    expect(stats.indexed).toBe(false);
    expect(stats.totalDocuments).toBe(0);
    expect(stats.cacheSize).toBe(0);
    expect(stats.hasVectorStore).toBe(false);
    expect(stats.hasAiProvider).toBe(false);
  });

  test('buildIndex should load recipes from DB', () => {
    const rows = [
      {
        id: 'r1',
        title: 'Swift URLSession',
        description: 'network',
        language: 'swift',
        category: 'Network',
        knowledgeType: 'code-pattern',
        kind: 'pattern',
        content_json: '{"pattern":"let s = URLSession()"}',
        status: 'active',
        tags_json: '["swift","network"]',
        trigger: 'url',
      },
    ];
    const db = makeMockDb(rows);
    const engine = new SearchEngine(db);

    engine.buildIndex();

    expect(engine.scorer.totalDocs).toBe(1);
    expect(engine.getStats().indexed).toBe(true);
  });

  test('search should return empty for blank query', async () => {
    const engine = new SearchEngine(makeMockDb());
    const result = await engine.search('');
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  test('search in keyword mode should use _keywordSearch', async () => {
    const rows = [
      {
        id: 'r1',
        title: 'URLSession',
        description: 'networking',
        language: 'swift',
        category: 'Net',
        knowledgeType: 'code-pattern',
        kind: 'pattern',
        status: 'active',
        content_json: '{}',
        trigger: '',
      },
    ];
    const db = makeMockDb(rows);
    const engine = new SearchEngine(db);

    const result = await engine.search('URLSession', { mode: 'keyword' });
    expect(result.mode).toBe('keyword');
    expect(db.prepare).toHaveBeenCalled();
  });

  test('search should cache results', async () => {
    const db = makeMockDb([]);
    const engine = new SearchEngine(db);

    await engine.search('test', { mode: 'keyword' });
    const stats1 = engine.getStats();
    expect(stats1.cacheSize).toBe(1);

    // Second call should hit cache
    await engine.search('test', { mode: 'keyword' });
    expect(engine.getStats().cacheSize).toBe(1);
  });

  test('search in bm25 mode should build index on first call', async () => {
    const rows = [
      {
        id: 'r1',
        title: 'Swift',
        description: 'test',
        language: 'swift',
        category: 'A',
        knowledgeType: 'code-pattern',
        kind: 'pattern',
        content_json: '{}',
        status: 'active',
        tags_json: '[]',
        trigger: '',
      },
    ];
    const db = makeMockDb(rows);
    const engine = new SearchEngine(db);

    const result = await engine.search('swift', { mode: 'bm25' });
    expect(result.mode).toBe('bm25');
    expect(engine.getStats().indexed).toBe(true);
  });

  test('search in semantic mode should fall back to bm25 without aiProvider', async () => {
    const rows = [
      {
        id: 'r1',
        title: 'Swift',
        description: 'test',
        language: 'swift',
        category: 'A',
        knowledgeType: 'code-pattern',
        kind: 'pattern',
        content_json: '{}',
        status: 'active',
        tags_json: '[]',
        trigger: '',
      },
    ];
    const db = makeMockDb(rows);
    const engine = new SearchEngine(db); // no aiProvider

    const result = await engine.search('swift', { mode: 'semantic' });
    expect(result.mode).toBe('bm25'); // falls back
  });

  test('refreshIndex should rebuild index', () => {
    const db = makeMockDb([]);
    const engine = new SearchEngine(db);

    engine.buildIndex();
    expect(engine.getStats().indexed).toBe(true);

    engine.refreshIndex();
    expect(engine.getStats().indexed).toBe(true);
  });

  test('search with groupByKind should partition results', async () => {
    const db = makeMockDb([]);
    const engine = new SearchEngine(db);

    const result = await engine.search('something', { mode: 'keyword', groupByKind: true });
    expect(result.byKind).toBeDefined();
    expect(result.byKind.rule).toBeDefined();
    expect(result.byKind.pattern).toBeDefined();
    expect(result.byKind.fact).toBeDefined();
  });

  test('cache should expire after maxAge', async () => {
    const db = makeMockDb([]);
    const engine = new SearchEngine(db, { cacheMaxAge: 1 }); // 1ms

    await engine.search('test', { mode: 'keyword' });
    expect(engine.getStats().cacheSize).toBe(1);

    // Wait for cache to expire
    await new Promise((r) => setTimeout(r, 10));
    // Access _getCache directly to verify expiration
    const cached = engine._getCache('test:all:20:keyword:');
    expect(cached).toBeNull();
  });
});
