/**
 * DimensionRegistry — 统一维度注册表 (Single Source of Truth)
 *
 * 25 个维度定义:
 *   Layer 1 (Universal): D1-D13 — 所有项目适用
 *   Layer 2 (Language):  DL1-DL7 — 按项目语言激活
 *   Layer 3 (Framework): DF1-DF5 — 按检测到的框架激活
 *
 * 这是整个系统中维度定义的唯一来源。
 * Bootstrap / Panorama / Rescan / Dashboard 均从此模块消费维度元数据。
 *
 * @module domain/dimension/DimensionRegistry
 */

import type { DimensionId, UnifiedDimension } from './UnifiedDimension.js';

// ═══════════════════════════════════════════════════════════
// Layer 1: Universal Dimensions (13)
// ═══════════════════════════════════════════════════════════

const D1_ARCHITECTURE: UnifiedDimension = {
  id: 'architecture',
  label: '架构与设计',
  layer: 'universal',
  icon: 'Workflow',
  colorFamily: 'sky',
  extractionGuide: '分层架构、模块职责与边界、依赖方向约束、入口点、目标枚举、启动流程、路由表',
  allowedKnowledgeTypes: ['architecture', 'module-dependency', 'boundary-constraint'],
  outputMode: 'candidate-only',
  qualityDescription: '模块边界清晰度、依赖方向合规性、层次分离完整性',
  matchTopics: ['architecture', 'scaffold', 'module-boundary', 'dependency-rule', 'layer-strategy'],
  matchCategories: ['architecture', 'project-profile'],
  weight: 1.0,
  suggestedTopics: ['module-boundary', 'dependency-rule', 'layer-strategy'],
  relatedRoles: ['core', 'foundation', 'app'],
  tierHint: 1,
  displayGroup: 'architecture',
};

const D2_CODING_STANDARDS: UnifiedDimension = {
  id: 'coding-standards',
  label: '代码规范',
  layer: 'universal',
  icon: 'BookOpen',
  colorFamily: 'violet',
  extractionGuide:
    '命名约定（类名/方法/变量/常量）、注释风格、文件组织、import 排序、访问控制约定、MARK 分段',
  allowedKnowledgeTypes: ['code-standard', 'code-style'],
  outputMode: 'candidate-only',
  qualityDescription: '命名一致性、文档注释覆盖率、文件组织标准化程度',
  matchTopics: ['conventions', 'naming-convention', 'code-style', 'documentation'],
  matchCategories: ['code-standard', 'code-style'],
  weight: 0.8,
  suggestedTopics: ['naming-convention', 'code-style', 'documentation'],
  relatedRoles: [],
  tierHint: 2,
  displayGroup: 'best-practice',
};

const D3_DESIGN_PATTERNS: UnifiedDimension = {
  id: 'design-patterns',
  label: '设计模式',
  layer: 'universal',
  icon: 'GitBranch',
  colorFamily: 'fuchsia',
  extractionGuide:
    '单例/委托/工厂/Builder/观察者/Coordinator/Repository/DI 容器等模式、继承层级、基类设计',
  allowedKnowledgeTypes: ['code-pattern', 'code-relation', 'inheritance'],
  outputMode: 'candidate-only',
  qualityDescription: '模式使用一致性、反模式检测、基类复用程度',
  matchTopics: ['design-pattern', 'code-pattern', 'inheritance', 'base-class'],
  matchCategories: ['code-pattern', 'code-relation'],
  weight: 0.8,
  suggestedTopics: ['design-pattern', 'code-pattern', 'inheritance'],
  relatedRoles: [],
  tierHint: 2,
  displayGroup: 'architecture',
};

const D4_ERROR_RESILIENCE: UnifiedDimension = {
  id: 'error-resilience',
  label: '错误与健壮性',
  layer: 'universal',
  icon: 'Shield',
  colorFamily: 'emerald',
  extractionGuide:
    '异常/错误类型定义、错误传播策略、用户可见错误展示、重试/回退/熔断模式、防御性编程、输入验证',
  allowedKnowledgeTypes: ['best-practice'],
  outputMode: 'candidate-only',
  qualityDescription: '错误类型覆盖率、错误恢复完整性、用户错误体验',
  matchTopics: ['error-handling', 'constraints', 'validation', 'error-recovery'],
  matchCategories: ['best-practice'],
  weight: 1.0,
  suggestedTopics: ['exception-pattern', 'error-recovery', 'input-validation'],
  relatedRoles: ['service', 'networking', 'core'],
  tierHint: 3,
  displayGroup: 'best-practice',
};

const D5_CONCURRENCY_ASYNC: UnifiedDimension = {
  id: 'concurrency-async',
  label: '并发与异步',
  layer: 'universal',
  icon: 'Repeat',
  colorFamily: 'orange',
  extractionGuide:
    '线程安全模式（锁/Actor/隔离）、异步编程模型（async-await/RxSwift/Combine/Promise）、竞态条件防护、内存安全（弱引用/捕获列表）',
  allowedKnowledgeTypes: ['best-practice'],
  outputMode: 'candidate-only',
  qualityDescription: '线程安全覆盖率、异步模式一致性、数据竞争风险',
  matchTopics: ['concurrency', 'async', 'thread-safety', 'race-condition', 'memory-safety'],
  matchCategories: [],
  weight: 0.9,
  suggestedTopics: ['thread-safety', 'async-pattern', 'race-condition'],
  relatedRoles: ['service', 'networking', 'storage'],
  tierHint: 3,
  displayGroup: 'data-event-flow',
};

const D6_DATA_EVENT_FLOW: UnifiedDimension = {
  id: 'data-event-flow',
  label: '事件与数据流',
  layer: 'universal',
  icon: 'Cog',
  colorFamily: 'amber',
  extractionGuide:
    '持久化模式（CoreData/UserDefaults/SQLite/Keychain）、缓存策略、序列化约定、事件传播（Delegate/Notification/Closure/RxSwift）、状态管理、数据一致性',
  allowedKnowledgeTypes: ['call-chain', 'data-flow', 'event-and-data-flow'],
  outputMode: 'candidate-only',
  qualityDescription: '数据流完整性、持久化安全性、事件耦合度',
  matchTopics: [
    'data',
    'data-flow',
    'memory',
    'persistence',
    'caching',
    'event',
    'state-management',
  ],
  matchCategories: ['event-and-data-flow', 'data-management'],
  weight: 0.8,
  suggestedTopics: ['persistence', 'caching', 'serialization', 'data-integrity'],
  relatedRoles: ['storage', 'model'],
  tierHint: 3,
  displayGroup: 'data-event-flow',
};

const D7_NETWORKING_API: UnifiedDimension = {
  id: 'networking-api',
  label: '网络与 API',
  layer: 'universal',
  icon: 'Wifi',
  colorFamily: 'blue',
  extractionGuide:
    'API 请求封装模式、响应模型定义、错误码映射、重试/超时策略、实时通信（WebSocket/SSE）、认证流程、CDN 策略',
  allowedKnowledgeTypes: ['best-practice', 'code-pattern'],
  outputMode: 'candidate-only',
  qualityDescription: 'API 抽象一致性、网络错误处理完整性、安全传输',
  matchTopics: ['networking', 'real-time', 'api-contract', 'retry-strategy', 'request-pattern'],
  matchCategories: ['Network'],
  weight: 0.7,
  suggestedTopics: ['api-contract', 'retry-strategy', 'request-pattern'],
  relatedRoles: ['networking'],
  tierHint: 2,
  displayGroup: 'data-event-flow',
};

const D8_UI_INTERACTION: UnifiedDimension = {
  id: 'ui-interaction',
  label: '界面与交互',
  layer: 'universal',
  icon: 'Layout',
  colorFamily: 'pink',
  extractionGuide:
    'UI 组件基类、布局约束模式、生命周期管理、导航/路由、数据绑定（MVVM/MVI/Redux）、列表分页、动画转场',
  allowedKnowledgeTypes: ['code-pattern', 'best-practice'],
  outputMode: 'candidate-only',
  qualityDescription: 'VC/View 一致性、组件复用率、导航健壮性',
  matchTopics: ['ui', 'binding', 'pagination', 'navigation', 'component-pattern', 'lifecycle'],
  matchCategories: ['View', 'UI'],
  weight: 0.7,
  suggestedTopics: ['component-pattern', 'lifecycle', 'navigation'],
  relatedRoles: ['ui', 'feature'],
  tierHint: 4,
  displayGroup: 'architecture',
};

const D9_TESTING_QUALITY: UnifiedDimension = {
  id: 'testing-quality',
  label: '测试与质量',
  layer: 'universal',
  icon: 'FlaskConical',
  colorFamily: 'lime',
  extractionGuide:
    '单元测试模式、Mock/Stub 策略、集成测试约定、CI/CD 流程、代码覆盖率策略、Snapshot 测试',
  allowedKnowledgeTypes: ['best-practice'],
  outputMode: 'candidate-only',
  qualityDescription: '测试覆盖率、Mock 一致性、CI 可靠性',
  matchTopics: ['testing', 'test', 'ci-cd', 'mock-strategy', 'unit-test', 'snapshot-test'],
  matchCategories: [],
  weight: 0.9,
  suggestedTopics: ['unit-test', 'mock-strategy', 'ci-cd'],
  relatedRoles: [],
  tierHint: 4,
  displayGroup: 'best-practice',
};

const D10_SECURITY_AUTH: UnifiedDimension = {
  id: 'security-auth',
  label: '安全与认证',
  layer: 'universal',
  icon: 'Lock',
  colorFamily: 'red',
  extractionGuide:
    '认证授权流程、Token 管理、加密存储（Keychain/SecureStorage）、证书锁定、输入清理、权限控制、隐私合规',
  allowedKnowledgeTypes: ['best-practice'],
  outputMode: 'candidate-only',
  qualityDescription: '安全实践覆盖率、认证流程完整性、数据保护',
  matchTopics: ['security', 'auth', 'authentication', 'authorization', 'encryption', 'privacy'],
  matchCategories: [],
  weight: 1.0,
  suggestedTopics: ['authentication', 'authorization', 'encryption'],
  relatedRoles: ['networking', 'service'],
  tierHint: 4,
  displayGroup: 'best-practice',
};

const D11_PERFORMANCE_OPTIMIZATION: UnifiedDimension = {
  id: 'performance-optimization',
  label: '性能优化',
  layer: 'universal',
  icon: 'Gauge',
  colorFamily: 'yellow',
  extractionGuide:
    '内存管理（ARC/GC/引用循环）、懒加载策略、缓存层级、渲染优化（离屏渲染/预计算）、启动耗时优化、包体积控制',
  allowedKnowledgeTypes: ['best-practice'],
  outputMode: 'candidate-only',
  qualityDescription: '内存泄漏风险、启动关键路径、资源利用效率',
  matchTopics: ['performance', 'optimization', 'memory-management', 'lazy-loading', 'rendering'],
  matchCategories: [],
  weight: 0.8,
  suggestedTopics: ['memory-management', 'lazy-loading', 'rendering'],
  relatedRoles: ['ui', 'storage'],
  tierHint: 5,
  displayGroup: 'data-event-flow',
};

const D12_OBSERVABILITY_LOGGING: UnifiedDimension = {
  id: 'observability-logging',
  label: '可观测性',
  layer: 'universal',
  icon: 'Activity',
  colorFamily: 'slate',
  extractionGuide:
    '日志框架与分级（OSLog/Logger/Winston/Pino）、事件追踪/埋点、监控指标、诊断工具链、错误上报',
  allowedKnowledgeTypes: ['best-practice'],
  outputMode: 'candidate-only',
  qualityDescription: '日志规范覆盖率、可追踪性、监控完整性',
  matchTopics: ['logging', 'monitoring', 'event-tracking', 'diagnostics', 'tracing'],
  matchCategories: [],
  weight: 0.7,
  suggestedTopics: ['logging-standard', 'event-tracking', 'diagnostics'],
  relatedRoles: ['service', 'core'],
  tierHint: 5,
  displayGroup: 'data-event-flow',
};

const D13_AGENT_GUIDELINES: UnifiedDimension = {
  id: 'agent-guidelines',
  label: '开发约束',
  layer: 'universal',
  icon: 'Brain',
  colorFamily: 'rose',
  extractionGuide: "项目强制规则（DO/DON'T）、已废弃 API 标记、架构约束声明、环境特殊约定",
  allowedKnowledgeTypes: ['boundary-constraint', 'code-standard'],
  outputMode: 'candidate-only',
  qualityDescription: '约束覆盖完整性、规则可执行性',
  matchTopics: ['constraints', 'deprecated-api', 'agent-rules'],
  matchCategories: ['agent-guidelines'],
  weight: 0.6,
  suggestedTopics: ['constraints', 'deprecated-api', 'agent-rules'],
  relatedRoles: [],
  tierHint: 5,
  displayGroup: 'best-practice',
};

// ═══════════════════════════════════════════════════════════
// Layer 2: Language Dimensions (7)
// ═══════════════════════════════════════════════════════════

const DL1_SWIFT_OBJC_IDIOM: UnifiedDimension = {
  id: 'swift-objc-idiom',
  label: '深度扫描',
  layer: 'language',
  icon: 'ScanSearch',
  colorFamily: 'indigo',
  extractionGuide:
    '常量定义模式（enum namespace vs global）、Sendable 合规、Method Swizzling 清单、Protocol 命名约定、属性包装器使用、#define 宏/extern 常量、Category/Extension 针对基础类的方法清单',
  allowedKnowledgeTypes: ['code-standard', 'code-pattern'],
  outputMode: 'candidate-only',
  qualityDescription: 'Swift 6.0 并发安全合规度、ObjC 互操作清洁度、常量管理规范性',
  matchTopics: ['swift-idiom', 'objc-idiom', 'sendable', 'method-swizzle', 'macro', 'constant'],
  matchCategories: ['objc-deep-scan', 'category-scan'],
  weight: 0.8,
  suggestedTopics: ['sendable', 'method-swizzle', 'objc-interop'],
  relatedRoles: [],
  conditions: { languages: ['swift', 'objectivec'] },
  tierHint: 1,
  displayGroup: 'deep-scan',
};

const DL2_TS_JS_MODULE: UnifiedDimension = {
  id: 'ts-js-module',
  label: '模块导出',
  layer: 'language',
  icon: 'Package',
  colorFamily: 'violet',
  extractionGuide:
    'barrel export 结构、re-export 链路、public API surface、tree-shaking 合规性、path alias、类型导出策略',
  allowedKnowledgeTypes: ['code-standard', 'architecture'],
  outputMode: 'candidate-only',
  qualityDescription: '模块封装一致性、exported API 清晰度',
  matchTopics: ['module-export', 'barrel-export', 'public-api', 'tree-shaking'],
  matchCategories: ['module-export-scan'],
  weight: 0.7,
  suggestedTopics: ['module-export', 'barrel-export', 'public-api'],
  relatedRoles: [],
  conditions: { languages: ['typescript', 'javascript'] },
  tierHint: 1,
  displayGroup: 'deep-scan',
};

const DL3_PYTHON_STRUCTURE: UnifiedDimension = {
  id: 'python-structure',
  label: 'Python 包结构',
  layer: 'language',
  icon: 'FileCode',
  colorFamily: 'green',
  extractionGuide:
    '__init__.py 导出策略、相对/绝对导入风格、type hints 覆盖率、decorator 使用模式、__all__ 定义、虚拟环境约定',
  allowedKnowledgeTypes: ['code-standard', 'architecture'],
  outputMode: 'candidate-only',
  qualityDescription: '包结构规范性、导入一致性、类型保障',
  matchTopics: ['python-package', 'import-style', 'type-hints', 'decorator-pattern'],
  matchCategories: ['python-package-scan'],
  weight: 0.7,
  suggestedTopics: ['python-package', 'import-style', 'type-hints'],
  relatedRoles: [],
  conditions: { languages: ['python'] },
  tierHint: 1,
  displayGroup: 'deep-scan',
};

const DL4_JVM_ANNOTATION: UnifiedDimension = {
  id: 'jvm-annotation',
  label: '注解体系',
  layer: 'language',
  icon: 'AtSign',
  colorFamily: 'purple',
  extractionGuide:
    'DI 注解（@Inject/@Autowired/@Component）、ORM 注解（@Entity/@Table）、API 注解（@RestController）、自定义注解、元编程模式',
  allowedKnowledgeTypes: ['code-pattern', 'architecture'],
  outputMode: 'candidate-only',
  qualityDescription: '注解约定一致性、DI 配置完整性',
  matchTopics: ['annotation', 'di-annotation', 'orm-annotation', 'api-annotation'],
  matchCategories: ['jvm-annotation-scan'],
  weight: 0.7,
  suggestedTopics: ['annotation', 'di-annotation', 'orm-annotation'],
  relatedRoles: [],
  conditions: { languages: ['java', 'kotlin'] },
  tierHint: 1,
  displayGroup: 'deep-scan',
};

const DL5_GO_MODULE: UnifiedDimension = {
  id: 'go-module',
  label: 'Go 模块',
  layer: 'language',
  icon: 'Boxes',
  colorFamily: 'cyan',
  extractionGuide:
    'go.mod 依赖图、internal 包隔离、cmd/ 入口、build tags、interface 分布与实现、init() 函数清单',
  allowedKnowledgeTypes: ['architecture', 'code-pattern'],
  outputMode: 'candidate-only',
  qualityDescription: '模块隔离完整性、接口设计合理性',
  matchTopics: ['go-module', 'internal-package', 'interface-impl', 'build-tags'],
  matchCategories: ['go-module-scan'],
  weight: 0.7,
  suggestedTopics: ['go-module', 'internal-package', 'interface-impl'],
  relatedRoles: [],
  conditions: { languages: ['go'] },
  tierHint: 1,
  displayGroup: 'deep-scan',
};

const DL6_RUST_OWNERSHIP: UnifiedDimension = {
  id: 'rust-ownership',
  label: 'Rust 所有权',
  layer: 'language',
  icon: 'Link2',
  colorFamily: 'stone',
  extractionGuide:
    '所有权转移模式、生命周期标注约定、trait 实现层次、derive 宏使用、unsafe 块审计、Error 类型层级',
  allowedKnowledgeTypes: ['code-pattern', 'best-practice'],
  outputMode: 'candidate-only',
  qualityDescription: '所有权安全性、trait 设计合理性',
  matchTopics: ['ownership', 'lifetime', 'trait-impl', 'unsafe-audit'],
  matchCategories: [],
  weight: 0.7,
  suggestedTopics: ['ownership', 'lifetime', 'trait-impl'],
  relatedRoles: [],
  conditions: { languages: ['rust'] },
  tierHint: 1,
  displayGroup: 'deep-scan',
};

const DL7_CSHARP_DOTNET: UnifiedDimension = {
  id: 'csharp-dotnet',
  label: '.NET 模式',
  layer: 'language',
  icon: 'Component',
  colorFamily: 'teal',
  extractionGuide:
    'DI 容器注册模式、LINQ 查询约定、async/await 模式、EF Core 映射、Middleware pipeline、特性标注（[Attribute]）',
  allowedKnowledgeTypes: ['code-pattern', 'architecture'],
  outputMode: 'candidate-only',
  qualityDescription: 'DI 注册完整性、EF Core 映射正确性',
  matchTopics: ['di-container', 'linq-pattern', 'ef-core', 'middleware', 'attribute'],
  matchCategories: [],
  weight: 0.7,
  suggestedTopics: ['di-container', 'linq-pattern', 'ef-core'],
  relatedRoles: [],
  conditions: { languages: ['csharp'] },
  tierHint: 1,
  displayGroup: 'deep-scan',
};

// ═══════════════════════════════════════════════════════════
// Layer 3: Framework Dimensions (5)
// ═══════════════════════════════════════════════════════════

const DF1_REACT_PATTERNS: UnifiedDimension = {
  id: 'react-patterns',
  label: 'React 模式',
  layer: 'framework',
  icon: 'Atom',
  colorFamily: 'sky',
  extractionGuide:
    '组件目录结构、状态管理约定（Redux/Zustand/Jotai）、Router 约定、数据获取模式（SWR/TanStack Query/Server Components）、样式方案',
  allowedKnowledgeTypes: ['code-standard', 'architecture'],
  outputMode: 'candidate-only',
  qualityDescription: '组件结构一致性、状态管理规范性',
  matchTopics: ['react-component', 'state-management', 'data-fetching', 'ssr-pattern'],
  matchCategories: ['framework-convention-scan'],
  weight: 0.7,
  suggestedTopics: ['react-component', 'state-management', 'data-fetching'],
  relatedRoles: ['ui', 'feature'],
  conditions: { languages: ['typescript', 'javascript'], frameworks: ['react', 'nextjs'] },
  tierHint: 1,
  displayGroup: 'deep-scan',
};

const DF2_VUE_PATTERNS: UnifiedDimension = {
  id: 'vue-patterns',
  label: 'Vue 模式',
  layer: 'framework',
  icon: 'Wind',
  colorFamily: 'emerald',
  extractionGuide:
    'Composition API vs Options API、Pinia 状态管理、路由守卫、Nuxt 目录约定（pages/layouts/middleware）',
  allowedKnowledgeTypes: ['code-standard', 'architecture'],
  outputMode: 'candidate-only',
  qualityDescription: 'Composition API 一致性、Pinia 约定规范性',
  matchTopics: ['vue-composition', 'pinia', 'nuxt-convention'],
  matchCategories: [],
  weight: 0.7,
  suggestedTopics: ['vue-composition', 'pinia', 'nuxt-convention'],
  relatedRoles: ['ui', 'feature'],
  conditions: { languages: ['typescript', 'javascript'], frameworks: ['vue', 'nuxt'] },
  tierHint: 1,
  displayGroup: 'deep-scan',
};

const DF3_SPRING_PATTERNS: UnifiedDimension = {
  id: 'spring-patterns',
  label: 'Spring 模式',
  layer: 'framework',
  icon: 'Leaf',
  colorFamily: 'green',
  extractionGuide:
    'Bean 生命周期管理、配置属性绑定、AOP 切面约定、异常处理器、Repository/Service 分层、Actuator 端点',
  allowedKnowledgeTypes: ['code-pattern', 'architecture'],
  outputMode: 'candidate-only',
  qualityDescription: 'Bean 管理完整性、AOP 一致性',
  matchTopics: ['spring-bean', 'aop-aspect', 'config-properties', 'actuator'],
  matchCategories: [],
  weight: 0.7,
  suggestedTopics: ['spring-bean', 'aop-aspect', 'config-properties'],
  relatedRoles: ['service', 'core'],
  conditions: { languages: ['java', 'kotlin'], frameworks: ['spring', 'spring-boot'] },
  tierHint: 1,
  displayGroup: 'deep-scan',
};

const DF4_SWIFTUI_PATTERNS: UnifiedDimension = {
  id: 'swiftui-patterns',
  label: 'SwiftUI 模式',
  layer: 'framework',
  icon: 'PaintBucket',
  colorFamily: 'blue',
  extractionGuide:
    'View 组合模式、@State/@Binding/@ObservableObject 管理、Navigation 策略、PreferenceKey 使用、环境值注入',
  allowedKnowledgeTypes: ['code-pattern', 'best-practice'],
  outputMode: 'candidate-only',
  qualityDescription: 'View 组合健壮性、状态管理分层合理性',
  matchTopics: ['swiftui-view', 'state-management', 'navigation', 'environment'],
  matchCategories: [],
  weight: 0.7,
  suggestedTopics: ['swiftui-view', 'state-management', 'navigation'],
  relatedRoles: ['ui', 'feature'],
  conditions: { languages: ['swift'], frameworks: ['swiftui'] },
  tierHint: 1,
  displayGroup: 'deep-scan',
};

const DF5_DJANGO_FASTAPI: UnifiedDimension = {
  id: 'django-fastapi',
  label: 'Django/FastAPI',
  layer: 'framework',
  icon: 'Server',
  colorFamily: 'amber',
  extractionGuide:
    'URL routing 约定、Model/Serializer 分层、Middleware 管线、Dependency Injection（FastAPI）、Admin 定制',
  allowedKnowledgeTypes: ['code-standard', 'architecture'],
  outputMode: 'candidate-only',
  qualityDescription: '路由组织清晰度、ORM 使用规范性',
  matchTopics: ['url-routing', 'model-serializer', 'middleware', 'dependency-injection'],
  matchCategories: [],
  weight: 0.7,
  suggestedTopics: ['url-routing', 'model-serializer', 'middleware'],
  relatedRoles: ['service', 'core'],
  conditions: { languages: ['python'], frameworks: ['django', 'fastapi', 'flask'] },
  tierHint: 1,
  displayGroup: 'deep-scan',
};

// ═══════════════════════════════════════════════════════════
// 维度注册表（唯一来源）
// ═══════════════════════════════════════════════════════════

export const DIMENSION_REGISTRY: readonly UnifiedDimension[] = [
  // Layer 1: Universal (13)
  D1_ARCHITECTURE,
  D2_CODING_STANDARDS,
  D3_DESIGN_PATTERNS,
  D4_ERROR_RESILIENCE,
  D5_CONCURRENCY_ASYNC,
  D6_DATA_EVENT_FLOW,
  D7_NETWORKING_API,
  D8_UI_INTERACTION,
  D9_TESTING_QUALITY,
  D10_SECURITY_AUTH,
  D11_PERFORMANCE_OPTIMIZATION,
  D12_OBSERVABILITY_LOGGING,
  D13_AGENT_GUIDELINES,

  // Layer 2: Language (7)
  DL1_SWIFT_OBJC_IDIOM,
  DL2_TS_JS_MODULE,
  DL3_PYTHON_STRUCTURE,
  DL4_JVM_ANNOTATION,
  DL5_GO_MODULE,
  DL6_RUST_OWNERSHIP,
  DL7_CSHARP_DOTNET,

  // Layer 3: Framework (5)
  DF1_REACT_PATTERNS,
  DF2_VUE_PATTERNS,
  DF3_SPRING_PATTERNS,
  DF4_SWIFTUI_PATTERNS,
  DF5_DJANGO_FASTAPI,
];

// ═══════════════════════════════════════════════════════════
// 查询辅助函数
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// 维度展示分组映射 — 从注册表自动派生
// ═══════════════════════════════════════════════════════════

/**
 * 维度 ID → 展示分组 ID 映射
 *
 *  展示分组:
 *   - 'architecture'     — 架构与设计
 *   - 'best-practice'    — 规范与实践
 *   - 'data-event-flow'  — 数据与并发
 *   - 'deep-scan'        — 深度扫描（语言/框架条件维度）
 */
export const DIMENSION_DISPLAY_GROUP: Record<string, string> = Object.fromEntries(
  DIMENSION_REGISTRY.map((d) => [d.id, d.displayGroup])
);

/** 按 ID 获取维度 */
export function getDimension(id: string): UnifiedDimension | undefined {
  return DIMENSION_REGISTRY.find((d) => d.id === id);
}

/** 获取指定层级的所有维度 */
export function getDimensionsByLayer(
  layer: 'universal' | 'language' | 'framework'
): readonly UnifiedDimension[] {
  return DIMENSION_REGISTRY.filter((d) => d.layer === layer);
}

/**
 * 根据项目语言和框架过滤出活跃维度
 *
 * - Layer 1 (universal): 全部返回
 * - Layer 2 (language): 仅当项目语言匹配时返回
 * - Layer 3 (framework): 仅当项目语言+框架均匹配时返回
 */
export function resolveActiveDimensions(
  primaryLang: string,
  detectedFrameworks: string[] = []
): readonly UnifiedDimension[] {
  return DIMENSION_REGISTRY.filter((dim) => {
    if (!dim.conditions) {
      return true; // Layer 1: 无条件 → 通用维度
    }
    const langMatch = !dim.conditions.languages || dim.conditions.languages.includes(primaryLang);
    const fwMatch =
      !dim.conditions.frameworks ||
      dim.conditions.frameworks.some((f) => detectedFrameworks.includes(f));
    // languages 必须匹配；frameworks 条件存在时也需匹配
    return langMatch && (dim.conditions.frameworks ? fwMatch : true);
  });
}

/**
 * 构建 Tier 分层调度计划
 *
 * 基于每个维度的 tierHint 字段动态分为 N 层 (不再硬编码 3 层):
 * - tierHint=1: 基础数据层 — architecture + 语言/框架条件维度
 * - tierHint=2: 规范+设计层 — coding-standards, design-patterns 等
 * - tierHint=3+: 实践+质量层 — 按声明值自动分桶
 *
 * 未声明 tierHint 的维度默认归入最后一层 (tierHint=max 或 3)。
 */
export function buildTierPlan(
  activeDims: readonly UnifiedDimension[] = DIMENSION_REGISTRY
): string[][] {
  const tierMap = new Map<number, string[]>();

  for (const dim of activeDims) {
    const hint = dim.tierHint ?? 3;
    if (!tierMap.has(hint)) {
      tierMap.set(hint, []);
    }
    tierMap.get(hint)!.push(dim.id);
  }

  // 按 tier 编号升序排列，过滤空层
  return [...tierMap.entries()].sort(([a], [b]) => a - b).map(([, dims]) => dims);
}

/**
 * 将 Recipe 分类到最匹配的维度
 *
 * 优先级: topicHint 精确匹配 → category 匹配 → null
 */
export function classifyRecipeToDimension(topicHint: string, category: string): DimensionId | null {
  // 1. topicHint 精确匹配
  if (topicHint) {
    for (const dim of DIMENSION_REGISTRY) {
      if (dim.matchTopics.includes(topicHint)) {
        return dim.id as DimensionId;
      }
    }
  }

  // 2. category 匹配
  if (category) {
    for (const dim of DIMENSION_REGISTRY) {
      if (dim.matchCategories.includes(category)) {
        return dim.id as DimensionId;
      }
    }
  }

  return null;
}
