/**
 * GuardCheckEngine - Guard 规则检查引擎
 *
 * 从 V1 guard/ios 迁移，适配 V2 架构
 * 支持: 正则模式匹配 + AST 语义规则 + code-level 检查 + 多维度审计
 */

import * as AstAnalyzerModule from '../../core/AstAnalyzer.js';
import { GUARD_LIFECYCLES } from '../../domain/knowledge/Lifecycle.js';
import Logger from '../../infrastructure/logging/Logger.js';
import type { SignalBus } from '../../infrastructure/signal/SignalBus.js';
import type { KnowledgeRepositoryImpl } from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type { GuardKnowledgeRepo } from '../../repository/search/SearchRepoAdapter.js';
import { RawDbGuardAdapter, unwrapRawDb } from '../../repository/search/SearchRepoAdapter.js';
import { LanguageService } from '../../shared/LanguageService.js';
import { runCodeLevelChecks } from './GuardCodeChecks.js';
import { runCrossFileChecks } from './GuardCrossFileChecks.js';
import {
  buildCommentMask,
  buildTestBlockMask,
  clearPatternCache,
  compilePattern,
  detectLanguage,
} from './GuardPatternUtils.js';
import type { GuardCapabilityReport, UncertainResult } from './UncertaintyCollector.js';
import { UncertaintyCollector } from './UncertaintyCollector.js';

/** Minimal DB interface for Guard engine */
interface DatabaseLike {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown>;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec?(sql: string): void;
}

interface BuiltInRule {
  message: string;
  severity: string;
  pattern: string;
  languages: string[];
  dimension?: string;
  category?: string;
  fixSuggestion?: string;
  excludePaths?: RegExp;
  excludeLinePatterns?: string[];
  excludePrevLinePatterns?: string[];
  skipComments?: boolean;
  skipTestBlocks?: boolean;
  skipTestFiles?: boolean;
}

interface GuardRule {
  id: string;
  name: string;
  message: string;
  pattern?: string | RegExp;
  languages: string[];
  severity: string;
  dimension?: string;
  category?: string;
  source?: string;
  type?: string;
  fixSuggestion?: string | null;
  excludePaths?: RegExp | string;
  excludeLinePatterns?: string[];
  excludePrevLinePatterns?: string[];
  skipComments?: boolean;
  skipTestBlocks?: boolean;
  /** When true, this rule is skipped for test files (detected by LanguageService.isTestFile) */
  skipTestFiles?: boolean;
  astQuery?: { queryType: string; params?: Record<string, string> };
}

interface GuardViolation {
  ruleId: string;
  message: string;
  severity: string;
  line: number;
  snippet: string;
  dimension?: string;
  fixSuggestion?: string;
  suggestedFix?: string | null;
  reasoning?: { whatViolated: string; whyItMatters: string; suggestedFix: string | null };
}

/** 每条规则的覆盖配置（支持数字阈值或富对象） */
interface RuleOverride {
  severity?: string;
  exclude?: string[];
}

interface GuardConfig {
  disabledRules?: string[];
  codeLevelThresholds?: Record<string, number | RuleOverride>;
}

interface GuardCheckEngineOptions {
  cacheTTL?: number;
  guardConfig?: GuardConfig;
  signalBus?: SignalBus;
  knowledgeRepo?: KnowledgeRepositoryImpl;
}

interface ExternalRuleInput {
  ruleId: string;
  pattern?: RegExp | string;
  severity?: string;
  message?: string;
  category?: string;
  dimension?: string;
  languages?: string[];
  fixSuggestion?: string;
}

interface AuditFileResult {
  filePath: string;
  language: string;
  violations: GuardViolation[];
  uncertainResults: UncertainResult[];
  summary: { total: number; errors: number; warnings: number; uncertain: number };
}

interface AuditFilesInput {
  path: string;
  content: string;
  /** Pre-computed test file flag from LanguageService.isTestFile */
  isTest?: boolean;
}

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
    // UIKit 框架契约保证安全的 as! 场景
    excludeLinePatterns: [
      'dequeueReusableCell.*as\\s*!',
      'dequeueReusableSupplementaryView.*as\\s*!',
      'dequeueReusableHeaderFooterView.*as\\s*!',
      '\\blayer\\s+as\\s*!',
    ],
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
    excludePaths:
      /(?:^|[/\\])(?:test|tests|__tests__|spec|__mocks__|mock|mocks|fixtures?)[/\\]|[/\\](?:test_|spec_)[^/\\]*\.(?:js|ts)$|\.(?:test|spec)\.(?:js|ts)$/,
  },
  'js-no-console-log': {
    message: '生产代码应移除 console.log，使用专用日志库',
    severity: 'info',
    pattern: 'console\\.log\\s*\\(',
    languages: ['javascript', 'typescript'],
    dimension: 'file',
    category: 'style',
    excludePaths:
      /(?:^|[/\\])(?:test|tests|__tests__|spec|mock|mocks|__mocks__|scripts|tools|debug)[/\\]|[/\\](?:test_|spec_|mock)[^/\\]*\.(?:js|ts)$|\.(?:test|spec)\.(?:js|ts)$/,
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
    excludePaths: /(?:^|[/\\])tests?[/\\]|[/\\]test_[^/\\]*\.py$|_test\.py$/,
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
    skipTestFiles: true,
  },
  'go-no-err-ignored': {
    message: '错误值不应用 _ 忽略，应处理或明确标注',
    severity: 'warning',
    pattern: '\\w+\\s*,\\s*_\\s*:?=\\s*\\w|_\\s*=\\s*\\w+\\.[A-Z]\\w*\\(',
    languages: ['go'],
    dimension: 'file',
    category: 'correctness',
    excludePaths: /(?:^|[/\\])(?:tests?|testdata|_test)[/\\]|_test\.go$/,
    excludeLinePatterns: [
      '\\.\\([^)]*\\)', // type assertion: val, _ := expr.(Type) — _ 是 bool ok，不是 error
      'RegisterFlagCompletionFunc', // cobra flag completion: flag 名由同函数字面量保证，不会失败
      'MarkFlagRequired', // cobra flag setup: 同上
    ],
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
    excludePaths: /(?:^|[/\\])(?:tests?|testdata)[/\\]|_test\.go$/,
    excludeLinePatterns: [
      '\\bembed\\.', // //go:embed requires package-level var
      '\\bsync\\.', // sync.Map, sync.Once, sync.Mutex etc. are designed as package-level vars
      '\\batomic\\.', // atomic.Pointer, atomic.Value etc.
    ],
    excludePrevLinePatterns: [
      '//go:embed', // //go:embed directive on previous line requires package-level var
    ],
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
    fixSuggestion:
      '使用 Object? 或具体类型替代 dynamic；Map<String, dynamic> 用于 JSON 序列化时可保留',
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
    pattern: 'import\\s+[\'"]\\.\\.?/',
    languages: ['dart'],
    dimension: 'file',
    category: 'style',
  },
  'dart-dispose-controller': {
    message: 'TextEditingController/AnimationController 等须在 dispose() 中释放',
    severity: 'warning',
    pattern:
      '(?:TextEditingController|AnimationController|ScrollController|FocusNode|TabController)\\(',
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
    excludePaths:
      /(?:^|[/\\])(?:tests?|test_helpers|benches|examples)[/\\]|[/\\]test_[^/\\]*\.rs$|_test\.rs$/,
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
    excludePaths: /(?:^|[/\\])(?:tests?|test_helpers|benches|examples)[/\\]|_test\.rs$/,
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
    excludePaths: /(?:^|[/\\])(?:tests?|test_helpers|benches|examples)[/\\]|_test\.rs$/,
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
    excludePaths: /(?:^|[/\\])(?:tests?|test_helpers|benches|examples)[/\\]|main\.rs$/,
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

// 向后兼容: 从 GuardPatternUtils 重新导出 detectLanguage
export { detectLanguage } from './GuardPatternUtils.js';

/** GuardCheckEngine - 核心检查引擎 */
export class GuardCheckEngine {
  _astRulesCache: GuardRule[] | null;
  _builtInRules: Record<string, BuiltInRule>;
  _cacheTTL: number;
  _cacheTime: number;
  _customRulesCache: GuardRule[] | null;
  _epInjected: boolean;
  _externalRules: Map<string, GuardRule>;
  _guardConfig: GuardConfig;
  _signalBus: SignalBus | null;
  /** 上次 guard 信号指纹，用于去重（相同结果不重复发射） */
  _lastGuardSignalKey: string;
  _lastBlindSpotSignalKey: string;
  _uncertaintyCollector: UncertaintyCollector;
  db: DatabaseLike;
  #knowledgeRepo: GuardKnowledgeRepo;
  logger: ReturnType<typeof Logger.getInstance>;
  constructor(
    db: DatabaseLike | { getDb(): DatabaseLike } | null,
    options: GuardCheckEngineOptions = {}
  ) {
    this.db = unwrapRawDb<DatabaseLike>(db as DatabaseLike);
    this.#knowledgeRepo =
      options.knowledgeRepo ??
      (this.db
        ? new RawDbGuardAdapter(this.db)
        : new RawDbGuardAdapter({
            prepare: () => ({ run: () => undefined, get: () => ({}), all: () => [] }),
          } as unknown as DatabaseLike));
    this.logger = Logger.getInstance();
    this._builtInRules = BUILT_IN_RULES;
    this._customRulesCache = null;
    this._astRulesCache = null;
    this._cacheTime = 0;
    this._cacheTTL = options.cacheTTL || 60_000; // 1min
    /** Enhancement Pack 注入的外部规则 */
    this._externalRules = new Map();
    /** EP 规则是否已注入（幂等标记，避免每次请求重复注入） */
    this._epInjected = false;
    /** Guard 配置 — 允许禁用特定规则或调整 Code-Level 检查阈值 */
    this._guardConfig = options.guardConfig || {};
    this._signalBus = options.signalBus || null;
    this._lastGuardSignalKey = '';
    this._lastBlindSpotSignalKey = '';
    this._uncertaintyCollector = new UncertaintyCollector();
  }

  /**
   * 注入 Enhancement Pack 外部规则（支持 RegExp 和 string pattern）
   * 与 BUILT_IN_RULES 合并检查，自动跳过 ruleId 重复的规则
   * @param rules
   */
  injectExternalRules(rules: ExternalRuleInput[]) {
    if (!Array.isArray(rules)) {
      return;
    }
    for (const rule of rules) {
      if (!rule.ruleId) {
        continue;
      }
      // 已注入的 ruleId 跳过（幂等）
      if (this._externalRules.has(rule.ruleId)) {
        continue;
      }
      // 跳过与 BUILT_IN_RULES 重复的模式（通过比较 pattern 源文本）
      const rulePatternStr =
        rule.pattern instanceof RegExp ? rule.pattern.source : String(rule.pattern || '');
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
    this.logger.debug(
      `[GuardCheckEngine] External rules injected: ${this._externalRules.size} active`
    );
  }

  /** EP 注入幂等标记 — 调用者可用此判断是否已完成注入，避免重复加载 EnhancementRegistry */
  isEpInjected() {
    return this._epInjected;
  }
  markEpInjected() {
    this._epInjected = true;
  }

  /** 获取所有启用的规则 (数据库 + 内置) */
  getRules(language: string | null = null) {
    let rules: GuardRule[] = [];

    // 从数据库加载自定义规则
    // 优先从 knowledge_entries 表查询（V3），回退到 recipes 表（V2）
    try {
      const now = Date.now();
      if (!this._customRulesCache || now - this._cacheTime > this._cacheTTL) {
        let rows: Record<string, unknown>[] = [];
        try {
          rows = this.#knowledgeRepo.findGuardRulesSync(GUARD_LIFECYCLES) as Record<
            string,
            unknown
          >[];
        } catch {
          /* table may not exist */
        }

        const regexRules: GuardRule[] = [];
        const astRules: GuardRule[] = [];

        for (const r of rows) {
          let guards: Record<string, unknown>[] = [];
          try {
            const constraints = JSON.parse((r.constraints as string) || '{}');
            guards = constraints.guards || [];
          } catch {
            /* ignore */
          }

          for (const g of guards) {
            const ruleType = (g.type as string) || 'regex';
            const lang = r.language as string | undefined;
            const isDecaying = (r as Record<string, unknown>).lifecycle === 'decaying';
            const rawSeverity = (g.severity || 'warning') as string;
            const base = {
              id: (g.id || r.id) as string,
              name: (g.name || r.title) as string,
              message: (g.message || r.description || r.title) as string,
              languages: lang ? [lang, LanguageService.toGuardLangId(lang)] : [],
              severity: isDecaying && rawSeverity === 'error' ? 'warning' : rawSeverity,
              dimension: (r.scope || 'file') as string,
              source: 'database',
              fixSuggestion: (g.fixSuggestion || null) as string | null,
            };

            if (ruleType === 'ast' && g.astQuery) {
              astRules.push({
                ...base,
                type: 'ast',
                astQuery: g.astQuery as GuardRule['astQuery'],
              });
            } else if (g.pattern) {
              regexRules.push({ ...base, type: 'regex', pattern: g.pattern as string });
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
          ...(rule.skipTestFiles ? { skipTestFiles: true } : {}),
          ...(rule.excludeLinePatterns ? { excludeLinePatterns: rule.excludeLinePatterns } : {}),
          ...(rule.excludePrevLinePatterns
            ? { excludePrevLinePatterns: rule.excludePrevLinePatterns }
            : {}),
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

    // 按语言过滤（标准化比较：objc == objectivec == objective-c）
    if (language) {
      const langNorm = LanguageService.toGuardLangId(language);
      rules = rules.filter(
        (r) =>
          !r.languages?.length ||
          r.languages.includes(language) ||
          r.languages.includes(langNorm) ||
          r.languages.some((l: string) => LanguageService.toGuardLangId(l) === langNorm)
      );
    }

    // 按 disabledRules 配置过滤
    const disabledRules = this._guardConfig.disabledRules;
    if (Array.isArray(disabledRules) && disabledRules.length > 0) {
      const disabledSet = new Set(disabledRules);
      rules = rules.filter((r) => !disabledSet.has(r.id || r.name));
    }

    // 合并 AST 规则（供外部调用者使用，如 GuardFeedbackLoop.查找 fixSuggestion）
    if (this._astRulesCache?.length) {
      let astRules = this._astRulesCache;
      if (language) {
        astRules = astRules.filter(
          (r: GuardRule) => !r.languages?.length || r.languages.includes(language)
        );
      }
      rules.push(...astRules);
    }

    return rules;
  }

  /**
   * 对代码运行静态检查
   * @param code 源代码
   * @param language 'objc'|'swift'|'javascript' 等
   * @param options {scope, filePath, isTest}
   * @returns >}
   */
  checkCode(
    code: string,
    language: string,
    options: { scope?: string | null; filePath?: string; isTest?: boolean } = {}
  ) {
    const { scope = null, filePath = '', isTest = false } = options;
    const violations: GuardViolation[] = [];

    // 获取匹配语言的规则
    let rules = this.getRules(language);

    // 按 excludePaths 过滤（测试文件排除等）
    if (filePath) {
      rules = rules.filter((r) => {
        if (!r.excludePaths) {
          return true;
        }
        const re = r.excludePaths instanceof RegExp ? r.excludePaths : new RegExp(r.excludePaths);
        return !re.test(filePath);
      });
    }

    // 按 skipTestFiles 标记过滤测试文件
    if (isTest) {
      rules = rules.filter((r) => !r.skipTestFiles);
    }

    // 如果有 scope，按层级过滤：project ⊇ target ⊇ file
    // project 范围包含所有维度的规则；target 包含 file+target；file 仅匹配 file
    // 'universal' 维度在所有 scope 下都生效
    if (scope) {
      const SCOPE_HIERARCHY: Record<string, string[]> = {
        project: ['file', 'target', 'project', 'universal'],
        target: ['file', 'target', 'universal'],
        file: ['file', 'universal'],
      };
      const allowedDimensions = SCOPE_HIERARCHY[scope] || [scope, 'universal'];
      rules = rules.filter((r) => !r.dimension || allowedDimensions.includes(r.dimension));
    }

    const lines = (code || '').split(/\r?\n/);

    // 预计算注释行掩码 — 供 skipComments 规则使用
    // 识别: // 行注释, /// doc, //! inner doc, /* block */, # Python/Shell 行注释
    const commentLines = buildCommentMask(lines, language);

    // 预计算测试块掩码 — 供 skipTestBlocks 规则使用
    // Rust: #[cfg(test)] mod tests { ... } 内联测试模块
    const testBlockLines = buildTestBlockMask(lines, language);

    for (const rule of rules) {
      // 跳过空模式或特殊标记 (?!) — 由 code-level 检查接管
      if (!rule.pattern || rule.pattern === '(?!)') {
        continue;
      }

      let re: RegExp;
      try {
        re = compilePattern(rule.pattern);
      } catch {
        this.logger.debug(`Invalid regex in rule ${rule.id}: ${rule.pattern}`);
        this._uncertaintyCollector.recordSkip(
          'regex',
          'invalid_regex',
          `Rule ${rule.id}: pattern "${rule.pattern}" failed to compile`,
          { ruleId: rule.id || rule.name }
        );
        this._uncertaintyCollector.addUncertain(
          rule.id || rule.name,
          rule.message,
          'regex',
          'invalid_regex',
          `Pattern compilation failed: ${rule.pattern}`
        );
        continue;
      }

      const shouldSkipComments = !!rule.skipComments;
      const shouldSkipTestBlocks = !!rule.skipTestBlocks;

      // 合并内置 + 配置级排除行模式
      const ruleId = rule.id || rule.name;
      const excludeLineRegexes = this._getExcludeLineRegexes(ruleId, rule.excludeLinePatterns);
      const excludePrevLineRegexes = this._getExcludeLineRegexes(
        `${ruleId}:prev`,
        rule.excludePrevLinePatterns
      );

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
          // excludeLinePatterns: 跳过匹配排除模式的行（UIKit 框架契约安全等场景）
          if (excludeLineRegexes.length > 0 && excludeLineRegexes.some((ep) => ep.test(lines[i]))) {
            continue;
          }
          // excludePrevLinePatterns: 跳过前一行匹配排除模式的行（//go:embed 等指令注释）
          if (
            excludePrevLineRegexes.length > 0 &&
            i > 0 &&
            excludePrevLineRegexes.some((ep) => ep.test(lines[i - 1]))
          ) {
            continue;
          }
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

    // Code-level 检查（不依赖正则）— 仅传递数字类型阈值
    const numericThresholds: Record<string, number> = {};
    for (const [k, v] of Object.entries(this._guardConfig.codeLevelThresholds || {})) {
      if (typeof v === 'number') {
        numericThresholds[k] = v;
      }
    }
    violations.push(
      ...runCodeLevelChecks(code, language, lines, {
        disabledRules: this._guardConfig.disabledRules,
        codeLevelThresholds: numericThresholds,
      })
    );

    // AST 语义规则检查（Layer 1: 3 查询函数）
    violations.push(...this._runAstRuleChecks(code, language));

    // AST Layer 2: analyzeFile() 深层检查（复杂度、类膨胀、深嵌套）
    violations.push(...this._runAstLayer2Checks(code, language, filePath));

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
   * @param code 源代码
   * @param language 语言标识
   * @returns violations
   */
  _runAstRuleChecks(code: string, language: string) {
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
      (r: GuardRule) => !r.languages?.length || r.languages.includes(language)
    );
    if (astRules.length === 0) {
      return [];
    }

    // 延迟加载 AstAnalyzer
    let AstAnalyzer: typeof AstAnalyzerModule | undefined;
    try {
      // 使用 dynamic import 会是 async，这里用 require 风格同步加载
      // AstAnalyzer 作为 ESM 模块，在 constructor 时已被引入
      AstAnalyzer = this._getAstAnalyzer();
      if (!AstAnalyzer || !AstAnalyzer.isAvailable()) {
        // AST 不可用 — 记录 uncertain
        for (const rule of astRules) {
          this._uncertaintyCollector.recordSkip(
            'ast',
            'ast_unavailable',
            `AST check skipped: tree-sitter not available for lang "${language}"`,
            { ruleId: rule.id }
          );
          this._uncertaintyCollector.addUncertain(
            rule.id,
            rule.message,
            'ast',
            'ast_unavailable',
            `Tree-sitter not available for language "${language}"`
          );
        }
        this._uncertaintyCollector.recordLayerStats('ast', astRules.length, 0);
        return [];
      }
    } catch {
      this.logger.debug('AstAnalyzer not available, skipping AST rules');
      for (const rule of astRules) {
        this._uncertaintyCollector.recordSkip('ast', 'ast_unavailable', `AST module load failed`, {
          ruleId: rule.id,
        });
        this._uncertaintyCollector.addUncertain(
          rule.id,
          rule.message,
          'ast',
          'ast_unavailable',
          'AstAnalyzer module failed to load'
        );
      }
      this._uncertaintyCollector.recordLayerStats('ast', astRules.length, 0);
      return [];
    }

    const violations: GuardViolation[] = [];

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
      } catch (err: unknown) {
        this.logger.debug(`AST rule ${rule.id} check failed: ${(err as Error).message}`);
      }
    }

    // AST 层统计
    this._uncertaintyCollector.recordLayerStats('ast', astRules.length, astRules.length);

    return violations;
  }

  /**
   * AST Layer 2: analyzeFile() 深层检查
   *
   * 利用 AstAnalyzer.analyzeFile() 的完整输出产出 violations:
   *
   * --- 方法度量 ---
   *   - ast_class_bloat: 类方法数过多 (>30)
   *   - ast_method_complexity: 高圈复杂度 (>20)
   *   - ast_method_too_long: 方法行数过长 (>120)
   *   - ast_deep_nesting: 方法嵌套过深 (>6)
   *
   * --- 继承图检查 ---
   *   - ast_deep_inheritance: 继承链过深 (>4)
   *   - ast_wide_protocol_conformance: 单类遵守协议过多 (>5)
   *   - ast_missing_super: 子类未调用 super 的关键方法
   *
   * --- 属性规范 ---
   *   - ast_assign_object_property: ObjC assign 修饰对象类型属性
   *   - ast_missing_nonatomic: ObjC 属性缺少 nonatomic
   *   - ast_mutable_public_collection: 公开可变集合属性
   *
   * --- 设计模式/反模式检测 ---
   *   - ast_god_class: 方法+属性过多的上帝类 (>40 methods + >20 properties)
   *   - ast_singleton_abuse: 过多单例模式
   *   - ast_missing_weakify: block 内 self 捕获但未使用 weakify
   */
  _runAstLayer2Checks(code: string, language: string, filePath: string): GuardViolation[] {
    const disabled = this._guardConfig.disabledRules || [];
    const allLayer2Rules = [
      'ast_class_bloat',
      'ast_method_complexity',
      'ast_method_too_long',
      'ast_deep_nesting',
      'ast_deep_inheritance',
      'ast_wide_protocol_conformance',
      'ast_missing_super',
      'ast_assign_object_property',
      'ast_missing_nonatomic',
      'ast_mutable_public_collection',
      'ast_god_class',
      'ast_singleton_abuse',
      'ast_missing_weakify',
    ];
    const allDisabled = allLayer2Rules.every((id) => disabled.includes(id));
    if (allDisabled) {
      return [];
    }

    // 语言标准化
    const astLang = LanguageService.isKnownLang(language)
      ? language
      : language === 'objc'
        ? 'objectivec'
        : language;
    if (!LanguageService.isKnownLang(astLang)) {
      return [];
    }

    let AstAnalyzer: typeof AstAnalyzerModule | undefined;
    try {
      AstAnalyzer = this._getAstAnalyzer();
      if (!AstAnalyzer || !AstAnalyzer.isAvailable()) {
        this._uncertaintyCollector.recordSkip(
          'ast',
          'ast_unavailable',
          `AST Layer 2 skipped: tree-sitter not available for "${language}"`
        );
        return [];
      }
    } catch {
      return [];
    }

    let fileSummary: ReturnType<typeof AstAnalyzer.analyzeFile>;
    try {
      fileSummary = AstAnalyzer.analyzeFile(code, astLang, { extractCallSites: false });
    } catch (err: unknown) {
      this.logger.debug(`AST Layer 2 analyzeFile failed: ${(err as Error).message}`);
      return [];
    }
    if (!fileSummary) {
      return [];
    }

    const violations: GuardViolation[] = [];

    // — 阈值配置（可通过 codeLevelThresholds 覆盖） —
    const thresholds = this._guardConfig.codeLevelThresholds || {};
    const classBloatLimit = (
      typeof thresholds['ast_class_bloat'] === 'number' ? thresholds['ast_class_bloat'] : 30
    ) as number;
    const complexityLimit = (
      typeof thresholds['ast_method_complexity'] === 'number'
        ? thresholds['ast_method_complexity']
        : 20
    ) as number;
    const methodLengthLimit = (
      typeof thresholds['ast_method_too_long'] === 'number'
        ? thresholds['ast_method_too_long']
        : 120
    ) as number;
    const nestingLimit = (
      typeof thresholds['ast_deep_nesting'] === 'number' ? thresholds['ast_deep_nesting'] : 6
    ) as number;
    const inheritanceDepthLimit = (
      typeof thresholds['ast_deep_inheritance'] === 'number'
        ? thresholds['ast_deep_inheritance']
        : 4
    ) as number;
    const protocolConformanceLimit = (
      typeof thresholds['ast_wide_protocol_conformance'] === 'number'
        ? thresholds['ast_wide_protocol_conformance']
        : 5
    ) as number;
    const godClassMethodLimit = (
      typeof thresholds['ast_god_class_methods'] === 'number'
        ? thresholds['ast_god_class_methods']
        : 40
    ) as number;
    const godClassPropertyLimit = (
      typeof thresholds['ast_god_class_properties'] === 'number'
        ? thresholds['ast_god_class_properties']
        : 20
    ) as number;

    // ══════════════════════════════════════════════════════════
    //  Section A: 方法度量（原有 4 条规则）
    // ══════════════════════════════════════════════════════════

    // 1. Class bloat — 类方法数过多
    if (!disabled.includes('ast_class_bloat')) {
      const methodCountByClass: Record<string, { count: number; line: number }> = {};
      for (const m of fileSummary.methods) {
        if (m.className && m.kind === 'definition') {
          if (!methodCountByClass[m.className]) {
            const cls = fileSummary.classes.find((c) => c.name === m.className);
            methodCountByClass[m.className] = { count: 0, line: cls?.line || 1 };
          }
          methodCountByClass[m.className].count++;
        }
      }
      for (const [className, { count, line }] of Object.entries(methodCountByClass)) {
        if (count > classBloatLimit) {
          violations.push({
            ruleId: 'ast_class_bloat',
            message: `类 ${className} 有 ${count} 个方法，超过阈值 ${classBloatLimit}，建议拆分职责`,
            severity: 'warning',
            line,
            snippet: `class ${className} — ${count} methods`,
            dimension: 'file',
            fixSuggestion: '将职责拆分到多个类或使用 Extension/Category 分组',
          });
        }
      }
    }

    // 2. Method complexity — 高圈复杂度
    if (!disabled.includes('ast_method_complexity')) {
      for (const m of fileSummary.methods) {
        if (m.complexity && m.complexity > complexityLimit) {
          violations.push({
            ruleId: 'ast_method_complexity',
            message: `方法 ${m.className ? `${m.className}.` : ''}${m.name} 圈复杂度 ${m.complexity}，超过阈值 ${complexityLimit}`,
            severity: 'warning',
            line: m.line || 1,
            snippet: `${m.name} — complexity: ${m.complexity}`,
            dimension: 'file',
            fixSuggestion: '提取子方法、使用 early return 或策略模式降低复杂度',
          });
        }
      }
    }

    // 3. Method too long — 方法行数过长
    if (!disabled.includes('ast_method_too_long')) {
      for (const m of fileSummary.methods) {
        if (m.bodyLines && m.bodyLines > methodLengthLimit) {
          violations.push({
            ruleId: 'ast_method_too_long',
            message: `方法 ${m.className ? `${m.className}.` : ''}${m.name} 有 ${m.bodyLines} 行，超过阈值 ${methodLengthLimit}`,
            severity: 'warning',
            line: m.line || 1,
            snippet: `${m.name} — ${m.bodyLines} lines`,
            dimension: 'file',
            fixSuggestion: '将长方法拆分为多个更小的、职责单一的方法',
          });
        }
      }
    }

    // 4. Deep nesting — 方法嵌套过深
    if (!disabled.includes('ast_deep_nesting')) {
      for (const m of fileSummary.methods) {
        if (m.nestingDepth && m.nestingDepth > nestingLimit) {
          violations.push({
            ruleId: 'ast_deep_nesting',
            message: `方法 ${m.className ? `${m.className}.` : ''}${m.name} 嵌套深度 ${m.nestingDepth}，超过阈值 ${nestingLimit}`,
            severity: 'warning',
            line: m.line || 1,
            snippet: `${m.name} — nesting depth: ${m.nestingDepth}`,
            dimension: 'file',
            fixSuggestion: '使用 guard/early return 减少嵌套，或提取内层逻辑为独立方法',
          });
        }
      }
    }

    // ══════════════════════════════════════════════════════════
    //  Section B: 继承图检查（inheritanceGraph + classes.protocols）
    // ══════════════════════════════════════════════════════════

    // 5. Deep inheritance — 继承链过深
    if (!disabled.includes('ast_deep_inheritance') && fileSummary.inheritanceGraph?.length > 0) {
      // 构建父类映射: child → parent
      const parentMap: Record<string, string> = {};
      for (const edge of fileSummary.inheritanceGraph) {
        if (edge.type === 'extends' || edge.type === 'inherits') {
          parentMap[edge.from] = edge.to;
        }
      }
      // 计算每个类的继承深度
      for (const cls of fileSummary.classes) {
        let depth = 0;
        let current = cls.name;
        const visited = new Set<string>();
        while (parentMap[current] && !visited.has(current)) {
          visited.add(current);
          current = parentMap[current];
          depth++;
        }
        if (depth > inheritanceDepthLimit) {
          violations.push({
            ruleId: 'ast_deep_inheritance',
            message: `类 ${cls.name} 继承链深度 ${depth}，超过阈值 ${inheritanceDepthLimit}，过深继承增加理解和维护成本`,
            severity: 'warning',
            line: cls.line || 1,
            snippet: `class ${cls.name} — inheritance depth: ${depth}`,
            dimension: 'file',
            fixSuggestion: '优先使用组合（Composition）替代继承，或使用协议/接口解耦',
          });
        }
      }
    }

    // 6. Wide protocol conformance — 单类遵守协议过多
    if (!disabled.includes('ast_wide_protocol_conformance')) {
      for (const cls of fileSummary.classes) {
        const protocolCount = cls.protocols?.length || 0;
        if (protocolCount > protocolConformanceLimit) {
          violations.push({
            ruleId: 'ast_wide_protocol_conformance',
            message: `类 ${cls.name} 遵守 ${protocolCount} 个协议，超过阈值 ${protocolConformanceLimit}，职责可能过重`,
            severity: 'warning',
            line: cls.line || 1,
            snippet: `class ${cls.name} — ${protocolCount} protocols: ${cls.protocols!.slice(0, 5).join(', ')}${protocolCount > 5 ? '...' : ''}`,
            dimension: 'file',
            fixSuggestion: '将协议实现拆分到 Extension/Category 中，或拆分类职责',
          });
        }
      }
    }

    // ══════════════════════════════════════════════════════════
    //  Section C: 属性规范（properties + attributes）
    // ══════════════════════════════════════════════════════════

    const isObjcLike = ['objc', 'objectivec', 'objective-c'].includes(language.toLowerCase());

    if (isObjcLike && fileSummary.properties?.length > 0) {
      for (const prop of fileSummary.properties) {
        const attrs = prop.attributes || [];
        const attrsLower = attrs.map((a) => a.toLowerCase());

        // 7. assign 修饰对象类型属性
        if (!disabled.includes('ast_assign_object_property')) {
          if (attrsLower.includes('assign') && !attrsLower.includes('readonly')) {
            // assign 用于对象类型（通过属性名启发：delegate, block, handler 等常为对象）
            const likelyObject =
              /delegate|block|handler|callback|completion|dataSource|view|controller|manager|service/i.test(
                prop.name
              );
            if (likelyObject) {
              violations.push({
                ruleId: 'ast_assign_object_property',
                message: `属性 ${prop.className ? `${prop.className}.` : ''}${prop.name} 使用 assign 修饰，疑似对象类型，应改为 weak`,
                severity: 'warning',
                line: prop.line || 1,
                snippet: `@property (assign) ... ${prop.name}`,
                dimension: 'file',
                fixSuggestion: '对象类型属性使用 weak（delegate）或 strong/copy，避免悬垂指针',
              });
            }
          }
        }

        // 8. 缺少 nonatomic
        if (!disabled.includes('ast_missing_nonatomic')) {
          if (
            !attrsLower.includes('nonatomic') &&
            !attrsLower.includes('atomic') &&
            attrs.length > 0
          ) {
            violations.push({
              ruleId: 'ast_missing_nonatomic',
              message: `属性 ${prop.className ? `${prop.className}.` : ''}${prop.name} 缺少 nonatomic，iOS 中应默认使用 nonatomic 提升性能`,
              severity: 'info',
              line: prop.line || 1,
              snippet: `@property (${attrs.join(', ')}) ... ${prop.name}`,
              dimension: 'file',
              fixSuggestion: '添加 nonatomic 修饰符：@property (nonatomic, ...) ...',
            });
          }
        }

        // 9. 公开可变集合属性
        if (!disabled.includes('ast_mutable_public_collection')) {
          const isMutable =
            /NSMutableArray|NSMutableDictionary|NSMutableSet|NSMutableString|NSMutableData|NSMutableOrderedSet/i.test(
              `${attrs.join(' ')} ${prop.name}`
            );
          if (isMutable && !attrsLower.includes('readonly')) {
            violations.push({
              ruleId: 'ast_mutable_public_collection',
              message: `属性 ${prop.className ? `${prop.className}.` : ''}${prop.name} 暴露可变集合，外部可直接修改内部状态`,
              severity: 'warning',
              line: prop.line || 1,
              snippet: `@property ... NSMutable* ${prop.name}`,
              dimension: 'file',
              fixSuggestion:
                '对外使用 readonly + 不可变类型（NSArray/NSDictionary），内部用 readwrite + 可变类型',
            });
          }
        }
      }
    }

    // ══════════════════════════════════════════════════════════
    //  Section D: 设计模式 / 反模式检测（patterns + aggregated metrics）
    // ══════════════════════════════════════════════════════════

    // 10. God class — 方法+属性过多的上帝类
    if (!disabled.includes('ast_god_class')) {
      // 按类聚合方法数和属性数
      const classStats: Record<string, { methods: number; properties: number; line: number }> = {};
      for (const m of fileSummary.methods) {
        if (m.className && m.kind === 'definition') {
          if (!classStats[m.className]) {
            const cls = fileSummary.classes.find((c) => c.name === m.className);
            classStats[m.className] = { methods: 0, properties: 0, line: cls?.line || 1 };
          }
          classStats[m.className].methods++;
        }
      }
      for (const p of fileSummary.properties) {
        if (p.className) {
          if (!classStats[p.className]) {
            const cls = fileSummary.classes.find((c) => c.name === p.className);
            classStats[p.className] = { methods: 0, properties: 0, line: cls?.line || 1 };
          }
          classStats[p.className].properties++;
        }
      }
      for (const [className, stats] of Object.entries(classStats)) {
        if (stats.methods > godClassMethodLimit && stats.properties > godClassPropertyLimit) {
          violations.push({
            ruleId: 'ast_god_class',
            message: `类 ${className} 有 ${stats.methods} 个方法和 ${stats.properties} 个属性，疑似上帝类（God Class），职责过重`,
            severity: 'warning',
            line: stats.line,
            snippet: `class ${className} — ${stats.methods} methods, ${stats.properties} properties`,
            dimension: 'file',
            fixSuggestion: '遵循单一职责原则（SRP），将类拆分为多个更小的、职责明确的类',
          });
        }
      }
    }

    // 11. Singleton abuse — 过多单例模式（文件级别）
    if (!disabled.includes('ast_singleton_abuse') && fileSummary.patterns?.length > 0) {
      const singletonPatterns = fileSummary.patterns.filter((p) => p.type === 'singleton');
      if (singletonPatterns.length > 2) {
        violations.push({
          ruleId: 'ast_singleton_abuse',
          message: `文件中检测到 ${singletonPatterns.length} 个单例模式，过多单例增加耦合和测试难度`,
          severity: 'info',
          line: singletonPatterns[0]?.line || 1,
          snippet: `${singletonPatterns.length} singletons: ${singletonPatterns
            .map((p) => p.className || p.methodName || 'unknown')
            .slice(0, 3)
            .join(', ')}`,
          dimension: 'file',
          fixSuggestion: '考虑使用依赖注入（DI）替代单例，提升可测试性和解耦',
        });
      }
    }

    // 12. Missing weakify — block 内 self 捕获但未使用 weakify 模式
    if (
      !disabled.includes('ast_missing_weakify') &&
      isObjcLike &&
      fileSummary.patterns?.length > 0
    ) {
      const selfCaptures = fileSummary.patterns.filter(
        (p) => p.type === 'block_self_capture' && !p.isWeakRef
      );
      for (const cap of selfCaptures) {
        violations.push({
          ruleId: 'ast_missing_weakify',
          message: `${cap.className ? `${cap.className}.` : ''}${cap.methodName || 'block'} 中 block 捕获 self 但未使用 @weakify/@strongify`,
          severity: 'warning',
          line: cap.line || 1,
          snippet: `block captures self without weakify in ${cap.methodName || 'anonymous block'}`,
          dimension: 'file',
          fixSuggestion:
            '使用 @weakify(self) / @strongify(self) 或 __weak typeof(self) weakSelf = self',
        });
      }
    }

    return violations;
  }

  /** 获取 AstAnalyzer 模块（静态 import，带可用性检测） */
  _getAstAnalyzer() {
    return AstAnalyzerModule;
  }

  /**
   * 合并内置 + 配置级行排除模式，编译为 RegExp 数组
   * 配置来自 guardConfig.codeLevelThresholds[ruleId].exclude
   */
  _getExcludeLineRegexes(ruleId: string, builtIn?: string[]): RegExp[] {
    const patterns: string[] = [...(builtIn || [])];
    // 合并项目配置中的 exclude
    const override = this._guardConfig.codeLevelThresholds?.[ruleId];
    if (override && typeof override === 'object' && Array.isArray(override.exclude)) {
      patterns.push(...override.exclude);
    }
    const regexes: RegExp[] = [];
    for (const p of patterns) {
      try {
        regexes.push(new RegExp(p));
      } catch {
        this.logger.debug(`Invalid excludeLinePattern in rule ${ruleId}: ${p}`);
      }
    }
    return regexes;
  }

  /**
   * 将 Guard 命中计数回写到对应 Recipe 的 guard_hit_count
   * @param violations
   */
  trackGuardHits(violations: GuardViolation[]) {
    if (!violations?.length || !this.#knowledgeRepo) {
      return;
    }

    try {
      // 收集来自数据库规则的 ruleId → 命中次数
      const hitMap = new Map<string, number>();
      for (const v of violations) {
        const count = hitMap.get(v.ruleId) || 0;
        hitMap.set(v.ruleId, count + 1);
      }

      for (const [ruleId, count] of hitMap) {
        try {
          this.#knowledgeRepo.incrementGuardHitsSync(ruleId, count);
        } catch {
          /* 非 Recipe 规则（内置规则）忽略 */
        }
      }
    } catch (err: unknown) {
      this.logger.debug('trackGuardHits failed', { error: (err as Error).message });
    }
  }

  /**
   * 文件审计 - 读取文件并检查
   * @param filePath 绝对路径
   * @param code 文件内容
   * @param options {scope}
   */
  auditFile(
    filePath: string,
    code: string,
    options: { scope?: string; isTest?: boolean } = {}
  ): AuditFileResult {
    const language = detectLanguage(filePath);
    // 每次文件审计前重置 collector（单文件粒度）
    this._uncertaintyCollector.reset();
    const violations = this.checkCode(code, language, { ...options, filePath });
    const report = this._uncertaintyCollector.buildReport();
    return {
      filePath,
      language,
      violations,
      uncertainResults: report.uncertainResults,
      summary: {
        total: violations.length,
        errors: violations.filter((v) => v.severity === 'error').length,
        warnings: violations.filter((v) => v.severity === 'warning').length,
        uncertain: report.uncertainResults.length,
      },
    };
  }

  /**
   * 批量文件审计
   * @param files
   * @param options {scope: 'file'|'target'|'project'}
   * @returns }
   */
  auditFiles(files: AuditFilesInput[], options: { scope?: string } = {}) {
    const results: AuditFileResult[] = [];
    let totalViolations = 0;
    let totalErrors = 0;

    for (const { path: filePath, content, isTest } of files) {
      const result = this.auditFile(filePath, content, { ...options, isTest });
      results.push(result);
      totalViolations += result.summary.total;
      totalErrors += result.summary.errors;
    }

    // ── 跨文件检查 ──
    const crossFileViolations = runCrossFileChecks(files, {
      disabledRules: this._guardConfig.disabledRules,
    });
    totalViolations += crossFileViolations.length;
    totalErrors += crossFileViolations.filter((v) => v.severity === 'error').length;

    const testFileCount = files.filter((f) => f.isTest).length;
    const summary = {
      filesChecked: results.length,
      testFiles: testFileCount,
      productionFiles: results.length - testFileCount,
      totalViolations,
      totalErrors,
      totalUncertain: results.reduce((s, r) => s + r.summary.uncertain, 0),
      filesWithViolations: results.filter((r) => r.summary.total > 0).length,
    };

    // ── Signal emission (去重：相同检查结果不重复发射) ──
    if (this._signalBus && totalViolations > 0) {
      const signalKey = `${summary.filesChecked}:${summary.totalViolations}:${summary.totalErrors}:${summary.totalUncertain}:${summary.filesWithViolations}`;
      if (signalKey !== this._lastGuardSignalKey) {
        this._lastGuardSignalKey = signalKey;
        this._signalBus.send('guard', 'GuardCheckEngine', totalErrors > 0 ? 1 : 0.5, {
          metadata: { ...summary },
        });
      }
    }

    // ── 聚合 capability report ──
    const aggregateCollector = new UncertaintyCollector();
    for (const r of results) {
      for (const u of r.uncertainResults) {
        aggregateCollector.addUncertain(u.ruleId, u.message, u.layer, u.reason, u.detail);
      }
    }
    const capabilityReport = aggregateCollector.buildReport();

    // ── guard_blind_spot: uncertain 超阈值时发射 CapabilityRequest 信号（去重） ──
    if (this._signalBus && capabilityReport.uncertainResults.length > 0) {
      const uncertainTotal = capabilityReport.uncertainResults.length;
      const blindSpotThreshold = 5; // 触发阈值
      if (uncertainTotal >= blindSpotThreshold) {
        const blindSpotKey = `${uncertainTotal}:${capabilityReport.checkCoverage}`;
        if (blindSpotKey !== this._lastBlindSpotSignalKey) {
          this._lastBlindSpotSignalKey = blindSpotKey;
          // 按 layer 聚合盲区
          const byLayer: Record<string, number> = {};
          for (const u of capabilityReport.uncertainResults) {
            byLayer[u.layer] = (byLayer[u.layer] || 0) + 1;
          }
          this._signalBus.send(
            'guard_blind_spot',
            'GuardCheckEngine',
            uncertainTotal >= 20 ? 1 : 0.5,
            {
              metadata: {
                type: 'CapabilityRequest',
                uncertainTotal,
                checkCoverage: capabilityReport.checkCoverage,
                byLayer,
                boundaries: capabilityReport.boundaries.map((b) => ({
                  type: b.type,
                  description: b.description,
                  affectedRules: b.affectedRules,
                  suggestedAction: b.suggestedAction,
                })),
                suggestedAction:
                  'Extend Guard capability: add AST support for uncovered languages or implement missing cross-file checks',
              },
            }
          );
        }
      }
    }

    return { files: results, crossFileViolations, summary, capabilityReport };
  }

  /** 获取 uncertainty collector（供外部读取单文件 uncertain 状态） */
  getUncertaintyCollector(): UncertaintyCollector {
    return this._uncertaintyCollector;
  }

  /** 清除规则缓存 */
  clearCache() {
    this._customRulesCache = null;
    this._cacheTime = 0;
    clearPatternCache();
  }

  /** 获取内置规则列表 */
  getBuiltInRules() {
    return { ...this._builtInRules };
  }

  /** 获取已注入的外部规则数量 */
  getExternalRuleCount() {
    return this._externalRules.size;
  }
}

export default GuardCheckEngine;
