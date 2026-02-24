/**
 * LanguageExtensions — 语言检测与语言特有扩展字段构建
 *
 * 负责：
 *   - 文件扩展名 → 语言映射（委托 LanguageService）
 *   - langStats 聚合 → 主语言推断（委托 LanguageService）
 *   - 主语言 → 语言扩展字段（分析维度、典型模式、反模式、Guard 规则等）
 *
 * 注册表驱动：
 *   所有语言知识集中在 LANG_REGISTRY 中，新增语言只需添加条目即可。
 *   覆盖 LanguageService.KNOWN_PROGRAMMING_LANGS 全部 14 种编程语言。
 */

import { LanguageService } from '../../../shared/LanguageService.js';

/** 根据文件扩展名推断语言 — 委托给 LanguageService（唯一来源） */
export function inferLang(filename) {
  return LanguageService.inferLang(filename);
}

/** 从 langStats 推断主语言 — 委托给 LanguageService（唯一来源） */
export function detectPrimaryLanguage(langStats) {
  return LanguageService.detectPrimary(langStats);
}

// ═══════════════════════════════════════════════════════════
// 语言扩展注册表 — 按 lang ID 索引
// ═══════════════════════════════════════════════════════════

/**
 * JS/TS 共享扩展生成器（根据具体 lang 微调差异点）
 * @param {'javascript'|'typescript'} lang
 */
function _buildJsTsEntry(lang) {
  const isTs = lang === 'typescript';
  return {
    extraDimensions: [
      {
        id: 'module-system',
        label: '模块系统',
        guide: 'ESM vs CJS、dynamic import、barrel export、tree-shaking',
      },
      {
        id: 'type-safety',
        label: '类型安全',
        guide: isTs
          ? 'strict 模式、泛型、类型守卫、Utility Types、satisfies 操作符'
          : 'JSDoc 类型标注、.d.ts 声明、@ts-check',
      },
      {
        id: 'async-pattern',
        label: '异步模式',
        guide: 'Promise 链、async/await、Error 处理、AbortController、AsyncIterator',
      },
      {
        id: 'framework-convention',
        label: '框架约定',
        guide: 'React Hooks/Vue Composition/Node.js 中间件/Svelte runes 等框架特有模式',
      },
    ],
    typicalPatterns: [
      'async/await + try-catch 错误处理',
      'barrel export (index.ts re-export)',
      isTs ? '泛型约束 <T extends Base>、satisfies 编译期验证' : 'JSDoc @param/@returns 类型标注',
      'Optional chaining (?.) + nullish coalescing (??)',
      'Factory function / 闭包替代 class',
      'Event emitter / pub-sub 解耦',
      isTs ? 'Discriminated union 状态建模' : 'Symbol 作为私有 key',
    ],
    commonAntiPatterns: [
      { bad: 'any 类型滥用', why: '丧失类型安全', fix: '定义具体接口或泛型' },
      { bad: '.catch() 空回调', why: '静默吞掉错误', fix: '记录日志或 re-throw' },
      { bad: 'callback hell', why: '嵌套层级过深难以维护', fix: 'async/await 改写' },
      { bad: 'for...in 遍历数组', why: '遍历原型链属性、顺序不保证', fix: 'for...of 或 Array 方法' },
    ],
    suggestedGuardRules: [
      ...(isTs
        ? [{ pattern: ': any', severity: 'warning', message: '避免 any 类型，使用 unknown 或具体类型' }]
        : []),
      { pattern: '\\.catch\\(\\(\\)\\s*=>', severity: 'info', message: 'catch 回调不应为空' },
      { pattern: 'console\\.log', severity: 'info', message: '生产代码移除 console.log' },
      { pattern: 'eval\\(', severity: 'error', message: '禁止使用 eval，存在安全风险' },
    ],
    agentCautions: [
      '使用 ESM (import/export) 而非 CJS (require/module.exports)',
      '异步函数必须处理错误 (try-catch 或 .catch)',
      isTs ? '启用 strict 模式，优先使用 unknown 替代 any' : '使用 JSDoc 或 @ts-check 标注关键函数类型',
      'Node.js 中注意 unhandledRejection 处理',
      '优先使用 structuredClone() 深拷贝，避免 JSON.parse(JSON.stringify())',
    ],
  };
}

/** @type {Readonly<Record<string, object>>} */
const LANG_REGISTRY = Object.freeze({

  // ── Swift ──────────────────────────────────────────────────

  swift: {
    extraDimensions: [
      { id: 'concurrency', label: 'Swift Concurrency', guide: 'async/await、Actor、@Sendable、TaskGroup、MainActor、AsyncStream 用法' },
      { id: 'protocol-oriented', label: '面向协议编程', guide: 'Protocol 扩展、条件一致性、PAT (Protocol with Associated Type)、some/any 关键字' },
      { id: 'property-wrapper', label: 'Property Wrapper', guide: '@Published、@State、@Environment、@Observable (Observation)、自定义 Property Wrapper' },
      { id: 'value-semantics', label: '值语义', guide: 'struct vs class 决策、COW (Copy-on-Write)、Equatable/Hashable、~Copyable (non-copyable types)' },
    ],
    typicalPatterns: [
      'Result<Success, Failure> 统一错误处理',
      'Protocol + Extension 默认实现',
      '@MainActor 标注 UI 相关类',
      'Combine Publisher / AsyncStream 数据流',
      'enum + associated value 状态建模',
      'Codable 自定义 CodingKeys',
      '@Observable 宏 (Observation 框架)',
    ],
    commonAntiPatterns: [
      { bad: '强制 try! / as! 解包', why: '运行时 crash', fix: 'guard let / if let / do-catch' },
      { bad: 'DispatchQueue.main.async 更新 UI', why: 'Swift Concurrency 下造成 data race', fix: '@MainActor' },
      { bad: '闭包中不用 [weak self]', why: '循环引用导致内存泄漏', fix: '[weak self] / [unowned self]' },
      { bad: '大量使用 AnyView 擦除类型', why: 'SwiftUI diff 性能下降', fix: '使用泛型或 @ViewBuilder' },
    ],
    suggestedGuardRules: [
      { pattern: 'try!', severity: 'warning', message: '避免 force try，使用 do-catch' },
      { pattern: 'as!', severity: 'warning', message: '避免 force cast，使用 as?' },
      { pattern: 'DispatchQueue\\.main', severity: 'info', message: '考虑使用 @MainActor 替代' },
      { pattern: 'AnyView', severity: 'info', message: '避免 AnyView，使用泛型或 @ViewBuilder' },
    ],
    agentCautions: [
      '新代码优先使用 Swift Concurrency (async/await) 而非 GCD/DispatchQueue',
      'UI 相关类和方法标注 @MainActor',
      '优先使用 struct（值类型），class 仅在需要引用语义时使用',
      '闭包捕获 self 时必须使用 [weak self] 或 [unowned self]',
      '使用 guard let 提前返回，避免嵌套 if let',
    ],
  },

  // ── Objective-C ────────────────────────────────────────────

  objectivec: {
    extraDimensions: [
      { id: 'memory-management', label: '内存管理', guide: 'ARC 下的 strong/weak/unsafe_unretained、autorelease、dealloc 模式' },
      { id: 'category-extension', label: 'Category/Extension', guide: 'Category 方法命名冲突、Class Extension 私有属性' },
      { id: 'block-pattern', label: 'Block 模式', guide: 'Block 循环引用、__weak/__strong dance、Block 作为回调' },
      { id: 'nullability', label: 'Nullability 标注', guide: 'nullable/nonnull/NS_ASSUME_NONNULL、与 Swift 互操作' },
    ],
    typicalPatterns: [
      'delegate + protocol 回调模式',
      'Category 扩展系统类',
      '__weak typeof(self) weakSelf = self',
      'NS_ASSUME_NONNULL_BEGIN/END 包裹头文件',
      'dispatch_once 单例',
      'KVO 属性观察',
    ],
    commonAntiPatterns: [
      { bad: 'Block 内直接引用 self', why: '循环引用', fix: '__weak + __strong dance' },
      { bad: '头文件缺少 nullability 标注', why: 'Swift 桥接时全部变为 optional', fix: 'NS_ASSUME_NONNULL + 显式 nullable' },
      { bad: 'Category 方法不带前缀', why: '与系统方法/其他库冲突', fix: '加项目前缀如 xx_methodName' },
    ],
    suggestedGuardRules: [
      { pattern: '\\[self\\s', severity: 'warning', message: 'Block 内直接引用 self，考虑 __weak' },
      { pattern: '@property.*assign.*id', severity: 'warning', message: '对象属性使用 strong/weak 替代 assign' },
    ],
    agentCautions: [
      'ObjC 头文件必须包含 NS_ASSUME_NONNULL_BEGIN/END',
      'Category 方法名加项目前缀避免冲突',
      'Block 回调注意 __weak/__strong self dance',
      'dealloc 中移除 KVO 观察者和 NSNotification 订阅',
    ],
  },

  // ── Python ─────────────────────────────────────────────────

  python: {
    extraDimensions: [
      { id: 'type-hints', label: '类型注解', guide: 'typing 模块、Protocol、TypeVar、Generic、dataclass、TypeAlias (3.12+)' },
      { id: 'async-io', label: '异步 IO', guide: 'asyncio、aiohttp、async generators、TaskGroup (3.11+)' },
      { id: 'package-structure', label: '包结构', guide: '__init__.py、相对导入、pyproject.toml、src-layout' },
      { id: 'testing', label: '测试模式', guide: 'pytest fixtures、parametrize、mock/patch、conftest.py 层级' },
    ],
    typicalPatterns: [
      'dataclass / pydantic BaseModel 数据建模',
      'context manager (with statement / @contextmanager)',
      'decorator 横切关注点',
      'typing.Protocol 鸭子类型接口',
      'generator / yield 惰性求值',
      'match-case 结构化模式匹配 (3.10+)',
      'pathlib.Path 替代 os.path 字符串操作',
    ],
    commonAntiPatterns: [
      { bad: 'bare except:', why: '捕获所有异常包括 SystemExit/KeyboardInterrupt', fix: 'except Exception as e:' },
      { bad: '可变默认参数 def f(x=[])', why: '函数间共享可变状态', fix: 'def f(x=None): x = x or []' },
      { bad: 'import *', why: '污染命名空间、难以追踪来源', fix: '显式导入: from mod import name' },
      { bad: '全局可变状态', why: '并发不安全、测试困难', fix: '依赖注入或函数参数传递' },
    ],
    suggestedGuardRules: [
      { pattern: 'except:', severity: 'warning', message: '避免 bare except，至少 except Exception' },
      { pattern: 'import \\*', severity: 'warning', message: '避免 wildcard import，使用显式导入' },
      { pattern: 'os\\.system\\(', severity: 'error', message: '使用 subprocess.run() 替代 os.system()' },
      { pattern: 'eval\\(', severity: 'error', message: '禁止 eval()，存在代码注入风险' },
    ],
    agentCautions: [
      '函数签名使用 type hints (PEP 484+)',
      '使用 dataclass 或 pydantic 建模数据，避免裸 dict',
      '避免 bare except，至少 except Exception',
      '使用 pathlib.Path 处理文件路径',
      '异步代码使用 asyncio.TaskGroup (3.11+) 做结构化并发',
    ],
  },

  // ── Kotlin ─────────────────────────────────────────────────

  kotlin: {
    extraDimensions: [
      { id: 'coroutines', label: '协程', guide: 'suspend、Flow、CoroutineScope、Dispatchers、structured concurrency' },
      { id: 'null-safety', label: '空安全', guide: '?.、!!、let、elvis ?:、requireNotNull、lateinit' },
      { id: 'dsl-builder', label: 'DSL/Builder', guide: 'Kotlin DSL、buildList、apply/run/let/also 作用域函数' },
      { id: 'multiplatform', label: 'Kotlin Multiplatform', guide: 'expect/actual、共享模块、平台特定实现' },
    ],
    typicalPatterns: [
      'sealed class/interface 状态建模',
      'data class 值对象',
      'extension function 扩展已有类',
      'Flow 链式异步流',
      'companion object 工厂方法',
      'when 表达式穷举枚举/sealed class',
      'inline function + reified 泛型',
    ],
    commonAntiPatterns: [
      { bad: '!! 强制非空断言', why: '运行时 NPE', fix: '?.let {} 或 elvis ?: defaultValue' },
      { bad: 'GlobalScope.launch', why: '泄漏协程，无法取消', fix: '使用 viewModelScope/lifecycleScope' },
      { bad: 'var 过度使用', why: '可变状态难以追踪', fix: '优先使用 val（不可变）' },
    ],
    suggestedGuardRules: [
      { pattern: '!!', severity: 'warning', message: '避免 !! 操作符，使用 ?.let 或 elvis ?:' },
      { pattern: 'GlobalScope', severity: 'warning', message: '使用结构化并发 scope 替代 GlobalScope' },
      { pattern: 'lateinit', severity: 'info', message: '确认 lateinit 使用合理，考虑 lazy 替代' },
    ],
    agentCautions: [
      '避免 !! 操作符，使用安全调用 ?.let 或 elvis ?: ',
      '协程使用结构化并发 (viewModelScope/lifecycleScope)',
      '优先 data class + sealed class/interface 建模',
      '利用 when 表达式穷举所有分支',
      '优先使用 val 不可变声明',
    ],
  },

  // ── Java ───────────────────────────────────────────────────

  java: {
    extraDimensions: [
      { id: 'concurrency', label: '并发', guide: 'synchronized、ExecutorService、CompletableFuture、虚拟线程 (21+)、StructuredTaskScope (preview)' },
      { id: 'generics', label: '泛型', guide: '类型擦除、通配符 <? extends/super>、类型安全容器' },
      { id: 'modern-java', label: '现代 Java', guide: 'record (16+)、sealed class (17+)、pattern matching (21+)、text block' },
    ],
    typicalPatterns: [
      'Builder 模式构造复杂对象',
      'Stream API 集合处理',
      'Optional 空值处理',
      'record 类型替代 POJO (Java 16+)',
      '依赖注入 (@Inject/@Autowired)',
      'sealed interface + record 代数数据类型 (Java 17+)',
      'try-with-resources 自动关闭资源',
    ],
    commonAntiPatterns: [
      { bad: '返回 null 表示不存在', why: '调用方容易忘记 null check', fix: 'Optional<T> 或 @Nullable 标注' },
      { bad: 'raw type 泛型', why: '运行时 ClassCastException', fix: '指定具体类型参数' },
      { bad: 'catch (Exception e) {}', why: '静默吞掉异常', fix: '至少记录日志或 rethrow' },
      { bad: 'new Thread().start()', why: '无法管理线程生命周期', fix: 'ExecutorService 或虚拟线程' },
    ],
    suggestedGuardRules: [
      { pattern: 'catch\\s*\\(\\s*Exception', severity: 'info', message: '避免宽泛的 Exception catch，使用具体异常类型' },
      { pattern: '\\.printStackTrace\\(\\)', severity: 'warning', message: '使用日志框架替代 printStackTrace' },
      { pattern: 'new Thread\\(', severity: 'info', message: '考虑使用 ExecutorService 或虚拟线程' },
    ],
    agentCautions: [
      '优先使用 Optional 处理可空返回值',
      '使用 Stream API 替代手动循环',
      '并发使用 ExecutorService 或虚拟线程 (21+) 而非 raw Thread',
      '使用 try-with-resources 管理 AutoCloseable 资源',
      '数据载体优先使用 record (16+) 替代手写 POJO',
    ],
  },

  // ── Go ─────────────────────────────────────────────────────

  go: {
    extraDimensions: [
      { id: 'goroutine', label: 'Goroutine/Channel', guide: '并发模式、channel、select、context 传播、errgroup' },
      { id: 'error-handling', label: '错误处理', guide: 'error interface、errors.Is/As、sentinel errors、%w wrap、多错误 errors.Join (1.20+)' },
      { id: 'interface', label: '接口设计', guide: '隐式实现、小接口、io.Reader/Writer 组合、Accept interfaces return structs' },
    ],
    typicalPatterns: [
      'if err != nil { return err }',
      'context.Context 贯穿调用链',
      'functional options 模式',
      'table-driven tests',
      'interface 在消费侧定义',
      'defer 确保资源清理',
      'embed 嵌入结构体组合复用',
    ],
    commonAntiPatterns: [
      { bad: '忽略 error 返回值 _', why: '静默丢失错误信息', fix: '检查并传播 error' },
      { bad: 'goroutine 无退出控制', why: '泄漏 goroutine', fix: 'context.WithCancel / done channel' },
      { bad: 'init() 函数过度使用', why: '隐式副作用、测试困难', fix: '显式初始化函数 + 依赖注入' },
      { bad: 'sync.Mutex 包级变量', why: '全局可变状态', fix: '封装到 struct 内' },
    ],
    suggestedGuardRules: [
      { pattern: 'panic\\(', severity: 'warning', message: '仅在不可恢复错误时使用 panic，正常错误返回 error' },
      { pattern: 'log\\.Fatal', severity: 'info', message: 'log.Fatal 会调用 os.Exit，确认场景合理' },
      { pattern: 'go func\\(', severity: 'info', message: '确保 goroutine 有退出路径（context/done channel）' },
    ],
    agentCautions: [
      '函数必须检查并传播 error，不要忽略 _',
      '使用 context.Context 作为第一个参数',
      'goroutine 确保有退出路径，使用 errgroup 管理并发',
      'defer 放在资源获取之后立即声明',
      '接口在消费方定义，保持小而精',
    ],
  },

  // ── Rust ───────────────────────────────────────────────────

  rust: {
    extraDimensions: [
      { id: 'ownership', label: '所有权/借用', guide: 'ownership、borrowing、lifetime、Clone vs Copy、interior mutability (RefCell/Mutex)' },
      { id: 'error-handling', label: '错误处理', guide: 'Result<T,E>、? 操作符、thiserror/anyhow、自定义 Error enum' },
      { id: 'trait-system', label: 'Trait 系统', guide: 'trait bound、impl Trait、dyn Trait、derive 宏、blanket impl' },
      { id: 'async-runtime', label: '异步运行时', guide: 'tokio/async-std、Future、Pin、async trait、select!' },
    ],
    typicalPatterns: [
      'Result<T, E> + ? 操作符链式传播',
      'enum 代数数据类型 + pattern matching',
      'impl Trait 返回类型 / dyn Trait 动态分发',
      'Builder 模式 (consuming self)',
      '#[derive(Debug, Clone, ...)] 自动实现',
      'From/Into trait 类型转换',
      'Iterator 链式组合子',
    ],
    commonAntiPatterns: [
      { bad: '.unwrap() / .expect() 泛滥', why: '生产环境 panic', fix: '? 操作符或 match' },
      { bad: '.clone() 逃避借用检查', why: '隐藏性能问题', fix: '重新设计所有权或使用引用' },
      { bad: 'Arc<Mutex<T>> 过度使用', why: '运行时锁开销', fix: '优先考虑消息传递 (channel) 或更细粒度设计' },
    ],
    suggestedGuardRules: [
      { pattern: '\\.unwrap\\(\\)', severity: 'warning', message: '避免 unwrap()，使用 ? 或 expect("reason")' },
      { pattern: 'unsafe\\s*\\{', severity: 'warning', message: '审查 unsafe 代码块，确保 safety invariant 有文档' },
      { pattern: 'todo!\\(\\)|unimplemented!\\(\\)', severity: 'info', message: '确认 todo!/unimplemented! 不会进入生产环境' },
    ],
    agentCautions: [
      '优先使用借用 (&T / &mut T) 而非 clone',
      '错误类型使用 thiserror 定义，应用层使用 anyhow',
      '避免 unwrap()，使用 ? 或 expect("有意义的说明")',
      'unsafe 代码块必须写 // SAFETY: 注释说明 invariant',
      '优先使用 Iterator 组合子替代手动循环',
    ],
  },

  // ── C ──────────────────────────────────────────────────────

  c: {
    extraDimensions: [
      { id: 'memory-safety', label: '内存安全', guide: 'malloc/free 配对、指针生命周期、缓冲区溢出防范、AddressSanitizer' },
      { id: 'preprocessor', label: '预处理器', guide: '#define 宏、条件编译、include guard / #pragma once、X-Macro 模式' },
      { id: 'api-design', label: 'API 设计', guide: 'opaque pointer(PIMPL)、const 正确性、错误码约定、头文件组织' },
    ],
    typicalPatterns: [
      'struct + 函数指针模拟 OOP',
      'typedef 定义公共 API 类型',
      'const 修饰只读参数',
      '错误码 + goto cleanup 资源释放',
      'include guard (#ifndef ... #define ... #endif)',
      'opaque pointer 隐藏实现细节',
    ],
    commonAntiPatterns: [
      { bad: 'malloc 后不检查 NULL', why: 'OOM 时解引用空指针 → crash', fix: 'if (!ptr) { handle_error(); }' },
      { bad: '缓冲区无边界检查', why: '缓冲区溢出 → 安全漏洞', fix: '使用 snprintf/strncat + 显式长度参数' },
      { bad: 'malloc/free 未配对', why: '内存泄漏或 double free', fix: '集中管理资源生命周期、使用 goto cleanup 模式' },
      { bad: '函数式宏无括号包裹参数', why: '宏展开时运算优先级错误', fix: '#define MAX(a,b) ((a) > (b) ? (a) : (b))' },
    ],
    suggestedGuardRules: [
      { pattern: 'gets\\(', severity: 'error', message: '禁止使用 gets()，已被移除（CVE 风险），使用 fgets()' },
      { pattern: 'sprintf\\(', severity: 'warning', message: '使用 snprintf() 替代 sprintf()，防止缓冲区溢出' },
      { pattern: 'strcpy\\(', severity: 'warning', message: '使用 strncpy()/strlcpy() 替代 strcpy()' },
      { pattern: 'atoi\\(', severity: 'info', message: '使用 strtol() 替代 atoi()，可检测解析错误' },
    ],
    agentCautions: [
      'malloc/calloc 后必须检查返回值是否为 NULL',
      '使用 snprintf/strncat 等带长度参数的安全函数',
      '每个 malloc 必须有对应 free，推荐 goto cleanup 模式',
      '头文件使用 include guard 或 #pragma once',
      '函数参数中只读指针用 const 修饰',
    ],
  },

  // ── C++ ────────────────────────────────────────────────────

  cpp: {
    extraDimensions: [
      { id: 'raii', label: 'RAII / 智能指针', guide: 'unique_ptr、shared_ptr、weak_ptr、自定义 deleter、make_unique/make_shared' },
      { id: 'templates', label: '模板 / Concepts', guide: '函数模板、类模板、SFINAE、Concepts (C++20)、requires 表达式' },
      { id: 'move-semantics', label: '移动语义', guide: '右值引用 (&&)、std::move、完美转发 (std::forward)、Rule of 0/3/5' },
      { id: 'modern-cpp', label: '现代 C++ 特性', guide: 'constexpr、std::optional、std::variant、structured bindings、ranges (C++20)' },
    ],
    typicalPatterns: [
      'RAII 管理资源 (unique_ptr/shared_ptr)',
      'range-based for 遍历容器',
      'constexpr 编译期求值',
      'override + final 虚函数覆盖',
      'std::optional 替代 nullable pointer',
      'std::variant + std::visit 类型安全联合',
      'auto + structured bindings 简化声明',
    ],
    commonAntiPatterns: [
      { bad: 'new/delete 手动管理内存', why: '容易泄漏，异常不安全', fix: 'std::make_unique / std::make_shared' },
      { bad: 'catch(...) 吃掉所有异常', why: '隐藏真实错误', fix: '捕获具体异常类型并处理' },
      { bad: '对象切片 (slicing)', why: '派生类信息丢失', fix: '使用指针/引用传递多态对象' },
      { bad: '#define 常量/函数', why: '无类型检查、调试困难', fix: 'constexpr 变量 / inline 函数 / 模板' },
    ],
    suggestedGuardRules: [
      { pattern: '\\bnew\\b(?!.*unique_ptr|.*shared_ptr)', severity: 'warning', message: '优先使用 make_unique/make_shared 替代 raw new' },
      { pattern: '\\bdelete\\b', severity: 'warning', message: '避免手动 delete，使用智能指针' },
      { pattern: 'using namespace std', severity: 'info', message: '避免在头文件中使用 using namespace' },
      { pattern: 'reinterpret_cast', severity: 'warning', message: '审查 reinterpret_cast 使用是否合理' },
    ],
    agentCautions: [
      '使用智能指针 (unique_ptr/shared_ptr) 而非 raw new/delete',
      '虚函数覆盖必须加 override 关键字',
      '优先使用 constexpr 替代 #define 宏常量',
      '遵循 Rule of Zero — 除非必要，不自定义析构/拷贝/移动',
      '头文件使用前置声明减少编译依赖',
    ],
  },

  // ── Ruby ───────────────────────────────────────────────────

  ruby: {
    extraDimensions: [
      { id: 'metaprogramming', label: '元编程', guide: 'define_method、method_missing、class_eval、open class、DSL 构建' },
      { id: 'block-proc-lambda', label: 'Block/Proc/Lambda', guide: 'yield、block_given?、Proc.new vs lambda、& 转换' },
      { id: 'convention-over-config', label: '约定优于配置', guide: 'Rails 约定 (命名/目录结构)、ActiveRecord 模式、concern 复用' },
    ],
    typicalPatterns: [
      'block + yield 迭代器模式',
      'module include/prepend 混入',
      'attr_accessor/attr_reader 声明式属性',
      'Symbol 作为 Hash key',
      'Enumerable 方法链 (map/select/reduce)',
      'begin-rescue-ensure 异常处理',
      'frozen_string_literal 优化字符串',
    ],
    commonAntiPatterns: [
      { bad: 'method_missing 无 respond_to_missing?', why: '反射 API 行为不一致', fix: '同时定义 respond_to_missing?' },
      { bad: 'Monkey-patch 核心类', why: '全局影响、版本升级冲突', fix: 'Refinements 或委托模式' },
      { bad: 'N+1 查询 (ActiveRecord)', why: '数据库性能严重退化', fix: 'includes/preload 预加载关联' },
    ],
    suggestedGuardRules: [
      { pattern: 'eval\\(', severity: 'error', message: '避免 eval，存在代码注入风险，使用 send/public_send' },
      { pattern: 'method_missing', severity: 'info', message: '确认配套定义了 respond_to_missing?' },
      { pattern: '\\.find_each|\\.all\\.each', severity: 'info', message: '大数据集使用 find_each / in_batches 分批处理' },
    ],
    agentCautions: [
      '在文件头添加 # frozen_string_literal: true',
      '元编程 (method_missing) 必须配套 respond_to_missing?',
      'ActiveRecord 使用 includes/preload 避免 N+1',
      '优先使用 module + include 组合，慎用 monkey-patching',
      '异常处理使用 begin-rescue-ensure，不要 rescue Exception',
    ],
  },

  // ── Dart ───────────────────────────────────────────────────

  dart: {
    extraDimensions: [
      { id: 'null-safety', label: '空安全', guide: '?、!、late、required、null-aware operators (?., ??, ??=)' },
      { id: 'widget-composition', label: 'Widget 组合 (Flutter)', guide: 'StatelessWidget/StatefulWidget、Widget 拆分、const 构造器、InheritedWidget' },
      { id: 'async-patterns', label: '异步模式', guide: 'Future、Stream、async*/yield*、Isolate 并行计算' },
      { id: 'state-management', label: '状态管理', guide: 'Provider/Riverpod/Bloc/GetX、单向数据流、响应式编程' },
    ],
    typicalPatterns: [
      'const 构造器优化 Widget rebuild',
      'StatelessWidget 优先、StatefulWidget 按需',
      'extension methods 扩展已有类型',
      'freezed + json_serializable 生成不可变模型',
      'named parameters + required 提升可读性',
      'Stream.listen / StreamBuilder 响应式 UI',
      'sealed class (Dart 3) 穷举模式匹配',
    ],
    commonAntiPatterns: [
      { bad: '在 build() 中调用 setState 或异步操作', why: '无限重建循环', fix: '在 initState/事件回调中处理' },
      { bad: '单个 Widget 过大 (>200 行)', why: '难以维护和复用', fix: '拆分为小 Widget + const 子树' },
      { bad: '滥用 late 关键字', why: '运行时 LateInitializationError', fix: '使用 nullable (?) 或在声明处初始化' },
      { bad: 'setState 管理全局状态', why: '状态散落、难以追踪', fix: '使用 Provider/Riverpod 等状态管理方案' },
    ],
    suggestedGuardRules: [
      { pattern: 'print\\(', severity: 'info', message: '生产代码使用 logger 替代 print()' },
      { pattern: '!\\s*\\.', severity: 'info', message: '审查 ! (force-unwrap) 使用，考虑 ?. 安全访问' },
      { pattern: 'dynamic', severity: 'warning', message: '避免 dynamic 类型，使用具体类型或泛型' },
    ],
    agentCautions: [
      '优先使用 const 构造器优化 Widget 树性能',
      '每个 Widget 保持单一职责，超过 100 行应考虑拆分',
      '使用 sealed class (Dart 3+) 进行穷举模式匹配',
      '异步操作使用 Future/Stream，计算密集型使用 Isolate',
      '优先用 final 声明局部变量和类属性',
    ],
  },

  // ── C# ─────────────────────────────────────────────────────

  csharp: {
    extraDimensions: [
      { id: 'async-await', label: 'async/await', guide: 'Task、ValueTask、IAsyncEnumerable、ConfigureAwait、CancellationToken' },
      { id: 'linq', label: 'LINQ', guide: '查询表达式、方法链、延迟执行、IQueryable vs IEnumerable' },
      { id: 'pattern-matching', label: '模式匹配', guide: 'switch expression、is pattern、property pattern、list pattern (C# 11)' },
      { id: 'dependency-injection', label: '依赖注入', guide: 'IServiceCollection、Scoped/Transient/Singleton、IOptions<T>、Hosted Services' },
    ],
    typicalPatterns: [
      'async Task 方法 + CancellationToken',
      'LINQ 方法链处理集合',
      'record 类型 (C# 9+) 不可变数据',
      'nullable reference types (#nullable enable)',
      '依赖注入 (IServiceCollection / constructor injection)',
      'switch expression 替代 if-else 链',
      'using declaration 自动释放资源',
    ],
    commonAntiPatterns: [
      { bad: 'async void 方法', why: '异常无法捕获、调用方无法 await', fix: '返回 async Task' },
      { bad: '.Result / .Wait() 阻塞', why: '线程池饥饿 / UI 线程死锁', fix: 'await 全程异步' },
      { bad: 'IDisposable 未 Dispose', why: '资源泄漏 (连接/句柄)', fix: 'using statement/declaration' },
      { bad: 'catch (Exception) { } 空处理', why: '静默吞掉错误', fix: '记录日志或 rethrow (throw;)' },
    ],
    suggestedGuardRules: [
      { pattern: 'async void', severity: 'warning', message: '避免 async void，使用 async Task' },
      { pattern: '\\.Result\\b|\\.Wait\\(', severity: 'warning', message: '避免同步阻塞异步方法，使用 await' },
      { pattern: 'catch\\s*\\(Exception', severity: 'info', message: '避免宽泛 catch Exception，捕获具体异常类型' },
    ],
    agentCautions: [
      'async 方法返回 Task/ValueTask，不要 async void',
      '异步代码全程 await，避免 .Result/.Wait() 死锁',
      'IDisposable 资源使用 using statement 确保释放',
      '启用 nullable reference types (#nullable enable)',
      '使用 record (C# 9+) 构建不可变数据传输对象',
    ],
  },

});

// ═══════════════════════════════════════════════════════════
// buildLanguageExtension — 公共 API
// ═══════════════════════════════════════════════════════════

/**
 * 根据主语言构建语言扩展字段
 * 包含：语言特有的分析关注点、典型模式、反模式、Guard 规则、Agent 注意事项
 *
 * @param {string} lang — 规范化语言 ID (如 'swift', 'typescript')
 * @returns {{ language: string, customFields: object, extraDimensions: object[], typicalPatterns: string[], commonAntiPatterns: object[], suggestedGuardRules: object[], agentCautions: string[] }}
 */
export function buildLanguageExtension(lang) {
  const base = {
    language: lang,
    customFields: {},
    extraDimensions: [],
    typicalPatterns: [],
    commonAntiPatterns: [],
    suggestedGuardRules: [],
    agentCautions: [],
  };

  // JS/TS 动态生成（有 lang-specific 差异点）
  if (lang === 'javascript' || lang === 'typescript') {
    const entry = _buildJsTsEntry(lang);
    return Object.assign(base, entry);
  }

  // 其他语言从注册表查找
  const entry = LANG_REGISTRY[lang];
  if (entry) {
    return Object.assign(base, entry);
  }

  return base;
}
