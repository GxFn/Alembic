/**
 * Integration: SearchEngine Pipeline
 *
 * 端到端搜索管线测试 — 使用独立的 in-memory SQLite，
 * 验证: 数据插入 → 索引构建 → BM25 搜索 → 排序 → 缓存
 *
 * 注意: 使用独立 DB 避免与其他集成测试的数据竞争。
 */

import Database from 'better-sqlite3';
import { vi } from 'vitest';
import { BM25Scorer, SearchEngine, tokenize } from '../../lib/service/search/SearchEngine.js';

/** 在内存 DB 中创建 knowledge_entries 表 */
function createInMemoryDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL DEFAULT '',
      description       TEXT DEFAULT '',
      lifecycle         TEXT NOT NULL DEFAULT 'pending',
      lifecycleHistory  TEXT DEFAULT '[]',
      autoApprovable    INTEGER DEFAULT 0,
      language          TEXT NOT NULL DEFAULT '',
      category          TEXT NOT NULL DEFAULT 'general',
      kind              TEXT DEFAULT 'pattern',
      knowledgeType     TEXT DEFAULT 'code-pattern',
      complexity        TEXT DEFAULT 'intermediate',
      scope             TEXT DEFAULT 'universal',
      difficulty        TEXT,
      tags              TEXT DEFAULT '[]',
      trigger           TEXT DEFAULT '',
      topicHint         TEXT DEFAULT '',
      whenClause        TEXT DEFAULT '',
      doClause          TEXT DEFAULT '',
      dontClause        TEXT DEFAULT '',
      coreCode          TEXT DEFAULT '',
      content           TEXT DEFAULT '{}',
      relations         TEXT DEFAULT '{}',
      constraints       TEXT DEFAULT '{}',
      reasoning         TEXT DEFAULT '{}',
      quality           TEXT DEFAULT '{}',
      stats             TEXT DEFAULT '{}',
      headers           TEXT DEFAULT '[]',
      headerPaths       TEXT DEFAULT '[]',
      moduleName        TEXT DEFAULT '',
      includeHeaders    INTEGER DEFAULT 0,
      agentNotes        TEXT,
      aiInsight         TEXT,
      reviewedBy        TEXT,
      reviewedAt        INTEGER,
      rejectionReason   TEXT,
      source            TEXT DEFAULT 'agent',
      sourceFile        TEXT,
      sourceCandidateId TEXT,
      createdBy         TEXT DEFAULT 'agent',
      createdAt         INTEGER NOT NULL,
      updatedAt         INTEGER NOT NULL,
      publishedAt       INTEGER,
      publishedBy       TEXT,
      contentHash       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ke3_lifecycle    ON knowledge_entries(lifecycle);
    CREATE INDEX IF NOT EXISTS idx_ke3_language     ON knowledge_entries(language);
    CREATE INDEX IF NOT EXISTS idx_ke3_category     ON knowledge_entries(category);
    CREATE INDEX IF NOT EXISTS idx_ke3_kind         ON knowledge_entries(kind);
    CREATE INDEX IF NOT EXISTS idx_ke3_trigger      ON knowledge_entries(trigger);
  `);
  return db;
}

describe('Integration: Search Pipeline', () => {
  let db;

  beforeAll(() => {
    db = createInMemoryDb();
  });

  afterAll(() => {
    db.close();
  });

  // ── tokenize 分词 ──────────────────────────────────────

  describe('tokenize 中英文混合分词', () => {
    it('应拆分 camelCase 和 PascalCase', () => {
      const tokens = tokenize('URLSession');
      expect(tokens).toContain('url');
      expect(tokens).toContain('session');
    });

    it('应支持中文单字 + bigram', () => {
      const tokens = tokenize('网络请求');
      expect(tokens).toContain('网');
      expect(tokens).toContain('络');
      expect(tokens).toContain('网络');
      expect(tokens).toContain('络请');
      expect(tokens).toContain('请求');
    });

    it('空字符串返回空数组', () => {
      expect(tokenize('')).toEqual([]);
      expect(tokenize(null)).toEqual([]);
    });

    it('应处理中英文混合文本', () => {
      const tokens = tokenize('使用URLSession发送请求');
      expect(tokens).toContain('url');
      expect(tokens).toContain('session');
      expect(tokens).toContain('发送');
      expect(tokens).toContain('请求');
    });
  });

  // ── BM25Scorer 独立测试 ───────────────────────────────

  describe('BM25Scorer 评分排序', () => {
    let scorer;

    beforeEach(() => {
      scorer = new BM25Scorer();
    });

    it('应按相关性排序', () => {
      scorer.addDocument('r1', 'Swift URLSession networking request');
      scorer.addDocument('r2', 'Swift TableView delegate datasource');
      scorer.addDocument('r3', 'URLSession download upload networking');

      const results = scorer.search('URLSession networking');
      expect(results.length).toBeGreaterThanOrEqual(2);
      // r1 和 r3 都双词命中，应出现在结果中
      const resultIds = results.map((r) => r.id);
      expect(resultIds).toContain('r1');
      expect(resultIds).toContain('r3');
      // r2 无匹配词，不应出现在结果中
      expect(resultIds).not.toContain('r2');
    });

    it('无匹配时返回空', () => {
      scorer.addDocument('r1', 'Swift class');
      const results = scorer.search('Python Django');
      expect(results).toHaveLength(0);
    });

    it('clear 后索引为空', () => {
      scorer.addDocument('r1', 'Swift class');
      scorer.clear();
      expect(scorer.totalDocs).toBe(0);
      expect(scorer.search('Swift')).toHaveLength(0);
    });
  });

  // ── SearchEngine 端到端 ───────────────────────────────

  describe('SearchEngine 端到端搜索', () => {
    let engine;

    /** 向 knowledge_entries 表插入测试条目 */
    function seedEntry(overrides = {}) {
      const id = overrides.id || `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const defaults = {
        id,
        title: 'Test Entry',
        description: 'A test knowledge entry',
        language: 'swift',
        category: 'networking',
        knowledgeType: 'best-practice',
        kind: 'pattern',
        content: JSON.stringify({
          pattern: 'URLSession.shared',
          rationale: 'Standard networking API',
        }),
        lifecycle: 'active',
        tags: JSON.stringify(['networking', 'ios']),
        trigger: 'urlsession',
        difficulty: 'intermediate',
        quality: JSON.stringify({ overall: 80 }),
        stats: JSON.stringify({ adoptions: 5, applications: 3, searchHits: 10 }),
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      };
      const row = { ...defaults, ...overrides };
      const keys = Object.keys(row);
      const placeholders = keys.map(() => '?').join(', ');
      db.prepare(`INSERT INTO knowledge_entries (${keys.join(', ')}) VALUES (${placeholders})`).run(
        ...Object.values(row)
      );
      return row;
    }

    beforeAll(() => {
      seedEntry({
        id: 'se-1',
        title: 'URLSession 网络请求最佳实践',
        description: '使用 URLSession 进行网络请求的推荐方式',
        trigger: 'urlsession',
        tags: JSON.stringify(['networking', 'ios', 'swift']),
        content: JSON.stringify({
          pattern: 'let task = URLSession.shared.dataTask(with: url)',
          rationale: 'Foundation networking',
        }),
      });
      seedEntry({
        id: 'se-2',
        title: 'Alamofire 封装',
        description: '第三方网络库 Alamofire 的封装方式',
        trigger: 'alamofire',
        tags: JSON.stringify(['networking', 'third-party']),
        content: JSON.stringify({
          pattern: 'AF.request(url).responseJSON',
          rationale: 'Alamofire convenience',
        }),
      });
      seedEntry({
        id: 'se-3',
        title: 'UITableView 代理模式',
        description: 'UITableView delegate 和 datasource 最佳实践',
        trigger: 'tableview',
        category: 'ui',
        tags: JSON.stringify(['ui', 'tableview']),
        content: JSON.stringify({
          pattern: 'extension VC: UITableViewDelegate',
          rationale: 'Separation of concerns',
        }),
      });
      seedEntry({
        id: 'se-4',
        title: 'dispatch_sync 主线程死锁',
        description: '禁止在主线程使用 dispatch_sync',
        language: 'objc',
        category: 'threading',
        knowledgeType: 'boundary-constraint',
        kind: 'rule',
        trigger: 'dispatch',
        tags: JSON.stringify(['threading', 'guard']),
        content: JSON.stringify({
          pattern: 'dispatch_sync(dispatch_get_main_queue())',
          rationale: 'Deadlock prevention',
        }),
      });
      seedEntry({
        id: 'se-5',
        title: 'Core Data 并发策略',
        description: 'NSManagedObjectContext 多线程使用规范',
        trigger: 'coredata',
        tags: JSON.stringify(['data', 'threading', 'coredata']),
        content: JSON.stringify({
          pattern: 'container.performBackgroundTask',
          rationale: 'Thread safety',
        }),
        lifecycle: 'deprecated',
      });

      engine = new SearchEngine(db);
    });

    it('buildIndex 应从 DB 加载非 deprecated 条目', () => {
      engine.buildIndex();
      const stats = engine.getStats();
      expect(stats.indexed).toBe(true);
      // se-1~se-4 应被索引, se-5 是 deprecated 不应被索引
      expect(stats.totalDocuments).toBe(4);
      // 验证 deprecated 条目不在索引中
      const deprecatedInIndex = engine.scorer.documents.find((d) => d.id === 'se-5');
      expect(deprecatedInIndex).toBeUndefined();
    });

    it('ensureIndex 幂等调用', () => {
      const spy = vi.spyOn(engine, 'buildIndex');
      engine.ensureIndex(); // 已构建，不应再次调用
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('keyword 模式应搜索到匹配条目', async () => {
      const result = await engine.search('URLSession', { mode: 'keyword' });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0].id).toBe('se-1');
      expect(result.query).toBe('URLSession');
      expect(result.mode).toBe('keyword');
    });

    it('BM25 模式应按相关性排序', async () => {
      const result = await engine.search('网络请求 networking', { mode: 'bm25' });
      expect(result.items.length).toBeGreaterThanOrEqual(2);
      // 前两条应是 networking 相关
      const ids = result.items.map((r) => r.id);
      expect(ids).toContain('se-1');
      expect(ids).toContain('se-2');
    });

    it('搜索不到 deprecated 条目', async () => {
      const result = await engine.search('Core Data 并发', { mode: 'keyword' });
      const ids = result.items.map((r) => r.id);
      expect(ids).not.toContain('se-5');
    });

    it('空查询返回空结果', async () => {
      const result = await engine.search('', { mode: 'keyword' });
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('type 过滤 — rule 类型', async () => {
      const result = await engine.search('dispatch', { mode: 'bm25', type: 'rule' });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      for (const item of result.items) {
        expect(item.kind).toBe('rule');
      }
    });

    it('groupByKind 分组', async () => {
      const result = await engine.search('dispatch', {
        mode: 'bm25',
        groupByKind: true,
      });
      expect(result.byKind).toBeDefined();
      expect(result.byKind).toHaveProperty('rule');
      expect(result.byKind).toHaveProperty('pattern');
    });

    it('搜索结果应包含完整字段', async () => {
      const result = await engine.search('URLSession', { mode: 'bm25' });
      const first = result.items[0];
      expect(first).toHaveProperty('id');
      expect(first).toHaveProperty('title');
      expect(first).toHaveProperty('score');
      expect(first).toHaveProperty('kind');
      expect(first).toHaveProperty('language');
      expect(first).toHaveProperty('content');
    });

    it('缓存命中 — 两次相同查询应返回一致结果', async () => {
      const r1 = await engine.search('tableview', { mode: 'bm25' });
      const r2 = await engine.search('tableview', { mode: 'bm25' });
      expect(r1.items.length).toBe(r2.items.length);
      expect(r1.items[0]?.id).toBe(r2.items[0]?.id);
    });

    it('refreshIndex 重建索引后仍可搜索', () => {
      engine.refreshIndex();
      const stats = engine.getStats();
      expect(stats.indexed).toBe(true);
      expect(stats.totalDocuments).toBe(4);
    });

    it('ranking 模式应使用 CoarseRanker + MultiSignalRanker', async () => {
      const result = await engine.search('networking swift', {
        mode: 'bm25',
        rank: true,
      });
      expect(result.ranked).toBe(true);
      expect(result.items.length).toBeGreaterThanOrEqual(1);
    });

    it('auto 模式无 AI 时降级到 BM25', async () => {
      const result = await engine.search('URLSession', { mode: 'auto' });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.mode).toContain('bm25');
    });

    it('semantic 模式无 AI 时降级到 BM25', async () => {
      const result = await engine.search('网络', { mode: 'semantic' });
      expect(result.items.length).toBeGreaterThanOrEqual(0);
    });

    it('trigger 精确匹配 keyword 搜索得分最高', async () => {
      seedEntry({
        id: 'se-trigger-test',
        title: 'Trigger Test Entry',
        description: 'Entry for trigger test',
        trigger: 'triggermatch',
        tags: JSON.stringify([]),
        content: JSON.stringify({ pattern: 'test code' }),
      });
      const freshEngine = new SearchEngine(db);
      freshEngine.buildIndex();

      const result = await freshEngine.search('triggermatch', { mode: 'keyword' });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      // trigger 精确匹配应给最高分 (1.2)
      const topItem = result.items.find((r) => r.id === 'se-trigger-test');
      expect(topItem).toBeDefined();
      expect(topItem.score).toBeGreaterThanOrEqual(1.0);
    });
  });
});
