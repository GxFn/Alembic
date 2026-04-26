import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

/* ────────────────────────────────────────────
 *  动态导入
 * ──────────────────────────────────────────── */
let ALL_TOOLS = [];

beforeAll(async () => {
  const toolsMod = await import('../../lib/tools/handlers/index.js');
  ALL_TOOLS = toolsMod.ALL_TOOLS || toolsMod.default;
});

/* ────────────────────────────────────────────
 *  Helpers
 * ──────────────────────────────────────────── */
function findTool(name) {
  return ALL_TOOLS.find((t) => t.name === name);
}

// 创建临时项目目录结构用于工具测试
let tmpDir = '';
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-v10-test-'));
  // 创建目录结构
  fs.mkdirSync(path.join(tmpDir, 'src', 'models'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'src', 'services'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });

  // 创建一个 ObjC 文件
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'models', 'User.m'),
    `
#import "User.h"
#import <Foundation/Foundation.h>

@interface User : NSObject
@property (nonatomic, copy) NSString *name;
@property (nonatomic, assign) NSInteger age;
- (instancetype)initWithName:(NSString *)name age:(NSInteger)age;
- (NSDictionary *)toDictionary;
@end

@implementation User
- (instancetype)initWithName:(NSString *)name age:(NSInteger)age {
    self = [super init];
    if (self) {
        _name = [name copy];
        _age = age;
    }
    return self;
}
- (NSDictionary *)toDictionary {
    return @{@"name": self.name, @"age": @(self.age)};
}
@end
`
  );

  // 创建一个 Swift 文件
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'services', 'NetworkManager.swift'),
    `
import Foundation
import Alamofire

public class NetworkManager {
    static let shared = NetworkManager()
    private var session: URLSession
    
    private init() {
        let config = URLSessionConfiguration.default
        self.session = URLSession(configuration: config)
    }
    
    func request(_ url: String, completion: @escaping (Result<Data, Error>) -> Void) {
        guard let url = URL(string: url) else { return }
        session.dataTask(with: url) { data, _, error in
            if let error = error {
                completion(.failure(error))
            } else if let data = data {
                completion(.success(data))
            }
        }.resume()
    }
}
`
  );

  // 创建一个 JS 文件
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'services', 'ApiClient.js'),
    `
import axios from 'axios';
import { Logger } from '../utils/Logger.js';

export class ApiClient {
  #baseUrl;
  #logger;

  constructor(baseUrl) {
    this.#baseUrl = baseUrl;
    this.#logger = new Logger('ApiClient');
  }

  async get(endpoint) {
    this.#logger.info('GET', endpoint);
    return axios.get(this.#baseUrl + endpoint);
  }

  async post(endpoint, data) {
    return axios.post(this.#baseUrl + endpoint, data);
  }
}
`
  );

  // 创建 node_modules 中的文件（应被过滤）
  fs.mkdirSync(path.join(tmpDir, 'node_modules', 'some-lib'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'node_modules', 'some-lib', 'index.js'),
    'module.exports = {}'
  );
});

afterAll(() => {
  // 清理临时目录
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ════════════════════════════════════════════════════════════
 *  P0: list_project_structure
 * ════════════════════════════════════════════════════════════ */
describe('P0: list_project_structure', () => {
  const ctx = () => ({ projectRoot: tmpDir });

  test('tool exists in ALL_TOOLS', () => {
    const tool = findTool('list_project_structure');
    expect(tool).toBeDefined();
    expect(tool.name).toBe('list_project_structure');
    expect(tool.parameters.properties).toHaveProperty('directory');
    expect(tool.parameters.properties).toHaveProperty('depth');
  });

  test('returns directory tree with file stats', async () => {
    const tool = findTool('list_project_structure');
    const result = await tool.handler({}, ctx());

    expect(result.tree).toBeDefined();
    expect(result.tree).toContain('src/');
    expect(result.stats).toBeDefined();
    expect(result.stats.totalFiles).toBeGreaterThan(0);
    expect(result.stats.byLanguage).toBeDefined();
  });

  test('filters out node_modules', async () => {
    const tool = findTool('list_project_structure');
    const result = await tool.handler({ depth: 5 }, ctx());

    expect(result.tree).not.toContain('node_modules');
  });

  test('respects directory parameter', async () => {
    const tool = findTool('list_project_structure');
    const result = await tool.handler({ directory: 'src/models' }, ctx());

    expect(result.tree).toContain('User.m');
    expect(result.directory).toBe('src/models');
  });

  test('respects depth limit', async () => {
    const tool = findTool('list_project_structure');
    const result = await tool.handler({ depth: 1 }, ctx());

    // At depth 1, should show top-level dirs but not their contents
    expect(result.tree).toContain('src/');
    // Sub-files inside src should NOT appear at depth 1 since src itself is at depth 1
    // and its children would be at depth 2
  });

  test('rejects path traversal', async () => {
    const tool = findTool('list_project_structure');
    const result = await tool.handler({ directory: '../../etc' }, ctx());
    expect(result.error).toContain('Path traversal');
  });

  test('works with includeStats=false', async () => {
    const tool = findTool('list_project_structure');
    const result = await tool.handler({ includeStats: false }, ctx());

    expect(result.tree).toBeDefined();
    expect(result.stats).toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════
 *  P0: get_file_summary
 * ════════════════════════════════════════════════════════════ */
describe('P0: get_file_summary', () => {
  const ctx = () => ({ projectRoot: tmpDir });

  test('tool exists in ALL_TOOLS', () => {
    const tool = findTool('get_file_summary');
    expect(tool).toBeDefined();
    expect(tool.parameters.required).toContain('filePath');
  });

  test('extracts ObjC declarations from .m file', async () => {
    const tool = findTool('get_file_summary');
    const result = await tool.handler({ filePath: 'src/models/User.m' }, ctx());

    expect(result.language).toBe('objectivec');
    expect(result.lineCount).toBeGreaterThan(10);
    expect(result.imports.length).toBeGreaterThanOrEqual(1);
    expect(result.declarations.length).toBeGreaterThanOrEqual(1);
    expect(result.methods.length).toBeGreaterThanOrEqual(2);
    expect(result.properties.length).toBeGreaterThanOrEqual(2);
  });

  test('extracts Swift declarations', async () => {
    const tool = findTool('get_file_summary');
    const result = await tool.handler({ filePath: 'src/services/NetworkManager.swift' }, ctx());

    expect(result.language).toBe('swift');
    expect(result.imports).toEqual(expect.arrayContaining([expect.stringContaining('Foundation')]));
    expect(result.declarations.length).toBeGreaterThanOrEqual(1);
    expect(result.methods.length).toBeGreaterThanOrEqual(1);
  });

  test('extracts JS declarations', async () => {
    const tool = findTool('get_file_summary');
    const result = await tool.handler({ filePath: 'src/services/ApiClient.js' }, ctx());

    expect(result.language).toBe('javascript');
    expect(result.imports.length).toBeGreaterThanOrEqual(1);
    expect(result.declarations.length).toBeGreaterThanOrEqual(1);
  });

  test('handles file not found', async () => {
    const tool = findTool('get_file_summary');
    const result = await tool.handler({ filePath: 'nonexistent.swift' }, ctx());
    expect(result.error).toContain('not found');
  });

  test('rejects path traversal', async () => {
    const tool = findTool('get_file_summary');
    const result = await tool.handler({ filePath: '../../../etc/passwd' }, ctx());
    expect(result.error).toContain('Path traversal');
  });

  test('uses fileCache when available', async () => {
    const tool = findTool('get_file_summary');
    const result = await tool.handler(
      { filePath: 'cached-file.swift' },
      {
        projectRoot: tmpDir,
        fileCache: [
          {
            relativePath: 'cached-file.swift',
            content: 'import UIKit\nclass MyView: UIView {\n  func setup() {\n  }\n}',
          },
        ],
      }
    );

    expect(result.language).toBe('swift');
    expect(result.imports).toEqual(expect.arrayContaining([expect.stringContaining('UIKit')]));
    expect(result.declarations.length).toBeGreaterThanOrEqual(1);
  });
});

/* ════════════════════════════════════════════════════════════
 *  P1: semantic_search_code
 * ════════════════════════════════════════════════════════════ */
describe('P1: semantic_search_code', () => {
  test('tool exists in ALL_TOOLS', () => {
    const tool = findTool('semantic_search_code');
    expect(tool).toBeDefined();
    expect(tool.parameters.required).toContain('query');
    expect(tool.parameters.properties).toHaveProperty('topK');
    expect(tool.parameters.properties).toHaveProperty('category');
    expect(tool.parameters.properties).toHaveProperty('language');
  });

  test('returns fallback error when no engine available', async () => {
    const tool = findTool('semantic_search_code');
    const result = await tool.handler(
      { query: 'error handling' },
      { projectRoot: tmpDir, container: null }
    );

    expect(result.error).toBeDefined();
    expect(result.fallbackTool).toBe('search_project_code');
  });

  test('handles empty query', async () => {
    const tool = findTool('semantic_search_code');
    const result = await tool.handler({ query: '' }, { container: { get: () => null } });
    expect(result.error).toContain('query');
  });

  test('uses SearchEngine when available', async () => {
    const tool = findTool('semantic_search_code');
    const mockEngine = {
      search: vi.fn().mockResolvedValue({
        items: [
          {
            id: '1',
            title: 'Error Handler',
            description: 'Handles errors',
            score: 0.95,
            knowledgeType: 'code-pattern',
            category: 'Service',
            language: 'swift',
          },
        ],
        mode: 'bm25',
      }),
    };
    const mockContainer = { get: (name) => (name === 'searchEngine' ? mockEngine : null) };

    const result = await tool.handler(
      { query: 'error handling', topK: 3 },
      { container: mockContainer }
    );

    expect(result.mode).toBe('bm25');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe('Error Handler');
    expect(mockEngine.search).toHaveBeenCalledWith(
      'error handling',
      expect.objectContaining({ mode: 'semantic' })
    );
  });
});

/* ════════════════════════════════════════════════════════════
 *  P2: Tool count & ALL_TOOLS integrity
 * ════════════════════════════════════════════════════════════ */
describe('P2: ALL_TOOLS integrity', () => {
  test('contains the current internal tool set', () => {
    expect(ALL_TOOLS.length).toBe(59);
  });

  test('all new tools have name, description, parameters, handler', () => {
    const newTools = ['list_project_structure', 'get_file_summary', 'semantic_search_code'];
    for (const name of newTools) {
      const tool = findTool(name);
      expect(tool).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  test('no duplicate tool names', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

/* ════════════════════════════════════════════════════════════
 *  P6: Knowledge service contract
 * ════════════════════════════════════════════════════════════ */
describe('P6: knowledge service contract', () => {
  test('search_recipes uses named knowledge service contract instead of container lookup', async () => {
    const tool = findTool('search_recipes');
    const searchEngine = {
      search: vi.fn().mockResolvedValue({ items: [{ id: 'r1', title: 'Recipe 1' }] }),
    };
    const context = knowledgeContractContext({
      searchEngine,
    });

    const result = await tool.handler({ keyword: 'recipe', limit: 5 }, context);

    expect(result).toEqual({ items: [{ id: 'r1', title: 'Recipe 1' }], total: 1 });
    expect(searchEngine.search).toHaveBeenCalledWith('recipe', { mode: 'keyword', limit: 5 });
  });

  test('get_related_recipes uses named knowledge graph contract', async () => {
    const tool = findTool('get_related_recipes');
    const knowledgeGraphService = {
      getStats: vi.fn(),
      getRelated: vi.fn().mockReturnValue([{ toId: 'r2' }]),
      getEdges: vi.fn(),
    };
    const context = knowledgeContractContext({
      knowledgeGraphService,
    });

    const result = await tool.handler({ recipeId: 'r1', relation: 'requires' }, context);

    expect(result).toEqual({
      recipeId: 'r1',
      relation: 'requires',
      edges: [{ toId: 'r2' }],
    });
    expect(knowledgeGraphService.getRelated).toHaveBeenCalledWith('r1', 'recipe', 'requires');
  });

  test('analyze_code uses named search engine contract for related recipes', async () => {
    const tool = findTool('analyze_code');
    const searchEngine = {
      search: vi.fn().mockResolvedValue([{ id: 'r1', title: 'Related Recipe' }]),
    };

    const result = await tool.handler(
      { code: 'function example() {}', language: 'typescript' },
      knowledgeContractContext({ searchEngine })
    );

    expect(result.relatedRecipes).toEqual({
      results: [{ id: 'r1', title: 'Related Recipe' }],
      total: 1,
    });
    expect(searchEngine.search).toHaveBeenCalledWith('function example() {}', { limit: 5 });
  });

  test('check_duplicate reads candidate through named knowledge service contract', async () => {
    const tool = findTool('check_duplicate');
    const knowledgeService = {
      search: vi.fn(),
      list: vi.fn(),
      get: vi.fn().mockResolvedValue({
        toJSON: () => ({
          title: 'Candidate Recipe',
          description: 'Candidate summary',
          content: { pattern: 'let value = optional!' },
        }),
      }),
      getStats: vi.fn(),
    };

    const result = await tool.handler(
      { candidateId: 'cand-1', threshold: 0.9 },
      knowledgeContractContext({ knowledgeService })
    );

    expect(result).toMatchObject({
      hasDuplicate: expect.any(Boolean),
      highestSimilarity: expect.any(Number),
    });
    expect(Array.isArray(result.similar)).toBe(true);
    expect(knowledgeService.get).toHaveBeenCalledWith('cand-1');
  });

  test('add_graph_edge uses named knowledge graph mutation contract', async () => {
    const tool = findTool('add_graph_edge');
    const knowledgeGraphService = {
      addEdge: vi.fn().mockReturnValue({ id: 'edge-1' }),
    };

    const result = await tool.handler(
      {
        fromId: 'r1',
        fromType: 'recipe',
        toId: 'r2',
        toType: 'recipe',
        relation: 'requires',
        weight: 0.7,
      },
      knowledgeContractContext({ knowledgeGraphService })
    );

    expect(result).toEqual({ id: 'edge-1' });
    expect(knowledgeGraphService.addEdge).toHaveBeenCalledWith(
      'r1',
      'recipe',
      'r2',
      'recipe',
      'requires',
      { weight: 0.7, source: 'manual' }
    );
  });
});

/* ════════════════════════════════════════════════════════════
 *  P6: Guard service contract
 * ════════════════════════════════════════════════════════════ */
describe('P6: guard service contract', () => {
  test('list_guard_rules uses named guard service contract instead of container lookup', async () => {
    const tool = findTool('list_guard_rules');
    const guardService = {
      listRules: vi.fn().mockResolvedValue({ data: [{ id: 'db-rule', source: 'database' }] }),
      checkCode: vi.fn(),
    };
    const guardCheckEngine = {
      getRules: vi.fn().mockReturnValue([
        { id: 'builtin-rule', source: 'built-in' },
        { id: 'custom-engine-rule', source: 'database' },
      ]),
      checkCode: vi.fn(),
    };

    const result = await tool.handler(
      { language: 'swift', limit: 10 },
      guardContractContext({ guardService, guardCheckEngine })
    );

    expect(result).toEqual({
      total: 2,
      rules: [
        { id: 'db-rule', source: 'database' },
        { id: 'builtin-rule', source: 'built-in' },
      ],
    });
    expect(guardService.listRules).toHaveBeenCalledWith({}, { page: 1, pageSize: 10 });
    expect(guardCheckEngine.getRules).toHaveBeenCalledWith('swift');
  });

  test('guard_check_code uses named guard check engine contract', async () => {
    const tool = findTool('guard_check_code');
    const guardCheckEngine = {
      getRules: vi.fn(),
      checkCode: vi.fn().mockReturnValue([{ ruleId: 'no-force-unwrap' }]),
    };

    const result = await tool.handler(
      { code: 'let value = optional!', language: 'swift', scope: 'file' },
      guardContractContext({ guardCheckEngine })
    );

    expect(result).toEqual({
      violationCount: 1,
      violations: [{ ruleId: 'no-force-unwrap' }],
    });
    expect(guardCheckEngine.checkCode).toHaveBeenCalledWith('let value = optional!', 'swift', {
      scope: 'file',
    });
  });

  test('query_violations uses named violations store contract', async () => {
    const tool = findTool('query_violations');
    const violationsStore = {
      getStats: vi.fn(),
      getRunsByFile: vi.fn(),
      list: vi.fn().mockReturnValue({ items: [{ id: 'run-1' }] }),
    };

    const result = await tool.handler({ limit: 3 }, guardContractContext({ violationsStore }));

    expect(result).toEqual({ items: [{ id: 'run-1' }] });
    expect(violationsStore.list).toHaveBeenCalledWith({}, { page: 1, limit: 3 });
  });

  test('analyze_code uses named guard contract for its guard branch', async () => {
    const tool = findTool('analyze_code');
    const guardCheckEngine = {
      getRules: vi.fn(),
      checkCode: vi.fn().mockReturnValue([{ ruleId: 'unsafe-call' }]),
    };

    const result = await tool.handler(
      { code: 'dangerousCall()', language: 'typescript' },
      guardContractContext({ guardCheckEngine })
    );

    expect(result.guard).toEqual({
      violationCount: 1,
      violations: [{ ruleId: 'unsafe-call' }],
    });
    expect(guardCheckEngine.checkCode).toHaveBeenCalledWith('dangerousCall()', 'typescript', {
      scope: 'file',
    });
  });
});

/* ════════════════════════════════════════════════════════════
 *  P6: Lifecycle service contract
 * ════════════════════════════════════════════════════════════ */
describe('P6: lifecycle service contract', () => {
  test('approve_candidate uses named lifecycle contract instead of container lookup', async () => {
    const tool = findTool('approve_candidate');
    const knowledgeLifecycleService = createKnowledgeLifecycleService({
      approve: vi.fn().mockResolvedValue({ id: 'cand-1', lifecycle: 'active' }),
    });

    const result = await tool.handler(
      { candidateId: 'cand-1' },
      lifecycleContractContext({ knowledgeLifecycleService })
    );

    expect(result).toEqual({ id: 'cand-1', lifecycle: 'active' });
    expect(knowledgeLifecycleService.approve).toHaveBeenCalledWith('cand-1', { userId: 'agent' });
  });

  test('update_recipe uses named lifecycle contract', async () => {
    const tool = findTool('update_recipe');
    const knowledgeLifecycleService = createKnowledgeLifecycleService({
      update: vi.fn().mockResolvedValue({ id: 'recipe-1', title: 'Updated' }),
    });

    const result = await tool.handler(
      { recipeId: 'recipe-1', updates: { title: 'Updated' } },
      lifecycleContractContext({ knowledgeLifecycleService })
    );

    expect(result).toEqual({ id: 'recipe-1', title: 'Updated' });
    expect(knowledgeLifecycleService.update).toHaveBeenCalledWith(
      'recipe-1',
      { title: 'Updated' },
      { userId: 'agent' }
    );
  });

  test('record_usage uses named lifecycle contract', async () => {
    const tool = findTool('record_usage');
    const knowledgeLifecycleService = createKnowledgeLifecycleService({
      incrementUsage: vi.fn().mockResolvedValue({ ok: true }),
    });

    const result = await tool.handler(
      { recipeId: 'recipe-1', type: 'application' },
      lifecycleContractContext({ knowledgeLifecycleService })
    );

    expect(result).toEqual({ success: true, recipeId: 'recipe-1', type: 'application' });
    expect(knowledgeLifecycleService.incrementUsage).toHaveBeenCalledWith(
      'recipe-1',
      'application'
    );
  });
});

/* ════════════════════════════════════════════════════════════
 *  P6: Infra service contract
 * ════════════════════════════════════════════════════════════ */
describe('P6: infra service contract', () => {
  test('graph_impact_analysis uses named infra knowledge graph contract', async () => {
    const tool = findTool('graph_impact_analysis');
    const knowledgeGraphService = {
      getImpactAnalysis: vi.fn().mockReturnValue([{ id: 'downstream-1' }]),
    };

    const result = await tool.handler(
      { recipeId: 'recipe-1', maxDepth: 2 },
      infraContractContext({ knowledgeGraphService })
    );

    expect(result).toEqual({
      recipeId: 'recipe-1',
      impactedCount: 1,
      impacted: [{ id: 'downstream-1' }],
    });
    expect(knowledgeGraphService.getImpactAnalysis).toHaveBeenCalledWith('recipe-1', 'recipe', 2);
  });

  test('rebuild_index uses named infra indexing contract', async () => {
    const tool = findTool('rebuild_index');
    const indexingPipeline = {
      run: vi.fn().mockResolvedValue({ rebuilt: true }),
    };

    const result = await tool.handler(
      { force: true, dryRun: true },
      infraContractContext({ indexingPipeline })
    );

    expect(result).toEqual({ rebuilt: true });
    expect(indexingPipeline.run).toHaveBeenCalledWith({ force: true, dryRun: true });
  });

  test('query_audit_log uses named infra audit contract', async () => {
    const tool = findTool('query_audit_log');
    const auditLogger = {
      getByActor: vi.fn().mockReturnValue([{ id: 'audit-1' }]),
      getByAction: vi.fn(),
      getStats: vi.fn(),
    };

    const result = await tool.handler(
      { actor: 'agent', limit: 5 },
      infraContractContext({ auditLogger })
    );

    expect(result).toEqual([{ id: 'audit-1' }]);
    expect(auditLogger.getByActor).toHaveBeenCalledWith('agent', 5);
  });
});

/* ════════════════════════════════════════════════════════════
 *  P6: Quality service contract
 * ════════════════════════════════════════════════════════════ */
describe('P6: quality service contract', () => {
  test('quality_score uses named quality scorer contract', async () => {
    const tool = findTool('quality_score');
    const qualityScorer = {
      score: vi.fn().mockReturnValue({ score: 92, grade: 'A' }),
    };
    const recipe = { id: 'recipe-1', title: 'Recipe' };

    const result = await tool.handler({ recipe }, qualityContractContext({ qualityScorer }));

    expect(result).toEqual({ score: 92, grade: 'A' });
    expect(qualityScorer.score).toHaveBeenCalledWith(recipe);
  });

  test('validate_candidate uses named candidate validator contract', async () => {
    const tool = findTool('validate_candidate');
    const recipeCandidateValidator = {
      validate: vi.fn().mockReturnValue({ ok: true, warnings: [] }),
    };
    const candidate = { title: 'Candidate' };

    const result = await tool.handler(
      { candidate },
      qualityContractContext({ recipeCandidateValidator })
    );

    expect(result).toEqual({ ok: true, warnings: [] });
    expect(recipeCandidateValidator.validate).toHaveBeenCalledWith(candidate);
  });

  test('get_feedback_stats uses named feedback collector contract', async () => {
    const tool = findTool('get_feedback_stats');
    const feedbackCollector = createFeedbackCollector({
      getRecipeStats: vi.fn().mockReturnValue({ recipeId: 'recipe-1', views: 3 }),
    });

    const result = await tool.handler(
      { recipeId: 'recipe-1', topN: 2 },
      qualityContractContext({ feedbackCollector })
    );

    expect(result).toEqual({
      global: { total: 10 },
      topRecipes: [{ id: 'top-1' }],
      recipeStats: { recipeId: 'recipe-1', views: 3 },
    });
    expect(feedbackCollector.getGlobalStats).toHaveBeenCalledWith();
    expect(feedbackCollector.getTopRecipes).toHaveBeenCalledWith(2);
    expect(feedbackCollector.getRecipeStats).toHaveBeenCalledWith('recipe-1');
  });

  test('knowledge_overview uses named quality feedback contract for top recipes', async () => {
    const tool = findTool('knowledge_overview');
    const feedbackCollector = createFeedbackCollector();

    const result = await tool.handler(
      { includeTopRecipes: true, limit: 1 },
      qualityContractContext({ feedbackCollector })
    );

    expect(result.topRecipes).toEqual([{ id: 'top-1' }]);
    expect(feedbackCollector.getTopRecipes).toHaveBeenCalledWith(1);
  });

  test('knowledge_overview uses named knowledge contracts for stats and graph', async () => {
    const tool = findTool('knowledge_overview');
    const knowledgeService = {
      search: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      getStats: vi.fn().mockReturnValue({ recipes: { total: 3 } }),
    };
    const knowledgeGraphService = {
      getStats: vi.fn().mockReturnValue({ nodes: 4, edges: 5 }),
      getRelated: vi.fn(),
      getEdges: vi.fn(),
    };

    const result = await tool.handler(
      { includeTopRecipes: false },
      knowledgeContractContext({ knowledgeService, knowledgeGraphService })
    );

    expect(result.knowledge).toEqual({ recipes: { total: 3 } });
    expect(result.knowledgeGraph).toEqual({ nodes: 4, edges: 5 });
    expect(knowledgeService.getStats).toHaveBeenCalledWith();
    expect(knowledgeGraphService.getStats).toHaveBeenCalledWith();
  });
});

function knowledgeContractContext({
  knowledgeService = null,
  searchEngine = null,
  knowledgeGraphService = null,
} = {}) {
  return {
    projectRoot: tmpDir,
    container: {
      get() {
        throw new Error('query tools should use the named knowledge service contract');
      },
    },
    serviceContracts: {
      knowledge: {
        getKnowledgeService: () => knowledgeService,
        getSearchEngine: () => searchEngine,
        getKnowledgeGraphService: () => knowledgeGraphService,
      },
    },
  };
}

function qualityContractContext({
  qualityScorer = null,
  recipeCandidateValidator = null,
  feedbackCollector = null,
} = {}) {
  return {
    projectRoot: tmpDir,
    container: {
      get() {
        throw new Error('quality tools should use the named quality service contract');
      },
    },
    serviceContracts: {
      quality: {
        getQualityScorer: () => qualityScorer,
        getRecipeCandidateValidator: () => recipeCandidateValidator,
        getFeedbackCollector: () => feedbackCollector,
      },
    },
  };
}

function createFeedbackCollector(overrides = {}) {
  return {
    getGlobalStats: vi.fn().mockReturnValue({ total: 10 }),
    getTopRecipes: vi.fn().mockReturnValue([{ id: 'top-1' }]),
    getRecipeStats: vi.fn(),
    ...overrides,
  };
}

function infraContractContext({
  knowledgeGraphService = null,
  indexingPipeline = null,
  auditLogger = null,
} = {}) {
  return {
    projectRoot: tmpDir,
    container: {
      get() {
        throw new Error('infra tools should use the named infra service contract');
      },
    },
    serviceContracts: {
      infra: {
        getKnowledgeGraphService: () => knowledgeGraphService,
        getIndexingPipeline: () => indexingPipeline,
        getAuditLogger: () => auditLogger,
      },
    },
  };
}

function lifecycleContractContext({
  knowledgeLifecycleService = null,
  proposalRepository = null,
  evolutionGateway = null,
  consolidationAdvisor = null,
} = {}) {
  return {
    projectRoot: tmpDir,
    container: {
      get() {
        throw new Error('lifecycle tools should use the named lifecycle service contract');
      },
    },
    serviceContracts: {
      lifecycle: {
        getKnowledgeLifecycleService: () => knowledgeLifecycleService,
        getProposalRepository: () => proposalRepository,
        getEvolutionGateway: () => evolutionGateway,
        getConsolidationAdvisor: () => consolidationAdvisor,
      },
    },
  };
}

function createKnowledgeLifecycleService(overrides = {}) {
  return {
    create: vi.fn().mockResolvedValue({ id: 'created-1', title: 'Created', lifecycle: 'pending' }),
    updateQuality: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    publish: vi.fn(),
    deprecate: vi.fn(),
    update: vi.fn(),
    incrementUsage: vi.fn(),
    get: vi.fn(),
    ...overrides,
  };
}

function guardContractContext({
  guardService = null,
  guardCheckEngine = null,
  violationsStore = null,
} = {}) {
  return {
    projectRoot: tmpDir,
    container: {
      get() {
        throw new Error('guard tools should use the named guard service contract');
      },
    },
    serviceContracts: {
      guard: {
        getGuardService: () => guardService,
        getGuardCheckEngine: () => guardCheckEngine,
        getViolationsStore: () => violationsStore,
      },
    },
  };
}

/* ════════════════════════════════════════════════════════════
 *  P3: query_call_graph tool structure & edge cases
 * ════════════════════════════════════════════════════════════ */
describe('P3: query_call_graph tool', () => {
  test('exists in ALL_TOOLS with correct schema', () => {
    const tool = findTool('query_call_graph');
    expect(tool).toBeDefined();
    expect(typeof tool.handler).toBe('function');
    expect(tool.parameters.properties.methodName).toBeDefined();
    expect(tool.parameters.properties.direction).toBeDefined();
    expect(tool.parameters.properties.direction.enum).toEqual(
      expect.arrayContaining(['callers', 'callees', 'both', 'impact', 'search'])
    );
    expect(tool.parameters.required).toEqual(['methodName']);
  });

  test('handler returns error when DB unavailable', async () => {
    const tool = findTool('query_call_graph');
    // no container → graceful error
    const result = await tool.handler({ methodName: 'Foo.bar' }, {});
    expect(typeof result).toBe('string');
    expect(result).toMatch(/不可用|未初始化|失败/);
  });

  test('handler returns error when methodName missing', async () => {
    const tool = findTool('query_call_graph');
    const result = await tool.handler({}, {});
    expect(result).toMatch(/methodName/);
  });

  test('supports snake_case parameter aliases', async () => {
    const tool = findTool('query_call_graph');
    // method_name alias — should still return error about DB, not about missing param
    const result = await tool.handler({ method_name: 'Foo.bar' }, {});
    expect(result).not.toMatch(/methodName 参数/);
  });
});

/* ════════════════════════════════════════════════════════════
 *  P4: Cross-language tool descriptions
 * ════════════════════════════════════════════════════════════ */
describe('P4: Cross-language tool descriptions', () => {
  test('get_project_overview mentions multi-language support', () => {
    const tool = findTool('get_project_overview');
    expect(tool.description).toMatch(/Swift|Java|Python|TS/);
  });

  test('get_class_info is cross-language', () => {
    const tool = findTool('get_class_info');
    expect(tool.description).toMatch(/跨语言/);
  });

  test('get_protocol_info is cross-language', () => {
    const tool = findTool('get_protocol_info');
    expect(tool.description).toMatch(/接口|trait/);
  });

  test('get_method_overrides is cross-language', () => {
    const tool = findTool('get_method_overrides');
    expect(tool.description).toMatch(/跨语言/);
  });

  test('query_code_graph includes method entity type', () => {
    const tool = findTool('query_code_graph');
    expect(tool.parameters.properties.entity_type.enum).toContain('method');
  });
});
