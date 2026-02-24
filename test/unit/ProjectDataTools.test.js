import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

/* ────────────────────────────────────────────
 *  动态导入 tools.js 获取 ALL_TOOLS 数组
 * ──────────────────────────────────────────── */
let searchProjectCode, readProjectFile, submitWithCheck, getFileSummary;

beforeAll(async () => {
  const mod = await import('../../lib/service/chat/tools.js');
  const tools = mod.ALL_TOOLS;
  searchProjectCode = tools.find((t) => t.name === 'search_project_code');
  readProjectFile = tools.find((t) => t.name === 'read_project_file');
  submitWithCheck = tools.find((t) => t.name === 'submit_with_check');
  getFileSummary = tools.find((t) => t.name === 'get_file_summary');
});

/* ────────────────────────────────────────────
 *  Helpers: 创建临时测试项目目录
 * ──────────────────────────────────────────── */
let testProjectDir;

function setupTestProject() {
  testProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-tools-test-'));

  // src/AppDelegate.m
  fs.mkdirSync(path.join(testProjectDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(testProjectDir, 'src', 'AppDelegate.m'),
    [
      '#import "AppDelegate.h"',
      '',
      '@implementation AppDelegate',
      '',
      '- (BOOL)application:(UIApplication *)app didFinishLaunchingWithOptions:(NSDictionary *)opts {',
      '    [self setupWindow];',
      '    [BILNetworkManager sharedManager];',
      '    return YES;',
      '}',
      '',
      '- (void)setupWindow {',
      '    self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];',
      '}',
      '',
      '@end',
    ].join('\n')
  );

  // src/BILNetworkManager.m
  fs.writeFileSync(
    path.join(testProjectDir, 'src', 'BILNetworkManager.m'),
    [
      '#import "BILNetworkManager.h"',
      '',
      '@implementation BILNetworkManager',
      '',
      '+ (instancetype)sharedManager {',
      '    static BILNetworkManager *instance;',
      '    static dispatch_once_t onceToken;',
      '    dispatch_once(&onceToken, ^{',
      '        instance = [[self alloc] init];',
      '    });',
      '    return instance;',
      '}',
      '',
      '- (void)fetchDataWithURL:(NSURL *)url completion:(void(^)(id))block {',
      '    NSURLSession *session = [NSURLSession sharedSession];',
      '    [[session dataTaskWithURL:url completionHandler:^(NSData *data, NSURLResponse *resp, NSError *err) {',
      '        if (block) block(data);',
      '    }] resume];',
      '}',
      '',
      '@end',
    ].join('\n')
  );

  // src/BILNetworkManager.h
  fs.writeFileSync(
    path.join(testProjectDir, 'src', 'BILNetworkManager.h'),
    [
      '#import <Foundation/Foundation.h>',
      '',
      '@interface BILNetworkManager : NSObject',
      '+ (instancetype)sharedManager;',
      '- (void)fetchDataWithURL:(NSURL *)url completion:(void(^)(id))block;',
      '@end',
    ].join('\n')
  );

  // Pods/Masonry/Masonry.m (third-party — should be filtered)
  fs.mkdirSync(path.join(testProjectDir, 'Pods', 'Masonry'), { recursive: true });
  fs.writeFileSync(
    path.join(testProjectDir, 'Pods', 'Masonry', 'Masonry.m'),
    [
      '// Masonry third party code',
      '#import "Masonry.h"',
      'dispatch_once(&tok, ^{ /* third party singleton */ });',
    ].join('\n')
  );

  // README.md (non-source — should be filtered)
  fs.writeFileSync(path.join(testProjectDir, 'README.md'), '# Test Project');

  // src/large-binary.m (simulating large file)
  // We don't actually create a 512KB+ file in tests to keep them fast
}

function cleanupTestProject() {
  if (testProjectDir) {
    fs.rmSync(testProjectDir, { recursive: true, force: true });
    testProjectDir = null;
  }
}

function makeCtx(overrides = {}) {
  return {
    projectRoot: testProjectDir,
    fileCache: null,
    logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    ...overrides,
  };
}

/* ────────────────────────────────────────────
 *  Tests: search_project_code
 * ──────────────────────────────────────────── */
describe('search_project_code', () => {
  beforeAll(() => setupTestProject());
  afterAll(() => cleanupTestProject());

  it('should exist in ALL_TOOLS', () => {
    expect(searchProjectCode).toBeDefined();
    expect(searchProjectCode.name).toBe('search_project_code');
  });

  it('should find text pattern in project files', async () => {
    const result = await searchProjectCode.handler({ pattern: 'dispatch_once' }, makeCtx());
    expect(result.total).toBeGreaterThan(0);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].file).toContain('BILNetworkManager.m');
    expect(result.matches[0].code).toContain('dispatch_once');
  });

  it('should filter third-party code (Pods)', async () => {
    const result = await searchProjectCode.handler({ pattern: 'dispatch_once' }, makeCtx());
    // Should NOT include Pods/Masonry hit
    const podHits = result.matches.filter((m) => m.file.includes('Pods'));
    expect(podHits).toHaveLength(0);
    expect(result.skippedThirdParty).toBeGreaterThan(0);
  });

  it('should support regex mode', async () => {
    const result = await searchProjectCode.handler(
      { pattern: 'sharedManager|sharedSession', isRegex: true },
      makeCtx()
    );
    expect(result.total).toBeGreaterThanOrEqual(2);
  });

  it('should support file extension filter', async () => {
    const result = await searchProjectCode.handler(
      { pattern: 'sharedManager', fileFilter: '.h' },
      makeCtx()
    );
    // Only .h files should be searched
    for (const m of result.matches) {
      expect(m.file).toMatch(/\.h$/);
    }
  });

  it('should include context lines', async () => {
    const result = await searchProjectCode.handler(
      { pattern: 'dispatch_once', contextLines: 3 },
      makeCtx()
    );
    expect(result.matches[0].context).toBeDefined();
    const contextLines = result.matches[0].context.split('\n');
    expect(contextLines.length).toBeGreaterThan(1);
  });

  it('should respect maxResults', async () => {
    const result = await searchProjectCode.handler({ pattern: 'self', maxResults: 2 }, makeCtx());
    expect(result.matches.length).toBeLessThanOrEqual(2);
    // total may be > maxResults
    expect(result.total).toBeGreaterThanOrEqual(result.matches.length);
  });

  it('should score usage lines higher than declarations', async () => {
    const result = await searchProjectCode.handler({ pattern: 'sharedManager' }, makeCtx());
    // matches sorted by score desc
    const scores = result.matches.map((m) => m.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  it('should handle invalid regex gracefully', async () => {
    const result = await searchProjectCode.handler(
      { pattern: '(unclosed', isRegex: true },
      makeCtx()
    );
    expect(result.error).toBeDefined();
    expect(result.matches).toEqual([]);
  });

  it('should handle empty project gracefully', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-empty-'));
    try {
      const result = await searchProjectCode.handler(
        { pattern: 'anything' },
        makeCtx({ projectRoot: emptyDir })
      );
      expect(result.matches).toEqual([]);
      expect(result.total).toBe(0);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('should work with fileCache (bootstrap mode)', async () => {
    const fileCache = [
      {
        relativePath: 'src/Cached.m',
        content: '// cached content\ndispatch_once(&tok, ^{});',
        name: 'Cached.m',
      },
      { relativePath: 'Pods/AFN/AFN.m', content: 'dispatch_once(&t, ^{});', name: 'AFN.m' },
    ];
    const result = await searchProjectCode.handler(
      { pattern: 'dispatch_once' },
      makeCtx({ fileCache })
    );
    // Should find in Cached.m but not in Pods/AFN
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].file).toBe('src/Cached.m');
    expect(result.skippedThirdParty).toBe(1);
  });
});

/* ────────────────────────────────────────────
 *  Tests: read_project_file
 * ──────────────────────────────────────────── */
describe('read_project_file', () => {
  beforeAll(() => setupTestProject());
  afterAll(() => cleanupTestProject());

  it('should exist in ALL_TOOLS', () => {
    expect(readProjectFile).toBeDefined();
    expect(readProjectFile.name).toBe('read_project_file');
  });

  it('should read a file by relative path', async () => {
    const result = await readProjectFile.handler({ filePath: 'src/AppDelegate.m' }, makeCtx());
    expect(result.content).toContain('AppDelegate');
    expect(result.totalLines).toBeGreaterThan(0);
    expect(result.language).toBe('objectivec');
  });

  it('should support startLine and endLine', async () => {
    const result = await readProjectFile.handler(
      { filePath: 'src/BILNetworkManager.m', startLine: 5, endLine: 12 },
      makeCtx()
    );
    expect(result.startLine).toBe(5);
    expect(result.endLine).toBe(12);
    expect(result.content).toContain('sharedManager');
  });

  it('should respect maxLines limit', async () => {
    const result = await readProjectFile.handler(
      { filePath: 'src/BILNetworkManager.m', maxLines: 5 },
      makeCtx()
    );
    const lines = result.content.split('\n');
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it('should reject path traversal (..)', async () => {
    const result = await readProjectFile.handler({ filePath: '../../../etc/passwd' }, makeCtx());
    expect(result.error).toBeDefined();
    expect(result.error).toContain('traversal');
  });

  it('should reject absolute paths', async () => {
    const result = await readProjectFile.handler({ filePath: '/etc/passwd' }, makeCtx());
    expect(result.error).toBeDefined();
    expect(result.error).toContain('traversal');
  });

  it('should handle non-existent file', async () => {
    const result = await readProjectFile.handler({ filePath: 'nonexistent/file.m' }, makeCtx());
    expect(result.error).toBeDefined();
    expect(result.error).toContain('not found');
  });

  it('should detect language from extension', async () => {
    const resultM = await readProjectFile.handler({ filePath: 'src/AppDelegate.m' }, makeCtx());
    expect(resultM.language).toBe('objectivec');

    const resultH = await readProjectFile.handler(
      { filePath: 'src/BILNetworkManager.h' },
      makeCtx()
    );
    expect(resultH.language).toBe('objectivec');
  });

  it('should work with fileCache (bootstrap mode)', async () => {
    const fileCache = [
      {
        relativePath: 'cached/Test.swift',
        content: 'import UIKit\nclass Test {}',
        name: 'Test.swift',
      },
    ];
    const result = await readProjectFile.handler(
      { filePath: 'cached/Test.swift' },
      makeCtx({ fileCache })
    );
    expect(result.content).toContain('import UIKit');
    expect(result.language).toBe('swift');
    expect(result.totalLines).toBe(2);
  });

  it('should fallback to disk when file not in cache', async () => {
    const fileCache = [{ relativePath: 'other/file.m', content: 'other', name: 'file.m' }];
    const result = await readProjectFile.handler(
      { filePath: 'src/AppDelegate.m' },
      makeCtx({ fileCache })
    );
    // Should read from disk since not in cache
    expect(result.content).toContain('AppDelegate');
  });
});

/* ────────────────────────────────────────────
 *  Tests: submit_with_check — 与 submit_knowledge 一致性
 * ──────────────────────────────────────────── */
describe('submit_with_check consistency', () => {
  beforeAll(() => setupTestProject());
  afterAll(() => cleanupTestProject());

  it('should auto-fill knowledgeType from dimensionMeta', async () => {
    const params = {
      title: 'Example Pattern',
      language: 'swift',
      category: 'Architecture',
      description: '示例架构模式',
      trigger: '@example-pattern',
      kind: 'pattern',
      doClause: 'Use this pattern for architecture',
      dontClause: 'Do not bypass the router',
      whenClause: 'When setting up module routing',
      coreCode: 'func example() {\n  router.navigate()\n}',
      headers: [],
      usageGuide: '### Usage\nCall example()',
      content: {
        markdown: '## Example\n\n架构模式示例。本模式展示了如何通过路由器实现模块间解耦导航，确保各业务模块不直接依赖彼此。\n\n```swift\n// 来源: Router.swift:10\nclass Router {\n  static let shared = Router()\n  private var routes: [String: () -> UIViewController] = [:]\n\n  func register(_ path: String, factory: @escaping () -> UIViewController) {\n    routes[path] = factory\n  }\n\n  func navigate(to path: String) {\n    guard let vc = routes[path]?() else { return }\n    topViewController?.navigationController?.pushViewController(vc, animated: true)\n  }\n}\n```\n\n应始终通过路由器导航，禁止直接 push ViewController。路由器负责统一管理页面跳转逻辑。',
        pattern: 'func example() {}',
        rationale: 'standard architecture',
      },
      reasoning: { whyStandard: 'standard approach', sources: ['Example.swift'], confidence: 0.85 },
    };
    const mockKnowledgeService = {
      create: jest.fn().mockResolvedValue({
        id: 'k-1',
        lifecycle: 'draft',
        toJSON() {
          return { id: 'k-1' };
        },
      }),
    };
    const ctx = {
      projectRoot: testProjectDir,
      source: 'system',
      _dimensionMeta: {
        id: 'architecture',
        allowedKnowledgeTypes: ['architecture', 'best-practice'],
        allowedCategories: ['Architecture', 'Service'],
      },
      container: { get: (name) => (name === 'knowledgeService' ? mockKnowledgeService : null) },
      logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    };
    const result = await submitWithCheck.handler(params, ctx);
    expect(result.submitted).toBe(true);
    // Verify knowledgeType was auto-filled into the data passed to create
    const dataArg = mockKnowledgeService.create.mock.calls[0][0];
    expect(dataArg.knowledgeType).toBe('architecture');
  });

  it('should derive source from ctx.source', async () => {
    const params = {
      title: 'Test',
      language: 'swift',
      category: 'Service',
      description: '测试来源推断',
      trigger: '@test-source',
      kind: 'pattern',
      doClause: 'Use this test pattern',
      dontClause: 'Do not skip validation',
      whenClause: 'When testing source derivation',
      coreCode: 'func test() {\n  validate()\n}',
      headers: [],
      usageGuide: '### Usage\nCall test()',
      content: {
        markdown: '## Test\n\n测试来源推断。本模式展示了如何在提交知识时自动推断数据来源，确保元数据完整性。\n\n```swift\n// 来源: Test.swift:5\nfunc validate(input: String) -> Bool {\n  guard !input.isEmpty else { return false }\n  let pattern = "^[a-zA-Z0-9]+$"\n  return input.range(of: pattern, options: .regularExpression) != nil\n}\n\nfunc testValidation() {\n  assert(validate(input: "abc123") == true)\n  assert(validate(input: "") == false)\n}\n```\n\n应始终进行验证，确保输入数据符合预期格式。验证失败时需提供明确的错误提示。',
        pattern: 'func test() {}',
        rationale: 'test rationale',
      },
      reasoning: { whyStandard: 'test reason', sources: ['Test.swift'], confidence: 0.8 },
    };
    const mockKnowledgeService = {
      create: jest.fn().mockResolvedValue({
        id: 'k-2',
        lifecycle: 'draft',
        toJSON() {
          return { id: 'k-2' };
        },
      }),
    };
    const ctx = {
      projectRoot: testProjectDir,
      source: 'system',
      container: { get: (name) => (name === 'knowledgeService' ? mockKnowledgeService : null) },
      logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    };
    const result = await submitWithCheck.handler(params, ctx);
    expect(result.submitted).toBe(true);
    // source='system' maps to 'bootstrap'
    const dataArg = mockKnowledgeService.create.mock.calls[0][0];
    expect(dataArg.source).toBe('bootstrap');
  });

  it('should use knowledgeType from dimensionMeta', async () => {
    const params = {
      title: 'Router Pattern',
      language: 'swift',
      category: 'Architecture',
      description: '路由模式',
      trigger: '@router-pattern',
      kind: 'pattern',
      doClause: 'Use Router for navigation',
      dontClause: 'Do not use direct pushViewController',
      whenClause: 'When implementing navigation',
      coreCode: 'class Router {\n  func navigate() {}\n}',
      headers: [],
      usageGuide: '### Usage\nUse Router.navigate()',
      content: {
        markdown: '## Router\n\n路由器模式。本模式定义了统一的页面导航方案，通过中心化的路由注册与跳转机制解耦模块间依赖。\n\n```swift\n// 来源: Router.swift:1\nclass Router {\n  static let shared = Router()\n  private var handlers: [String: () -> UIViewController] = [:]\n\n  func register(_ route: String, handler: @escaping () -> UIViewController) {\n    handlers[route] = handler\n  }\n\n  func navigate(to route: String) {\n    guard let vc = handlers[route]?() else { return }\n    UIApplication.topVC?.navigationController?.pushViewController(vc, animated: true)\n  }\n}\n```\n\n应始终通过路由器导航，禁止直接 push ViewController。路由器负责统一管理跳转逻辑。',
        pattern: 'class Router {}',
        rationale: 'router pattern',
      },
      reasoning: { whyStandard: 'standard router', sources: ['Router.swift'], confidence: 0.85 },
    };
    const mockKnowledgeService = {
      create: jest.fn().mockResolvedValue({
        id: 'k-3',
        lifecycle: 'draft',
        toJSON() {
          return { id: 'k-3' };
        },
      }),
    };
    const ctx = {
      projectRoot: testProjectDir,
      _dimensionMeta: {
        id: 'architecture',
        allowedKnowledgeTypes: ['architecture'],
        allowedCategories: ['Architecture'],
      },
      container: { get: (name) => (name === 'knowledgeService' ? mockKnowledgeService : null) },
      logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    };
    const result = await submitWithCheck.handler(params, ctx);
    expect(result.submitted).toBe(true);
    const dataArg = mockKnowledgeService.create.mock.calls[0][0];
    expect(dataArg.knowledgeType).toBe('architecture');
  });
});

/* ────────────────────────────────────────────
 *  Tests: get_file_summary — 语言映射
 * ──────────────────────────────────────────── */
describe('get_file_summary language map', () => {
  beforeAll(() => setupTestProject());
  afterAll(() => cleanupTestProject());

  it('should not mismap .java/.kt/.go/.rs/.rb to javascript', async () => {
    // Create test files
    const testFiles = {
      'Test.java': 'public class Test { public void run() {} }',
      'Test.kt': 'class Test { fun run() {} }',
      'test.go': 'package main\nfunc main() {}',
      'test.rs': 'fn main() {}',
      'test.rb': 'class Test; end',
    };
    for (const [name, content] of Object.entries(testFiles)) {
      fs.writeFileSync(path.join(testProjectDir, name), content);
    }

    // Languages with extractors should return structured data, not JS extractors
    const withExtractors = ['Test.java', 'Test.kt', 'test.go'];
    for (const name of withExtractors) {
      const result = await getFileSummary.handler({ filePath: name }, makeCtx());
      expect(result.language).not.toBe('javascript');
      expect(result.language).not.toBe('unknown');
    }
    // Languages without extractors (rust, ruby) should fall back to preview
    const withoutExtractors = ['test.rs', 'test.rb'];
    for (const name of withoutExtractors) {
      const result = await getFileSummary.handler({ filePath: name }, makeCtx());
      expect(result.language).not.toBe('javascript');
      expect(result.preview).toBeDefined();
    }
  });
});
