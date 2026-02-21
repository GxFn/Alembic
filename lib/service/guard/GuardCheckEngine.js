/**
 * GuardCheckEngine - Guard 规则检查引擎
 *
 * 从 V1 guard/ios 迁移，适配 V2 架构
 * 支持: 正则模式匹配 + AST 语义规则 + code-level 检查 + 多维度审计
 */

import * as AstAnalyzerModule from '../../core/AstAnalyzer.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { LanguageService } from '../../shared/LanguageService.js';

/**
 * 内置默认规则集 — 多语言基础规则
 *
 * 每条规则包含:
 *   - message: 违反时的中文提示
 *   - severity: 'error' | 'warning' | 'info'
 *   - pattern: 行级正则（不跨行）
 *   - languages: 适用语言数组
 *   - dimension: 'file' | 'target' | 'project'
 *   - category: 规则分类 (安全 / 性能 / 风格 / 正确性)
 *   - fixSuggestion?: 修复建议
 */
const BUILT_IN_RULES = {
  // ══════════════════════════════════════════════════════════
  //  ObjC / Swift — iOS 核心规则
  // ══════════════════════════════════════════════════════════

  'no-main-thread-sync': {
    message: '禁止在主线程上使用 dispatch_sync(main)，易死锁',
    severity: 'error',
    pattern: 'dispatch_sync\\s*\\([^)]*main',
    languages: ['objc', 'swift'],
    dimension: 'file',
    category: 'correctness',
  },
  'main-thread-sync-swift': {
    message: '禁止在主线程上使用 DispatchQueue.main.sync，易死锁',
    severity: 'error',
    pattern: 'DispatchQueue\\.main\\.sync',
    languages: ['swift'],
    dimension: 'file',
    category: 'correctness',
  },
  'objc-dealloc-async': {
    message: 'dealloc 内禁止使用 dispatch_async/dispatch_after/postNotification 等',
    severity: 'error',
    pattern:
      '(dealloc.*(dispatch_async|dispatch_after|postNotification|performSelector.*afterDelay))',
    languages: ['objc'],
    dimension: 'file',
    category: 'correctness',
  },
  'objc-block-retain-cycle': {
    message: 'block 内直接使用 self 可能循环引用，建议 weakSelf',
    severity: 'warning',
    pattern: '\\^\\s*[({][^}]*\\bself\\b',
    languages: ['objc'],
    dimension: 'file',
    category: 'correctness',
    fixSuggestion: '声明 __weak typeof(self) weakSelf = self; 后在 block 内使用 weakSelf',
  },
  'objc-assign-object': {
    message: 'assign 用于对象类型会产生悬垂指针，建议改为 weak 或 strong',
    severity: 'warning',
    pattern: '@property\\s*\\([^)]*\\bassign\\b[^)]*\\)[^;]*(\\*|id\\s*<|\\bid\\s+)',
    languages: ['objc'],
    dimension: 'file',
    category: 'correctness',
  },
  'swift-force-cast': {
    message: '强制类型转换 as! 在失败时崩溃，建议 as? 或 guard let',
    severity: 'warning',
    pattern: 'as\\s*!',
    languages: ['swift'],
    dimension: 'file',
    category: 'safety',
    fixSuggestion: '使用 as? 配合 guard let / if let 进行安全转换',
  },
  'swift-force-try': {
    message: 'try! 在异常时崩溃，建议 do-catch 或 try?',
    severity: 'warning',
    pattern: 'try\\s*!',
    languages: ['swift'],
    dimension: 'file',
    category: 'safety',
  },
  'objc-timer-retain-cycle': {
    message:
      'NSTimer 以 self 为 target 会强引用 self，需在 dealloc 前 invalidate 或使用 block 形式',
    severity: 'warning',
    pattern: '(scheduledTimerWithTimeInterval|timerWithTimeInterval)[^;]*target\\s*:\\s*self',
    languages: ['objc'],
    dimension: 'file',
    category: 'correctness',
  },
  'objc-possible-main-thread-blocking': {
    message: 'sleep/usleep 可能造成主线程阻塞',
    severity: 'warning',
    pattern: '\\b(sleep|usleep)\\s*\\(',
    languages: ['objc'],
    dimension: 'file',
    category: 'performance',
  },

  // ══════════════════════════════════════════════════════════
  //  JavaScript / TypeScript
  // ══════════════════════════════════════════════════════════

  'js-no-eval': {
    message: 'eval() 存在安全风险和性能问题，应避免使用',
    severity: 'error',
    pattern: '\\beval\\s*\\(',
    languages: ['javascript', 'typescript'],
    dimension: 'file',
    category: 'safety',
  },
  'js-no-var': {
    message: '使用 let/const 替代 var，避免变量提升问题',
    severity: 'warning',
    pattern: '\\bvar\\s+\\w+',
    languages: ['javascript', 'typescript'],
    dimension: 'file',
    category: 'style',
    excludePaths: /(?:^|[\/\\])(?:test|tests|__tests__|spec|__mocks__|mock|mocks|fixtures?)[\/\\]|[\/\\](?:test_|spec_)[^\/\\]*\.(?:js|ts)$|\.(?:test|spec)\.(?:js|ts)$/,
  },
  'js-no-console-log': {
    message: '生产代码应移除 console.log，使用专用日志库',
    severity: 'info',
    pattern: 'console\\.log\\s*\\(',
    languages: ['javascript', 'typescript'],
    dimension: 'file',
    category: 'style',
    excludePaths: /(?:^|[\/\\])(?:test|tests|__tests__|spec|mock|mocks|__mocks__|scripts|tools|debug)[\/\\]|[\/\\](?:test_|spec_|mock)[^\/\\]*\.(?:js|ts)$|\.(?:test|spec)\.(?:js|ts)$/,
  },
  'js-no-debugger': {
    message: '生产代码中不应包含 debugger 语句',
    severity: 'error',
    pattern: '\\bdebugger\\b',
    languages: ['javascript', 'typescript'],
    dimension: 'file',
    category: 'style',
  },
  'js-no-alert': {
    message: '生产代码中不应使用 alert()，影响用户体验',
    severity: 'warning',
    pattern: '\\balert\\s*\\(',
    languages: ['javascript', 'typescript'],
    dimension: 'file',
    category: 'style',
  },
  'ts-no-non-null-assertion': {
    message: '非空断言 ! 可能掩盖 null/undefined 错误',
    severity: 'warning',
    pattern: '\\w+!\\.',
    languages: ['typescript'],
    dimension: 'file',
    category: 'safety',
  },

  // ══════════════════════════════════════════════════════════
  //  Python
  // ══════════════════════════════════════════════════════════

  'py-no-bare-except': {
    message: '裸 except: 会捕获所有异常（含 SystemExit），应指定异常类型',
    severity: 'warning',
    pattern: 'except\\s*:',
    languages: ['python'],
    dimension: 'file',
    category: 'correctness',
  },
  'py-no-exec': {
    message: 'exec() 存在安全风险，应避免使用',
    severity: 'error',
    pattern: '\\bexec\\s*\\(',
    languages: ['python'],
    dimension: 'file',
    category: 'safety',
  },
  'py-no-mutable-default': {
    message: '函数默认参数使用可变对象（list/dict/set）会导致共享状态 bug',
    severity: 'warning',
    pattern: 'def\\s+\\w+\\s*\\([^)]*=\\s*(?:\\[\\]|\\{\\}|set\\(\\))',
    languages: ['python'],
    dimension: 'file',
    category: 'correctness',
  },
  'py-no-star-import': {
    message: 'from module import * 导致命名空间污染，应显式导入',
    severity: 'warning',
    pattern: 'from\\s+\\S+\\s+import\\s+\\*',
    languages: ['python'],
    dimension: 'file',
    category: 'style',
  },
  'py-no-assert-in-prod': {
    message: 'assert 在 -O 模式下会被移除，不应用于生产逻辑校验',
    severity: 'info',
    pattern: '^\\s*assert\\s+',
    languages: ['python'],
    dimension: 'file',
    category: 'correctness',
    excludePaths: /(?:^|[\/\\])tests?[\/\\]|[\/\\]test_[^\/\\]*\.py$|_test\.py$/,
  },

  // ══════════════════════════════════════════════════════════
  //  Java / Kotlin
  // ══════════════════════════════════════════════════════════

  'java-no-system-exit': {
    message: 'System.exit() 直接终止 JVM，应抛异常或返回状态码',
    severity: 'error',
    pattern: 'System\\.exit\\s*\\(',
    languages: ['java', 'kotlin'],
    dimension: 'file',
    category: 'correctness',
  },
  'java-no-raw-type': {
    message: '使用泛型集合替代原始类型 (如 List<String> 替代 List)',
    severity: 'warning',
    pattern: '(List|Map|Set|Collection|Iterable)\\s+\\w+\\s*[=;]',
    languages: ['java'],
    dimension: 'file',
    category: 'style',
  },
  'java-no-empty-catch': {
    message: '空 catch 块会静默吞掉异常，至少应记录日志',
    severity: 'warning',
    pattern: 'catch\\s*\\([^)]+\\)\\s*\\{\\s*\\}',
    languages: ['java', 'kotlin'],
    dimension: 'file',
    category: 'correctness',
  },
  'java-no-thread-stop': {
    message: 'Thread.stop() 已废弃且不安全，使用 interrupt() 协作式终止',
    severity: 'error',
    pattern: '\\.stop\\s*\\(\\)',
    languages: ['java'],
    dimension: 'file',
    category: 'safety',
  },
  'kotlin-no-force-unwrap': {
    message: '!! 非空断言在值为 null 时抛 NPE，应使用 ?. 或 ?: 安全访问',
    severity: 'warning',
    pattern: '\\w+!!',
    languages: ['kotlin'],
    dimension: 'file',
    category: 'safety',
    fixSuggestion: '使用 ?. 安全调用或 ?: 提供默认值',
  },

  // ══════════════════════════════════════════════════════════
  //  Go
  // ══════════════════════════════════════════════════════════

  'go-no-panic': {
    message: 'panic 应仅用于不可恢复错误，库代码应返回 error',
    severity: 'warning',
    pattern: '\\bpanic\\s*\\(',
    languages: ['go'],
    dimension: 'file',
    category: 'correctness',
  },
  'go-no-err-ignored': {
    message: '错误值不应用 _ 忽略，应处理或明确标注',
    severity: 'warning',
    pattern: '\\w+\\s*,\\s*_\\s*:?=\\s*\\w|_\\s*=\\s*\\w+\\.[A-Z]\\w*\\(',
    languages: ['go'],
    dimension: 'file',
    category: 'correctness',
    excludePaths: /(?:^|[\/\\])(?:tests?|testdata|_test)[\/\\]|_test\.go$/,
  },
  'go-no-init-abuse': {
    message: 'init() 函数副作用难以追踪，避免在 init 中执行复杂逻辑',
    severity: 'info',
    pattern: 'func\\s+init\\s*\\(\\s*\\)',
    languages: ['go'],
    dimension: 'file',
    category: 'style',
  },
  'go-no-global-var': {
    message: '全局可变变量导致并发安全问题，考虑使用依赖注入',
    severity: 'info',
    pattern: '^var\\s+(?!_\\s)[a-zA-Z]\\w*\\s+(?!=[^=])',
    languages: ['go'],
    dimension: 'file',
    category: 'style',
    excludePaths: /(?:^|[\/\\])(?:tests?|testdata)[\/\\]|_test\.go$/,
  },

  // ══════════════════════════════════════════════════════════
  //  Dart (Flutter)
  // ══════════════════════════════════════════════════════════

  'dart-no-print': {
    message: '生产代码应使用 logger 替代 print()，便于日志分级和关闭',
    severity: 'info',
    pattern: '\\bprint\\s*\\(',
    languages: ['dart'],
    dimension: 'file',
    category: 'style',
  },
  'dart-avoid-dynamic': {
    message: '避免直接使用 dynamic 作为变量/参数类型，使用具体类型或泛型提升类型安全',
    severity: 'warning',
    pattern: '(?<!<\\w*,\\s*)(?<!<)\\bdynamic\\b(?!\\s*>)',
    languages: ['dart'],
    dimension: 'file',
    category: 'style',
    fixSuggestion: '使用 Object? 或具体类型替代 dynamic；Map<String, dynamic> 用于 JSON 序列化时可保留',
  },
  'dart-no-set-state-after-dispose': {
    message: 'setState 调用前应检查 mounted 状态，避免 disposed 后调用',
    severity: 'info',
    pattern: '(?<!mounted\\)\\s*)setState\\s*\\(',
    languages: ['dart'],
    dimension: 'file',
    category: 'correctness',
    fixSuggestion: '使用 if (mounted) setState(...) 守卫',
  },

  'dart-avoid-bang-operator': {
    message: '避免使用 ! 空断言操作符，优先使用 ?? 默认值或 ?. 安全调用',
    severity: 'warning',
    pattern: '\\w+!\\.',
    languages: ['dart'],
    dimension: 'file',
    category: 'correctness',
    fixSuggestion: '使用 ?. 安全调用或 ?? 提供默认值',
  },
  'dart-prefer-const-constructor': {
    message: '当所有字段均为 final 时，构造函数应声明为 const 以优化 Widget 重建',
    severity: 'info',
    pattern: '(?<!const\\s)\\bnew\\s+\\w+\\(',
    languages: ['dart'],
    dimension: 'file',
    category: 'performance',
    fixSuggestion: '移除 new 关键字，并在 Widget 构造调用前加 const',
  },
  'dart-no-relative-import': {
    message: 'lib/ 目录内应使用 package: 形式的绝对导入，避免相对路径导入',
    severity: 'info',
    pattern: "import\\s+['\"]\\.\\.?/",
    languages: ['dart'],
    dimension: 'file',
    category: 'style',
  },
  'dart-dispose-controller': {
    message: 'TextEditingController/AnimationController 等须在 dispose() 中释放',
    severity: 'warning',
    pattern: '(?:TextEditingController|AnimationController|ScrollController|FocusNode|TabController)\\(',
    languages: ['dart'],
    dimension: 'file',
    category: 'correctness',
    fixSuggestion: '在 State.dispose() 中调用 controller.dispose()',
  },
  'dart-no-build-context-across-async': {
    message: 'BuildContext 不应跨越 async gap 使用，可能导致引用已卸载的 Widget',
    severity: 'warning',
    pattern: 'await\\s+.*\\n.*context\\.',
    languages: ['dart'],
    dimension: 'file',
    category: 'correctness',
    fixSuggestion: '在 await 前缓存所需数据，或在 await 后检查 mounted',
  },

  // ══════════════════════════════════════════════════════════
  //  Rust
  // ══════════════════════════════════════════════════════════

  'rust-no-unwrap': {
    message: '生产代码避免 .unwrap()，None/Err 时会 panic。使用 ? 或 unwrap_or / expect',
    severity: 'warning',
    pattern: '\\.unwrap\\s*\\(\\)',
    languages: ['rust'],
    dimension: 'file',
    category: 'correctness',
    fixSuggestion: '使用 ? 操作符传播错误，或 .unwrap_or_default() / .expect("原因")',
    excludePaths: /(?:^|[\/\\])(?:tests?|test_helpers|benches|examples)[\/\\]|[\/\\]test_[^\/\\]*\.rs$|_test\.rs$/,
    skipComments: true,
    skipTestBlocks: true,
  },
  'rust-no-expect-without-msg': {
    message: 'expect() 应提供有意义的错误消息，帮助定位 panic 原因',
    severity: 'info',
    pattern: '\\.expect\\s*\\(\\s*""\\s*\\)',
    languages: ['rust'],
    dimension: 'file',
    category: 'style',
    fixSuggestion: '提供描述性消息: .expect("config file should exist")',
  },
  'rust-unsafe-block': {
    message: 'unsafe 块需要 SAFETY 注释说明前置条件，确保审计可追踪',
    severity: 'warning',
    pattern: 'unsafe\\s*\\{',
    languages: ['rust'],
    dimension: 'file',
    category: 'safety',
    fixSuggestion: '在 unsafe 块前添加 // SAFETY: ... 注释说明安全前提',
  },
  'rust-no-todo-macro': {
    message: '生产代码不应包含 todo!() / unimplemented!()，运行时会 panic',
    severity: 'warning',
    pattern: '\\b(?:todo|unimplemented)!\\s*\\(',
    languages: ['rust'],
    dimension: 'file',
    category: 'correctness',
    excludePaths: /(?:^|[\/\\])(?:tests?|test_helpers|benches|examples)[\/\\]|_test\.rs$/,
    skipComments: true,
    skipTestBlocks: true,
  },
  'rust-clone-overuse': {
    message: '频繁 .clone() 可能暗示所有权设计问题，考虑使用借用或 Cow',
    severity: 'info',
    pattern: '\\.clone\\s*\\(\\)',
    languages: ['rust'],
    dimension: 'file',
    category: 'performance',
    fixSuggestion: '分析是否可用 &T 借用替代，或使用 Cow<T> 延迟克隆',
    excludePaths: /(?:^|[\/\\])(?:tests?|test_helpers|benches|examples)[\/\\]|_test\.rs$/,
    skipComments: true,
    skipTestBlocks: true,
  },
  'rust-no-panic-in-lib': {
    message: 'panic!() 在库代码中应避免使用，返回 Result 让调用方决定如何处理',
    severity: 'warning',
    pattern: '\\bpanic!\\s*\\(',
    languages: ['rust'],
    dimension: 'file',
    category: 'correctness',
    excludePaths: /(?:^|[\/\\])(?:tests?|test_helpers|benches|examples)[\/\\]|main\.rs$/,
    skipComments: true,
    skipTestBlocks: true,
  },
  'rust-std-mutex-in-async': {
    message: 'async 代码中不应使用 std::sync::Mutex，MutexGuard 不是 Send',
    severity: 'warning',
    pattern: 'std::sync::Mutex',
    languages: ['rust'],
    dimension: 'file',
    category: 'correctness',
    fixSuggestion: '使用 tokio::sync::Mutex 或 parking_lot::Mutex',
  },
  'rust-no-string-push-in-loop': {
    message: '循环中 String::push_str/format! 拼接可能导致多次分配，考虑预分配或 join',
    severity: 'info',
    pattern: 'for\\s+.*\\{[\\s\\S]*?(?:push_str|format!)',
    languages: ['rust'],
    dimension: 'file',
    category: 'performance',
    fixSuggestion: '使用 Vec<&str> 收集后 .join()，或 String::with_capacity 预分配',
  },

};

/**
 * 从文件扩展名推断语言
 */
export function detectLanguage(filePath) {
  if (!filePath) {
    return 'unknown';
  }
  const lang = LanguageService.inferLang(filePath);
  // 向后兼容: objectivec → objc
  return lang === 'objectivec' ? 'objc' : lang;
}

/**
 * GuardCheckEngine - 核心检查引擎
 */
export class GuardCheckEngine {
  constructor(db, options = {}) {
    this.db = typeof db?.getDb === 'function' ? db.getDb() : db;
    this.logger = Logger.getInstance();
    this._builtInRules = BUILT_IN_RULES;
    this._customRulesCache = null;
    this._astRulesCache = null;
    this._cacheTime = 0;
    this._cacheTTL = options.cacheTTL || 60_000; // 1min
    /** @type {Map<string, object>} Enhancement Pack 注入的外部规则 */
    this._externalRules = new Map();
    /** @type {Map<string, RegExp>} 已编译的正则缓存 (pattern string → RegExp) */
    this._regexCache = new Map();
  }

  /**
   * 注入 Enhancement Pack 外部规则（支持 RegExp 和 string pattern）
   * 与 BUILT_IN_RULES 合并检查，自动跳过 ruleId 重复的规则
   * @param {Array<{ruleId: string, pattern: RegExp|string, severity: string, message: string, category?: string, dimension?: string, languages?: string[], fixSuggestion?: string}>} rules
   */
  injectExternalRules(rules) {
    if (!Array.isArray(rules)) return;
    for (const rule of rules) {
      if (!rule.ruleId) continue;
      // 跳过与 BUILT_IN_RULES 重复的模式（通过比较 pattern 源文本）
      const rulePatternStr = rule.pattern instanceof RegExp ? rule.pattern.source : String(rule.pattern || '');
      const isDuplicate = Object.entries(this._builtInRules).some(([, builtIn]) => {
        return builtIn.pattern === rulePatternStr;
      });
      if (isDuplicate) {
        this.logger.debug(`[GuardCheckEngine] Skipping duplicate external rule: ${rule.ruleId}`);
        continue;
      }
      this._externalRules.set(rule.ruleId, {
        id: rule.ruleId,
        name: rule.ruleId,
        message: rule.message || '',
        pattern: rule.pattern,
        languages: rule.languages || [],
        severity: rule.severity || 'warning',
        dimension: rule.dimension || 'file',
        category: rule.category || '',
        source: 'enhancement-pack',
        type: 'regex',
        fixSuggestion: rule.fixSuggestion || null,
      });
    }
    this.logger.debug(`[GuardCheckEngine] External rules injected: ${this._externalRules.size} active`);
  }

  /**
   * 获取所有启用的规则 (数据库 + 内置)
   */
  getRules(language = null) {
    let rules = [];

    // 从数据库加载自定义规则
    // 优先从 knowledge_entries 表查询（V3），回退到 recipes 表（V2）
    try {
      const now = Date.now();
      if (!this._customRulesCache || now - this._cacheTime > this._cacheTTL) {
        let rows = [];
        try {
          rows = this.db
            .prepare(
              `SELECT id, title, description, language, scope, constraints
             FROM knowledge_entries
             WHERE (kind = 'rule' OR knowledgeType = 'boundary-constraint')
               AND lifecycle = 'active'`
            )
            .all();
        } catch {
          /* table may not exist */
        }

        const regexRules = [];
        const astRules = [];

        for (const r of rows) {
          let guards = [];
          try {
            const constraints = JSON.parse(r.constraints || '{}');
            guards = constraints.guards || [];
          } catch {
            /* ignore */
          }

          for (const g of guards) {
            const ruleType = g.type || 'regex';
            const base = {
              id: g.id || r.id,
              name: g.name || r.title,
              message: g.message || r.description || r.title,
              languages: r.language ? [r.language] : [],
              severity: g.severity || 'warning',
              dimension: r.scope || 'file',
              source: 'database',
              fixSuggestion: g.fixSuggestion || null,
            };

            if (ruleType === 'ast' && g.astQuery) {
              astRules.push({ ...base, type: 'ast', astQuery: g.astQuery });
            } else if (g.pattern) {
              regexRules.push({ ...base, type: 'regex', pattern: g.pattern });
            }
          }
        }

        this._customRulesCache = regexRules;
        this._astRulesCache = astRules;
        this._cacheTime = now;
      }
      rules.push(...this._customRulesCache);
    } catch {
      // table or column may not exist
    }

    // 合并内置规则（不覆盖同名数据库规则）
    const existingIds = new Set(rules.map((r) => r.id || r.name));
    for (const [ruleId, rule] of Object.entries(this._builtInRules)) {
      if (!existingIds.has(ruleId)) {
        rules.push({
          id: ruleId,
          name: ruleId,
          message: rule.message,
          pattern: rule.pattern,
          languages: rule.languages,
          severity: rule.severity,
          dimension: rule.dimension || 'file',
          category: rule.category || '',
          source: 'built-in',
          type: 'regex',
          fixSuggestion: rule.fixSuggestion || null,
          ...(rule.excludePaths ? { excludePaths: rule.excludePaths } : {}),
          ...(rule.skipComments ? { skipComments: true } : {}),
          ...(rule.skipTestBlocks ? { skipTestBlocks: true } : {}),
        });
      }
    }

    // 合并 Enhancement Pack 外部规则（不覆盖已有 ID）
    for (const [ruleId, rule] of this._externalRules) {
      if (!existingIds.has(ruleId)) {
        rules.push(rule);
        existingIds.add(ruleId);
      }
    }

    // 按语言过滤
    if (language) {
      rules = rules.filter((r) => !r.languages?.length || r.languages.includes(language));
    }

    // 合并 AST 规则（供外部调用者使用，如 GuardFeedbackLoop.查找 fixSuggestion）
    if (this._astRulesCache?.length) {
      let astRules = this._astRulesCache;
      if (language) {
        astRules = astRules.filter((r) => !r.languages?.length || r.languages.includes(language));
      }
      rules.push(...astRules);
    }

    return rules;
  }

  /**
   * 对代码运行静态检查
   * @param {string} code - 源代码
   * @param {string} language - 'objc'|'swift'|'javascript' 等
   * @param {object} options - {scope, filePath}
   * @returns {Array<{ruleId, message, severity, line, snippet, dimension?, fixSuggestion?}>}
   */
  checkCode(code, language, options = {}) {
    const { scope = null, filePath = '' } = options;
    const violations = [];

    // 获取匹配语言的规则
    let rules = this.getRules(language);

    // 按 excludePaths 过滤（测试文件排除等）
    if (filePath) {
      rules = rules.filter((r) => {
        if (!r.excludePaths) return true;
        const re = r.excludePaths instanceof RegExp ? r.excludePaths : new RegExp(r.excludePaths);
        return !re.test(filePath);
      });
    }

    // 如果有 scope，按层级过滤：project ⊇ target ⊇ file
    // project 范围包含所有维度的规则；target 包含 file+target；file 仅匹配 file
    if (scope) {
      const SCOPE_HIERARCHY = {
        project: ['file', 'target', 'project'],
        target: ['file', 'target'],
        file: ['file'],
      };
      const allowedDimensions = SCOPE_HIERARCHY[scope] || [scope];
      rules = rules.filter((r) => !r.dimension || allowedDimensions.includes(r.dimension));
    }

    const lines = (code || '').split(/\r?\n/);

    // 预计算注释行掩码 — 供 skipComments 规则使用
    // 识别: // 行注释, /// doc, //! inner doc, /* block */, # Python/Shell 行注释
    const commentLines = this._buildCommentMask(lines, language);

    // 预计算测试块掩码 — 供 skipTestBlocks 规则使用
    // Rust: #[cfg(test)] mod tests { ... } 内联测试模块
    const testBlockLines = this._buildTestBlockMask(lines, language);

    for (const rule of rules) {
      // 跳过空模式或特殊标记 (?!) — 由 code-level 检查接管
      if (!rule.pattern || rule.pattern === '(?!)') {
        continue;
      }

      let re;
      try {
        re = this._compilePattern(rule.pattern);
      } catch {
        this.logger.debug(`Invalid regex in rule ${rule.id}: ${rule.pattern}`);
        continue;
      }

      const shouldSkipComments = !!rule.skipComments;
      const shouldSkipTestBlocks = !!rule.skipTestBlocks;

      for (let i = 0; i < lines.length; i++) {
        // skipComments: 跳过注释行（doc comments / 行注释 / 块注释内）
        if (shouldSkipComments && commentLines[i]) {
          continue;
        }
        // skipTestBlocks: 跳过内联测试模块（Rust #[cfg(test)] 块等）
        if (shouldSkipTestBlocks && testBlockLines[i]) {
          continue;
        }

        if (re.test(lines[i])) {
          violations.push({
            ruleId: rule.id || rule.name,
            message: rule.message,
            severity: rule.severity || 'warning',
            line: i + 1,
            snippet: lines[i].trim().slice(0, 120),
            ...(rule.dimension ? { dimension: rule.dimension } : {}),
            ...(rule.fixSuggestion ? { fixSuggestion: rule.fixSuggestion } : {}),
          });
        }
      }
    }

    // Code-level 检查（不依赖正则）
    violations.push(...this._runCodeLevelChecks(code, language, lines));

    // AST 语义规则检查
    violations.push(...this._runAstRuleChecks(code, language));

    // 跟踪 Guard 命中次数（回写 Recipe 统计）
    this.trackGuardHits(violations);

    // ── Reasoning Enrichment: 推理信息跟随数据流动 ──
    return violations.map((v) => ({
      ...v,
      reasoning: {
        whatViolated: v.ruleId,
        whyItMatters: v.message,
        suggestedFix: v.fixSuggestion || v.suggestedFix || null,
      },
    }));
  }

  /**
   * AST 语义规则检查
   * 支持 3 种查询类型: mustCallThrough, mustNotUseInContext, mustConformToProtocol
   * 仅在 Tree-sitter 可用且语言为 ObjC/Swift 时执行
   * @param {string} code - 源代码
   * @param {string} language - 语言标识
   * @returns {Array} violations
   */
  _runAstRuleChecks(code, language) {
    // AST 语言标准化 — 通过 LanguageService 判断是否为已知编程语言
    const astLang = LanguageService.isKnownLang(language)
      ? language
      : language === 'objc'
        ? 'objectivec'
        : language;
    if (!LanguageService.isKnownLang(astLang)) {
      return [];
    }

    // 获取缓存中的 AST 规则
    const astRules = (this._astRulesCache || []).filter(
      (r) => !r.languages?.length || r.languages.includes(language)
    );
    if (astRules.length === 0) {
      return [];
    }

    // 延迟加载 AstAnalyzer
    let AstAnalyzer;
    try {
      // 使用 dynamic import 会是 async，这里用 require 风格同步加载
      // AstAnalyzer 作为 ESM 模块，在 constructor 时已被引入
      AstAnalyzer = this._getAstAnalyzer();
      if (!AstAnalyzer || !AstAnalyzer.isAvailable()) {
        return [];
      }
    } catch {
      this.logger.debug('AstAnalyzer not available, skipping AST rules');
      return [];
    }

    const violations = [];

    for (const rule of astRules) {
      const { astQuery } = rule;
      if (!astQuery?.queryType) {
        continue;
      }

      try {
        switch (astQuery.queryType) {
          case 'mustCallThrough': {
            // 检查某 API 是否只在指定 wrapper 类中调用
            const { targetAPI, wrapperClass } = astQuery.params || {};
            if (!targetAPI || !wrapperClass) {
              break;
            }

            const calls = AstAnalyzer.findCallExpressions(code, astLang, targetAPI);
            for (const call of calls) {
              if (call.enclosingClass !== wrapperClass) {
                violations.push({
                  ruleId: rule.id,
                  message: rule.message,
                  severity: rule.severity,
                  line: call.line,
                  snippet: call.snippet,
                  dimension: rule.dimension || 'file',
                  ...(rule.fixSuggestion ? { fixSuggestion: rule.fixSuggestion } : {}),
                });
              }
            }
            break;
          }

          case 'mustNotUseInContext': {
            // 在特定上下文中禁止使用某模式
            const { pattern: textPattern, forbiddenContext } = astQuery.params || {};
            if (!textPattern || !forbiddenContext) {
              break;
            }

            const matches = AstAnalyzer.findPatternInContext(code, astLang, textPattern, {
              forbiddenContext,
            });
            for (const match of matches) {
              violations.push({
                ruleId: rule.id,
                message: rule.message,
                severity: rule.severity,
                line: match.line,
                snippet: match.snippet,
                dimension: rule.dimension || 'file',
                ...(rule.fixSuggestion ? { fixSuggestion: rule.fixSuggestion } : {}),
              });
            }
            break;
          }

          case 'mustConformToProtocol': {
            // 检查类是否实现了指定协议
            const { className, protocolName } = astQuery.params || {};
            if (!className || !protocolName) {
              break;
            }

            const result = AstAnalyzer.checkProtocolConformance(
              code,
              astLang,
              className,
              protocolName
            );
            if (result.classFound && !result.conforms) {
              violations.push({
                ruleId: rule.id,
                message: rule.message,
                severity: rule.severity,
                line: result.classDeclLine || 1,
                snippet: `class ${className} — missing ${protocolName} conformance`,
                dimension: rule.dimension || 'file',
                ...(rule.fixSuggestion ? { fixSuggestion: rule.fixSuggestion } : {}),
              });
            }
            break;
          }

          default:
            this.logger.debug(`Unknown AST query type: ${astQuery.queryType}`);
        }
      } catch (err) {
        this.logger.debug(`AST rule ${rule.id} check failed: ${err.message}`);
      }
    }

    return violations;
  }

  /**
   * 获取 AstAnalyzer 模块（静态 import，带可用性检测）
   */
  _getAstAnalyzer() {
    return AstAnalyzerModule;
  }

  /**
   * 将 Guard 命中计数回写到对应 Recipe 的 guard_hit_count
   * @param {Array<{ruleId: string}>} violations
   */
  trackGuardHits(violations) {
    if (!violations?.length || !this.db) {
      return;
    }

    try {
      // 收集来自数据库规则的 ruleId → 命中次数
      const hitMap = new Map();
      for (const v of violations) {
        const count = hitMap.get(v.ruleId) || 0;
        hitMap.set(v.ruleId, count + 1);
      }

      let updateStmt;
      try {
        updateStmt = this.db.prepare(
          `UPDATE knowledge_entries
           SET stats = json_set(COALESCE(stats, '{}'), '$.guardHits',
                 COALESCE(json_extract(stats, '$.guardHits'), 0) + ?),
               updatedAt = ?
           WHERE id = ?`
        );
      } catch {
        /* table may not exist */
      }
      const now = Math.floor(Date.now() / 1000);

      for (const [ruleId, count] of hitMap) {
        try {
          updateStmt.run(count, now, ruleId);
        } catch {
          /* 非 Recipe 规则（内置规则）忽略 */
        }
      }
    } catch (err) {
      this.logger.debug('trackGuardHits failed', { error: err.message });
    }
  }

  /**
   * 代码级别检查 - 需要上下文理解的检查（跨行 / 配对检查）
   * 按语言分发到各自的检查逻辑
   */
  _runCodeLevelChecks(code, language, lines) {
    const violations = [];

    // ── ObjC ──
    if (language === 'objc') {
      // KVO 观察者未移除检查
      if (code.includes('addObserver') && !code.includes('removeObserver')) {
        const lineIdx = lines.findIndex((l) => /addObserver/.test(l));
        violations.push({
          ruleId: 'objc-kvo-missing-remove',
          message: '存在 addObserver 未发现配对 removeObserver，请在 dealloc 或合适时机移除',
          severity: 'warning',
          line: lineIdx >= 0 ? lineIdx + 1 : 1,
          snippet: lineIdx >= 0 ? lines[lineIdx].trim().slice(0, 120) : '',
          dimension: 'file',
        });
      }

      // ObjC Category 重名检查 (同文件)
      const categoryRegex = /@interface\s+(\w+)\s*\(\s*(\w+)\s*\)/g;
      const categories = {};
      for (let i = 0; i < lines.length; i++) {
        categoryRegex.lastIndex = 0;
        const m = categoryRegex.exec(lines[i]);
        if (!m) {
          continue;
        }
        const key = `${m[1]}(${m[2]})`;
        if (!categories[key]) {
          categories[key] = [];
        }
        categories[key].push({ line: i + 1, snippet: lines[i].trim().slice(0, 120) });
      }
      for (const [key, occs] of Object.entries(categories)) {
        if (occs.length <= 1) {
          continue;
        }
        for (let j = 1; j < occs.length; j++) {
          violations.push({
            ruleId: 'objc-duplicate-category',
            message: `同文件内 Category 重名：${key}，首次在第 ${occs[0].line} 行`,
            severity: 'warning',
            line: occs[j].line,
            snippet: occs[j].snippet,
            dimension: 'file',
          });
        }
      }
    }

    // ── JavaScript / TypeScript ──
    if (language === 'javascript' || language === 'typescript') {
      // Promise 未处理 rejection 检查
      // 文件中存在 .then() 但没有对应的 .catch() 或 try-catch
      if (code.includes('.then(') && !code.includes('.catch(') && !code.includes('try')) {
        const thenLines = [];
        for (let i = 0; i < lines.length; i++) {
          if (/\.then\s*\(/.test(lines[i])) {
            thenLines.push(i);
          }
        }
        if (thenLines.length > 0) {
          violations.push({
            ruleId: 'js-unhandled-promise',
            message: 'Promise 链缺少 .catch() 错误处理，未捕获的 rejection 可能导致静默失败',
            severity: 'warning',
            line: thenLines[0] + 1,
            snippet: lines[thenLines[0]].trim().slice(0, 120),
            dimension: 'file',
          });
        }
      }
    }

    // ── Go ──
    if (language === 'go') {
      // defer 在循环内检查 — defer 在函数结束时才执行，循环内 defer 可能资源泄露
      let inLoop = false;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (/^for\s/.test(trimmed) || /^for\s*\{/.test(trimmed)) {
          inLoop = true;
        }
        if (inLoop && /^\s*defer\s/.test(lines[i])) {
          violations.push({
            ruleId: 'go-defer-in-loop',
            message: 'defer 在循环内会延迟到函数返回时才执行，可能导致资源泄露或大量堆积',
            severity: 'warning',
            line: i + 1,
            snippet: lines[i].trim().slice(0, 120),
            dimension: 'file',
            fixSuggestion: '将循环体提取到独立函数中，或手动调用 Close()',
          });
        }
        // 简化: 遇到 } 且缩进回到顶层，认为循环结束
        if (inLoop && trimmed === '}' && (lines[i].match(/^\t/) || lines[i].match(/^}/))) {
          inLoop = false;
        }
      }
    }

    // ── Python ──
    if (language === 'python') {
      // 文件中同时存在 tab 和 space 缩进
      let hasTab = false;
      let hasSpace = false;
      for (let i = 0; i < Math.min(lines.length, 200); i++) {
        if (/^\t/.test(lines[i])) hasTab = true;
        if (/^ {2,}/.test(lines[i]) && !/^\t/.test(lines[i])) hasSpace = true;
      }
      if (hasTab && hasSpace) {
        violations.push({
          ruleId: 'py-mixed-indentation',
          message: '文件混用 tab 和 space 缩进，Python 对此敏感，请统一使用 space',
          severity: 'warning',
          line: 1,
          snippet: '',
          dimension: 'file',
        });
      }
    }

    return violations;
  }

  /**
   * 文件审计 - 读取文件并检查
   * @param {string} filePath - 绝对路径
   * @param {string} code - 文件内容
   * @param {object} options - {scope}
   */
  auditFile(filePath, code, options = {}) {
    const language = detectLanguage(filePath);
    const violations = this.checkCode(code, language, { ...options, filePath });
    return {
      filePath,
      language,
      violations,
      summary: {
        total: violations.length,
        errors: violations.filter((v) => v.severity === 'error').length,
        warnings: violations.filter((v) => v.severity === 'warning').length,
      },
    };
  }

  /**
   * 批量文件审计
   * @param {Array<{path: string, content: string}>} files
   * @param {object} options - {scope: 'file'|'target'|'project'}
   * @returns {{files, summary, crossFileViolations}}
   */
  auditFiles(files, options = {}) {
    const results = [];
    let totalViolations = 0;
    let totalErrors = 0;

    for (const { path: filePath, content } of files) {
      const result = this.auditFile(filePath, content, options);
      results.push(result);
      totalViolations += result.summary.total;
      totalErrors += result.summary.errors;
    }

    // ── 跨文件检查 ──
    const crossFileViolations = this._runCrossFileChecks(files);
    totalViolations += crossFileViolations.length;
    totalErrors += crossFileViolations.filter((v) => v.severity === 'error').length;

    return {
      files: results,
      crossFileViolations,
      summary: {
        filesChecked: results.length,
        totalViolations,
        totalErrors,
        filesWithViolations: results.filter((r) => r.summary.total > 0).length,
      },
    };
  }

  /**
   * 跨文件检查 — 需要多文件上下文才能发现的问题
   * @param {Array<{path: string, content: string}>} files
   * @returns {Array<{ruleId, message, severity, locations}>}
   */
  _runCrossFileChecks(files) {
    const violations = [];

    // ── ObjC Category 跨文件重名检查 ──
    // 收集所有文件中的 @interface ClassName(CategoryName) 声明
    const categoryMap = new Map(); // key: "ClassName(CategoryName)" → [{filePath, line, snippet}]
    const categoryRegex = /@interface\s+(\w+)\s*\(\s*(\w+)\s*\)/g;

    for (const { path: filePath, content } of files) {
      const ext = filePath.split('.').pop()?.toLowerCase();
      if (ext !== 'm' && ext !== 'mm' && ext !== 'h') {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        categoryRegex.lastIndex = 0;
        let m;
        while ((m = categoryRegex.exec(lines[i])) !== null) {
          const key = `${m[1]}(${m[2]})`;
          if (!categoryMap.has(key)) {
            categoryMap.set(key, []);
          }
          categoryMap.get(key).push({
            filePath,
            line: i + 1,
            snippet: lines[i].trim().slice(0, 120),
          });
        }
      }
    }

    // .h 和 .m 成对出现是正常的（声明 + 实现），只有同类型文件重名才是问题
    // 或者超过 2 处声明就一定有问题
    for (const [key, locations] of categoryMap) {
      if (locations.length <= 1) {
        continue;
      }

      // 按文件扩展名分组: .h 和 .m/.mm 各一个是合法的
      const hFiles = locations.filter((l) => l.filePath.endsWith('.h'));
      const mFiles = locations.filter((l) => !l.filePath.endsWith('.h'));

      // 同类型文件中有多个声明 → 重名冲突
      const hasDuplicateH = hFiles.length > 1;
      const hasDuplicateM = mFiles.length > 1;
      // 超过 2 处总声明（如 3 个文件都声明了同一个 Category）→ 一定有问题
      const tooMany = locations.length > 2;

      if (hasDuplicateH || hasDuplicateM || tooMany) {
        // 收集冲突的那些位置
        const conflictLocations = tooMany
          ? locations
          : hasDuplicateH && hasDuplicateM
            ? locations
            : hasDuplicateH
              ? hFiles
              : mFiles;

        violations.push({
          ruleId: 'objc-cross-file-duplicate-category',
          message: `Category ${key} 在 ${conflictLocations.length} 个文件中重复声明，可能导致方法覆盖或未定义行为`,
          severity: 'warning',
          locations: conflictLocations,
        });
      }
    }

    return violations;
  }

  /**
   * 清除规则缓存
   */
  clearCache() {
    this._customRulesCache = null;
    this._cacheTime = 0;
    this._regexCache.clear();
  }

  /**
   * 编译正则模式（支持 RegExp 对象和 string，带缓存）
   * @param {RegExp|string} pattern
   * @returns {RegExp}
   */
  _compilePattern(pattern) {
    if (pattern instanceof RegExp) {
      return pattern;
    }
    const key = String(pattern);
    let cached = this._regexCache.get(key);
    if (!cached) {
      cached = new RegExp(key);
      this._regexCache.set(key, cached);
    }
    return cached;
  }

  /**
   * 构建内联测试块掩码
   * 目前支持 Rust #[cfg(test)] mod xxx { ... } 块
   * @param {string[]} lines
   * @param {string} language
   * @returns {boolean[]} 每行是否在测试块内
   */
  _buildTestBlockMask(lines, language) {
    const mask = new Array(lines.length).fill(false);

    // 目前仅 Rust 需要 — #[cfg(test)] 内联测试模块
    if (language !== 'rust') return mask;

    let inTestBlock = false;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();

      if (!inTestBlock) {
        // 检测 #[cfg(test)] 属性行
        if (/^#\[cfg\(test\)\]/.test(trimmed)) {
          // 向后找 mod xxx { — 标记为测试块起始
          // 可能在同一行: #[cfg(test)] mod tests {
          // 也可能在下一行: mod tests {
          const restOfLine = trimmed.slice('#[cfg(test)]'.length).trim();
          if (/^mod\s+\w+/.test(restOfLine)) {
            // 同一行有 mod 声明
            inTestBlock = true;
            braceDepth = 0;
            // 计算本行的花括号
            for (const ch of lines[i]) {
              if (ch === '{') braceDepth++;
              else if (ch === '}') braceDepth--;
            }
            mask[i] = true;
            if (braceDepth <= 0) inTestBlock = false; // 单行 mod 声明 (mod tests;)
            continue;
          }
          // 检查下一行是否是 mod xxx {
          if (i + 1 < lines.length && /^\s*mod\s+\w+/.test(lines[i + 1])) {
            mask[i] = true; // #[cfg(test)] 行本身也标记
            inTestBlock = true;
            braceDepth = 0;
            // 下一行会在循环中处理
            continue;
          }
          // 单行 #[cfg(test)] 但后面不是 mod — 不处理
        }
      } else {
        // 正在测试块内 — 追踪花括号深度
        mask[i] = true;
        for (const ch of lines[i]) {
          if (ch === '{') braceDepth++;
          else if (ch === '}') braceDepth--;
        }
        if (braceDepth <= 0) {
          inTestBlock = false; // 测试块结束
        }
      }
    }

    return mask;
  }

  /**
   * 构建注释行掩码 — 识别行注释和块注释内部行
   *
   * 支持的注释形式:
   *   // 行注释,  /// 文档注释,  //! 内部文档注释  (C/Java/JS/TS/Go/Rust/Swift/Kotlin/Dart)
   *   # 行注释  (Python)
   *   /* ... * / 块注释  (C/Java/JS/TS/Go/Rust/Swift/Kotlin)
   *   \"\"\" ... \"\"\"  (Python doc-string — 简化: 整行以 \"\"\" 开头的行)
   *
   * @param {string[]} lines
   * @param {string} language
   * @returns {boolean[]} 每行是否为注释行
   */
  _buildCommentMask(lines, language) {
    const mask = new Array(lines.length).fill(false);
    let inBlock = false; // 是否在 /* ... */ 块内

    const usesHash = language === 'python'; // Python 用 # 注释
    const usesSlash = !usesHash;            // 其他语言用 //

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();

      // 块注释延续
      if (inBlock) {
        mask[i] = true;
        if (trimmed.includes('*/')) {
          inBlock = false;
        }
        continue;
      }

      // 块注释开始（同行不闭合）
      if (usesSlash && /^\s*\/\*/.test(lines[i])) {
        mask[i] = true;
        if (!trimmed.includes('*/')) {
          inBlock = true;
        }
        continue;
      }

      // 行注释: // 或 /// 或 //!
      if (usesSlash && /^\s*\/\//.test(lines[i])) {
        mask[i] = true;
        continue;
      }

      // Python 行注释: #
      if (usesHash && /^\s*#/.test(lines[i])) {
        mask[i] = true;
        continue;
      }

      // Python docstring 行 (简化: 整行以 """ 或 ''' 开头)
      if (usesHash && /^\s*("""|''')/.test(lines[i])) {
        mask[i] = true;
        continue;
      }
    }

    return mask;
  }

  /**
   * 获取内置规则列表
   */
  getBuiltInRules() {
    return { ...this._builtInRules };
  }

  /**
   * 获取已注入的外部规则数量
   */
  getExternalRuleCount() {
    return this._externalRules.size;
  }
}

export default GuardCheckEngine;
