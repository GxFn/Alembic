/**
 * Integration: GuardCheckEngine — Guard 规则检查引擎
 *
 * 使用真实 Bootstrap（内存 SQLite），测试:
 *   - 内置规则检查（多语言）
 *   - 数据库自定义规则加载
 *   - 代码级别检查（上下文感知）
 *   - 跨文件审计
 *   - 语言检测
 */

import { createTestBootstrap } from '../fixtures/factory.js';
import { GuardCheckEngine, detectLanguage } from '../../lib/service/guard/GuardCheckEngine.js';

describe('Integration: GuardCheckEngine', () => {
  let bootstrap, components, db, engine;

  beforeAll(async () => {
    ({ bootstrap, components } = await createTestBootstrap());
    db = components.db.getDb();
    engine = new GuardCheckEngine(db);
  });

  afterAll(async () => {
    await bootstrap.shutdown();
  });

  // ── 语言检测 ──────────────────────────────────────────

  describe('detectLanguage', () => {
    it.each([
      ['ViewController.swift', 'swift'],
      ['AppDelegate.m', 'objc'],
      ['Header.h', 'objc'],
      ['index.js', 'javascript'],
      ['server.ts', 'typescript'],
      ['server.tsx', 'typescript'],
      ['main.py', 'python'],
      ['App.java', 'java'],
      ['Main.kt', 'kotlin'],
      ['main.go', 'go'],
      ['lib.rs', 'rust'],
      ['README.md', 'unknown'],
      [null, 'unknown'],
    ])('detectLanguage(%s) → %s', (filePath, expected) => {
      expect(detectLanguage(filePath)).toBe(expected);
    });
  });

  // ── 内置规则: ObjC ────────────────────────────────────

  describe('ObjC 内置规则', () => {
    it('检测 dispatch_sync(main) 死锁', () => {
      const code = `
- (void)doSomething {
    dispatch_sync(dispatch_get_main_queue(), ^{
        [self updateUI];
    });
}`;
      const violations = engine.checkCode(code, 'objc');
      const found = violations.find(v => v.ruleId === 'no-main-thread-sync');
      expect(found).toBeDefined();
      expect(found.severity).toBe('error');
      expect(found.reasoning).toBeDefined();
      expect(found.reasoning.whatViolated).toBe('no-main-thread-sync');
    });

    it('检测 dealloc 中的异步操作', () => {
      // 正则要求 dealloc 和 dispatch_async 在同一行
      const code = '- (void)dealloc { dispatch_async(dispatch_get_main_queue(), ^{ [self cleanup]; });}';
      const violations = engine.checkCode(code, 'objc');
      const found = violations.find(v => v.ruleId === 'objc-dealloc-async');
      expect(found).toBeDefined();
      expect(found.severity).toBe('error');
    });

    it('检测 block 内直接使用 self', () => {
      // 正则要求 ^ 后紧跟 ({ 和 self 在同一行
      const code = 'void (^block)(void) = ^{ [self doSomething]; };';
      const violations = engine.checkCode(code, 'objc');
      const found = violations.find(v => v.ruleId === 'objc-block-retain-cycle');
      expect(found).toBeDefined();
      expect(found.severity).toBe('warning');
    });

    it('检测 assign 用于对象类型', () => {
      const code = '@property (nonatomic, assign) NSString *name;';
      const violations = engine.checkCode(code, 'objc');
      const found = violations.find(v => v.ruleId === 'objc-assign-object');
      expect(found).toBeDefined();
    });

    it('检测 NSTimer 循环引用', () => {
      const code = '[NSTimer scheduledTimerWithTimeInterval:1.0 target:self selector:@selector(tick) userInfo:nil repeats:YES];';
      const violations = engine.checkCode(code, 'objc');
      const found = violations.find(v => v.ruleId === 'objc-timer-retain-cycle');
      expect(found).toBeDefined();
    });

    it('检测 sleep 阻塞主线程', () => {
      const code = 'sleep(5);';
      const violations = engine.checkCode(code, 'objc');
      const found = violations.find(v => v.ruleId === 'objc-possible-main-thread-blocking');
      expect(found).toBeDefined();
    });

    it('安全代码不应产生 error/warning', () => {
      const code = `
- (void)safeMethod {
    __weak typeof(self) weakSelf = self;
    dispatch_async(dispatch_get_global_queue(0, 0), ^{
        [weakSelf doSomething];
    });
}`;
      const violations = engine.checkCode(code, 'objc');
      const errors = violations.filter(v => v.severity === 'error');
      expect(errors).toHaveLength(0);
    });
  });

  // ── 内置规则: Swift ───────────────────────────────────

  describe('Swift 内置规则', () => {
    it('检测 DispatchQueue.main.sync', () => {
      const code = 'DispatchQueue.main.sync { self.updateUI() }';
      const violations = engine.checkCode(code, 'swift');
      const found = violations.find(v => v.ruleId === 'main-thread-sync-swift');
      expect(found).toBeDefined();
      expect(found.severity).toBe('error');
    });

    it('检测 as! 强制转换', () => {
      const code = 'let vc = sender as! UIViewController';
      const violations = engine.checkCode(code, 'swift');
      const found = violations.find(v => v.ruleId === 'swift-force-cast');
      expect(found).toBeDefined();
    });

    it('检测 try! 强制 try', () => {
      const code = 'let data = try! Data(contentsOf: url)';
      const violations = engine.checkCode(code, 'swift');
      const found = violations.find(v => v.ruleId === 'swift-force-try');
      expect(found).toBeDefined();
    });
  });

  // ── 内置规则: JavaScript / TypeScript ─────────────────

  describe('JavaScript/TypeScript 内置规则', () => {
    it('检测 eval()', () => {
      const code = 'const result = eval("1+2");';
      const violations = engine.checkCode(code, 'javascript');
      const found = violations.find(v => v.ruleId === 'js-no-eval');
      expect(found).toBeDefined();
      expect(found.severity).toBe('error');
    });

    it('检测 var 声明', () => {
      const code = 'var name = "test";';
      const violations = engine.checkCode(code, 'javascript');
      const found = violations.find(v => v.ruleId === 'js-no-var');
      expect(found).toBeDefined();
    });

    it('检测 console.log', () => {
      const code = 'console.log("debug");';
      const violations = engine.checkCode(code, 'javascript');
      const found = violations.find(v => v.ruleId === 'js-no-console-log');
      expect(found).toBeDefined();
      expect(found.severity).toBe('info');
    });

    it('检测 debugger 语句', () => {
      const code = 'debugger;';
      const violations = engine.checkCode(code, 'javascript');
      const found = violations.find(v => v.ruleId === 'js-no-debugger');
      expect(found).toBeDefined();
      expect(found.severity).toBe('error');
    });

    it('检测 TypeScript any 类型', () => {
      const code = 'function process(data: any) { return data; }';
      const violations = engine.checkCode(code, 'typescript');
      const found = violations.find(v => v.ruleId === 'ts-no-any');
      expect(found).toBeDefined();
    });
  });

  // ── 内置规则: Python ──────────────────────────────────

  describe('Python 内置规则', () => {
    it('检测裸 except', () => {
      const code = `try:\n    pass\nexcept:\n    pass`;
      const violations = engine.checkCode(code, 'python');
      const found = violations.find(v => v.ruleId === 'py-no-bare-except');
      expect(found).toBeDefined();
    });

    it('检测 exec()', () => {
      const code = 'exec("print(1)")';
      const violations = engine.checkCode(code, 'python');
      const found = violations.find(v => v.ruleId === 'py-no-exec');
      expect(found).toBeDefined();
      expect(found.severity).toBe('error');
    });

    it('检测可变默认参数', () => {
      const code = 'def append_to(element, target=[]):';
      const violations = engine.checkCode(code, 'python');
      const found = violations.find(v => v.ruleId === 'py-no-mutable-default');
      expect(found).toBeDefined();
    });
  });

  // ── 内置规则: Java/Kotlin/Go/Rust ─────────────────────

  describe('其他语言内置规则', () => {
    it('Java: 检测 System.exit()', () => {
      const violations = engine.checkCode('System.exit(0);', 'java');
      expect(violations.find(v => v.ruleId === 'java-no-system-exit')).toBeDefined();
    });

    it('Go: 检测 panic()', () => {
      const violations = engine.checkCode('panic("crash")', 'go');
      expect(violations.find(v => v.ruleId === 'go-no-panic')).toBeDefined();
    });

    it('Rust: 检测 unwrap()', () => {
      const violations = engine.checkCode('let val = result.unwrap();', 'rust');
      expect(violations.find(v => v.ruleId === 'rust-no-unwrap')).toBeDefined();
    });
  });

  // ── 代码级别检查（ObjC 上下文感知）────────────────────

  describe('代码级别检查', () => {
    it('检测 KVO 观察者未移除', () => {
      const code = `
- (void)viewDidLoad {
    [self addObserver:self forKeyPath:@"name" options:0 context:nil];
}`;
      const violations = engine.checkCode(code, 'objc');
      const found = violations.find(v => v.ruleId === 'objc-kvo-missing-remove');
      expect(found).toBeDefined();
      expect(found.severity).toBe('warning');
    });

    it('KVO 有配对 removeObserver 时不报警', () => {
      const code = `
- (void)viewDidLoad {
    [self addObserver:self forKeyPath:@"name" options:0 context:nil];
}
- (void)dealloc {
    [self removeObserver:self forKeyPath:@"name"];
}`;
      const violations = engine.checkCode(code, 'objc');
      const found = violations.find(v => v.ruleId === 'objc-kvo-missing-remove');
      expect(found).toBeUndefined();
    });

    it('检测同文件 Category 重名', () => {
      const code = `
@interface NSString (Utility)
@end
@interface NSString (Utility)
@end`;
      const violations = engine.checkCode(code, 'objc');
      const found = violations.find(v => v.ruleId === 'objc-duplicate-category');
      expect(found).toBeDefined();
    });
  });

  // ── 文件审计 ──────────────────────────────────────────

  describe('auditFile / auditFiles', () => {
    it('auditFile 应返回完整审计结果', () => {
      const result = engine.auditFile(
        'ViewController.swift',
        'let data = try! Data(contentsOf: url)\nDispatchQueue.main.sync { }',
      );
      expect(result.filePath).toBe('ViewController.swift');
      expect(result.language).toBe('swift');
      expect(result.violations.length).toBeGreaterThanOrEqual(2);
      expect(result.summary.total).toBeGreaterThanOrEqual(2);
      expect(result.summary.errors).toBeGreaterThanOrEqual(1);
    });

    it('auditFiles 应汇总多文件结果', () => {
      const files = [
        { path: 'a.swift', content: 'let x = try! foo()' },
        { path: 'b.js', content: 'eval("code"); var x = 1;' },
        { path: 'c.py', content: 'exec("code")' },
      ];
      const result = engine.auditFiles(files);
      expect(result.summary.filesChecked).toBe(3);
      expect(result.summary.totalViolations).toBeGreaterThanOrEqual(3);
      expect(result.summary.filesWithViolations).toBe(3);
    });

    it('跨文件 Category 重名检测', () => {
      const files = [
        { path: 'NSString+A.h', content: '@interface NSString (Utility)\n@end' },
        { path: 'NSString+B.h', content: '@interface NSString (Utility)\n@end' },
      ];
      const result = engine.auditFiles(files);
      expect(result.crossFileViolations.length).toBeGreaterThanOrEqual(1);
      const found = result.crossFileViolations.find(
        v => v.ruleId === 'objc-cross-file-duplicate-category',
      );
      expect(found).toBeDefined();
      expect(found.locations.length).toBe(2);
    });

    it('合法 .h + .m 配对不应报跨文件重名', () => {
      const files = [
        { path: 'NSString+Utils.h', content: '@interface NSString (Utils)\n@end' },
        { path: 'NSString+Utils.m', content: '@interface NSString (Utils)\n@end\n@implementation NSString (Utils)\n@end' },
      ];
      const result = engine.auditFiles(files);
      const found = result.crossFileViolations.find(
        v => v.ruleId === 'objc-cross-file-duplicate-category',
      );
      expect(found).toBeUndefined();
    });
  });

  // ── 自定义规则（数据库） ──────────────────────────────

  describe('数据库自定义规则', () => {
    beforeAll(() => {
      // 插入自定义 Guard 规则
      db.prepare(`INSERT OR REPLACE INTO knowledge_entries (id, title, description, language, kind, knowledgeType, lifecycle, constraints, scope, content, tags, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'custom-rule-1',
        'No TODO comments',
        '禁止提交含 TODO 的代码',
        'swift',
        'rule',
        'boundary-constraint',
        'active',
        JSON.stringify({
          guards: [{
            id: 'custom-no-todo',
            name: 'No TODO',
            message: '代码中存在 TODO 注释，请处理后再提交',
            pattern: '//\\s*TODO',
            severity: 'warning',
          }],
        }),
        'file',
        JSON.stringify({}),
        JSON.stringify(['guard', 'code-style']),
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000),
      );
      // 清除规则缓存以加载新规则
      engine.clearCache();
    });

    it('自定义规则应被加载', () => {
      const rules = engine.getRules('swift');
      const found = rules.find(r => r.id === 'custom-no-todo');
      expect(found).toBeDefined();
      expect(found.source).toBe('database');
    });

    it('自定义规则应检出违规', () => {
      const code = '// TODO: fix this later\nlet x = 1';
      const violations = engine.checkCode(code, 'swift');
      const found = violations.find(v => v.ruleId === 'custom-no-todo');
      expect(found).toBeDefined();
      expect(found.message).toContain('TODO');
    });

    it('按语言过滤规则', () => {
      const swiftRules = engine.getRules('swift');
      const jsRules = engine.getRules('javascript');

      // Swift 应包含 Swift 规则
      expect(swiftRules.find(r => r.id === 'swift-force-cast')).toBeDefined();
      // Swift 不应包含 JS 特有规则
      expect(swiftRules.find(r => r.id === 'js-no-eval')).toBeUndefined();
      // JS 不应包含 Swift 特有规则
      expect(jsRules.find(r => r.id === 'swift-force-cast')).toBeUndefined();
    });

    it('getRules(null) 返回所有规则', () => {
      const allRules = engine.getRules(null);
      expect(allRules.length).toBeGreaterThan(10);
      // 应同时包含多种语言的规则
      const languages = new Set(allRules.flatMap(r => r.languages || []));
      expect(languages.size).toBeGreaterThanOrEqual(3);
    });
  });

  // ── scope 层级过滤 ───────────────────────────────────

  describe('scope 层级过滤', () => {
    it('file scope 只包含 file 维度规则', () => {
      const violations = engine.checkCode('eval("x")', 'javascript', { scope: 'file' });
      for (const v of violations) {
        if (v.dimension) {
          expect(v.dimension).toBe('file');
        }
      }
    });
  });

  // ── violation 结构验证 ────────────────────────────────

  describe('violation 结构', () => {
    it('应包含 reasoning 信息', () => {
      const violations = engine.checkCode('eval("x")', 'javascript');
      expect(violations.length).toBeGreaterThanOrEqual(1);
      const v = violations[0];
      expect(v).toHaveProperty('ruleId');
      expect(v).toHaveProperty('message');
      expect(v).toHaveProperty('severity');
      expect(v).toHaveProperty('line');
      expect(v).toHaveProperty('snippet');
      expect(v).toHaveProperty('reasoning');
      expect(v.reasoning).toHaveProperty('whatViolated');
      expect(v.reasoning).toHaveProperty('whyItMatters');
    });
  });
});
