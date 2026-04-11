/**
 * DimensionSop — 维度分析 SOP（Standard Operating Procedure）
 *
 * 每个维度定义 3 个自定义分析阶段 + 自动生成的提交阶段。
 * Builder 模式消除 Phase 4 重复 & 共享质量检查清单。
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 分析阶段定义（Phase 1–3） */
interface SopPhase {
  readonly name: string;
  readonly action: string;
  readonly output: string;
  readonly tools?: readonly string[];
}

/** 紧凑 SOP 输入（每个维度只需定义这些） */
interface CompactSop {
  readonly keywords?: readonly string[];
  readonly phases: readonly [SopPhase, SopPhase, SopPhase];
  readonly submitAction: string;
  readonly submitExtras?: readonly string[];
  readonly mistakes: readonly string[];
}

/** 完整 SOP 步骤（消费者使用的形状） */
export interface FullSopStep {
  phase: string;
  action: string;
  expectedOutput?: string;
  tools?: string[];
  qualityChecklist?: string[];
  [key: string]: unknown; // Record<string, unknown> 兼容
}

/** 完整 SOP 对象（消费者使用的形状） */
export interface FullSop {
  focusKeywords?: string[];
  steps: FullSopStep[];
  timeEstimate: string;
  commonMistakes: string[];
  [key: string]: unknown; // Record<string, unknown> 兼容
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Shared Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Phase 4 共享质量检查项（与 PRE_SUBMIT_CHECKLIST 互补，非重复） */
const SHARED_SUBMIT_CHECKLIST: readonly string[] = [
  '**数量由证据决定** — 有几条扎实证据就提交几条，不凑数；若本维度在项目中无实质内容则跳过，提交 0 条',
  'content 包含 ✅ 正确写法 和 ❌ 禁止写法（如适用）',
  'coreCode 是可复制的完整代码骨架',
  'doClause 英文祈使句，以动词开头',
  '引用具体的文件路径和代码行',
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Builder
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 从紧凑定义生成消费者兼容的完整 SOP 对象 */
function _sop(def: CompactSop): FullSop {
  const steps: FullSopStep[] = def.phases.map((p, i) => ({
    phase: `${i + 1}. ${p.name}`,
    action: p.action,
    expectedOutput: p.output,
    ...(p.tools ? { tools: [...p.tools] } : {}),
  }));

  steps.push({
    phase: `${steps.length + 1}. 提交`,
    action: def.submitAction,
    qualityChecklist: [...SHARED_SUBMIT_CHECKLIST, ...(def.submitExtras ?? [])],
  });

  return {
    ...(def.keywords ? { focusKeywords: [...def.keywords] } : {}),
    steps,
    timeEstimate: '1-5 min',
    commonMistakes: [...def.mistakes],
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ┌──────────────────────────────────────────────┐
// │  Universal Dimensions (13)                   │
// └──────────────────────────────────────────────┘
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COMPACT_SOPS: Record<string, CompactSop> = {
  // ──────────────────────────────────────────────
  // 1. coding-standards — 命名/注释/文件组织/代码风格
  // ──────────────────────────────────────────────
  'coding-standards': {
    keywords: [
      '命名约定',
      '类名前缀',
      '方法签名',
      '注释风格',
      '文件组织',
      'camelCase',
      'PascalCase',
      'snake_case',
      'MARK',
      'access control',
      'import 排序',
      '缩进',
      '代码规范',
    ],
    phases: [
      {
        name: '命名体系扫描',
        action:
          '搜索项目中类/协议/结构体的定义语句，统计类名前缀后缀模式（如 BD/XY 前缀、ViewModel/Service/Repository 后缀）、方法命名风格（动词开头 vs 名词短语）、变量命名约定（camelCase/snake_case）、常量命名方式',
        output: '项目命名体系全景：类名模式、方法名惯例、变量/常量命名约定、文件名与类名的对应关系',
        tools: [
          'grep_search 搜索 class/struct/protocol/interface/enum 定义',
          '浏览核心目录文件列表观察文件命名规律',
        ],
      },
      {
        name: '规范一致性验证',
        action:
          '跨模块选取核心文件（覆盖不同功能区域），逐一阅读，验证：命名模式是否全局一致、注释风格（MARK 段落/文档注释格式/行内注释习惯）、文件内代码组织顺序（属性→初始化→公开方法→私有方法）、import 排列规则（系统框架/第三方/项目内 分组情况）、access control 使用惯例（public/internal/private/fileprivate 的选择策略）',
        output: '每条规范有跨模块证据支撑，含具体 文件名:行号 引用',
        tools: ['read_file 逐个阅读不同模块的代表性文件'],
      },
      {
        name: '偏差与例外检测',
        action:
          '搜索偏离主流命名体系的代码（不同前缀、不同命名风格、不同文件组织方式），区分"历史遗留"、"第三方适配"和"有意的例外设计"',
        output: '偏差清单及其成因分类 — 判断哪些是要遵循的规范、哪些是要避免的旧写法',
      },
    ],
    submitAction:
      '每种规范独立提交候选（**按实际发现提交，无实质内容则跳过本维度**），每个候选聚焦一种具体代码规范',
    submitExtras: [
      '每个候选聚焦单一规范维度（命名约定、注释风格、文件组织、import 规则、access control 分别独立）',
    ],
    mistakes: [
      '不要只看一两个文件就归纳规范 — 必须跨模块验证一致性，以偏概全是最常见错误',
      '不要合并不同层次的规范 — "类名前缀"、"方法命名风格"、"文件内代码组织"各自独立成条',
      '不要写空泛规范如 "use camelCase" — 必须写明项目特有的前缀/后缀/风格及其适用范围',
      '不要遗漏 access control 约定和 import 排列规则 — 这些是高频编码动作，对一致性影响大',
      '【跨维度边界】coding-standards 只关注命名/注释/文件组织/代码风格 — 设计模式归 design-patterns，分层架构归 architecture',
    ],
  },

  // ──────────────────────────────────────────────
  // 2. design-patterns — 设计模式的使用与实现
  // ──────────────────────────────────────────────
  'design-patterns': {
    keywords: [
      'Singleton',
      'Factory',
      'Delegate',
      'Observer',
      'Builder',
      'Repository',
      'Strategy',
      'Coordinator',
      'Adapter',
      '设计模式',
      '工厂',
      '单例',
      '代理',
      'Protocol',
      '接口',
      'shared',
      'default',
      'make',
      'create',
    ],
    phases: [
      {
        name: '模式发现',
        action:
          '搜索项目中设计模式的典型信号：Singleton(shared/default/instance), Factory(create/make/build), Delegate(delegate/dataSource), Observer(listener/subscribe/on), Repository(repository/store/dao), Coordinator(coordinator/router/navigator), Strategy(protocol+多实现), Builder(builder/configure)',
        output: '项目设计模式全景图：每种模式的使用位置、频率、变体形式',
        tools: [
          'grep_search 搜索 shared/default/create/make/delegate/subscribe 等信号词',
          '浏览核心目录结构识别模式集中区域',
        ],
      },
      {
        name: '实现规范提取',
        action:
          '阅读每种模式的代表性实现文件，提取项目的标准写法：线程安全策略（Singleton 的初始化方式）、创建约束（Factory 的参数校验）、生命周期管理（Delegate 的弱引用）、注册/注销对称性（Observer 的移除时机）',
        output: '每种模式的规范实现骨架（含线程安全、生命周期、约束规则）+ 多个实现实例的代码引用',
        tools: ['read_file 阅读模式核心实现文件'],
      },
      {
        name: '反模式与滥用检测',
        action:
          '搜索模式的不规范使用：God Object（单个类包含过多职责）、过度继承（深继承链）、滥用 Singleton（本应局部作用域的实例被全局化）、空 Delegate 方法（实现了协议但方法体为空）',
        output: '反模式实例清单（含文件位置），或确认项目模式使用健康',
      },
    ],
    submitAction:
      '每种设计模式单独提交候选（**按实际发现提交，无实质内容则跳过本维度**），包含标准实现骨架和使用约束',
    submitExtras: [
      '每个候选只聚焦一种设计模式的项目特定实现',
      'whenClause 需说明何时应使用此模式，dontClause 说明何时不应使用',
    ],
    mistakes: [
      '不要将不同模式合并为一个候选（如 "创建型模式"）— Singleton 和 Factory 必须分别提交',
      '不要只列模式名称 — 必须包含项目中的实际实现代码，展示规范写法',
      '不要把框架内置模式当作项目自定义模式 — 只提取项目团队主动采用和约定的模式',
      '不要忽略模式的约束面（线程安全、生命周期、弱引用）— 约束才是 Recipe 的核心价值',
      '【跨维度边界】design-patterns 只关注模式的实现规范 — 架构分层归 architecture，编码命名归 coding-standards',
    ],
  },

  // ──────────────────────────────────────────────
  // 3. architecture — 分层架构/模块边界/依赖方向
  // ──────────────────────────────────────────────
  architecture: {
    keywords: [
      '架构',
      '分层',
      '模块',
      '依赖方向',
      'import',
      '目录结构',
      'Package',
      'module',
      'layer',
      'feature',
      'target',
      '依赖注入',
      'DI',
      '组装',
      '启动流程',
      '路由',
    ],
    phases: [
      {
        name: '架构层次映射',
        action:
          '浏览项目根目录和核心子目录，识别分层架构类型（MVC/MVVM/Clean Architecture/Feature-based/Monorepo）。阅读构建配置（Package.swift/build.gradle/package.json/Cargo.toml/go.mod/pyproject.toml/CMakeLists.txt）确认模块划分。绘制层次关系：哪些目录属于哪一层、各层的职责边界',
        output: '架构层次图：层名→目录映射→职责定义→层间依赖方向（上层→下层，禁止反向）',
        tools: ['list_dir 浏览目录树（至少两层深度）', 'read_file 阅读构建配置文件确认模块划分'],
      },
      {
        name: '依赖规则提取',
        action:
          '跨层选取文件阅读 import 语句，验证依赖方向是否全局一致。重点关注：表现层是否依赖了数据层、模块间是否通过协议/接口解耦、是否存在跨 Feature 的直接引用。提取项目的依赖注入/组装方式（构造器注入/Service Locator/DI Container）',
        output: '依赖规则矩阵（层A可→层B, 层A禁→层C）+ 依赖注入机制说明 + 违规实例（如有）',
        tools: [
          'grep_search 搜索 import/include/require/from 语句',
          'read_file 阅读 DI/组装/启动入口文件',
        ],
      },
      {
        name: '边界违规与通信检测',
        action:
          '搜索跨层直接调用、循环依赖信号。分析模块间通信方式：事件总线/NotificationCenter/URL 路由/协议抽象/回调闭包。确认是否存在启动顺序依赖或隐式耦合',
        output: '模块通信模式清单 + 边界违规实例 + 启动流程依赖图',
      },
    ],
    submitAction:
      '分层规则、依赖方向约束、模块通信模式分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: [
      'dontClause 明确表达禁止的跨层调用方向',
      'content 中包含架构层次图（文字描述即可）和依赖方向规则',
    ],
    mistakes: [
      '不要只罗列目录结构 — 必须分析出层间依赖方向和约束规则，目录本身不是知识',
      '不要遗漏依赖注入/组装机制 — 这是架构的关键胶水层',
      '不要把分层架构和模块通信合并 — "禁止 Feature 间直接 import"和"使用 URL 路由跨 Feature 通信"是两条独立规则',
      '不要忽略启动流程中的隐式依赖和初始化顺序要求',
      '【跨维度边界】architecture 只关注分层/模块/依赖 — 设计模式归 design-patterns，编码风格归 coding-standards',
    ],
  },

  // ──────────────────────────────────────────────
  // 4. error-resilience — 错误处理体系与降级策略
  // ──────────────────────────────────────────────
  'error-resilience': {
    keywords: [
      'Error',
      'Exception',
      'catch',
      'throw',
      'Result',
      'try',
      'retry',
      'fallback',
      'recovery',
      '错误处理',
      '异常',
      '降级',
      'ErrorType',
      'UserFacingError',
      'toast',
      '错误码',
      'error mapping',
      '错误传播',
    ],
    phases: [
      {
        name: '错误类型体系扫描',
        action:
          '搜索项目中的 Error/Exception 类型定义，构建错误类型层次树。区分：业务错误（如 APIError/BizError）、系统错误（网络/存储/权限）、用户面向错误（展示给用户的提示文案）。关注错误码体系（如有）和错误枚举的分类方式',
        output: '错误类型层次图：基类→子类/枚举→使用场景映射。含错误码编排规则（如有）',
        tools: [
          'grep_search 搜索 Error/Exception/enum.*Error 定义',
          '浏览 Error/Exception 类型集中目录',
        ],
      },
      {
        name: '错误传播链路追踪',
        action:
          '选取典型业务流程（如网络请求→解析→展示），阅读完整调用链，追踪错误从底层到表现层的传播路径：底层抛出什么错误→中间层如何转换/包装→表现层如何展示给用户。关注统一错误转换层（如 Error Mapper/Handler）、重试策略（指数退避/有限次数）、降级方案（缓存兜底/默认值）',
        output: '错误传播全链路图（底层→中间层→表现层）+ 重试策略说明 + 降级机制说明',
        tools: ['read_file 沿调用链逐层阅读错误处理代码'],
      },
      {
        name: '薄弱点检测',
        action:
          '搜索错误处理的薄弱环节：空 catch 块（静默吞错误）、裸 catch（catch 所有异常不区分类型）、未处理的 Promise/async 错误、缺失的 error 回调、print/NSLog 替代正式错误处理',
        output: '错误处理薄弱点清单 + 项目整体错误处理健康度评估',
      },
    ],
    submitAction:
      '错误类型体系、错误传播规则、重试与降级策略分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['每个候选聚焦单一错误处理维度 — 类型体系、传播规则、重试策略、用户提示各自独立'],
    mistakes: [
      '不要把所有错误处理塞进一个候选 — 错误类型体系、传播规则、重试策略、用户提示应分别提交',
      '不要只写 "使用 try/catch" — 必须说明项目特定的错误类型层次和转换规则',
      '不要忽略错误传播链路 — "底层 NetworkError 如何变成用户看到的 toast 文案"才是核心知识',
      '不要遗漏降级策略 — 缓存兜底、默认值回退、优雅退出等异常恢复路径同样重要',
      '【跨维度边界】error-resilience 只关注错误处理与恢复 — 日志记录归 observability-logging，线程安全归 concurrency-async',
    ],
  },

  // ──────────────────────────────────────────────
  // 5. data-event-flow — 数据流/状态管理/事件传播
  // ──────────────────────────────────────────────
  'data-event-flow': {
    keywords: [
      '数据流',
      'event',
      '事件',
      'state',
      '状态管理',
      'Observable',
      'Subject',
      'Driver',
      'Relay',
      'Signal',
      'Redux',
      'Store',
      'Combine',
      'Flow',
      'Publisher',
      '响应式',
      'binding',
      'emit',
      'subscribe',
      'disposeBag',
      'Notification',
      'EventBus',
      'KVO',
    ],
    phases: [
      {
        name: '数据流框架识别',
        action:
          '搜索项目中的状态管理和事件框架信号：Rx系列(Observable/Subject/Driver/Relay/Flowable), Combine/Publisher, Redux/Flux(Store/Action/Reducer/dispatch), Vuex/Pinia/Zustand(state/mutations/actions), EventBus/Notification/KVO/LiveData/StateFlow。确认主框架选型及其在项目中的角色分配',
        output: '数据流技术选型全景：主框架 + 辅助机制 + 各层的角色分配',
        tools: [
          'grep_search 搜索 Observable/Subject/Publisher/Store/dispatch 等信号词',
          '浏览状态管理/ViewModel 集中目录',
        ],
      },
      {
        name: '数据绑定模式深挖',
        action:
          '阅读核心 ViewModel/Store 文件，深入分析：数据绑定方式（单向/双向）、Input→Output 转换模式、事件传播路径（用户操作→ViewModel→Service→Repository 的完整链路）、状态持久化策略（内存/磁盘/远程同步）。特别关注 Output 类型约束（如 Driver 不能 error、Relay 必须有初始值）',
        output: '数据绑定标准模式：输入→转换→输出→UI 的完整链路图 + Output 类型约束规则',
        tools: ['read_file 阅读核心 ViewModel/Store/Reducer 文件'],
      },
      {
        name: '订阅泄漏检测',
        action:
          '搜索内存泄漏风险模式：未取消的订阅/观察者(disposeBag/cancellable/removeObserver/取消订阅)、闭包/回调内强引用导致循环引用、未取消的 Timer/定时器、长生命周期对象持有短生命周期对象的订阅',
        output: '泄漏风险点清单 + 项目已有的防泄漏机制（disposeBag 管理策略、weak self 约定）',
      },
    ],
    submitAction:
      '数据绑定模式、事件传播路径、订阅管理规则分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['每个候选聚焦单一数据流模式，说明其适用场景和约束'],
    mistakes: [
      '不要只描述框架 API（如 "使用 Observable"）— 必须说明项目如何使用该框架、约定了哪些模式',
      '不要混淆不同框架的模式 — 如果项目同时使用多种响应式/状态管理框架，应按框架分别提交',
      '不要忽略订阅的生命周期管理 — 订阅取消/引用管理/防泄漏机制的使用约定是核心知识',
      '不要遗漏 Output 类型约束 — "Driver 不能 error" 这类约束比 "使用 Driver" 更有价值',
      '【跨维度边界】data-event-flow 只关注数据流/事件/状态 — UI 组件构建归 ui-interaction，设计模式归 design-patterns',
    ],
  },

  // ──────────────────────────────────────────────
  // 6. agent-guidelines — 团队开发指南与隐性约定
  // ──────────────────────────────────────────────
  'agent-guidelines': {
    keywords: [
      'Agent',
      'AI',
      'Copilot',
      'prompt',
      '指南',
      'guideline',
      '约定',
      'convention',
      '规范文档',
      'CONTRIBUTING',
      'AGENTS',
      'PR template',
      'commit message',
      'code review',
      'CI',
      'lint',
      'pre-commit',
      'husky',
    ],
    phases: [
      {
        name: '显式规范收集',
        action:
          "搜索项目中所有开发指南文档：CONTRIBUTING.md, AGENTS.md, CODE_OF_CONDUCT.md, .github/ 下的 PR template/issue template, docs/ 中的开发文档。逐一阅读，提取可编码的规则（明确的 DO/DON'T 约束）",
        output: '显式规范清单：每条规范的来源文档、规则内容、约束范围（全局/某模块/某语言）',
        tools: [
          'file_search 搜索 CONTRIBUTING/AGENTS/GUIDELINES/CONVENTIONS 文件',
          'list_dir 浏览 .github/ 和 docs/ 目录',
        ],
      },
      {
        name: '规则强度分级',
        action:
          '区分硬规则（CI 强制执行、lint 报错、pre-commit 拦截）和软指南（文档建议但无自动化检查）。阅读 CI 配置(.github/workflows/)、lint 配置(biome.json/.eslintrc/swiftlint.yml/rustfmt.toml/.golangci.yml/flake8/mypy.ini)、pre-commit/husky 配置，提取被工具链强制的规则',
        output: '规则强度矩阵：硬规则（工具强制）vs 软指南（文档建议）+ 每条规则的强制机制',
        tools: [
          'read_file 阅读 CI 配置和 lint 配置文件',
          'grep_search 搜索 lint/format/check 相关命令',
        ],
      },
      {
        name: '隐性规范发现',
        action:
          '分析 PR template 中的必填项、commit message 格式（Conventional Commits/Semantic）、branch 命名约定、代码 review 的 approve 规则。搜索 .editorconfig、.prettierrc 等格式化配置。寻找文档中没写但团队实际遵循的约定',
        output: '隐性规范列表 + 发现路径（从配置/模板/历史 commit 中推断）',
      },
    ],
    submitAction:
      "每条开发规范独立提交候选（**按实际发现提交，无实质内容则跳过本维度**），含明确的 DO/DON'T",
    submitExtras: ['每个候选标注规则强度（硬规则/软指南）和强制机制'],
    mistakes: [
      '不要照搬文档原文 — 必须提炼为可执行的规则，冗长的说明段落不是 Recipe',
      '不要忽略 CI/lint/pre-commit 配置中的隐性规范 — 这些往往比文档更权威',
      '不要把代码风格和提交规范合并 — "import 排序"和"commit message 格式"是不同主题',
      '不要遗漏 PR template 和 branch 命名约定 — 这些是团队协作的高频触发规则',
      '【跨维度边界】agent-guidelines 只关注团队级开发约定 — 代码命名细节归 coding-standards，架构规则归 architecture',
    ],
  },

  // ──────────────────────────────────────────────
  // 7. concurrency-async — 并发模型/线程安全/异步策略
  // ──────────────────────────────────────────────
  'concurrency-async': {
    keywords: [
      'async',
      'await',
      'Task',
      'Actor',
      'Sendable',
      '@MainActor',
      'DispatchQueue',
      'GCD',
      'Thread',
      'Lock',
      'NSLock',
      'Mutex',
      'Promise',
      'Future',
      'concurrent',
      'semaphore',
      '并发',
      '异步',
      '线程安全',
      '数据竞争',
      '死锁',
    ],
    phases: [
      {
        name: '并发模型全景扫描',
        action:
          '搜索项目中的并发原语和异步模式：structured concurrency(async/await/Task/TaskGroup/asyncio), actors/isolates, locks/mutexes(Mutex/synchronized/Lock/RWLock), thread pools/executors/dispatch queues, Promise/Future/Rx/Channel/Flow。统计各种并发模型的使用频率和场景分布',
        output: '并发模型使用全景：主模型选型 + 各层/各场景的并发策略分布',
        tools: [
          'grep_search 搜索 async/await/Task/Actor/Lock/Mutex/Thread/coroutine/goroutine 等关键词',
        ],
      },
      {
        name: '线程安全策略提取',
        action:
          '阅读核心并发文件，提取项目的线程安全约定：共享可变状态的保护方式(Lock/Actor/Mutex/串行队列/synchronized)、UI 线程保障机制(MainActor/main thread dispatch/runOnUiThread)、跨线程数据传递方式(值拷贝/不可变引用/Channel/Queue)、线程安全标注或约束(Sendable/ThreadSafe/@WorkerThread)',
        output: '线程安全策略矩阵：各场景的标准做法 + 标准代码骨架',
        tools: ['read_file 阅读包含并发逻辑的核心文件'],
      },
      {
        name: '竞态与死锁风险检测',
        action:
          '搜索并发风险信号：未加锁的共享可变状态、缺少 UI 线程保障的界面更新代码、嵌套锁(潜在死锁)、异步闭包/回调中的资源泄漏(未释放引用/未取消订阅)、回调地狱(多层嵌套的异步回调)',
        output: '并发风险点清单 + 项目已有的防护机制评估',
      },
    ],
    submitAction:
      '并发模型选型、线程安全策略、锁使用模式分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['每个候选聚焦单一并发策略，coreCode 展示标准的线程安全写法'],
    mistakes: [
      '不要把不同并发策略混在一个候选中 — 不同锁/队列/Actor 模式应独立成条',
      '不要写通用并发理论 — 必须引用项目实际代码，展示项目团队选择的具体方案',
      '不要忽略 UI 线程保障 — 确保界面更新总是在主线程/UI 线程执行是最常见的并发约束',
      '不要忽略异步上下文中的资源管理 — 引用捕获/订阅取消/上下文传递策略是关键决策',
      '【跨维度边界】concurrency-async 只关注并发/线程安全 — 错误处理归 error-resilience，性能优化归 performance-optimization',
    ],
  },

  // ──────────────────────────────────────────────
  // 8. networking-api — 网络请求/API 封装/接口规范
  // ──────────────────────────────────────────────
  'networking-api': {
    keywords: [
      'API',
      'HTTP',
      'REST',
      'GraphQL',
      'WebSocket',
      'URLSession',
      'Alamofire',
      'Moya',
      'fetch',
      'axios',
      '网络请求',
      '接口',
      'endpoint',
      'request',
      'response',
      'interceptor',
      'middleware',
      'token',
      'retry',
      'timeout',
    ],
    phases: [
      {
        name: '网络架构映射',
        action:
          '搜索项目的网络请求基础设施：HTTP 客户端选型(URLSession/OkHttp/Retrofit/fetch/axios/requests/net/http)、API 定义方式(枚举/类/装饰器/接口)、请求构建流程(URL+参数+Header+Body 的组装方式)、拦截器/中间件链(认证注入/日志/重试/缓存)',
        output: '网络架构全景图：技术选型 → 分层结构 → 请求流水线（构建→拦截→发送→响应→解析）',
        tools: [
          'grep_search 搜索 request/response/API/endpoint/interceptor 关键词',
          '浏览网络层/API 定义目录',
        ],
      },
      {
        name: '请求全链路分析',
        action:
          '阅读核心网络封装文件，追踪一个典型 API 请求的完整生命周期：API 定义→请求构建→Header/Token 注入→错误码映射→响应模型解析→结果包装(Result/Observable)。提取认证管理(Token 存储/刷新/过期处理)、超时/重试策略、响应缓存机制',
        output: '标准 API 请求全链路文档 + 认证流程 + 重试策略 + 缓存策略',
        tools: ['read_file 沿请求链路逐层阅读网络封装文件'],
      },
      {
        name: '安全与健壮性检测',
        action:
          '搜索网络层风险：硬编码的 URL/API Key、不安全的 HTTP 配置(允许明文传输)、缺失的证书校验、无超时的请求、未处理的网络错误场景(无网络/超时/服务端 5xx)',
        output: '网络安全检查结果 + 健壮性评估 + API 版本管理策略',
      },
    ],
    submitAction:
      '网络架构、请求模式、认证管理、响应解析分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['doClause 强制使用项目的网络封装层，禁止直接调用底层 HTTP API'],
    mistakes: [
      '不要描述底层 HTTP 库的通用 API 用法 — 必须说明项目特定的封装方式和约定',
      '不要忽略认证/Token 管理 — Token 存储位置、刷新机制、过期处理是网络层核心知识',
      '不要遗漏错误码映射规则 — 服务端返回的 code/status 如何映射到客户端 Error 类型',
      '不要忽略超时、重试、缓存策略 — 这些直接影响用户体验和接口健壮性',
      '【跨维度边界】networking-api 只关注网络请求链路 — 数据持久化归 data-event-flow，认证安全细节归 security-auth',
    ],
  },

  // ──────────────────────────────────────────────
  // 9. ui-interaction — UI 构建/布局/交互/样式
  // ──────────────────────────────────────────────
  'ui-interaction': {
    keywords: [
      'UI',
      'View',
      'Layout',
      'Animation',
      'SnapKit',
      'AutoLayout',
      'CSS',
      'Component',
      'Tailwind',
      'Styled',
      '界面',
      '布局',
      '动画',
      '交互',
      'gesture',
      '手势',
      'Dark Mode',
      '主题',
      'theme',
      'accessibility',
      '无障碍',
    ],
    phases: [
      {
        name: 'UI 技术栈识别',
        action:
          '搜索项目的 UI 构建方式：布局技术(代码布局/声明式UI/XML布局/CSS/模板引擎)、布局引擎(AutoLayout/SnapKit/Flexbox/Grid/ConstraintLayout/Compose)、组件库(自定义基础组件/第三方 UI 库)、动画框架。识别是否有统一的 BaseView/BaseComponent',
        output: 'UI 技术栈全景：布局方式 + 组件库 + 基类继承体系 + 动画技术',
        tools: ['grep_search 搜索项目使用的布局/UI 框架关键词', '浏览 UI/View/Component 集中目录'],
      },
      {
        name: '组件规范深挖',
        action:
          '阅读核心 UI 组件和 ViewController/Page，提取：布局代码的标准写法（约束创建方式/布局方法命名）、样式管理策略（颜色/字体/间距是否有统一管理）、主题/Dark Mode 适配方式、复用组件的使用约定（Cell/Header/Footer 的标准实现）',
        output: 'UI 组件标准实现模式：布局写法 + 样式管理 + 主题适配 + 组件复用约定',
        tools: ['read_file 阅读核心 ViewController/Component/Cell 实现文件'],
      },
      {
        name: 'UI 一致性检测',
        action:
          '搜索 UI 实现的不一致现象：混用不同布局方式（同一项目中多种布局引擎共存）、硬编码样式值（直接写颜色/字体数值而非引用常量/token）、遗漏 Dark Mode 适配（未使用动态颜色/CSS 变量）、缺失无障碍标注(accessibilityLabel/contentDescription/aria-label)',
        output: 'UI 一致性问题清单 + 项目 UI 规范整体遵守情况评估',
      },
    ],
    submitAction:
      'UI 布局模式、样式管理、组件复用、主题适配分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['每个候选聚焦单一 UI 规范（布局写法 和 样式管理 是独立候选）'],
    mistakes: [
      '不要描述 UI 框架的通用 API — 必须说明项目特定的布局约定和样式管理方式',
      '不要合并不同层次的 UI 规范 — "布局约束写法"和"主题颜色管理"应独立提交',
      '不要忽略 Dark Mode/主题适配 — 动态颜色和样式切换是现代 UI 项目的标配',
      '不要遗漏基类/基组件继承约定 — BaseView/BaseActivity/BaseComponent 的重写点和使用规则是高频知识',
      '【跨维度边界】ui-interaction 只关注 UI 构建/布局/样式 — 数据绑定归 data-event-flow，设计模式归 design-patterns',
    ],
  },

  // ──────────────────────────────────────────────
  // 10. testing-quality — 测试策略/Mock/质量保障
  // ──────────────────────────────────────────────
  'testing-quality': {
    keywords: [
      'Test',
      'XCTest',
      'Jest',
      'Vitest',
      'pytest',
      'JUnit',
      'Mock',
      'Stub',
      'Spy',
      'Fixture',
      'Factory',
      '测试',
      '单元测试',
      '集成测试',
      'snapshot',
      'E2E',
      'coverage',
      'assert',
      'expect',
      'spec',
      'describe',
    ],
    phases: [
      {
        name: '测试基础设施扫描',
        action:
          '搜索项目的测试配置和目录结构：测试框架(XCTest/Jest/Vitest/pytest/JUnit/go test/RSpec)、测试目录组织(unit/integration/e2e 分离方式)、测试辅助工具(Mock 框架/Fixture 管理/测试 DSL)、CI 中的测试命令和覆盖率配置',
        output: '测试基础设施全景：框架选型 + 目录结构 + 覆盖率要求 + CI 集成方式',
        tools: [
          'file_search 搜索 *Test*/*Spec*/*test* 文件',
          'read_file 阅读测试配置(jest.config/vitest.config/pytest.ini)',
        ],
      },
      {
        name: '测试模式提取',
        action:
          '阅读核心测试文件，提取项目的测试约定：测试命名规则(test_功能_场景_预期/describe-it 结构)、Mock 创建方式(手写 Mock/框架 Mock/Protocol Mock)、Fixture/测试数据管理(Factory 模式/JSON 文件/Builder)、arrange-act-assert 结构、异步测试写法',
        output: '测试模式规范：命名约定 + Mock 策略 + Fixture 管理 + 异步测试写法',
        tools: ['read_file 阅读不同模块的测试文件（覆盖 Mock/Fixture/异步场景）'],
      },
      {
        name: '测试覆盖评估',
        action:
          '评估关键模块的测试覆盖情况：核心业务逻辑是否有对应测试、边界条件是否覆盖、Error 路径是否测试。识别测试薄弱区域和测试质量问题（过度 Mock 导致测试与实现耦合、测试名称不能描述场景）',
        output: '测试覆盖评估：强覆盖区域 + 薄弱区域 + 测试质量问题清单',
      },
    ],
    submitAction:
      '测试策略、Mock 模式、测试命名约定分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['每个候选聚焦单一测试规范，coreCode 展示标准测试骨架'],
    mistakes: [
      '不要只列出测试框架名称 — 必须说明项目特定的测试约定（命名/Mock/Fixture 管理方式）',
      '不要忽略 Mock 的创建和管理方式 — 手写 Mock vs Protocol Mock vs 框架 Mock 的选择策略是核心知识',
      '不要把单元测试和集成测试的约定混在一起 — 它们的 Mock 策略和 Fixture 管理通常不同',
      '不要遗漏异步测试的写法约定 — async/await 测试、异步等待机制(expectation/waitFor/eventually)、超时控制',
      '【跨维度边界】testing-quality 只关注测试策略和模式 — CI/CD 流程归 agent-guidelines',
    ],
  },

  // ──────────────────────────────────────────────
  // 11. security-auth — 认证/授权/安全存储
  // ──────────────────────────────────────────────
  'security-auth': {
    keywords: [
      'Auth',
      'Token',
      'JWT',
      'OAuth',
      'KeyChain',
      'Credential',
      'encrypt',
      'hash',
      'HTTPS',
      'SSL',
      'certificate',
      '安全',
      '认证',
      '授权',
      'permission',
      'CSRF',
      'XSS',
      'cookie',
      'session',
      'SSO',
      'biometric',
    ],
    phases: [
      {
        name: '认证架构映射',
        action:
          '搜索项目的认证/授权基础设施：认证方式(JWT/OAuth/Session/Cookie/SSO/生物识别)、Token 存储位置(Keychain/SharedPreferences/EncryptedStorage/HttpOnly Cookie/内存)、用户状态管理(登录/登出/Token 过期/Session 过期)、权限控制粒度(角色/功能/页面级)',
        output: '认证架构全景：认证方式 + Token 生命周期 + 权限控制体系 + 用户状态机',
        tools: [
          'grep_search 搜索 Token/Auth/Login/Credential/Session/OAuth 关键词',
          '浏览认证/安全相关目录',
        ],
      },
      {
        name: '安全实现深挖',
        action:
          '阅读认证模块核心文件，分析：Token 刷新策略(主动刷新/被动刷新/双 Token 机制)、敏感数据存储方式(加密方式/安全等级)、网络安全配置(HTTPS 强制/证书校验/Certificate Pinning)、输入校验(防 XSS/SQL 注入/CSRF Token)',
        output: '安全实现详图：Token 刷新流程 + 存储安全策略 + 网络安全配置 + 输入校验规则',
        tools: ['read_file 阅读认证/Token 管理/安全配置核心文件'],
      },
      {
        name: '安全漏洞扫描',
        action:
          '搜索安全风险信号：硬编码的密钥/Token/URL、明文存储敏感数据(明文写入本地存储/localStorage/UserDefaults/plain text file)、缺失的输入校验、允许 HTTP 明文传输的配置、日志中泄漏敏感信息(打印 Token/密码)',
        output: '潜在安全漏洞清单 + 严重等级评估 + 修复建议',
      },
    ],
    submitAction:
      '认证机制、Token 管理、安全存储、权限控制分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: [
      '严禁在候选的 coreCode/content 中包含实际密钥、Token 或敏感配置值',
      '每个候选必须引用具体的安全相关类名和文件路径 — 纯理论描述会被拒绝',
      '如果项目使用第三方 SDK 提供认证，只提交项目自身的集成方式和配置，不要重复 SDK 通用文档',
    ],
    mistakes: [
      '不要描述通用安全理论 — 必须说明项目特定的认证机制和存储方式',
      '严禁在候选中暴露实际的密钥、Token、API Secret 或敏感配置 — 用占位符替代',
      '不要忽略 Token 刷新机制 — "过期后如何自动刷新、刷新失败如何引导重新登录"是核心流程',
      '不要遗漏登录/登出的状态广播机制 — 其他模块如何感知认证状态变化',
      '不要将同一个认证流程拆分成过多候选 — "登录 + Token 存储 + Cookie 同步"如果是一个紧密耦合的流程，应合并为一个候选',
      '不要提交与 networking-api 维度重叠的内容 — HTTPS 配置、证书校验归本维度，但请求拦截、Header 注入归 networking-api',
      '【跨维度边界】security-auth 只关注认证/授权/安全 — 网络请求封装归 networking-api，错误处理归 error-resilience',
    ],
  },

  // ──────────────────────────────────────────────
  // 12. performance-optimization — 性能策略/缓存/资源管理
  // ──────────────────────────────────────────────
  'performance-optimization': {
    keywords: [
      '性能',
      'performance',
      'cache',
      '缓存',
      'lazy',
      '懒加载',
      'prefetch',
      '预加载',
      'throttle',
      'debounce',
      'pagination',
      'memory',
      '内存',
      'profiling',
      'benchmark',
      'image',
      '列表优化',
      'cell reuse',
      'virtual scroll',
      'CDN',
    ],
    phases: [
      {
        name: '性能策略扫描',
        action:
          '搜索项目中的性能优化策略：缓存(内存缓存/磁盘缓存/HTTP 缓存/CDN)、懒加载/延迟初始化(lazy init/dynamic import/按需创建)、预加载/预取(prefetch/preload)、列表优化(组件复用/虚拟滚动/分页加载)、图片/资源优化(压缩/缩放/缓存)、节流防抖(throttle/debounce/合并请求)',
        output: '性能优化策略全景：各场景的优化手段 + 技术选型 + 实现位置',
        tools: [
          'grep_search 搜索 cache/lazy/prefetch/throttle/debounce/reuse 关键词',
          '浏览缓存/性能相关目录',
        ],
      },
      {
        name: '策略实现深挖',
        action:
          '阅读核心性能优化文件，分析各策略的实现细节：缓存策略(淘汰算法/容量限制/过期机制)、列表分页(页码/游标/预加载阈值)、图片管线(下载→解码→缩放→缓存的链路)、启动优化(预热/懒加载/延迟任务)',
        output: '性能优化实现详图：各策略的标准实现 + 参数配置 + 使用约束',
        tools: ['read_file 阅读缓存管理器/列表优化/图片管线核心文件'],
      },
      {
        name: '性能瓶颈检测',
        action:
          '搜索可能的性能问题：主线程/UI 线程上的同步 I/O 或重计算、未缓存的重复网络请求、未复用的列表项组件、过大的资源未优化直接加载、内存泄漏点(未释放的缓存/循环引用/未取消的订阅)',
        output: '潜在性能瓶颈清单 + 优化优先级建议',
      },
    ],
    submitAction:
      '缓存策略、列表优化、图片管线、启动优化分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: [
      '每个候选聚焦单一优化策略，说明适用场景和配置参数',
      '每个候选的 coreCode 必须包含项目实际的类名/方法名/配置值 — 不能是伪代码或通用示例',
      'content.markdown 必须包含具体的度量数据或配置参数（如缓存大小、超时时间、阈值等）— 纯文字描述的优化建议会被拒绝',
    ],
    mistakes: [
      '不要写通用性能理论 — 必须引用项目实际的优化代码和配置参数',
      '不要合并不同维度的优化策略 — "内存缓存策略"和"列表分页加载"是独立候选',
      '不要忽略缓存的淘汰和过期机制 — "缓存了什么"不如"何时淘汰、容量多大"有价值',
      '不要遗漏资源加载优化 — 图片/字体/数据等大资源的压缩/缩放/缓存策略必须覆盖',
      '不要提交没有具体代码证据的性能建议 — "建议使用懒加载"不是候选，"项目中 XxxManager 使用单例/延迟初始化模式"才是候选',
      '不要重复框架/三方库的通用用法 — 只有项目对第三方库有自定义配置或封装时才值得提交',
      '【跨维度边界】performance-optimization 只关注性能优化策略 — 并发模型归 concurrency-async，网络策略归 networking-api',
    ],
  },

  // ──────────────────────────────────────────────
  // 13. observability-logging — 日志/监控/埋点/崩溃
  // ──────────────────────────────────────────────
  'observability-logging': {
    keywords: [
      'Log',
      'Logger',
      'os_log',
      'print',
      'NSLog',
      'console',
      '日志',
      '监控',
      'trace',
      'analytics',
      'metric',
      'event',
      'crash',
      'Sentry',
      'Firebase',
      'Crashlytics',
      'structured logging',
      '埋点',
      'APM',
    ],
    phases: [
      {
        name: '可观测性体系扫描',
        action:
          '搜索项目的日志和监控基础设施：日志框架(os_log/Logger/winston/log4j/自定义)、崩溃收集(Sentry/Firebase Crashlytics/Bugsnag)、性能监控APM(Firebase Performance/自建)、业务埋点(自定义事件/第三方 Analytics)、结构化日志(JSON 格式/标签体系)',
        output: '可观测性体系全景：日志框架 + 崩溃收集 + APM + 埋点 + 数据流向',
        tools: [
          'grep_search 搜索 Logger/log/analytics/track/Sentry/Crashlytics 关键词',
          '浏览日志/监控相关文件',
        ],
      },
      {
        name: '日志规范提取',
        action:
          '阅读日志封装文件，提取项目的日志约定：日志分级规则(verbose/debug/info/warning/error 各自的使用场景)、日志分类系统(Category/Tag/Module 标签)、格式约定(是否使用结构化日志)、Release 构建策略(哪些级别会在 Release 中输出、敏感信息过滤)',
        output: '日志规范矩阵：各级别的使用场景 + 分类标签体系 + Release 安全策略',
        tools: ['read_file 阅读 Logger 封装/Category 定义/日志配置文件'],
      },
      {
        name: '日志合规检测',
        action:
          '搜索日志使用的不规范之处：使用 print/NSLog 替代正式 Logger、日志中包含敏感数据(Token/密码/个人信息)、缺失错误场景的日志(catch 块中无日志)、verbose/debug 日志泄漏到 Release 构建、埋点事件命名不一致',
        output: '日志合规问题清单 + Release 构建日志安全评估 + 埋点规范遵守情况',
      },
    ],
    submitAction:
      '日志规范、崩溃收集、埋点约定分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['每个候选聚焦单一可观测性规范，明确 Release vs Debug 的差异处理'],
    mistakes: [
      '不要描述 Logger API 的通用用法 — 必须说明项目特定的日志分级规则和分类标签',
      '不要忽略 Release 构建的日志安全 — verbose/debug 级别不应出现在 Release 构建中',
      '不要遗漏 print/NSLog 的禁用规则 — 在有正式 Logger 的项目中使用 print 是常见违规',
      '不要忽略埋点事件的命名约定 — 事件名/参数名的一致性直接影响数据分析',
      '【跨维度边界】observability-logging 只关注日志/监控/埋点 — 错误处理逻辑归 error-resilience',
    ],
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ┌──────────────────────────────────────────────┐
  // │  Language Dimensions (7)                     │
  // └──────────────────────────────────────────────┘
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ──────────────────────────────────────────────
  // 14. swift-objc-idiom — Swift/ObjC 语言惯用法
  // ──────────────────────────────────────────────
  'swift-objc-idiom': {
    keywords: [
      'Swift',
      'Objective-C',
      '@objc',
      'bridging',
      'protocol',
      'Protocol-Oriented',
      'extension',
      'enum',
      'generics',
      'value type',
      '值类型',
      'struct',
      'final class',
      'Category',
      'Block',
      'Closure',
      'KVO',
      'Swizzling',
      '#define',
      '宏',
      'macro',
      'Foundation',
      'UIKit',
    ],
    phases: [
      {
        name: '语言特性全景扫描',
        action:
          '搜索项目中 Swift/ObjC 语言特性的使用模式：Protocol(protocol 定义、extension 默认实现、Protocol-Oriented 编程风格)、值类型 vs 引用类型(struct vs class 的选择策略)、enum 活用(关联值/RawValue/命名空间枚举)、Generics(泛型约束/where 子句)、Swift/ObjC 混编(Bridging Header/@objc 暴露/@objcMembers)',
        output: '语言特性使用全景：各特性的使用频率和场景 + Swift/ObjC 混编策略',
        tools: [
          'grep_search 搜索 protocol/extension/struct/enum/@objc 定义',
          '浏览 Bridging Header 和协议集中定义的目录',
        ],
      },
      {
        name: '惯用法规范提取',
        action:
          '阅读核心 Swift/ObjC 文件，提取项目的语言惯用法约定：Protocol-Oriented vs 继承的选择准则、值类型(struct) vs 引用类型(class) 的边界、final class 的强制/可选策略、enum 命名空间的使用模式、Optional 解包策略(guard let/if let/强制解包的场景限制)、闭包简写约定($0 vs 命名参数)',
        output: '项目 Swift 惯用法矩阵：各场景的标准做法 + 禁止做法',
        tools: ['read_file 阅读展示多种语言特性的核心文件'],
      },
      {
        name: '过时模式检测',
        action:
          '搜索过时或不推荐的语言使用：不必要的 NSObject 继承(纯 Swift 类继承 NSObject)、@objc 滥用(非必要的 @objc 标注)、过度使用 KVO(Swift 中应优先 Combine/didSet)、force unwrap 在不安全场景的使用、Any/AnyObject 类型擦除的滥用',
        output: '过时/不推荐模式清单 + 推荐的现代替代方案',
      },
    ],
    submitAction:
      '每种 Swift/ObjC 惯用法独立提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: [
      '每个候选标注适用的 Swift 版本要求（如 Swift 5.9+/6.0+）',
      'ObjC 相关候选需说明是否为混编必需',
    ],
    mistakes: [
      '不要合并不同层面的惯用法 — "Protocol-Oriented 编程"和"Optional 解包策略"是独立候选',
      '不要写通用 Swift 语法教程 — 必须提取项目特有的选择准则（如"何时用 struct 何时用 class"的项目答案）',
      '不要忽略 Swift/ObjC 混编的桥接规则 — 哪些类需要 @objc、Bridging Header 的管理约定',
      '不要遗漏 Optional 处理约定 — guard let vs if let vs 强制解包各自的适用场景是高频决策',
      '【跨维度边界】swift-objc-idiom 只关注语言惯用法 — 架构模式归 architecture，并发模式归 concurrency-async',
    ],
  },

  // ──────────────────────────────────────────────
  // 15. ts-js-module — TypeScript/JavaScript 惯用法
  // ──────────────────────────────────────────────
  'ts-js-module': {
    keywords: [
      'TypeScript',
      'JavaScript',
      'ESM',
      'CommonJS',
      'import',
      'export',
      'type',
      'interface',
      'generic',
      'enum',
      'union',
      'template literal',
      'type guard',
      'module',
      'package.json',
      'tsconfig',
      'barrel',
      'path alias',
      'strict',
      'any',
      'unknown',
    ],
    phases: [
      {
        name: '模块与类型体系扫描',
        action:
          '搜索项目的模块系统和类型基础设施：模块格式(ESM/CommonJS/UMD)、路径别名(tsconfig paths/#imports)、barrel exports(index.ts 重导出策略)、TypeScript 严格模式配置(strict/noImplicitAny/strictNullChecks)、类型定义文件(.d.ts)分布',
        output: '模块+类型体系全景：模块格式 + 路径别名 + barrel 策略 + TS 严格度配置',
        tools: [
          'read_file 阅读 tsconfig.json/package.json 的关键配置',
          'grep_search 搜索 import/export/type/interface 模式',
        ],
      },
      {
        name: '类型策略深挖',
        action:
          '阅读核心类型定义文件和业务代码，提取项目的 TypeScript 约定：泛型使用模式(工具类型/条件类型/映射类型)、类型守卫策略(is/in/typeof/instanceof)、联合类型 vs enum 的选择、模板字面量类型的活用、any/unknown 的使用边界(何时允许 any、何时必须 unknown)、类型断言(as)的使用约束',
        output: '类型策略矩阵：各场景的推荐方案 + 禁止方案 + 代码骨架示例',
        tools: ['read_file 阅读核心 .d.ts 文件和展示泛型使用的业务文件'],
      },
      {
        name: '类型安全薄弱检测',
        action:
          '搜索类型安全风险：any 的使用频率和场景(是否有 eslint no-explicit-any 规则)、@ts-ignore/@ts-expect-error 的使用、类型断言 as 的滥用、缺失返回类型的函数、未使用 strict null checks 的模块',
        output: '类型安全薄弱点清单 + 项目类型严格度评估',
      },
    ],
    submitAction:
      '模块组织策略、类型系统约定、TS 配置规范分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['包含 tsconfig/package.json 关键配置引用作为规则依据'],
    mistakes: [
      '不要描述 TypeScript 通用语法 — 必须说明项目特有的类型策略和模块约定',
      '不要忽略路径别名和 barrel exports — 这些是 TS 项目中最常用且最容易出错的约定',
      '不要遗漏 any/unknown 的使用边界 — 何时允许 any（如遗留代码适配）何时必须 unknown 是关键规则',
      '不要忽略 ESM import 的后缀约定 — 部分项目要求 .js 后缀，这是高频出错点',
      '【跨维度边界】ts-js-module 只关注 TS/JS 语言惯用法 — React/Vue 框架模式归对应框架维度',
    ],
  },

  // ──────────────────────────────────────────────
  // 16. python-structure — Python 惯用法与包结构
  // ──────────────────────────────────────────────
  'python-structure': {
    keywords: [
      'Python',
      '__init__',
      'class',
      'dataclass',
      'pydantic',
      'typing',
      'type hint',
      'decorator',
      'generator',
      'async',
      'import',
      'virtual env',
      'pip',
      'poetry',
      'uv',
      'pyproject.toml',
      'setup.py',
      'requirements',
      'mypy',
    ],
    phases: [
      {
        name: '包结构与工具链扫描',
        action:
          '搜索项目的 Python 包结构和开发工具链：包管理(pip/poetry/uv/conda)、构建配置(pyproject.toml/setup.py/setup.cfg)、__init__.py 的导出策略(__all__ 定义)、虚拟环境管理、类型检查工具(mypy/pyright/pytype 配置)',
        output: '包结构+工具链全景：包管理方式 + 目录组织 + 类型检查配置 + 开发工具链',
        tools: ['list_dir 浏览项目包结构', 'read_file 阅读 pyproject.toml/setup.py/mypy.ini'],
      },
      {
        name: 'Python 惯用法提取',
        action:
          '阅读核心 Python 文件，提取项目的 Python 约定：dataclass vs pydantic vs NamedTuple 的选择策略、类型标注完整度(是否全量标注/关键接口标注)、装饰器使用模式(自定义装饰器/框架装饰器)、上下文管理器(with 语句的使用场景)、生成器/迭代器模式、f-string vs format 的选择',
        output: 'Python 惯用法矩阵：数据类选型 + 类型标注策略 + 装饰器约定 + 其他惯用法',
        tools: ['read_file 阅读核心 Python 模块文件'],
      },
      {
        name: '反模式检测',
        action:
          '搜索 Python 反模式和风格违规：可变默认参数(def f(x=[]))、裸 except(except: 不指定类型)、过深继承链(>3 层)、循环 import、全局可变状态、过长函数(>50 行)、缺失 docstring',
        output: '反模式清单 + 项目 Python 代码质量评估',
      },
    ],
    submitAction:
      '包结构约定、类型标注策略、Python 惯用法分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['包含 pyproject.toml 关键配置引用'],
    mistakes: [
      '不要描述 Python 通用语法 — 必须说明项目特有的类型标注策略和数据类选型',
      '不要忽略包管理工具约定 — pip vs poetry vs uv 的选择以及lock 文件管理',
      '不要遗漏 __init__.py 的导出策略 — __all__ 的使用约定影响模块的公开接口',
      '不要忽略 mypy/pyright 配置 — 类型检查的严格度直接决定类型标注的要求',
      '【跨维度边界】python-structure 只关注 Python 语言惯用法 — Django/FastAPI 框架模式归 django-fastapi',
    ],
  },

  // ──────────────────────────────────────────────
  // 17. jvm-annotation — Java/Kotlin 惯用法
  // ──────────────────────────────────────────────
  'jvm-annotation': {
    keywords: [
      'Java',
      'Kotlin',
      'annotation',
      '@',
      'generic',
      'gradle',
      'maven',
      'package',
      'interface',
      'abstract',
      'Stream',
      'coroutine',
      'suspend',
      'sealed',
      'data class',
      'Lombok',
      'Validation',
      'reflection',
      'null safety',
    ],
    phases: [
      {
        name: '注解与语言特性扫描',
        action:
          '搜索项目中的自定义注解定义和主要注解使用模式：自定义注解(@interface 定义)、元注解使用(@Target/@Retention)、Lombok 注解(@Data/@Builder/@Slf4j)、Validation 注解(@NotNull/@Size)、Kotlin 特性(sealed class/data class/suspend/coroutine)',
        output: '注解+语言特性全景：自定义注解清单 + 主要注解使用场景分布 + Kotlin 特性采用情况',
        tools: ['grep_search 搜索 @interface 定义和高频注解使用', '浏览注解定义和核心包目录'],
      },
      {
        name: 'JVM 惯用法提取',
        action:
          '阅读核心 Java/Kotlin 文件，提取项目约定：泛型使用模式(泛型约束/通配符/类型擦除处理)、Stream API vs 传统循环的选择、Kotlin coroutine 使用约定(Dispatchers 选择/结构化并发/Flow vs Channel)、null 安全策略(Java: @Nullable/@NonNull/Optional; Kotlin: ?/!!的限制)、sealed class/enum 的使用场景',
        output: 'JVM 惯用法矩阵：各场景的标准做法 + null 安全约定 + 异步策略',
        tools: ['read_file 阅读核心 Java/Kotlin 业务文件'],
      },
      {
        name: '反模式检测',
        action:
          '搜索 JVM 反模式：注解滥用(过度注解导致声明式代码不可读)、raw type 使用(缺失泛型参数)、Kotlin !! 强制非空的不安全使用、checked exception 的不当处理(空 catch)、过度反射',
        output: '反模式清单 + JVM 代码质量评估',
      },
    ],
    submitAction:
      '注解约定、泛型策略、Kotlin 惯用法分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['包含 build.gradle/pom.xml 关键配置引用'],
    mistakes: [
      '不要描述 Java/Kotlin 通用语法 — 必须说明项目特有的注解约定和惯用法',
      '不要忽略 null 安全策略 — Java 项目的 @Nullable/@NonNull 约定和 Kotlin 的 !! 限制是核心规则',
      '不要把 Kotlin 和 Java 的约定混在一起 — 如果项目同时使用两种语言，应区分各自的约定',
      '不要遗漏 Kotlin coroutine 使用模式 — Dispatchers 选择和结构化并发是高频决策',
      '【跨维度边界】jvm-annotation 只关注 JVM 语言惯用法 — Spring 框架模式归 spring-patterns',
    ],
  },

  // ──────────────────────────────────────────────
  // 18. go-module — Go 语言惯用法
  // ──────────────────────────────────────────────
  'go-module': {
    keywords: [
      'Go',
      'go.mod',
      'goroutine',
      'channel',
      'interface',
      'struct',
      'error',
      'context',
      'package',
      'defer',
      'select',
      'sync',
      'WaitGroup',
      'errgroup',
      'error wrapping',
      '%w',
      'internal',
      'cmd',
      'pkg',
    ],
    phases: [
      {
        name: '模块与包结构扫描',
        action:
          '搜索项目的 Go 模块结构：go.mod(模块路径/Go 版本/依赖管理)、标准布局(cmd/pkg/internal/api)、包命名约定(单数 vs 复数/缩写规则)、internal 包的使用(封装边界)、接口定义位置(消费方定义 vs 提供方定义)',
        output: '模块结构全景：标准布局 + 包组织约定 + internal 封装策略 + 接口定义位置约定',
        tools: ['read_file 阅读 go.mod', 'list_dir 浏览项目目录结构（cmd/pkg/internal 等）'],
      },
      {
        name: 'Go 惯用法提取',
        action:
          '阅读核心 Go 文件，提取项目的 Go 约定：接口设计(小接口/单方法接口/embed 组合)、错误处理链(error wrapping with %w/sentinel errors/custom error types)、context 传递(首参数 context/超时控制/取消传播)、goroutine 启动约定(errgroup/WaitGroup/context cancel)、defer 使用模式',
        output: 'Go 惯用法矩阵：错误处理约定 + 接口设计规范 + goroutine 管理策略',
        tools: ['read_file 阅读核心 Go 业务文件（选取展示多种惯用法的文件）'],
      },
      {
        name: '反模式检测',
        action:
          '搜索 Go 反模式：goroutine 泄漏(启动 goroutine 无退出机制)、缺失 context 传递(函数参数列表中无 context)、过大接口(>5 方法的接口)、init() 函数滥用(隐式初始化副作用)、error 未检查(忽略返回的 error)',
        output: '反模式清单 + Go 代码质量评估',
      },
    ],
    submitAction:
      '模块组织约定、错误处理规范、goroutine 管理分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['包含 go.mod 和标准目录布局引用'],
    mistakes: [
      '不要描述 Go 通用语法 — 必须说明项目特有的错误处理链和接口设计约定',
      '不要忽略 error wrapping 约定 — fmt.Errorf("%w", err) 的使用规则和 sentinel error 定义方式',
      '不要遗漏 context 传递规则 — 是否强制所有函数首参为 context 是核心约定',
      '不要忽略 goroutine 的生命周期管理 — 启动方式、退出机制、panic recovery 策略',
      '【跨维度边界】go-module 只关注 Go 语言惯用法 — 通用架构分层归 architecture',
    ],
  },

  // ──────────────────────────────────────────────
  // 19. rust-ownership — Rust 所有权与惯用法
  // ──────────────────────────────────────────────
  'rust-ownership': {
    keywords: [
      'Rust',
      'ownership',
      'borrow',
      'lifetime',
      'trait',
      'impl',
      'derive',
      'macro',
      'unsafe',
      'Cargo',
      'crate',
      'mod',
      'Arc',
      'Rc',
      'Box',
      'Clone',
      'Result',
      'Option',
      '?',
      'thiserror',
      'anyhow',
    ],
    phases: [
      {
        name: '所有权与依赖扫描',
        action:
          '搜索项目中的所有权模式和 crate 结构：智能指针使用(Arc/Rc/Box/Cow 的选择策略)、生命周期标注(显式 lifetime 的使用场景)、Clone/Copy 的使用频率、Cargo.toml(workspace 结构/依赖管理/feature flags)、mod 组织方式(mod.rs vs 文件名)',
        output: '所有权策略全景：智能指针选型 + 生命周期管理策略 + crate 组织方式',
        tools: [
          'grep_search 搜索 Arc/Rc/Box/lifetime/Clone/unsafe 关键词',
          'read_file 阅读 Cargo.toml',
        ],
      },
      {
        name: 'Rust 惯用法提取',
        action:
          '阅读核心 Rust 文件，提取项目约定：trait 设计(small traits/blanket implements/trait objects vs generics)、错误处理(thiserror vs anyhow/? 操作符链/自定义 Error 类型层次)、derive 宏使用约定(哪些 trait 需要 derive)、enum 活用(Option/Result 的自定义扩展)、迭代器链 vs 命令式循环的选择',
        output: 'Rust 惯用法矩阵：trait 设计规范 + 错误处理链 + derive 约定 + 迭代器使用策略',
        tools: ['read_file 阅读核心 Rust 业务文件和 lib.rs'],
      },
      {
        name: 'unsafe 与质量检测',
        action:
          '搜索 unsafe 块使用：每处 unsafe 是否有安全注释(// SAFETY: ...)、是否有更安全的替代方案、是否被安全抽象包裹。同时检测：不必要的 Clone(可以用引用替代)、过度的 lifetime 标注(可以省略)、unwrap 在非测试代码中的使用',
        output: 'unsafe 审计报告 + 所有权健康度评估 + unwrap 使用合规检查',
      },
    ],
    submitAction:
      '所有权策略、trait 规范、错误处理约定分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['包含 Cargo.toml 关键配置和 workspace 结构引用'],
    mistakes: [
      '不要描述 Rust 通用语法 — 必须说明项目特有的所有权策略和 trait 设计约定',
      '不要忽略 unsafe 块的安全注释要求 — // SAFETY: 注释是 Rust 社区的核心约定',
      '不要遗漏 thiserror vs anyhow 的选择 — 库 crate 和应用 crate 通常有不同的错误策略',
      '不要忽略 unwrap 的使用限制 — 测试中允许 unwrap，业务代码中应使用 ? 操作符',
      '【跨维度边界】rust-ownership 只关注 Rust 语言惯用法 — 并发模式归 concurrency-async',
    ],
  },

  // ──────────────────────────────────────────────
  // 20. csharp-dotnet — C#/.NET 惯用法
  // ──────────────────────────────────────────────
  'csharp-dotnet': {
    keywords: [
      'C#',
      '.NET',
      'LINQ',
      'async',
      'Task',
      'nuget',
      'namespace',
      'interface',
      'attribute',
      'record',
      'dependency injection',
      'Entity Framework',
      'Dapper',
      'nullable reference',
      'pattern matching',
      'IHost',
    ],
    phases: [
      {
        name: '.NET 项目结构扫描',
        action:
          '搜索项目的 .NET 结构：.csproj(SDK/TargetFramework/NuGet 依赖)、项目类型(ASP.NET Core/Console/Worker/MAUI)、namespace 组织约定(与目录对齐/自定义规则)、启动配置(Program.cs/Startup.cs/Host Builder)、Nullable reference types 开启状态',
        output: '.NET 项目结构全景：SDK 版本 + 项目类型 + namespace 约定 + nullable 启用状态',
        tools: ['read_file 阅读 .csproj/Program.cs/appsettings.json', 'list_dir 浏览项目结构'],
      },
      {
        name: 'C# 惯用法提取',
        action:
          '阅读核心 C# 文件，提取项目约定：LINQ 使用模式(方法语法 vs 查询语法/延迟执行的理解)、async/await 模式(ConfigureAwait/async void 禁用/ValueTask vs Task)、DI 注册约定(AddScoped/AddTransient/AddSingleton 的选择策略)、record/readonly struct 的使用场景、pattern matching 活用度',
        output: 'C# 惯用法矩阵：LINQ 约定 + async 策略 + DI 注册模式 + 现代 C# 特性采用情况',
        tools: ['read_file 阅读核心 C# 业务文件和 DI 注册文件'],
      },
      {
        name: '反模式检测',
        action:
          '搜索 C# 反模式：async void(非事件处理场景)、缺失 ConfigureAwait(库代码)、Service Locator 模式(绕过 DI)、过度使用 static 类、LINQ N+1 查询(Entity Framework 未使用 Include)、IDisposable 未正确释放',
        output: '反模式清单 + .NET 代码质量评估',
      },
    ],
    submitAction:
      '.NET 配置约定、C# 惯用法、DI 策略分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['包含 .csproj 和 DI 注册代码引用'],
    mistakes: [
      '不要描述 C# 通用语法 — 必须说明项目特有的 .NET 版本特性采用和 C# 约定',
      '不要忽略 async/await 细节约定 — ConfigureAwait/async void 禁用/取消令牌传递',
      '不要遗漏 DI 生命周期选择规则 — Scoped vs Transient vs Singleton 的项目约定',
      '不要忽略 Entity Framework/ORM 的使用约定 — 查询优化和连接管理是高频问题',
      '【跨维度边界】csharp-dotnet 只关注 C#/.NET 惯用法 — ASP.NET 框架模式归更高层维度',
    ],
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ┌──────────────────────────────────────────────┐
  // │  Framework Dimensions (5)                    │
  // └──────────────────────────────────────────────┘
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ──────────────────────────────────────────────
  // 21. react-patterns — React 框架模式
  // ──────────────────────────────────────────────
  'react-patterns': {
    keywords: [
      'React',
      'useState',
      'useEffect',
      'useCallback',
      'useMemo',
      'hook',
      'component',
      'JSX',
      'TSX',
      'props',
      'children',
      'Redux',
      'Zustand',
      'Context',
      'Suspense',
      'ErrorBoundary',
      'SSR',
      'Next.js',
      'Remix',
      'compound component',
    ],
    phases: [
      {
        name: 'React 生态扫描',
        action:
          '搜索项目的 React 技术栈：组件类型分布(函数组件/类组件/Server Component)、状态管理(useState/useReducer/Redux/Zustand/Jotai/Context)、路由(React Router/Next.js pages/app directory)、自定义 Hooks 清单(use* 前缀函数)、样式方案(CSS Modules/Tailwind/Styled Components/Emotion)',
        output: 'React 生态全景：组件模式 + 状态管理选型 + 路由方案 + 自定义 Hooks 清单',
        tools: [
          'grep_search 搜索 useState/useEffect/Redux/Zustand/Context 关键词',
          '浏览 hooks/components/pages 目录',
        ],
      },
      {
        name: '组件模式深挖',
        action:
          '阅读核心组件和 Hooks 文件，提取项目约定：组件拆分粒度(容器/展示/Layout/原子组件)、Props 设计(interface vs type/children 使用/默认值策略)、自定义 Hook 的封装模式(数据获取/表单/定时器)、副作用管理(useEffect 依赖规则/清理函数约定)、性能优化(React.memo/useMemo/useCallback 的使用准则)',
        output: '组件模式规范：组件拆分策略 + Props 设计约定 + Hooks 封装模式 + 性能优化规则',
        tools: ['read_file 阅读核心 Page/Component/Hook 文件'],
      },
      {
        name: '反模式检测',
        action:
          '搜索 React 反模式：useEffect 依赖数组缺失或多余、组件过大(>300 行)、prop drilling 过深(>3 层传递)、状态提升过度(应局部的状态放到了全局)、不必要的 re-render(缺少 memo/缺少 useCallback)、直接修改状态(mutation)',
        output: '反模式清单 + React 代码质量评估',
      },
    ],
    submitAction:
      'React 组件模式、Hooks 约定、状态管理策略分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['每个候选聚焦单一 React 模式，coreCode 展示标准组件/Hook 骨架'],
    mistakes: [
      '不要描述 React 通用 API — 必须说明项目特定的组件约定、Hooks 封装模式',
      '不要合并状态管理和组件模式 — "使用 Zustand 管理全局状态"和"组件拆分为容器/展示"是独立候选',
      '不要忽略 useEffect 的依赖管理约定 — 这是 React 项目最高频的 Bug 源',
      '不要遗漏自定义 Hooks 的命名和封装约定 — 团队的 Hook 抽象策略是核心知识',
      '【跨维度边界】react-patterns 只关注 React 框架模式 — TypeScript 策略归 ts-js-module',
    ],
  },

  // ──────────────────────────────────────────────
  // 22. vue-patterns — Vue 框架模式
  // ──────────────────────────────────────────────
  'vue-patterns': {
    keywords: [
      'Vue',
      'ref',
      'reactive',
      'computed',
      'watch',
      'watchEffect',
      'Composition API',
      'Options API',
      'Pinia',
      'Vuex',
      'SFC',
      'v-model',
      'v-bind',
      'directive',
      'composable',
      'defineProps',
      'defineEmits',
      'provide',
      'inject',
      'Nuxt',
    ],
    phases: [
      {
        name: 'Vue 生态扫描',
        action:
          '搜索项目的 Vue 技术栈：API 风格(Composition API/Options API/混用)、状态管理(Pinia/Vuex/provide-inject)、路由(Vue Router/Nuxt)、Composable 清单(use* 函数)、SFC 风格(<script setup> vs <script>)、响应式选型(ref vs reactive 的使用比例)',
        output: 'Vue 生态全景：API 风格 + 状态管理 + 路由方案 + Composable 清单 + SFC 约定',
        tools: [
          'grep_search 搜索 ref/reactive/defineProps/defineEmits/Pinia 关键词',
          '浏览 composables/stores/pages 目录',
        ],
      },
      {
        name: '组件模式深挖',
        action:
          '阅读核心 SFC 和 Composable 文件，提取项目约定：Composable 封装模式(何时抽取为 composable)、ref vs reactive 选择策略、Props/Emits 定义方式(TypeScript interface/runtime 声明)、v-model 组件绑定约定、provide/inject 的使用场景、插槽(slot)使用模式',
        output: '组件模式规范：Composable 封装策略 + 响应式选型规则 + Props 设计约定',
        tools: ['read_file 阅读核心 Vue SFC 和 Composable 文件'],
      },
      {
        name: '反模式检测',
        action:
          '搜索 Vue 反模式：ref/reactive 混用不一致(同项目无统一策略)、v-for 缺失 :key、过度 watch(应该用 computed 的场景使用了 watch)、Composition API 和 Options API 混用(除迁移期外)、模板中过多逻辑(应抽取为 computed)',
        output: '反模式清单 + Vue 代码质量评估',
      },
    ],
    submitAction:
      'Vue 组件模式、Composable 约定、状态管理策略分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['每个候选聚焦单一 Vue 模式'],
    mistakes: [
      '不要描述 Vue 通用 API — 必须说明项目特定的 Composition API 约定和 Composable 封装模式',
      '不要忽略 ref vs reactive 的统一选型策略 — 项目内不一致会导致团队混乱',
      '不要遗漏 <script setup> 的约定 — defineProps/defineEmits 的 TypeScript 声明方式是高频规则',
      '不要忽略 provide/inject 的使用边界 — 何时用 provide/inject 何时用 Pinia store',
      '【跨维度边界】vue-patterns 只关注 Vue 框架模式 — TypeScript 策略归 ts-js-module',
    ],
  },

  // ──────────────────────────────────────────────
  // 23. spring-patterns — Spring 框架模式
  // ──────────────────────────────────────────────
  'spring-patterns': {
    keywords: [
      'Spring',
      'Boot',
      'Bean',
      'Controller',
      'Service',
      'Repository',
      '@Autowired',
      '@Inject',
      'AOP',
      'Interceptor',
      'Filter',
      'Configuration',
      'Profile',
      'transaction',
      '@Transactional',
      'WebFlux',
      'Security',
    ],
    phases: [
      {
        name: 'Spring 架构扫描',
        action:
          '搜索项目的 Spring 技术栈：Spring Boot 版本 + Web 框架(Spring MVC/WebFlux)、分层(Controller/Service/Repository/Domain)、Bean 管理方式(@Component 扫描/@Configuration 显式注册)、配置管理(application.yml/Profile/Environment)、Spring Security 配置',
        output: 'Spring 架构全景：技术版本 + 分层约定 + Bean 管理方式 + 配置结构',
        tools: [
          'grep_search 搜索 @Controller/@Service/@Repository/@Configuration',
          '浏览 config/controller/service/repository 目录',
        ],
      },
      {
        name: '框架模式深挖',
        action:
          '阅读核心 Spring 组件，提取项目约定：Controller 层约定(响应包装/参数校验/异常处理器)、Service 层约定(事务管理/幂等性)、Repository 层约定(JPA vs MyBatis/查询方法命名)、中间件链(Interceptor→Filter→AOP 的使用分工)、配置管理约定(@Value vs @ConfigurationProperties)',
        output: 'Spring 框架模式规范：各层职责+约定 + 中间件链 + 配置管理',
        tools: ['read_file 阅读核心 Controller/Service/Configuration 文件'],
      },
      {
        name: '反模式检测',
        action:
          '搜索 Spring 反模式：循环依赖(@Autowired 相互注入)、Controller 膨胀(>200 行/直接调用 Repository)、@Transactional 位置不当(标注在 private 方法/Controller 上)、缺失的参数校验(@Valid 遗漏)、过度使用 @Autowired(应使用构造器注入)',
        output: '反模式清单 + Spring 代码质量评估',
      },
    ],
    submitAction:
      'Spring 分层约定、事务管理、中间件配置分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['包含 application.yml/pom.xml 关键配置引用'],
    mistakes: [
      '不要描述 Spring 通用 API — 必须说明项目特定的分层约定和 Bean 管理方式',
      '不要忽略 @Transactional 的使用规则 — 事务边界放在哪一层、传播行为选择',
      '不要遗漏异常处理器(@ControllerAdvice)的约定 — 统一错误响应格式的规则',
      '不要忽略构造器注入 vs @Autowired 的选择 — 现代 Spring 推荐构造器注入',
      '【跨维度边界】spring-patterns 只关注 Spring 框架模式 — Java/Kotlin 语言惯用法归 jvm-annotation',
    ],
  },

  // ──────────────────────────────────────────────
  // 24. swiftui-patterns — SwiftUI 框架模式
  // ──────────────────────────────────────────────
  'swiftui-patterns': {
    keywords: [
      'SwiftUI',
      'View',
      'body',
      '@State',
      '@Binding',
      '@Observable',
      '@Bindable',
      '@Environment',
      '@Query',
      'modifier',
      'ViewModifier',
      'PreviewProvider',
      '#Preview',
      'NavigationStack',
      'NavigationPath',
      'sheet',
      'fullScreenCover',
      'LazyVStack',
      'LazyHStack',
      'GeometryReader',
    ],
    phases: [
      {
        name: 'SwiftUI 模式扫描',
        action:
          '搜索项目的 SwiftUI 技术栈：数据流属性包装器(@State/@Binding/@Observable/@Environment/@Query 的使用分布)、导航方案(NavigationStack/NavigationPath/自定义 Router)、视图组合方式(子视图拆分粒度/ViewModifier 自定义)、预览配置(#Preview macro/PreviewProvider)',
        output: 'SwiftUI 技术栈全景：属性包装器选型 + 导航方案 + 视图拆分策略 + 预览配置',
        tools: [
          'grep_search 搜索 @State/@Observable/@Environment/NavigationStack 关键词',
          '浏览 SwiftUI View 集中目录',
        ],
      },
      {
        name: '视图模式深挖',
        action:
          '阅读核心 SwiftUI View 文件，提取项目约定：视图拆分策略(何时抽取子视图/何时用 ViewModifier)、数据流规则(@State 局部状态/@Observable 共享状态/@Environment 环境值的选择准则)、导航约定(路由管理方式/sheet vs fullScreenCover 选择)、列表性能(LazyVStack/ForEach 优化)、动画约定(withAnimation/animation modifier 的使用方式)',
        output: '视图模式规范：拆分策略 + 属性包装器选择准则 + 导航约定 + 性能优化规则',
        tools: ['read_file 阅读核心 SwiftUI View 文件（覆盖列表/表单/导航场景）'],
      },
      {
        name: '反模式检测',
        action:
          '搜索 SwiftUI 反模式：body 过大(>50 行/嵌套过深)、@State 滥用(本应 @Observable 的状态用了 @State)、AnyView 类型擦除(损失性能)、GeometryReader 滥用(非必要时使用)、缺失 .id() 导致列表更新异常',
        output: '反模式清单 + SwiftUI 代码质量评估',
      },
    ],
    submitAction:
      'SwiftUI 视图模式、数据流约定、导航方案分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['每个候选聚焦单一 SwiftUI 模式', '标注适用的 iOS/macOS 最低版本要求'],
    mistakes: [
      '不要描述 SwiftUI 通用 API — 必须说明项目特定的视图拆分约定和数据流规则',
      '不要忽略 @Observable vs @State 的选择准则 — 何时局部状态何时共享状态是核心决策',
      '不要遗漏导航方案约定 — NavigationStack 的路由管理方式差异很大',
      '不要合并不同层面的约定 — 数据流选型和导航方案应独立提交',
      '【跨维度边界】swiftui-patterns 只关注 SwiftUI 框架模式 — Swift 语言惯用法归 swift-objc-idiom',
    ],
  },

  // ──────────────────────────────────────────────
  // 25. django-fastapi — Python Web 框架模式
  // ──────────────────────────────────────────────
  'django-fastapi': {
    keywords: [
      'Django',
      'FastAPI',
      'Flask',
      'model',
      'serializer',
      'view',
      'viewset',
      'router',
      'middleware',
      'ORM',
      'migration',
      'Pydantic',
      'endpoint',
      'dependency',
      'Alembic',
      'SQLAlchemy',
      'Celery',
      'admin',
    ],
    phases: [
      {
        name: 'Python Web 框架扫描',
        action:
          '搜索项目的 Python Web 技术栈：框架选型(Django/FastAPI/Flask/Starlette)、ORM(Django ORM/SQLAlchemy/Tortoise)、序列化(Django REST Serializer/Pydantic/Marshmallow)、任务队列(Celery/Dramatiq/RQ)、应用目录组织(Django app/FastAPI router/Blueprint)',
        output: 'Web 框架生态全景：框架+ORM+序列化+任务队列 + 应用组织方式',
        tools: ['grep_search 搜索框架标志性 import/装饰器', '浏览应用/路由/模型目录'],
      },
      {
        name: '框架模式深挖',
        action:
          '阅读核心框架组件，提取项目约定：Model 定义规范(字段命名/Meta 配置/Manager 自定义)、View/Router 组织(URL 命名空间/版本管理/权限装饰器)、序列化策略(嵌套序列化器/自定义验证/动态字段)、中间件链(认证/CORS/日志/限流的顺序和实现)、数据库迁移管理(migration 文件组织/数据迁移策略)',
        output: '框架模式规范：Model 约定 + View 组织 + 序列化策略 + 中间件链 + 迁移管理',
        tools: ['read_file 阅读核心 models/views/serializers/middleware 文件'],
      },
      {
        name: '反模式检测',
        action:
          '搜索 Python Web 反模式：N+1 查询(缺失 select_related/prefetch_related/joinedload)、View 膨胀(业务逻辑写在 View 中而非 Service 层)、缺失 migration(Model 变更后未生成 migration)、缺失输入校验(未使用 Serializer/Pydantic 校验)、同步阻塞(在异步框架中调用同步 I/O)',
        output: '反模式清单 + 框架代码质量评估',
      },
    ],
    submitAction:
      '框架分层约定、ORM 规范、中间件配置分别提交候选（**按实际发现提交，无实质内容则跳过本维度**）',
    submitExtras: ['包含 settings.py/配置文件关键引用'],
    mistakes: [
      '不要描述 Django/FastAPI 通用 API — 必须说明项目特定的框架约定和组织方式',
      '不要忽略 N+1 查询防范规则 — select_related/prefetch_related 的使用约定是性能核心',
      '不要遗漏 migration 管理约定 — 数据迁移(data migration)和 schema 迁移的区分',
      '不要忽略异步框架(FastAPI)中的阻塞检测 — 同步 I/O 在 async 视图中会阻塞事件循环',
      '【跨维度边界】django-fastapi 只关注 Python Web 框架模式 — Python 语言惯用法归 python-structure',
    ],
  },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Built SOP Registry
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 完整 SOP 注册表（由 COMPACT_SOPS 构建，消费者使用此对象） */
const DIMENSION_SOP: Record<string, FullSop> = Object.fromEntries(
  Object.entries(COMPACT_SOPS).map(([id, def]) => [id, _sop(def)])
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PRE_SUBMIT_CHECKLIST
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 提交前全局质量检查清单（跨所有维度通用）
 * 消费者: MissionBriefingBuilder.ts — 嵌入 submissionSpec
 */
export const PRE_SUBMIT_CHECKLIST = {
  MUST: [
    'title: 中文 ≤20 字，引用项目真实类名或模式名（不以项目名开头）',
    'description: 中文简述 ≤80 字',
    'trigger: @前缀 kebab-case 唯一标识符',
    'kind: rule | pattern | fact（必须选一）',
    'content.markdown: ≥200 字符的项目特写，含代码块+来源标注 (来源: FileName.ext:行号)',
    'content.rationale: 设计原理说明',
    'coreCode: 3-8 行纯代码骨架，语法完整可复制',
    'headers: import 语句数组（无则 []）',
    'doClause: 英文祈使句 ≤60 tokens，以动词开头',
    'dontClause: 英文反向约束',
    'whenClause: 英文触发场景描述',
    'reasoning.whyStandard + reasoning.sources（非空文件列表）',
    'sourceRefs: 引用的源文件列表',
    'usageGuide: ### 使用指南 格式',
  ],
  SHOULD: [
    '每个候选只聚焦单一知识点 — 不要合并不同模式',
    'content 中使用 ✅ / ❌ 对比正确写法和禁止写法',
    'coreCode 使用项目实际的代码而非伪代码',
    'description 提及影响范围（全局 / 某层 / 某模块）',
    'tags 包含有意义的搜索关键词',
    'confidence ≥0.85 才提交',
  ],
  FAIL_EXAMPLES: [
    {
      bad: "title: '项目使用了 MVVM 模式'",
      good: "title: 'ViewModel 的 Output 必须通过 Driver 转换'",
      why: 'title 必须具体到可执行的规则，不能是泛泛的描述',
    },
    {
      bad: "content.markdown: '本项目使用 RxSwift 进行响应式编程。'",
      good: "content.markdown: '## ViewModel Output 转换规范\\n\\n所有 ViewModel 的 Output 统一使用...(来源: HomeViewModel.swift:45)'",
      why: 'content 必须 ≥200 字符，包含项目特有的实现细节和代码引用',
    },
  ],
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Query Functions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 获取指定维度的完整 SOP
 * @returns FullSop | undefined
 */
export function getDimensionSOP(dimId: string): FullSop | undefined {
  return DIMENSION_SOP[dimId];
}

/**
 * 获取维度的关注关键词（用于 EpisodicMemory 跨维度匹配）
 * 优先使用 SOP 中定义的 focusKeywords，fallback 到从 guideText 解析
 */
export function getDimensionFocusKeywords(dimId: string, guideText = ''): string[] {
  const sop = DIMENSION_SOP[dimId];
  if (sop?.focusKeywords && sop.focusKeywords.length > 0) {
    return sop.focusKeywords;
  }

  // fallback: 从 guideText 中提取关键词
  if (!guideText) {
    return [];
  }
  const keywords: string[] = [];
  // 提取中文关键词（2-6字）
  const zhMatches = guideText.match(/[\u4E00-\u9FFF]{2,6}/g);
  if (zhMatches) {
    keywords.push(...zhMatches.slice(0, 8));
  }
  // 提取英文关键词（大写开头或全大写）
  const enMatches = guideText.match(/\b[A-Z][a-zA-Z]{2,}\b/g);
  if (enMatches) {
    keywords.push(...enMatches.slice(0, 5));
  }
  return keywords;
}

/**
 * 将 SOP / analysisGuide 压缩为纯文本（用于 Level 5 极致压缩模式）
 * 接受 analysisGuide 对象（含 steps + commonMistakes 字段）
 */
export function sopToCompactText(guide: Record<string, unknown>): string {
  if (!guide || typeof guide !== 'object') {
    return '';
  }

  const lines: string[] = [];
  const steps = Array.isArray(guide.steps) ? guide.steps : [];
  for (const step of steps) {
    if (typeof step === 'object' && step !== null) {
      const s = step as Record<string, unknown>;
      const phase = typeof s.phase === 'string' ? s.phase : '';
      const action = typeof s.action === 'string' ? s.action : '';
      lines.push(`${phase}: ${action}`);
      if (typeof s.expectedOutput === 'string') {
        lines.push(`  → ${s.expectedOutput}`);
      }
    }
  }
  const mistakes = Array.isArray(guide.commonMistakes) ? guide.commonMistakes : [];
  if (mistakes.length > 0) {
    lines.push('⚠️ 常见错误:');
    for (const m of mistakes) {
      if (typeof m === 'string') {
        lines.push(`  - ${m}`);
      }
    }
  }
  return lines.join('\n');
}
