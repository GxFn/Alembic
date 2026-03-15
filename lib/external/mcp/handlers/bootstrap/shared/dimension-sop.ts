/**
 * dimension-sop.js — 维度级 SOP (Standard Operating Procedure)
 *
 * 为每个维度定义结构化分析步骤，替代 enrichDimensionTask() 中
 * 原有的通用 analysisGuide 字符串。
 *
 * 参考:
 *   - MetaGPT SOP 驱动模式 (docs/design/external-agent-quality-gap.md §4.2)
 *   - 内部 Agent 的 PipelineStrategy (Analyze → QualityGate → Produce → RejectionGate)
 *
 * 设计原则:
 *   - 每个维度 4 个阶段: 扫描 → 验证 → 异常检测 → 提交
 *   - steps[].tools 仅为建议，外部 Agent 可用自身原生能力替代
 *   - commonMistakes 来自实际 cold start 观察到的低质量模式
 *
 * @module bootstrap/shared/dimension-sop
 */

// ═══════════════════════════════════════════════════════════
// 维度 SOP 注册表
// ═══════════════════════════════════════════════════════════

export const DIMENSION_SOP = {
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 通用维度
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  'code-standard': {
    focusKeywords: [
      '命名约定',
      '类名前缀',
      '方法签名',
      '注释风格',
      '文件组织',
      'camelCase',
      'PascalCase',
      '代码规范',
    ],
    steps: [
      {
        phase: '1. 全局扫描',
        action: '搜索项目中出现频率最高的类名前缀/后缀、方法命名模式',
        expectedOutput: '识别 3-5 个主要命名模式及其出现频率统计',
        tools: ['grep_search 搜索类定义/接口定义', '浏览核心目录下的文件列表'],
      },
      {
        phase: '2. 深度验证',
        action: '阅读 5+ 个核心类文件，验证命名模式、注释风格、文件组织方式是否一致',
        expectedOutput: '每个模式至少有 3 个文件证据，含具体行号',
        tools: ['read_file 逐个阅读核心类/模块'],
      },
      {
        phase: '3. 异常检测',
        action: '搜索不符合主流命名模式的例外，确认是否为已废弃写法或特殊例外',
        expectedOutput: '识别例外模式及其原因（历史遗留/第三方要求等）',
      },
      {
        phase: '4. 提交',
        action:
          '按项目特写格式提交知识候选（**最少 3 条，目标 5 条**），每个候选聚焦一种具体代码规范（如命名约定、注释风格、文件组织分别独立提交）',
        qualityChecklist: [
          '每个 content ≥200 字符',
          '每个候选引用 ≥3 个文件路径',
          'doClause 用英文祈使句，具体到命名模式',
          'coreCode 提供可复制的完整代码骨架',
        ],
      },
    ],
    timeEstimate: '1-5 min',
    commonMistakes: [
      '不要只扫描 1 个文件就提交 — 至少读 5+ 个文件验证模式一致性',
      '不要把"类名前缀"和"方法签名风格"合并成一个候选 — 每种规范应独立成条',
      '不要写空泛的规范如"use camelCase" — 必须写明项目特定的前缀/后缀/风格',
      'content 中必须有 (来源: FileName.ext:行号) 标注具体出处',
    ],
  },

  'code-pattern': {
    focusKeywords: [
      '设计模式',
      '单例',
      'Singleton',
      '工厂',
      'Factory',
      '委托',
      'Delegate',
      '观察者',
      'Observer',
      'Builder',
      '继承',
      'Extension',
      'Category',
    ],
    steps: [
      {
        phase: '1. 模式识别',
        action:
          '搜索常见设计模式关键词: Singleton/shared/default, Factory/create/build, Delegate/protocol, Observer/notify',
        expectedOutput: '列出项目中使用的设计模式类型及代表性实现',
        tools: ['grep_search 搜索单例、工厂、委托、观察者等关键词'],
      },
      {
        phase: '2. 实现验证',
        action: '阅读每种模式的 2-3 个实现，记录实现方式是否统一',
        expectedOutput: '每种模式的标准实现写法 + 文件证据 + 变体说明',
        tools: ['read_file 阅读模式实现类'],
      },
      {
        phase: '3. 继承与组合分析',
        action: '追踪核心基类的继承链，分析"基类-子类"和"接口-实现"关系',
        expectedOutput: '核心继承图、关键基类的扩展约束',
      },
      {
        phase: '4. 提交',
        action:
          '每种设计模式单独提交候选（**整体最少 3 条，目标 5 条**），包含标准实现代码和使用约束',
        qualityChecklist: [
          '候选数量 ≥3（将不同模式拆分为独立候选，如 Singleton 一条、Factory 一条、Delegate 一条）',
          '每个候选只聚焦一种设计模式',
          'content 包含 ✅ 正确写法 和 ❌ 禁止写法',
          'coreCode 是可复制的模式骨架代码',
          '说明何时应使用此模式（whenClause）',
        ],
      },
    ],
    timeEstimate: '1-5 min',
    commonMistakes: [
      '不要只列出模式名称而不分析实现 — 必须展示项目的具体实现代码',
      '不要把 Singleton 和 Factory 合并成一个候选 — 每种模式独立提交',
      '不要忽略项目中模式的变体 — 如果项目的 Singleton 不用标准 dispatch_once，要说明其特殊写法',
    ],
  },

  architecture: {
    steps: [
      {
        phase: '1. 目录结构分析',
        action: '浏览项目根目录和核心子目录，识别分层结构（Controller/View/Model/Service 等）',
        expectedOutput: '项目的分层架构图和模块划分',
        tools: ['list_dir 浏览项目目录结构'],
      },
      {
        phase: '2. 依赖关系分析',
        action: '阅读核心模块的 import/include，追踪模块间依赖方向',
        expectedOutput: '模块间通信方式清单（Protocol/Delegate/Notification/DI 等）',
        tools: ['grep_search 搜索 import/include/require 语句'],
      },
      {
        phase: '3. 边界约束验证',
        action: '确认是否存在分层约束（如 View 不直接访问 Model），搜索违反约束的例外',
        expectedOutput: '架构约束规则 + 违规例外及原因',
      },
      {
        phase: '4. 提交',
        action: '分别提交分层架构、模块通信、依赖管理等知识候选（**最少 3 条，目标 5 条**）',
        qualityChecklist: [
          '候选数量 ≥3（分层结构、通信方式、依赖管理应分别提交）',
          'content 包含架构层次图或文字描述',
          '引用具体目录路径和核心文件',
          'doClause 表达架构约束规则',
          'dontClause 表达禁止的跨层调用',
        ],
      },
    ],
    timeEstimate: '1-5 min',
    commonMistakes: [
      '不要只描述目录名 — 要分析每层的职责和通信方式',
      '不要忽略依赖方向 — 是 Controller→Service 还是双向依赖？',
      '不要把整个架构写进一个候选 — 分层结构、通信方式、依赖管理应分别提交',
    ],
  },

  'best-practice': {
    focusKeywords: [
      '错误处理',
      'Error Handling',
      '并发安全',
      '线程安全',
      '内存管理',
      '日志',
      '测试',
      'logging',
      'concurrency',
    ],
    steps: [
      {
        phase: '1. 错误处理扫描',
        action: '搜索 try/catch/throw、Error/Exception、错误码定义，分析错误处理策略',
        expectedOutput: '错误处理模式分类 + 统计分布',
        tools: ['grep_search 搜索错误处理关键词'],
      },
      {
        phase: '2. 并发与安全分析',
        action:
          '搜索锁/队列/线程相关代码（dispatch_queue/mutex/synchronized/async-await），分析并发安全策略',
        expectedOutput: '并发模式 + 线程安全约束',
        tools: ['grep_search 搜索并发相关关键词'],
      },
      {
        phase: '3. 日志与调试',
        action: '搜索日志框架使用（NSLog/Logger/print/console.log），分析日志规范',
        expectedOutput: '日志级别使用惯例 + 调试基础设施',
      },
      {
        phase: '4. 提交',
        action: '每种最佳实践独立提交（**整体最少 3 条，目标 5 条**），包含正反面代码示例',
        qualityChecklist: [
          '候选数量 ≥3（错误处理、并发安全、日志规范等应分别提交）',
          '每个候选聚焦一种实践（如"错误处理"或"并发安全"）',
          'content 包含 ✅ 推荐写法 和 ❌ 反模式',
          '提供具体的统计数据（如"项目中 80% 的错误处理使用 Result 类型"）',
          'coreCode 展示推荐的代码模板',
        ],
      },
    ],
    timeEstimate: '1-5 min',
    commonMistakes: [
      '不要笼统写"项目有错误处理" — 必须说明具体的处理策略（Result/throw/错误码）',
      '不要忽略反模式 — dontClause 要具体说明禁止的做法',
      '不要遗漏并发安全 — 这是代码补全时最容易出错的地方',
    ],
  },

  'event-and-data-flow': {
    focusKeywords: [
      '事件',
      'Delegate',
      'Notification',
      'Block',
      'Closure',
      'callback',
      '数据流',
      '状态管理',
      'KVO',
      '响应式',
      '持久化',
      'Observable',
    ],
    steps: [
      {
        phase: '1. 事件机制扫描',
        action:
          '搜索 Delegate/Protocol、Notification、Callback/Closure/Block、EventEmitter 等事件传播机制',
        expectedOutput: '事件传播机制清单 + 各机制使用频率统计',
        tools: ['grep_search 搜索事件相关关键词'],
      },
      {
        phase: '2. 数据流追踪',
        action: '选取 2-3 个核心业务流程，追踪数据从输入到持久化的完整路径',
        expectedOutput: '数据流转路径图 + 状态管理方式',
        tools: ['read_file 阅读核心业务流程入口'],
      },
      {
        phase: '3. 持久化方案',
        action: '搜索数据库/缓存/文件存储相关代码，分析数据持久化方案',
        expectedOutput: '持久化技术栈 + 数据访问模式',
      },
      {
        phase: '4. 提交',
        action: '事件传播和数据流分别提交候选（**最少 3 条，目标 5 条**，将不同机制拆为独立候选）',
        qualityChecklist: [
          '候选数量 ≥3（Delegate、Notification、Callback 等每种机制独立提交）',
          '每个候选聚焦一种事件/数据流模式',
          'content 描述具体的事件传播链路（从触发到响应）',
          'whenClause 描述何时使用此事件/数据模式',
          '引用具体的文件路径和代码行',
        ],
      },
    ],
    timeEstimate: '1-5 min',
    commonMistakes: [
      '不要只列出"项目使用 Notification" — 要说明具体的通知名、发送者、接收者',
      '不要混淆事件传播和数据流 — Delegate 是事件机制，CoreData 是数据流',
      '应关注跨模块的事件链路 — 单模块内的方法调用不算事件传播',
    ],
  },

  'project-profile': {
    focusKeywords: [
      '技术栈',
      '目录结构',
      '三方依赖',
      '基础设施',
      '生命周期',
      '启动流程',
      'Runtime',
      '入口点',
    ],
    steps: [
      {
        phase: '1. 项目结构概览',
        action: '浏览根目录和核心子目录，识别模块划分和技术栈',
        expectedOutput: '技术栈清单、目录结构图、模块列表',
        tools: [
          'list_dir 浏览目录',
          'read_file 阅读配置文件(Package.swift/Podfile/package.json 等)',
        ],
      },
      {
        phase: '2. 依赖与基础设施',
        action: '阅读依赖配置文件，识别三方库及其用途；搜索基础设施服务（网络/存储/日志）',
        expectedOutput: '三方依赖清单 + 基础设施服务注册表',
        tools: ['read_file 阅读依赖配置', 'grep_search 搜索服务注册/初始化代码'],
      },
      {
        phase: '3. 入口与生命周期',
        action: '找到应用入口点，分析启动流程和生命周期 hook',
        expectedOutput: '启动流程链路 + 核心生命周期回调',
        tools: ['grep_search 搜索 main/AppDelegate/Application 等入口关键词'],
      },
      {
        phase: '4. 提交',
        action:
          '分模块提交项目特征候选（**最少 3 条，目标 5 条**：技术栈、依赖、入口点、基础设施等分别提交）',
        qualityChecklist: [
          '候选数量 ≥3（技术栈、三方依赖、启动流程等应独立成条）',
          'content 包含具体的技术栈版本和依赖列表',
          '引用配置文件和入口文件路径',
          '每个候选只关注一个方面（如"三方依赖"或"启动流程"）',
          'coreCode 展示关键的配置或初始化代码',
        ],
      },
    ],
    timeEstimate: '1-5 min',
    commonMistakes: [
      '不要直接复制依赖列表 — 要说明每个关键依赖的用途和版本',
      '不要只写"项目使用 MVC" — 要说明具体的分层职责和文件组织方式',
      '不要遗漏项目的自定义基类和全局定义 — 这些是开发时最容易忽略的',
    ],
  },

  'agent-guidelines': {
    focusKeywords: [
      '强制规范',
      '约束',
      '废弃 API',
      'deprecated',
      '线程安全',
      '内存约束',
      'TODO',
      'FIXME',
      '架构约束',
    ],
    steps: [
      {
        phase: '1. 综合前序维度发现',
        action: '回顾之前所有维度分析的结果，提取项目开发中最重要的强制约束规则',
        expectedOutput: '关键约束规则清单（命名、线程、内存、已废弃 API）',
      },
      {
        phase: '2. 搜索显式约束',
        action: '搜索 TODO/FIXME/DEPRECATED/WARNING 注释，以及 lint 配置中的强制规则',
        expectedOutput: '项目显式标注的约束和已废弃 API 列表',
        tools: ['grep_search 搜索 TODO/FIXME/DEPRECATED/WARNING'],
      },
      {
        phase: '3. 推导隐式约束',
        action:
          '从代码模式中推导隐式约束（如"所有 Manager 必须是单例"、"网络请求必须通过 BaseRequest"）',
        expectedOutput: '隐式约束规则 + 代码证据',
      },
      {
        phase: '4. 提交',
        action:
          '每条开发约束单独提交（**最少 3 条，目标 5 条**），确保 doClause 表达清晰的强制规则',
        qualityChecklist: [
          '候选数量 ≥3（命名约束、线程约束、废弃 API  等应分别提交）',
          '每个候选是一条明确的项目开发规则',
          'doClause 以动词开头，表达强制性要求',
          'dontClause 明确禁止的做法',
          'content 说明规则来源和违反后果',
          '【禁止】标题和内容中不要出现 "Agent" 字样 — 应写为项目规范/开发规范',
        ],
      },
    ],
    timeEstimate: '1-5 min',
    commonMistakes: [
      '【重要】不要在标题或内容中使用 "Agent" 字样 — 这是项目编码规范，不是 Agent 说明书',
      '不要只写通用编程建议 — 必须是此项目特有的约束',
      '不要遗漏线程安全约束 — 这是代码补全时最容易犯的错误',
      '本维度应在最后分析 — 需要综合前序维度的发现',
      '不要把所有规则写进一个候选 — 每条约束独立成条',
    ],
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 语言条件维度
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  'objc-deep-scan': {
    focusKeywords: [
      '#define',
      '宏',
      'macro',
      'extern',
      'static',
      '常量',
      'Swizzling',
      'hook',
      'Method Swizzling',
    ],
    steps: [
      {
        phase: '1. 宏定义扫描',
        action: '搜索 #define 值宏和函数宏，分类统计常量宏 vs 功能宏',
        expectedOutput: '宏定义分类清单 + 使用频率统计',
        tools: ['grep_search 搜索 #define'],
      },
      {
        phase: '2. 常量定义扫描',
        action: '搜索 extern/static 常量定义、NS_ENUM/NS_OPTIONS 类型定义',
        expectedOutput: '常量定义清单 + 命名约定分析',
        tools: ['grep_search 搜索 extern/static const'],
      },
      {
        phase: '3. Method Swizzling 扫描',
        action: '搜索 method_exchangeImplementations、class_addMethod、+load、+initialize',
        expectedOutput: 'Hook 清单（原方法→替换方法映射）+ 执行时机',
        tools: ['grep_search 搜索 swizzl/method_exchange/class_addMethod'],
      },
      {
        phase: '4. 提交',
        action: '宏定义、常量、Hook 分别提交候选（**最少 3 条，目标 5 条**），确保包含完整实现代码',
        qualityChecklist: [
          '候选数量 ≥3（宏定义、常量定义、Method Swizzling 等应分别提交）',
          'coreCode 包含完整的宏/常量/Hook 实现',
          'content 包含使用频率和场景说明',
          'Hook 候选必须说明原方法和替换方法的对应关系',
          '常量候选必须包含 extern 声明和值定义',
        ],
      },
    ],
    timeEstimate: '1-5 min',
    commonMistakes: [
      '不要只列出宏名 — 必须包含宏定义的完整值和使用场景',
      'Hook 必须说明 hook 的目的和潜在风险',
      '常量必须说明值和使用位置 — Agent 需要知道用哪个常量替代硬编码',
    ],
  },

  'category-scan': {
    focusKeywords: [
      'Category',
      'Extension',
      'Foundation',
      'UIKit',
      '分类方法',
      'NSString',
      'UIView',
      'NSArray',
    ],
    steps: [
      {
        phase: '1. Category 文件定位',
        action:
          '搜索 Foundation/UIKit 基础类的 Category 文件（NSString+/UIView+/NSDictionary+ 等）',
        expectedOutput: 'Category 文件列表 + 基类分类统计',
        tools: [
          'file_search 搜索 +Extension/+Category 文件',
          'grep_search 搜索 @interface.*Category',
        ],
      },
      {
        phase: '2. 逐方法分析',
        action: '阅读每个 Category，记录方法签名、实现代码和使用场景',
        expectedOutput: '每个 Category 的方法清单 + 核心方法实现代码',
        tools: ['read_file 逐个阅读 Category 文件'],
      },
      {
        phase: '3. 使用频率验证',
        action: '搜索核心 Category 方法在项目中的调用频率',
        expectedOutput: '高频使用的 Category 方法排行',
        tools: ['grep_search 搜索 Category 方法名'],
      },
      {
        phase: '4. 提交',
        action:
          '按基类分组提交候选（**最少 3 条，目标 5 条**：NSString Category 一条、UIView Category 一条等）',
        qualityChecklist: [
          '候选数量 ≥3（不同基类的 Category 独立提交）',
          'content 包含完整的方法签名列表',
          'coreCode 包含最常用方法的实现代码',
          'doClause 强制要求使用已有 Category 方法',
          'dontClause 禁止重复实现同功能方法',
        ],
      },
    ],
    timeEstimate: '1-5 min',
    commonMistakes: [
      '不要遗漏任何 Category 方法 — 要做到全量扫描',
      '不要只列出方法名不含实现 — Agent 需要实现代码才能正确使用',
      '不要把业务代码 Category 混入基础类 Category',
    ],
  },

  'module-export-scan': {
    focusKeywords: [
      'export',
      'barrel',
      're-export',
      'index.ts',
      'public API',
      'tree-shaking',
      'import',
    ],
    steps: [
      {
        phase: '1. barrel export 扫描',
        action: '搜索 index.ts/index.js 文件，分析 re-export 结构',
        expectedOutput: 'barrel export 结构图 + public API surface',
        tools: ['file_search 搜索 index.ts/index.js', 'grep_search 搜索 export.*from'],
      },
      {
        phase: '2. 导出模式分析',
        action: '统计 named export vs default export 使用比例，分析导出命名约定',
        expectedOutput: '导出模式统计 + 命名约定',
        tools: ['grep_search 搜索 export default/export const/export function'],
      },
      {
        phase: '3. 循环依赖检测',
        action: '追踪 import 链路，检查模块间是否存在循环依赖',
        expectedOutput: '循环依赖列表（如有）+ 模块依赖方向约束',
      },
      {
        phase: '4. 提交',
        action: '分别提交 barrel export 结构、导出约定、依赖约束等候选（**最少 3 条，目标 5 条**）',
        qualityChecklist: [
          '候选数量 ≥3（barrel export、命名导出约定、依赖方向约束等独立提交）',
          'content 包含具体的 import/export 代码示例',
          '引用 index.ts 和核心模块文件路径',
          'doClause 表达导出约定规则',
          'coreCode 展示标准的 export 写法',
        ],
      },
    ],
    timeEstimate: '1-5 min',
    commonMistakes: [
      '不要只说"项目使用 named export" — 要展示具体的 export 模式和约定',
      '不要忽略 re-export 链路 — barrel export 结构对项目维护很重要',
      '如果项目有 tree-shaking 相关配置，需要特别说明',
    ],
  },

  'framework-convention-scan': {
    focusKeywords: [
      '组件',
      'component',
      '状态管理',
      'store',
      '路由',
      'router',
      '样式',
      'CSS',
      'data fetching',
    ],
    steps: [
      {
        phase: '1. 组件结构分析',
        action: '浏览组件目录，分析组件文件组织方式（单文件/目录组件/atoms-molecules 等）',
        expectedOutput: '组件目录结构约定 + 命名约定',
        tools: ['list_dir 浏览组件目录', 'read_file 阅读代表性组件'],
      },
      {
        phase: '2. 状态管理分析',
        action: '搜索状态管理相关代码（store/reducer/action/mutation/atom 等）',
        expectedOutput: '状态管理方案 + 使用模式 + 约定',
        tools: ['grep_search 搜索 store/useStore/createSlice/defineStore 等'],
      },
      {
        phase: '3. 路由与数据获取',
        action: '分析路由配置和数据获取模式（SSR/CSR/ISR 等）',
        expectedOutput: '路由约定 + 数据获取模式',
        tools: ['grep_search 搜索 router/route/fetch/loader/getServerSideProps'],
      },
      {
        phase: '4. 提交',
        action: '组件约定、状态管理、路由模式分别提交候选（**最少 3 条，目标 5 条**）',
        qualityChecklist: [
          '候选数量 ≥3（组件结构、状态管理、路由配置等独立提交）',
          'content 包含组件/状态/路由的代码示例',
          '引用具体框架版本和配置文件',
          'coreCode 是可复制的标准写法模板',
          'whenClause 描述何时使用此约定',
        ],
      },
    ],
    timeEstimate: '1-5 min',
    commonMistakes: [
      '不要假设框架版本 — 从 package.json 确认具体版本再分析',
      '不要只分析组件结构忽略状态管理 — 状态管理模式对项目开发至关重要',
      '不要混淆 SSR 和 CSR 数据获取模式',
    ],
  },

  'python-package-scan': {
    focusKeywords: [
      '__init__',
      'import',
      'type hints',
      'decorator',
      '__all__',
      'package',
      'module',
    ],
    steps: [
      {
        phase: '1. 包结构分析',
        action: '浏览包目录，分析 __init__.py 内容和 __all__ 定义',
        expectedOutput: '__init__.py 导出策略 + 包层级结构',
        tools: ['file_search 搜索 __init__.py', 'read_file 阅读 __init__.py 文件'],
      },
      {
        phase: '2. 导入风格分析',
        action: '统计相对导入 vs 绝对导入使用比例，分析导入约定',
        expectedOutput: '导入风格统计 + 项目约定',
        tools: ['grep_search 搜索 from . import/from .. import/import xxx'],
      },
      {
        phase: '3. 类型标注与装饰器',
        action: '分析 type hints 覆盖率、Protocol 使用、decorator 模式',
        expectedOutput: '类型标注覆盖率 + 常用装饰器清单',
        tools: ['grep_search 搜索 -> /: str/: int/Protocol/@decorator'],
      },
      {
        phase: '4. 提交',
        action: '包结构、导入约定、类型标注分别提交候选（**最少 3 条，目标 5 条**）',
        qualityChecklist: [
          '候选数量 ≥3（包结构、导入风格、类型标注约定独立提交）',
          'content 包含具体的 import/type hint 代码示例',
          '引用 __init__.py 和核心模块路径',
          'coreCode 展示标准的导入和类型标注写法',
          'doClause 表达导入和类型标注约定',
        ],
      },
    ],
    timeEstimate: '1-5 min',
    commonMistakes: [
      '不要忽略 __all__ 定义 — 它决定了 from pkg import * 的行为',
      '不要假设所有包都有 type hints — 先统计覆盖率再分析',
      '不要遗漏 decorator 模式 — 自定义 decorator 是项目的重要约定',
    ],
  },

  'jvm-annotation-scan': {
    focusKeywords: [
      '@Inject',
      '@Autowired',
      '@Component',
      '@Entity',
      '@Table',
      '@RestController',
      'annotation',
      'DI',
      'ORM',
    ],
    steps: [
      {
        phase: '1. DI 注解扫描',
        action: '搜索 @Inject/@Autowired/@Component/@Service/@Repository 等 DI 注解',
        expectedOutput: 'DI 注解使用模式 + 统计',
        tools: ['grep_search 搜索 @Inject/@Autowired/@Component'],
      },
      {
        phase: '2. ORM 注解扫描',
        action: '搜索 @Entity/@Table/@Column/@ManyToOne 等 ORM 注解',
        expectedOutput: 'ORM 映射模式 + 实体关系图',
        tools: ['grep_search 搜索 @Entity/@Table/@Column'],
      },
      {
        phase: '3. API 与自定义注解',
        action: '搜索 @RestController/@RequestMapping/@GetMapping + 自定义注解定义',
        expectedOutput: 'API 路由约定 + 自定义注解清单及用途',
        tools: ['grep_search 搜索 @RestController/@interface (annotation 定义)'],
      },
      {
        phase: '4. 提交',
        action: 'DI、ORM、API、自定义注解分别提交候选（**最少 3 条，目标 5 条**）',
        qualityChecklist: [
          '候选数量 ≥3（DI 注解、ORM 注解、API 注解等独立提交）',
          'content 包含注解的完整使用示例',
          '引用具体的类文件和配置',
          'coreCode 展示标准的注解使用骨架',
          'doClause 表达注解使用的强制规则',
        ],
      },
    ],
    timeEstimate: '1-5 min',
    commonMistakes: [
      '不要只扫描 Spring 注解 — 项目可能使用 Guice/Dagger/Hilt',
      '不要忽略自定义注解 — 它们编码了项目特有的规则',
      '区分 field injection 和 constructor injection — 项目通常有明确偏好',
    ],
  },

  'go-module-scan': {
    focusKeywords: ['go.mod', 'internal', 'cmd', 'build tags', 'interface', 'init()', 'package'],
    steps: [
      {
        phase: '1. 模块结构分析',
        action: '阅读 go.mod，浏览 cmd/ 目录和 internal/ 目录',
        expectedOutput: 'go.mod 依赖图 + 入口点枚举 + internal 包边界',
        tools: ['read_file 阅读 go.mod', 'list_dir 浏览 cmd/ 和 internal/'],
      },
      {
        phase: '2. 接口分布分析',
        action: '搜索 interface 定义和实现，分析接口设计模式',
        expectedOutput: '核心接口清单 + 实现关系',
        tools: ['grep_search 搜索 type.*interface'],
      },
      {
        phase: '3. 初始化与构建',
        action: '搜索 init() 函数、build tags，分析初始化链路',
        expectedOutput: 'init() 执行链路 + build tags 约束',
        tools: ['grep_search 搜索 func init()/go:build'],
      },
      {
        phase: '4. 提交',
        action: '模块结构、接口约定、初始化模式分别提交候选（**最少 3 条，目标 5 条**）',
        qualityChecklist: [
          '候选数量 ≥3（模块结构、接口约定、初始化模式独立提交）',
          'content 包含模块依赖关系和接口设计',
          '引用 go.mod 和核心包路径',
          'coreCode 展示标准的接口定义和使用',
          'doClause 表达模块边界和导入约束',
        ],
      },
    ],
    timeEstimate: '1-5 min',
    commonMistakes: [
      '不要忽略 internal/ 包的隔离边界 — 这是 Go 的强制约束',
      '不要只列出依赖不说明用途',
      '注意区分项目自有模块和第三方模块',
    ],
  },
};

// ═══════════════════════════════════════════════════════════
// Quality Checklist (提交前自检清单)
// ═══════════════════════════════════════════════════════════

export const PRE_SUBMIT_CHECKLIST = {
  MUST: [
    'content.markdown ≥ 200 字符（含 ## 标题 + 正文 + 代码块 + 来源标注）',
    '引用 ≥ 3 个项目真实文件路径（不得编造文件路径）',
    '至少 1 个 ```代码块``` + 来源标注「(来源: FileName.ext:行号)」',
    'doClause 英文祈使句 + 以动词开头 + ≤60 tokens + 包含项目特定信息',
    'dontClause 英文反向约束 + 描述具体的禁止做法',
    'whenClause 英文触发场景 + 描述具体的适用条件',
    'trigger 唯一 + @kebab-case 格式',
    'coreCode 3-8 行可复制纯代码骨架（语法完整、括号配对）',
    'kind 正确分类: rule=强制约束 | pattern=实现模式 | fact=项目事实',
    'usageGuide ### 章节格式使用指南 — 描述何时使用此模式、步骤和注意事项',
    '标题和正文禁止出现 "Agent" 字样 — 所有候选必须以项目规范/开发规范视角撰写',
  ],
  SHOULD: [
    '每个候选聚焦单一知识点 — 不要把多种模式合并成一个候选',
    'content 包含统计数据（数量、占比、频率）',
    'content 包含 ✅ 正确写法 和 ❌ 禁止写法的对比',
    'reasoning.whyStandard 解释为什么这是项目标准（含统计证据）',
    'reasoning.sources 列出 ≥2 个文件路径作为证据来源',
    'reasoning.confidence ≥ 0.8',
  ],
  FAIL_EXAMPLES: [
    {
      bad: {
        content: '项目使用 Swift 语言开发',
        doClause: 'use swift',
        coreCode: '// swift code',
      },
      why: 'content 太短且无项目特征 — 没有展示任何具体的代码模式或约定; doClause 不是祈使句且无具体规则; coreCode 不是可复制的代码骨架',
      good: {
        content:
          '## BD 前缀单例管理类\n\n项目中所有 Manager 单例类使用 BD 前缀 + sharedInstance 模式...\n\n### 项目选择了什么\n18 个 Manager 类中 16 个使用此模式...\n\n```objc\n@interface BDVideoManager : NSObject\n+ (instancetype)sharedInstance;\n@end\n```\n(来源: BDVideoManager.h:12)',
        doClause: 'Use BD prefix and sharedInstance class method for all singleton Manager classes',
        coreCode:
          '+ (instancetype)sharedInstance {\n    static id instance;\n    static dispatch_once_t onceToken;\n    dispatch_once(&onceToken, ^{ instance = [[self alloc] init]; });\n    return instance;\n}',
      },
    },
    {
      bad: {
        content: '## 网络请求\n\n项目有网络请求功能。使用了 URLSession。',
        doClause: 'Make network requests using URLSession',
        coreCode: 'URLSession.shared.dataTask(url)',
      },
      why: 'content 虽有标题但只有两句话 — 缺少项目特有的封装/约定/统计; doClause 是 iOS 通用知识非项目特有; coreCode 不是项目封装的调用方式',
      good: {
        content:
          '## BDBaseRequest 网络请求封装\n\n项目所有网络请求必须通过 BDBaseRequest 子类发起...\n\n### 项目选择了什么\n47 个 API 请求全部继承自 BDBaseRequest，使用 BDNetworkManager 调度...\n\n```objc\n@interface BDUserInfoRequest : BDBaseRequest\n- (void)startWithSuccess:(BDRequestSuccess)success failure:(BDRequestFailure)failure;\n@end\n```\n(来源: BDUserInfoRequest.h:8)\n\n### 新代码怎么写\n继承 BDBaseRequest，覆写 requestUrl 和 requestMethod...',
        doClause:
          'Subclass BDBaseRequest for all network requests and use BDNetworkManager for dispatch',
        coreCode:
          '@interface MyRequest : BDBaseRequest\n- (NSString *)requestUrl { return @"/api/v2/xxx"; }\n- (BDRequestMethod)requestMethod { return BDRequestMethodGET; }\n@end',
      },
    },
  ],
};

// ═══════════════════════════════════════════════════════════
// SOP 查询辅助函数
// ═══════════════════════════════════════════════════════════

/**
 * 获取维度的 SOP 配置
 * @param dimId 维度 ID
 * @returns SOP 配置，未定义时返回 null
 */
export function getDimensionSOP(dimId: string) {
  return (
    (
      DIMENSION_SOP as Record<
        string,
        {
          focusKeywords?: string[];
          steps: Array<{
            phase: string;
            action: string;
            expectedOutput?: string;
            tools?: string[];
            qualityChecklist?: string[];
          }>;
          timeEstimate?: string;
          commonMistakes?: string[];
        }
      >
    )[dimId] || null
  );
}

/**
 * 获取维度的关键关注域词汇（用于 EpisodicMemory 跨维度 findings 相关性匹配）
 *
 * 优先使用 SOP 中显式定义的 focusKeywords；
 * 若无，则从 baseDimension.guide 按中文顿号/逗号/斜杠拆分。
 *
 * @param dimId 维度 ID
 * @param [guideText] fallback: baseDimension.guide 文本
 * @returns 关键词列表（短语级，用于 includes() 匹配）
 */
export function getDimensionFocusKeywords(dimId: string, guideText = '') {
  const sop = (DIMENSION_SOP as Record<string, { focusKeywords?: string[] }>)[dimId];
  if (sop?.focusKeywords && sop.focusKeywords.length > 0) {
    return sop.focusKeywords;
  }
  // fallback: 从 guide 文本按常见分隔符拆分
  if (guideText) {
    return guideText
      .split(/[、，,/·]/) // 中文顿号、逗号、英文逗号、斜杠、中文间隔号
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && s.length <= 30);
  }
  return [];
}

/**
 * 将 SOP 步骤序列化为紧凑文本（用于体积紧张时的降级）
 * @param sop SOP 配置
 * @returns 紧凑的文本表示
 */
export function sopToCompactText(
  sop:
    | {
        steps?: Array<{ phase: string; action: string; expectedOutput?: string }>;
        commonMistakes?: string[];
      }
    | null
    | undefined
) {
  if (!sop?.steps) {
    return '';
  }
  const lines: string[] = [];
  for (const step of sop.steps) {
    lines.push(`${step.phase}: ${step.action}`);
    if (step.expectedOutput) {
      lines.push(`  → 预期产出: ${step.expectedOutput}`);
    }
  }
  if (sop.commonMistakes && sop.commonMistakes.length > 0) {
    lines.push('\n⚠ 常见错误:');
    for (const m of sop.commonMistakes) {
      lines.push(`  - ${m}`);
    }
  }
  return lines.join('\n');
}
