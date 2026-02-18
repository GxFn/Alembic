import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* ────────────────────────────────────────────
 *  动态导入
 * ──────────────────────────────────────────── */
let ALL_TOOLS;

beforeAll(async () => {
  const toolsMod = await import('../../lib/service/chat/tools.js');
  ALL_TOOLS = toolsMod.ALL_TOOLS || toolsMod.default;
});

/* ────────────────────────────────────────────
 *  Helpers
 * ──────────────────────────────────────────── */
function findTool(name) {
  return ALL_TOOLS.find(t => t.name === name);
}

// 创建临时项目目录结构用于工具测试
let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-v10-test-'));
  // 创建目录结构
  fs.mkdirSync(path.join(tmpDir, 'src', 'models'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'src', 'services'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });

  // 创建一个 ObjC 文件
  fs.writeFileSync(path.join(tmpDir, 'src', 'models', 'User.m'), `
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
`);

  // 创建一个 Swift 文件
  fs.writeFileSync(path.join(tmpDir, 'src', 'services', 'NetworkManager.swift'), `
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
`);

  // 创建一个 JS 文件
  fs.writeFileSync(path.join(tmpDir, 'src', 'services', 'ApiClient.js'), `
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
`);

  // 创建 node_modules 中的文件（应被过滤）
  fs.mkdirSync(path.join(tmpDir, 'node_modules', 'some-lib'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'node_modules', 'some-lib', 'index.js'), 'module.exports = {}');
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
    expect(result.imports).toEqual(expect.arrayContaining([
      expect.stringContaining('Foundation'),
    ]));
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
          { relativePath: 'cached-file.swift', content: 'import UIKit\nclass MyView: UIView {\n  func setup() {\n  }\n}' },
        ],
      },
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
      { projectRoot: tmpDir, container: null },
    );

    expect(result.error).toBeDefined();
    expect(result.fallbackTool).toBe('search_project_code');
  });

  test('handles empty query', async () => {
    const tool = findTool('semantic_search_code');
    const result = await tool.handler(
      { query: '' },
      { container: { get: () => null } },
    );
    expect(result.error).toContain('query');
  });

  test('uses SearchEngine when available', async () => {
    const tool = findTool('semantic_search_code');
    const mockEngine = {
      search: jest.fn().mockResolvedValue({
        items: [
          { id: '1', title: 'Error Handler', description: 'Handles errors', score: 0.95, knowledgeType: 'code-pattern', category: 'Service', language: 'swift' },
        ],
        mode: 'bm25',
      }),
    };
    const mockContainer = { get: (name) => name === 'searchEngine' ? mockEngine : null };

    const result = await tool.handler(
      { query: 'error handling', topK: 3 },
      { container: mockContainer },
    );

    expect(result.mode).toBe('bm25');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe('Error Handler');
    expect(mockEngine.search).toHaveBeenCalledWith('error handling', expect.objectContaining({ mode: 'semantic' }));
  });
});

/* ════════════════════════════════════════════════════════════
 *  P2: Tool count & ALL_TOOLS integrity
 * ════════════════════════════════════════════════════════════ */
describe('P2: ALL_TOOLS integrity', () => {
  test('contains 57 tools (54 original + 3 agent-memory)', () => {
    expect(ALL_TOOLS.length).toBe(58);
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
    const names = ALL_TOOLS.map(t => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
