/**
 * LanguageExtensions — 语言检测与语言特有扩展字段构建
 *
 * 从 bootstrap.js 拆分而来，负责：
 *   - 文件扩展名 → 语言映射
 *   - langStats 聚合 → 主语言推断
 *   - 主语言 → 语言扩展字段（分析维度、典型模式、反模式、Guard 规则等）
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

/**
 * 根据主语言构建语言扩展字段
 * 包含：语言特有的分析关注点、典型模式、特有 knowledgeType 提示、保留字段（供未来拓展）
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

  switch (lang) {
    case 'swift':
      base.extraDimensions = [
        {
          id: 'concurrency',
          label: 'Swift Concurrency',
          guide: 'async/await、Actor、@Sendable、TaskGroup、MainActor 用法',
        },
        {
          id: 'protocol-oriented',
          label: '面向协议编程',
          guide: 'Protocol 扩展、条件一致性、PAT (Protocol with Associated Type)',
        },
        {
          id: 'property-wrapper',
          label: 'Property Wrapper',
          guide: '@Published、@State、@Environment、自定义 Property Wrapper',
        },
        {
          id: 'value-semantics',
          label: '值语义',
          guide: 'struct vs class 决策、COW (Copy-on-Write)、Equatable/Hashable',
        },
      ];
      base.typicalPatterns = [
        'Result<Success, Failure> 统一错误处理',
        'Protocol + Extension 默认实现',
        '@MainActor 标注 UI 相关类',
        'Combine Publisher 链式数据流',
        'enum + associated value 状态建模',
        'Codable 自定义 CodingKeys',
      ];
      base.commonAntiPatterns = [
        { bad: '强制 try! / as! 解包', why: '运行时 crash', fix: 'guard let / if let / do-catch' },
        {
          bad: 'DispatchQueue.main.async 更新 UI',
          why: 'Swift Concurrency 下造成 data race',
          fix: '@MainActor',
        },
        {
          bad: '闭包中不用 [weak self]',
          why: '循环引用导致内存泄漏',
          fix: '[weak self] / [unowned self]',
        },
      ];
      base.suggestedGuardRules = [
        { pattern: 'try!', severity: 'warning', message: '避免 force try，使用 do-catch' },
        { pattern: 'as!', severity: 'warning', message: '避免 force cast，使用 as?' },
        { pattern: 'DispatchQueue\\.main', severity: 'info', message: '考虑使用 @MainActor 替代' },
      ];
      base.agentCautions = [
        '新代码优先使用 Swift Concurrency (async/await) 而非 GCD/DispatchQueue',
        'UI 相关类和方法标注 @MainActor',
        '优先使用 struct（值类型），class 仅在需要引用语义时使用',
        '闭包捕获 self 时必须使用 [weak self] 或 [unowned self]',
        '使用 guard let 提前返回，避免嵌套 if let',
      ];
      break;

    case 'objectivec':
      base.extraDimensions = [
        {
          id: 'memory-management',
          label: '内存管理',
          guide: 'ARC 下的 strong/weak/unsafe_unretained、autorelease、dealloc 模式',
        },
        {
          id: 'category-extension',
          label: 'Category/Extension',
          guide: 'Category 方法命名冲突、Class Extension 私有属性',
        },
        {
          id: 'block-pattern',
          label: 'Block 模式',
          guide: 'Block 循环引用、__weak/__strong dance、Block 作为回调',
        },
        {
          id: 'nullability',
          label: 'Nullability 标注',
          guide: 'nullable/nonnull/NS_ASSUME_NONNULL、与 Swift 互操作',
        },
      ];
      base.typicalPatterns = [
        'delegate + protocol 回调模式',
        'Category 扩展系统类',
        '__weak typeof(self) weakSelf = self',
        'NS_ASSUME_NONNULL_BEGIN/END 包裹头文件',
        'dispatch_once 单例',
        'KVO 属性观察',
      ];
      base.commonAntiPatterns = [
        { bad: 'Block 内直接引用 self', why: '循环引用', fix: '__weak + __strong dance' },
        {
          bad: '头文件缺少 nullability 标注',
          why: 'Swift 桥接时全部变为 optional',
          fix: 'NS_ASSUME_NONNULL + 显式 nullable',
        },
        {
          bad: 'Category 方法不带前缀',
          why: '与系统方法/其他库冲突',
          fix: '加项目前缀如 xx_methodName',
        },
      ];
      base.suggestedGuardRules = [
        {
          pattern: '\\[self\\s',
          severity: 'warning',
          message: 'Block 内直接引用 self，考虑 __weak',
        },
      ];
      base.agentCautions = [
        'ObjC 头文件必须包含 NS_ASSUME_NONNULL_BEGIN/END',
        'Category 方法名加项目前缀避免冲突',
        'Block 回调注意 __weak/__strong self dance',
        'dealloc 中移除 KVO 观察者和 NSNotification 订阅',
      ];
      break;

    case 'typescript':
    case 'javascript':
      base.extraDimensions = [
        {
          id: 'module-system',
          label: '模块系统',
          guide: 'ESM vs CJS、dynamic import、barrel export、tree-shaking',
        },
        {
          id: 'type-safety',
          label: '类型安全',
          guide:
            lang === 'typescript'
              ? 'strict 模式、泛型、类型守卫、Utility Types'
              : 'JSDoc 类型标注、.d.ts 声明',
        },
        {
          id: 'async-pattern',
          label: '异步模式',
          guide: 'Promise 链、async/await、Error 处理、AbortController',
        },
        {
          id: 'framework-convention',
          label: '框架约定',
          guide: 'React Hooks/Vue Composition/Node.js 中间件等框架特有模式',
        },
      ];
      base.typicalPatterns = [
        'async/await + try-catch 错误处理',
        'barrel export (index.ts re-export)',
        lang === 'typescript' ? '泛型约束 <T extends Base>' : 'JSDoc @param/@returns 类型标注',
        'Optional chaining (?.) + nullish coalescing (??)',
        'Factory function 替代 class',
        'Event emitter / pub-sub 解耦',
      ];
      base.commonAntiPatterns = [
        { bad: 'any 类型滥用', why: '丧失类型安全', fix: '定义具体接口或泛型' },
        { bad: '.catch() 空回调', why: '静默吞掉错误', fix: '记录日志或抛出' },
        { bad: 'callback hell', why: '嵌套层级过深难以维护', fix: 'async/await 改写' },
      ];
      base.suggestedGuardRules = [
        { pattern: ': any', severity: 'warning', message: '避免 any 类型，使用具体类型' },
        { pattern: '\\.catch\\(\\(\\)\\s*=>', severity: 'info', message: 'catch 回调不应为空' },
      ];
      base.agentCautions = [
        '使用 ESM（import/export）而非 CJS（require/module.exports）',
        '异步函数必须处理错误（try-catch 或 .catch）',
        lang === 'typescript' ? '启用 strict 模式，避免 any' : '使用 JSDoc 标注关键函数类型',
        'Node.js 中注意 unhandledRejection 处理',
      ];
      break;

    case 'python':
      base.extraDimensions = [
        {
          id: 'type-hints',
          label: '类型注解',
          guide: 'typing 模块、Protocol、TypeVar、Generic、dataclass',
        },
        { id: 'async-io', label: '异步 IO', guide: 'asyncio、aiohttp、async generators' },
        {
          id: 'package-structure',
          label: '包结构',
          guide: '__init__.py、相对导入、pyproject.toml',
        },
      ];
      base.typicalPatterns = [
        'dataclass 数据建模',
        'context manager (with statement)',
        'decorator 横切关注点',
        'typing.Protocol 鸭子类型接口',
        'generator / yield 惰性求值',
      ];
      base.commonAntiPatterns = [
        { bad: 'bare except:', why: '捕获所有异常包括 SystemExit', fix: 'except Exception as e:' },
        { bad: '可变默认参数 def f(x=[])', why: '共享可变状态', fix: 'def f(x=None): x = x or []' },
      ];
      base.agentCautions = [
        '函数签名使用 type hints',
        '使用 dataclass 或 pydantic 建模数据',
        '避免 bare except，至少 except Exception',
      ];
      break;

    case 'kotlin':
      base.extraDimensions = [
        { id: 'coroutines', label: '协程', guide: 'suspend、Flow、CoroutineScope、Dispatchers' },
        { id: 'null-safety', label: '空安全', guide: '?.、!!、let、elvis ?: 操作符' },
        { id: 'dsl-builder', label: 'DSL/Builder', guide: 'Kotlin DSL、buildList、apply/run/let' },
      ];
      base.typicalPatterns = [
        'sealed class 状态建模',
        'data class 值对象',
        'extension function',
        'Flow 链式异步流',
        'companion object 工厂方法',
      ];
      base.commonAntiPatterns = [
        { bad: '!! 强制非空断言', why: '运行时 NPE', fix: '?.let {} 或 elvis ?:' },
        { bad: 'GlobalScope.launch', why: '泄漏协程', fix: '使用 viewModelScope/lifecycleScope' },
      ];
      base.agentCautions = [
        '避免 !! 操作符，使用安全调用 ?.let',
        '协程使用结构化并发（viewModelScope/lifecycleScope）',
        '优先 data class + sealed class 建模',
      ];
      break;

    case 'java':
      base.extraDimensions = [
        {
          id: 'concurrency',
          label: '并发',
          guide: 'synchronized、ExecutorService、CompletableFuture、虚拟线程 (21+)',
        },
        {
          id: 'generics',
          label: '泛型',
          guide: '类型擦除、通配符 <? extends/super>、类型安全容器',
        },
      ];
      base.typicalPatterns = [
        'Builder 模式',
        'Stream API 集合处理',
        'Optional 空值处理',
        'record 类型 (Java 16+)',
        '依赖注入 (@Inject/@Autowired)',
      ];
      base.agentCautions = [
        '优先使用 Optional 处理可空返回值',
        '使用 Stream API 替代手动循环',
        '并发使用 ExecutorService 而非 raw Thread',
      ];
      break;

    case 'go':
      base.extraDimensions = [
        {
          id: 'goroutine',
          label: 'Goroutine/Channel',
          guide: '并发模式、channel、select、context 传播',
        },
        {
          id: 'error-handling',
          label: '错误处理',
          guide: 'error interface、errors.Is/As、sentinel errors、%w wrap',
        },
        { id: 'interface', label: '接口设计', guide: '隐式实现、小接口、io.Reader/Writer 组合' },
      ];
      base.typicalPatterns = [
        'if err != nil { return err }',
        'context.Context 贯穿调用链',
        'functional options 模式',
        'table-driven tests',
        'interface 在消费侧定义',
      ];
      base.agentCautions = [
        '函数必须检查并传播 error',
        '使用 context.Context 作为第一个参数',
        'goroutine 确保有退出路径，避免泄漏',
      ];
      break;

    case 'rust':
      base.extraDimensions = [
        {
          id: 'ownership',
          label: '所有权/借用',
          guide: 'ownership、borrowing、lifetime、Clone vs Copy',
        },
        {
          id: 'error-handling',
          label: '错误处理',
          guide: 'Result<T,E>、? 操作符、thiserror/anyhow',
        },
        {
          id: 'trait-system',
          label: 'Trait 系统',
          guide: 'trait bound、impl Trait、dyn Trait、derive 宏',
        },
      ];
      base.typicalPatterns = [
        'Result<T, E> + ? 操作符',
        'enum 代数数据类型',
        'impl Trait 返回类型',
        'Builder 模式 (owned self)',
        '#[derive(...)] 自动实现',
      ];
      base.agentCautions = [
        '优先使用借用 (&T) 而非克隆',
        '错误类型使用 thiserror 定义',
        '避免 unwrap()，使用 ? 或 expect()',
      ];
      break;

    default:
      break;
  }

  return base;
}
