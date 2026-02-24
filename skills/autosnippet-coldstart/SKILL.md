---
name: autosnippet-coldstart
description: Cold-start knowledge base initialization (V3). Full 9-dimension analysis workflow for external Agent. Call autosnippet_bootstrap (no params) → analyze code → submit_knowledge → dimension_complete.
---

# AutoSnippet — Cold Start (知识库冷启动) V3

> 首次接入项目 / 知识库重建 / 大版本升级后使用。目标：从零建立完整知识库，覆盖 9 大知识维度。
> Self-check & Fallback: MCP 工具返回 JSON Envelope（{ success, errorCode?, data?, meta }）。失败时不在同一轮重试，缩小范围再试。
> **DB 不可用不影响冷启动**: autosnippet_bootstrap 不依赖数据库（纯文件系统分析），可直接调用。

## Quick Decision

| 情况 | 使用 |
|------|------|
| 首次接入 / "初始化知识库" / "冷启动" | **本 Skill**（完整冷启动） |
| 已有知识库，查/用 Recipe | → autosnippet-recipes |
| 只扫描单个文件/模块 | → autosnippet-candidates |
| 只做 Guard 审计 | → autosnippet-guard |
| 快速看看项目结构 | → autosnippet-structure（用 `autosnippet_structure(operation=targets)`） |

---

## Phase 0: 启动扫描

调用 `autosnippet_bootstrap`（**无参数**）获取 Mission Briefing：

```
autosnippet_bootstrap()
```

> 💡 Bootstrap 不依赖数据库，DB 不可用时也能正常工作。

### Mission Briefing 返回数据

| 字段 | 内容 |
|------|------|
| `projectMeta` | 项目元数据（name, primaryLanguage, fileCount, projectType） |
| `ast` | AST 分析摘要（classes, protocols, functions, imports） |
| `codeEntityGraph` | 代码实体图谱（类/协议/函数之间的关系） |
| `dependencyGraph` | `{ nodes, edges }` 模块间依赖关系 |
| `guardFindings` | Guard 规则违规摘要 |
| `targets` | 所有模块 Target（含 `inferredRole`: core/service/ui/networking/…） |
| `dimensions` | 激活的分析维度任务列表（每个维度含 analysisGuide + evidenceStarters） |
| `submissionSchema` | **提交格式定义 + 语言自适应 JSON 示例**（⚠️ 必须严格按此格式提交） |
| `executionPlan` | 分 Tier 执行计划（Tier 1 → Tier 2 → Tier 3） |
| `session` | Bootstrap 会话信息（session.id 供 dimension_complete 使用） |

### submissionSchema — 提交格式（关键！）

Mission Briefing 的 `submissionSchema.example` 包含**完整的提交 JSON 示例**，按项目主语言自适应。
**你必须严格按照该示例的字段格式提交知识**，特别注意：
- `content` 是 JSON 对象：`{ "pattern": "...", "markdown": "...", "rationale": "..." }`
- `reasoning` 是 JSON 对象：`{ "whyStandard": "...", "sources": [...], "confidence": 0.85 }`
- `headers` 是数组：`["import Foundation"]`（无 import 时传 `[]`）

### dimensions — 维度任务

每个维度对象包含：
- `id` — 维度标识
- `label` — 维度名称
- `analysisGuide` — 分析步骤指引（SOP）
- `evidenceStarters` — 从 Phase 1-4 数据中提取的证据启发
- `submissionSpec` — 提交规范（含 preSubmitChecklist）

### executionPlan — 分 Tier 执行

```
Tier 1（项目特征/深度扫描/分类扫描）→ Tier 2（代码规范/架构/设计模式）→ Tier 3（事件流/最佳实践/开发指南）
```

每个维度的工作流：
1. 用原生能力（read_file/grep_search）阅读代码分析
2. 调用 `autosnippet_submit_knowledge_batch` 批量提交 3-5 条候选
3. 调用 `autosnippet_dimension_complete` 完成维度（传 referencedFiles + keyFindings）

---

## Phase 1: 架构分析（全局视角）

**目标**: 提取 3-8 条架构级知识条目。

**分析步骤**:

1. **查看 `targets`** — 每个 Target 的 `inferredRole` 告诉你它可能是什么
2. **查看 `dependencyGraph.edges`** — 理解模块间依赖关系
3. **查看各 Target 核心文件** — 确认架构模式（MVVM / MVC / Clean / 模块化 SPM 等）
4. **识别分层边界** — 哪些层可以调用哪些层？有无跨层调用？

**输出类型**: `architecture` / `module-dependency` / `boundary-constraint`

**架构候选模板**:
```json
{
  "title": "分层架构: Presentation → Domain → Data",
  "trigger": "@layered-arch",
  "content": {
    "markdown": "## 分层架构\n\n项目采用三层架构...\n\n```\nPresentation (FeatureA, FeatureB)\n  → Domain (UseCases, Entities)\n    → Data (Repositories, API, Storage)\n```\n\n### 层级职责\n- **Presentation**: UI + ViewModel\n- **Domain**: UseCase + Entity\n- **Data**: Repository + API + Storage\n\n### 边界约束\n- View 层不直接 import Data 层\n- 所有数据访问通过 Domain 层 UseCase 中转",
    "pattern": "// Presentation → Domain → Data\nPresentation (FeatureA, FeatureB)\n  → Domain (UseCases, Entities)\n    → Data (Repositories, API, Storage)",
    "rationale": "项目采用三层架构，Presentation 不直接访问 Data 层。所有数据访问通过 Domain 层的 UseCase 中转，保证单向依赖。"
  },
  "description": "三层架构 Presentation → Domain → Data，禁止跨层访问",
  "language": "<primaryLanguage>",
  "headers": [],
  "category": "Service",
  "kind": "rule",
  "doClause": "Follow Presentation → Domain → Data layered architecture with no cross-layer access",
  "dontClause": "Never import Data layer modules directly from Presentation layer",
  "whenClause": "When creating new modules, reviewing code, or making architectural decisions",
  "coreCode": "// Presentation → Domain → Data\n// ✅ Presentation imports Domain\nimport DomainModule\n// ✅ Domain imports Data\nimport DataModule\n// ❌ Presentation must NOT import Data directly",
  "knowledgeType": "architecture",
  "usageGuide": "### 何时使用\n- 新建模块时确定放置层级\n- 代码审查检查跨层调用\n\n### 规则\n- View 层只调 Domain\n- Domain 层只调 Data\n- 禁止反向依赖",
  "difficulty": "intermediate",
  "scope": "project-specific",
  "steps": [
    { "title": "理解层级", "description": "Presentation 依赖 Domain, Domain 依赖 Data", "code": "" },
    { "title": "新模块规则", "description": "新功能模块放在 Presentation 层，公共逻辑放 Domain", "code": "" }
  ],
  "constraints": {
    "boundaries": ["View 层不直接 import Data 层模块"],
    "preconditions": []
  },
  "relations": {
    "dependsOn": [{ "target": "DomainModule", "description": "核心业务逻辑" }]
  },
  "reasoning": {
    "whyStandard": "项目全部模块遵循此分层，违反会导致循环依赖和测试困难",
    "sources": ["Package.swift", "dependencyGraph"],
    "confidence": 0.9
  }
}
```

---

## Phase 2: 逐 Target 代码分析（8 维度）

### 分析优先级

按 `priority` 字段排序文件。推荐顺序：

1. **high priority** — 核心模块、Service 层、配置、协议定义
2. **medium priority** — 功能模块、Model、View
3. **low priority** — 工具类、扩展、测试

### 8 维度分析清单

对每个文件，系统性提取：

| # | 维度 | 寻找什么 | knowledgeType | 示例 |
|---|------|---------|---------------|------|
| 1 | **代码规范** | 命名约定、注释风格、文件组织 | `code-standard` / `code-style` | "Manager 类统一以 Manager 结尾" |
| 2 | **使用习惯** | 常用封装、工厂方法、API 调用方式 | `code-pattern` | "网络请求统一用 Result<T, Error>" |
| 3 | **最佳实践** | 错误处理、并发、内存管理 | `best-practice` | "async 操作都用 Task { @MainActor in }" |
| 4 | **调用链** | 关键业务路径、初始化链 | `call-chain` | "登录: View → AuthService → API → Token" |
| 5 | **数据流** | 状态管理、响应式流 | `data-flow` | "Publisher 链: Network → VM → View" |
| 6 | **代码关系** | 继承、协议实现 | `code-relation` / `inheritance` | "所有 VC 继承 BaseViewController" |
| 7 | **Bug 修复** | 常见问题、defensive coding | `solution` + antiPattern | "避免在 deinit 中访问 weak self" |
| 8 | **边界约束** | 访问限制、线程要求 | `boundary-constraint` | "UI 操作必须在主线程" |

### antiPattern 格式（Bug 修复维度专用）

```json
{
  "antiPattern": {
    "bad": "DispatchQueue.main.async { self.update() }",
    "why": "在 Swift Concurrency 环境中可能造成数据竞争",
    "fix": "@MainActor func update() { ... }"
  }
}
```

### relations 格式（知识关联）

```json
{
  "relations": {
    "dependsOn": [{ "target": "NetworkModule", "description": "依赖网络层" }],
    "extends": [{ "target": "BaseService", "description": "扩展基础服务" }],
    "conflicts": [{ "target": "旧版 URLSession 直接调用", "description": "与新封装冲突" }]
  }
}
```

---

## Phase 3: 项目库特征（Project Profile）

分析项目整体技术特征，提交 1 条汇总型候选：

```json
{
  "title": "项目技术特征 — [ProjectName]",
  "trigger": "@projectProfile",
  "content": {
    "markdown": "## 技术栈全貌\n\n| 维度 | 值 |\n|------|------|\n| 主语言 | <language> |\n| 框架 | <framework1>, <framework2> |\n| 最低部署版本 | <platform version> |\n\n### 项目结构\n- 类型: <modular-spm|monorepo|workspace|...>\n- 核心模块: ModuleA（核心业务SDK）, ModuleB（UI组件库）\n\n### 三方依赖\n- LibA: 用途\n- LibB: 用途",
    "pattern": "techStack:\n  primaryLanguage: <language>\n  frameworks: [<fw1>, <fw2>]\n  projectStructure: <modular|monorepo|workspace>\n  keyModules: [ModuleA, ModuleB]",
    "rationale": "项目技术栈全貌，新人 onboarding 和 Agent 理解项目的基础上下文"
  },
  "description": "项目技术栈全貌：语言、框架、模块结构、三方依赖",
  "language": "<primaryLanguage>",
  "headers": [],
  "category": "Architecture",
  "kind": "fact",
  "doClause": "Understand the project tech stack before making architectural decisions",
  "dontClause": "Do not introduce frameworks or patterns that conflict with the established tech stack",
  "whenClause": "When onboarding to the project or making technology choices",
  "coreCode": "// Project: [ProjectName]\n// Language: <language>\n// Frameworks: <fw1>, <fw2>\n// Structure: <modular|monorepo|workspace>\n// Key Modules: ModuleA, ModuleB",
  "knowledgeType": "architecture",
  "usageGuide": "### 何时查阅\n新人入职、技术选型、跨模块开发时参考\n### 注意事项\n版本升级时同步更新此条目",
  "reasoning": {
    "whyStandard": "项目技术选型摘要，所有开发决策的基础上下文",
    "sources": ["<project manifest: Package.swift / package.json / go.mod / pom.xml / etc.>", "projectMeta", "dependencyGraph"],
    "confidence": 0.95
  }
}
```

**分析要点**:
- 从 `projectMeta` 获取主语言和项目类型
- 从 `targets` 推断项目结构（单体/模块化）
- 从 `dependencyGraph` 推断三方/自有模块依赖
- 从代码中的 import 语句推断框架使用

---

## Phase 4: Agent 开发注意事项

提取 Agent（Cursor/Copilot）在本项目开发时**必须遵守的规则**。每条规则一个候选。

### 规则类别与严重级别

| 类别 | severity | 示例 |
|------|----------|------|
| 命名 (naming) | `must` | "所有 ViewModel 以 VM 结尾" |
| 线程 (threading) | `must` | "UI 更新必须在主线程/主 Actor" |
| 内存 (memory) | `should` | "闭包/回调中注意循环引用" |
| 架构 (architecture) | `must` | "View 层不直接访问 Repository" |
| 安全 (security) | `must` | "不在代码中硬编码 API key" |
| 性能 (performance) | `should` | "大列表使用虚拟化/懒加载" |

### Agent 注意事项候选模板

```json
{
  "title": "[must] UI 更新必须在主线程",
  "trigger": "@agent-threading",
  "content": {
    "markdown": "## UI 线程安全\n\n所有 UI 更新操作必须在主线程/主 Actor 执行。\n\n### 各语言实现\n- **Swift**: `@MainActor func updateUI() { ... }`\n- **JS/TS**: 单线程无需处理，Web Worker 返回需 `postMessage`\n- **Python**: `loop.call_soon_threadsafe()` 或框架 API\n- **Go**: 使用 channel 或 sync 包\n- **Java/Kotlin**: `runOnUiThread { }` 或 `Dispatchers.Main`\n- **Rust**: `tokio::spawn` + channel 或 `Arc<Mutex<T>>`\n- **Dart**: `setState` 或 `WidgetsBinding.instance.addPostFrameCallback`\n\n### 反例\n在后台线程直接操作 UI 会导致崩溃或数据竞争。",
    "pattern": "// ✅ 正确 — 使用语言/框架提供的主线程机制\n// Swift: @MainActor func updateUI() { ... }\n// Kotlin: runOnUiThread { updateView() }\n\n// ❌ 错误 — 在后台线程直接操作 UI",
    "rationale": "UI 框架通常要求在主线程更新界面，违反会导致崩溃或数据竞争"
  },
  "description": "UI 更新必须在主线程/主 Actor 执行，违反会导致崩溃或数据竞争",
  "language": "<primaryLanguage>",
  "headers": [],
  "category": "Tool",
  "kind": "rule",
  "doClause": "Always dispatch UI updates to the main thread or main actor",
  "dontClause": "Never update UI elements from background threads or non-main dispatchers",
  "whenClause": "When writing code that updates UI after async operations or background tasks",
  "coreCode": "// Swift: @MainActor func updateUI() { ... }\n// Kotlin: runOnUiThread { updateView() }\n// JS/TS: postMessage from Worker\n// Python: loop.call_soon_threadsafe(callback)",
  "knowledgeType": "boundary-constraint",
  "usageGuide": "### 适用场景\n所有涉及 UI 更新的异步操作\n### 检查方式\n确认回调/闭包中的 UI 操作是否已切换到主线程",
  "reasoning": {
    "whyStandard": "项目 UI 层需在主线程操作，Agent 新写的代码也必须遵守",
    "sources": ["<relevant source files>"],
    "confidence": 0.9
  }
}
```

---

## Phase 5: 批量提交

将所有分析结果通过 `autosnippet_submit_knowledge_batch` 批量提交（内置自动校验 + 去重）：

```json
{
  "items": [ /* Phase 1-4 的所有候选 */ ],
  "source": "bootstrap-external",
  "deduplicate": true
}
```

**建议**: 按维度分批提交，每批 10-20 条，避免单次请求过大。

### 预期产出（完整冷启动）

| 维度 | 预期条数 |
|------|---------|
| 代码规范 (code-standard / code-style) | 15-30 |
| 使用习惯 (code-pattern) | 20-40 |
| 架构模式 (architecture) | 3-8 |
| 最佳实践 (best-practice) | 10-20 |
| 调用链 (call-chain) | 5-10 |
| 数据流 (data-flow) | 3-8 |
| Bug 修复 (solution + antiPattern) | 5-15 |
| 项目特征 | 1 |
| Agent 注意事项 | 5-15 |
| 知识图谱边 | SPM 自动写入 |

总计: **70-150 条候选** → Dashboard 审核后成为正式 Recipe.

---

## 候选必填字段 Quick Reference

提交每条候选**必须**提供以下全部字段，缺失将被直接拒绝：

| 字段 | 必填? | 说明 |
|------|-------|------|
| `title` | ★★★ 必填 | 简明标题（≤20字） |
| `trigger` | ★★★ 必填 | @前缀触发词，如 `@swiftNaming` |
| `content.markdown` | ★★★ 必填 | 项目特写 Markdown（≥200字） |
| `content.pattern` | ★☆☆ 可选 | 核心代码片段（markdown 已含代码块时可省略） |
| `content.rationale` | ★★★ 必填 | 设计原理（为什么这样做） |
| `description` | ★★★ 必填 | 中文摘要 ≤80字 |
| `language` | ★★★ 必填 | swift / objectivec / go / python / java / kotlin / dart / javascript / typescript 等 |
| `headers` | ★★★ 必填 | import 语句数组，如 `["import Foundation"]`；无 import 时传 `[]` |
| `category` | ★★★ 必填 | View / Service / Tool / Model / Network / Storage / UI / Utility |
| `kind` | ★★★ 必填 | rule / pattern / fact |
| `doClause` | ★★★ 必填 | 英文祈使句正向指令（≤60 tokens） |
| `dontClause` | ★★★ 必填 | 英文反向约束（描述禁止的做法） |
| `whenClause` | ★★★ 必填 | 英文触发场景（描述何时适用此规则） |
| `coreCode` | ★★★ 必填 | 3-8行纯代码骨架（语法完整、括号配对、可直接复制） |
| `knowledgeType` | ★★★ 必填 | 见 8 维度清单 |
| `usageGuide` | ★★★ 必填 | 使用指南（### 章节格式） |
| `reasoning.whyStandard` | ★★★ 必填 | 为什么值得沉淀 |
| `reasoning.sources` | ★★★ 必填 | 来源文件路径 |
| `reasoning.confidence` | ★★★ 必填 | 0-1 置信度 |
| `difficulty` | ★★☆ 推荐 | beginner / intermediate / advanced |
| `scope` | ★★☆ 推荐 | universal / project-specific / target-specific |
| `steps` | ★★☆ 推荐 | 实施步骤 |
| `constraints` | ★★☆ 推荐 | 前置条件/边界/副作用 |
| `topicHint` | ★★☆ 推荐 | 主题分组（networking/ui/data/architecture/conventions） |
| `relations` | ★★☆ 推荐 | 依赖/扩展/冲突关系 |
| `antiPattern` | 条件必填 | 仅 Bug 修复维度 |

---

## Per-Dimension Industry Reference Templates

> 以下是每个分析维度的**高质量候选模板**，基于业界最佳实践。分析时请以此为参考产出同等质量的候选。
> **注意**: 每个维度提供多语言示例，实际分析时应使用项目的 `primaryLanguage` 和对应语言的代码示例。

### 维度 1: 代码规范 (code-standard) — 参考模板

**Swift 示例：**

```json
{
  "title": "命名约定: 类型用 UpperCamelCase, 变量/函数用 lowerCamelCase",
  "trigger": "@swift-naming",
  "content": {
    "markdown": "## Swift 命名约定\n\n遵循 Apple API Design Guidelines：\n\n```swift\n// ✅ 正确\nclass NetworkManager { }\nfunc fetchUserProfile() -> UserProfile { }\nlet currentUser: User\n\n// ❌ 错误\nclass network_manager { }\nfunc FetchUserProfile() -> UserProfile { }\nlet CURRENT_USER: User\n```\n\n### 规则\n- 类型名: UpperCamelCase\n- 变量/函数: lowerCamelCase\n- 缩写: URL/ID 在首位全大写，其他位置 lowerCamelCase\n\n### 反例\n```swift\nlet kMaxRetryCount = 3  // ❌ 匈牙利命名\nclass network_manager { } // ❌ 下划线\n```",
    "pattern": "// ✅ 正确\nclass NetworkManager { }\nfunc fetchUserProfile() -> UserProfile { }\nlet currentUser: User\n\n// ❌ 错误\nclass network_manager { }\nfunc FetchUserProfile() -> UserProfile { }",
    "rationale": "遵循 Apple API Design Guidelines 和 Google Swift Style Guide：类型名用 UpperCamelCase，变量/函数/参数用 lowerCamelCase，全局常量用 lowerCamelCase（不用 k 前缀或 SCREAMING_SNAKE_CASE）"
  },
  "description": "Swift 命名约定：类型 UpperCamelCase，变量/函数 lowerCamelCase",
  "language": "swift",
  "headers": ["import Foundation"],
  "category": "Tool",
  "kind": "rule",
  "doClause": "Use UpperCamelCase for types and lowerCamelCase for variables, functions, and parameters",
  "knowledgeType": "code-standard",
  "usageGuide": "### 何时使用\n- 新建类/结构体/枚举/协议时\n- 命名变量/函数/参数时\n\n### 规则\n- class/struct/enum/protocol: UpperCamelCase\n- 变量/函数/参数: lowerCamelCase\n- 缩写: URL/ID 首位全大写，其他位 lowerCamelCase",
  "difficulty": "beginner",
  "scope": "project-specific",
  "steps": [
    { "title": "类型命名", "description": "class/struct/enum/protocol 用 UpperCamelCase", "code": "struct UserProfile { }" },
    { "title": "函数命名", "description": "方法名以动词开头，参数标签读起来像句子", "code": "func insert(_ element: Element, at index: Int)" },
    { "title": "缩写处理", "description": "缩写作为整体大小写", "code": "let urlString = ...\nclass HTMLParser { }" }
  ],
  "antiPattern": {
    "bad": "let kMaxRetryCount = 3\nclass network_manager { }",
    "why": "匈牙利命名法 k 前缀和下划线命名不符合 Swift 惯例，降低可读性",
    "fix": "let maxRetryCount = 3\nclass NetworkManager { }"
  },
  "reasoning": {
    "whyStandard": "统一命名规范是代码可读性的基础，Apple 和 Google 风格指南均以此为核心准则",
    "sources": ["Apple API Design Guidelines", "Google Swift Style Guide"],
    "confidence": 0.95
  }
}
```

**Go 示例：**

```json
{
  "title": "命名约定: 导出用 UpperCamelCase, 内部用 lowerCamelCase",
  "trigger": "@go-naming",
  "content": {
    "markdown": "## Go 命名约定\n\n遵循 Effective Go：\n\n```go\n// ✅ 正确 — 导出名大写开头，内部名小写开头\ntype NetworkManager struct { }\nfunc FetchUserProfile() (*UserProfile, error) { }\nvar currentUser *User\n\n// ❌ 错误\ntype network_manager struct { }\nfunc fetch_user_profile() { }\n```\n\n### 规则\n- 导出标识符: 首字母大写\n- 内部标识符: 首字母小写\n- 缩写: 保持全大写（HTTP、URL、ID）",
    "pattern": "// 导出用 UpperCamelCase\ntype NetworkManager struct { }\nfunc FetchUserProfile() (*UserProfile, error) { }\n// 内部用 lowerCamelCase\nvar currentUser *User",
    "rationale": "遵循 Effective Go：导出标识符首字母大写，内部小写；缩写保持全大写（HTTP、URL、ID）"
  },
  "description": "Go 命名约定：导出标识符大写开头，内部小写开头",
  "language": "go",
  "headers": [],
  "category": "Tool",
  "kind": "rule",
  "doClause": "Use UpperCamelCase for exported identifiers and lowerCamelCase for unexported ones",
  "knowledgeType": "code-standard",
  "usageGuide": "### 何时使用\n- 定义新的类型/函数/变量时\n\n### 规则\n- 导出（大写开头）: 提供给外部包使用\n- 未导出（小写开头）: 包内私有\n- 缩写全大写: HTTPClient, URL, ID",
  "antiPattern": {
    "bad": "type http_client struct { }\nfunc get_User() { }",
    "why": "下划线和混合大小写不符合 Go 惯例",
    "fix": "type HTTPClient struct { }\nfunc GetUser() { }"
  },
  "reasoning": {
    "whyStandard": "Go 用大小写控制可见性，统一命名是团队协作的基础",
    "sources": ["Effective Go", "Go Code Review Comments"],
    "confidence": 0.95
  }
}
```

**Python 示例：**

```json
{
  "title": "命名约定: 类用 PascalCase, 函数/变量用 snake_case",
  "trigger": "@python-naming",
  "content": {
    "markdown": "## Python 命名规范 (PEP 8)\n\n### ✅ 正确示例\n```python\nclass NetworkManager:\n    pass\n\ndef fetch_user_profile() -> UserProfile:\n    pass\n\ncurrent_user: User\nMAX_RETRY_COUNT = 3  # 常量全大写\n```\n\n### ❌ 错误示例\n```python\nclass network_manager:\n    pass\n\ndef FetchUserProfile():\n    pass\n```\n\n### 规则总结\n- 类名：PascalCase（如 `NetworkManager`）\n- 函数/变量：snake_case（如 `fetch_user_profile`）\n- 常量：UPPER_SNAKE_CASE（如 `MAX_RETRY_COUNT`）\n- 模块名：全小写 snake_case",
    "pattern": "class NetworkManager:\n    pass\n\ndef fetch_user_profile() -> UserProfile:\n    pass\n\ncurrent_user: User\nMAX_RETRY_COUNT = 3",
    "rationale": "遵循 PEP 8：类名 PascalCase，函数/变量 snake_case，常量 UPPER_SNAKE_CASE。所有主流 Python 工具（pylint、flake8、black）均强制执行此规范。"
  },
  "description": "Python 命名规范：类 PascalCase，函数/变量 snake_case，常量 UPPER_SNAKE_CASE",
  "kind": "rule",
  "doClause": "Use PascalCase for classes, snake_case for functions and variables, UPPER_SNAKE_CASE for constants",
  "language": "python",
  "headers": [],
  "category": "Tool",
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\n在 Python 项目中创建新类、函数或变量时，触发 `@python-naming` 查阅命名约定，确保符合 PEP 8 标准。",
  "difficulty": "beginner",
  "scope": "project-specific",
  "antiPattern": {
    "bad": "class network_manager:\n    def FetchData(self): pass",
    "why": "类名应 PascalCase，方法名应 snake_case，混用降低可读性",
    "fix": "class NetworkManager:\n    def fetch_data(self): pass"
  },
  "reasoning": {
    "whyStandard": "PEP 8 是 Python 社区标准，所有主流工具（pylint、flake8、black）均强制执行",
    "sources": ["PEP 8", "Google Python Style Guide"],
    "confidence": 0.95
  }
}
```

**Dart (Flutter) 示例：**

```json
{
  "title": "命名约定: 类用 UpperCamelCase, 变量/函数用 lowerCamelCase, 文件名 snake_case",
  "trigger": "@dart-naming",
  "content": {
    "markdown": "## Dart 命名规范 (Effective Dart)\n\n### ✅ 正确示例\n```dart\nclass NetworkManager { }\nvoid fetchUserProfile() { }\nfinal currentUser = User();\nconst defaultTimeout = Duration(seconds: 30);\n\n// 文件名: user_service.dart, home_page.dart\n// 私有成员: _isLoading, _controller\n```\n\n### ❌ 错误示例\n```dart\nconst MAX_RETRY_COUNT = 3;  // Dart 不用 SCREAMING_CAPS\nclass user_service { }       // 类名应 UpperCamelCase\nString UserName = '';         // 变量应 lowerCamelCase\n```\n\n### 规则总结\n- 类名: UpperCamelCase（如 `UserService`）\n- 变量/函数: lowerCamelCase（如 `fetchData`）\n- 常量: lowerCamelCase（如 `defaultTimeout`，不用 SCREAMING_CAPS）\n- 文件名: snake_case（如 `user_service.dart`）",
    "pattern": "class NetworkManager { }\nvoid fetchUserProfile() { }\nfinal currentUser = User();\nconst defaultTimeout = Duration(seconds: 30);",
    "rationale": "遵循 Effective Dart Style：类名 UpperCamelCase，变量/函数 lowerCamelCase，常量也用 lowerCamelCase（区别于 Java/C++），文件名 snake_case。dart analyze 会强制检查。"
  },
  "description": "Dart 命名规范：类 UpperCamelCase，变量/函数 lowerCamelCase，常量 lowerCamelCase，文件 snake_case",
  "kind": "rule",
  "doClause": "Use UpperCamelCase for types, lowerCamelCase for variables/functions/constants, snake_case for filenames",
  "language": "dart",
  "headers": [],
  "category": "Tool",
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\n在 Dart/Flutter 项目中创建新文件或标识符时，触发 `@dart-naming` 查阅 Effective Dart 命名约定。",
  "difficulty": "beginner",
  "scope": "project-specific",
  "antiPattern": {
    "bad": "const MAX_RETRY = 3;\nclass user_service { }",
    "why": "SCREAMING_CAPS 和下划线类名不符合 Dart 惯例，dart analyze 会警告",
    "fix": "const maxRetry = 3;\nclass UserService { }"
  },
  "reasoning": {
    "whyStandard": "Effective Dart Style 是 Dart 官方规范，dart analyze + flutter_lints 强制执行",
    "sources": ["Effective Dart - Style", "Dart Linter Rules"],
    "confidence": 0.95
  }
}
```

### 维度 2: 使用习惯 (code-pattern) — 参考模板

**Swift 示例：**

```json
{
  "title": "单例模式: 使用 static let shared",
  "trigger": "@swift-singleton",
  "content": {
    "markdown": "## Swift 单例模式\n\n### ✅ 推荐模式\n```swift\nclass CacheManager {\n  static let shared = CacheManager()\n  private init() { }\n  \n  func store(_ data: Data, forKey key: String) { ... }\n}\n\n// 使用\nCacheManager.shared.store(data, forKey: \"user\")\n```\n\n### 要点\n- `static let` 天然线程安全（dispatch_once 语义）\n- `private init()` 防止外部实例化\n- 属性名通常用 `shared` 或 `default`",
    "pattern": "class CacheManager {\n  static let shared = CacheManager()\n  private init() { }\n}",
    "rationale": "Swift 的 static let 天然线程安全（dispatch_once 语义）。private init() 防止外部实例化。"
  },
  "description": "Swift 单例模式：static let shared + private init()，天然线程安全",
  "kind": "pattern",
  "doClause": "Implement singletons using static let shared with private init for thread safety",
  "language": "swift",
  "headers": ["import Foundation"],
  "category": "Service",
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\n创建 Manager/Service 类的唯一实例时，触发 `@swift-singleton` 获取标准单例实现模式。",
  "difficulty": "beginner",
  "scope": "universal",
  "steps": [
    { "title": "声明", "description": "用 static let shared 暴露唯一实例", "code": "static let shared = MyService()" },
    { "title": "私有初始化", "description": "用 private init() 防止外部创建", "code": "private init() { }" },
    { "title": "命名", "description": "属性名通常用 shared 或 default", "code": "" }
  ],
  "reasoning": {
    "whyStandard": "项目中 Manager/Service 类全部采用此模式。static let 在 Swift 中自动 lazy + thread-safe",
    "sources": ["Google Swift Style Guide - Static and Class Properties"],
    "confidence": 0.9
  }
}
```

**TypeScript 示例：**

```json
{
  "title": "单例模式: class + private constructor + getInstance()",
  "trigger": "@ts-singleton",
  "content": {
    "markdown": "## TypeScript 单例模式\n\n### ✅ 推荐模式\n```typescript\nclass CacheManager {\n  private static instance: CacheManager;\n  private constructor() { }\n\n  static getInstance(): CacheManager {\n    if (!CacheManager.instance) {\n      CacheManager.instance = new CacheManager();\n    }\n    return CacheManager.instance;\n  }\n\n  store(key: string, data: unknown): void { /* ... */ }\n}\n\n// 使用\nCacheManager.getInstance().store('user', data);\n```\n\n### 要点\n- `private constructor` 阻止外部实例化\n- `getInstance()` 保证返回唯一实例\n- 也可用 ES Module 导出单实例对象作为替代",
    "pattern": "class CacheManager {\n  private static instance: CacheManager;\n  private constructor() { }\n  static getInstance(): CacheManager { ... }\n}",
    "rationale": "TypeScript 用 private constructor 阻止外部实例化，getInstance() 保证唯一。也可用 ES Module 导出单实例对象。"
  },
  "description": "TypeScript 单例模式：private constructor + 静态 getInstance()，保证唯一实例",
  "kind": "pattern",
  "doClause": "Implement singletons using private constructor and static getInstance method",
  "language": "typescript",
  "headers": [],
  "category": "Service",
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\n创建 TypeScript Manager/Service 单例时，触发 `@ts-singleton` 获取标准实现模式。",
  "difficulty": "beginner",
  "scope": "universal",
  "reasoning": {
    "whyStandard": "项目中 Manager/Service 类使用此模式或 module-level 单例",
    "sources": ["TypeScript Design Patterns"],
    "confidence": 0.9
  }
}
```

**Go 示例：**

```json
{
  "title": "单例模式: sync.Once + 包级变量",
  "trigger": "@go-singleton",
  "content": {
    "markdown": "## Go 单例模式\n\n### ✅ 推荐模式\n```go\nvar (\n\tinstance *CacheManager\n\tonce     sync.Once\n)\n\nfunc GetCacheManager() *CacheManager {\n\tonce.Do(func() {\n\t\tinstance = &CacheManager{}\n\t})\n\treturn instance\n}\n\ntype CacheManager struct { /* ... */ }\nfunc (c *CacheManager) Store(key string, data []byte) { /* ... */ }\n```\n\n### 要点\n- `sync.Once` 保证初始化函数只执行一次（并发安全）\n- 包级变量 + 导出函数暴露实例\n- 延迟初始化，首次调用时才创建",
    "pattern": "var (\n\tinstance *CacheManager\n\tonce     sync.Once\n)\n\nfunc GetCacheManager() *CacheManager {\n\tonce.Do(func() { instance = &CacheManager{} })\n\treturn instance\n}",
    "rationale": "Go 使用 sync.Once 保证线程安全的延迟初始化，是标准单例实现方式。"
  },
  "description": "Go 单例模式：sync.Once 保证线程安全的延迟初始化",
  "kind": "pattern",
  "doClause": "Implement singletons using sync.Once with package-level variable for thread-safe lazy init",
  "language": "go",
  "headers": ["import \"sync\""],
  "category": "Service",
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\n创建 Go 全局唯一实例时，触发 `@go-singleton` 获取 sync.Once 标准模式。",
  "difficulty": "beginner",
  "scope": "universal",
  "reasoning": {
    "whyStandard": "sync.Once 是 Go 标准库提供的并发安全初始化原语",
    "sources": ["Effective Go", "Go sync package documentation"],
    "confidence": 0.9
  }
}
```

**Dart (Flutter) 示例：**

```json
{
  "title": "单例模式: private constructor + static final instance",
  "trigger": "@dart-singleton",
  "content": {
    "markdown": "## Dart 单例模式\n\n### ✅ 推荐模式\n```dart\nclass CacheManager {\n  CacheManager._();\n  static final CacheManager instance = CacheManager._();\n\n  // 或使用 factory 构造函数\n  factory CacheManager() => instance;\n\n  void store(String key, dynamic data) { /* ... */ }\n}\n\n// 使用\nCacheManager.instance.store('user', data);\n// 或\nCacheManager().store('user', data);\n```\n\n### 要点\n- `ClassName._()` private 命名构造函数阻止外部实例化\n- `static final` 保证唯一实例，Dart 天然线程安全（单隔离区）\n- factory 构造函数可选，让调用更自然",
    "pattern": "class CacheManager {\n  CacheManager._();\n  static final CacheManager instance = CacheManager._();\n  factory CacheManager() => instance;\n}",
    "rationale": "Dart 的 private 命名构造函数 + static final 是标准单例实现，单 Isolate 天然线程安全。"
  },
  "description": "Dart 单例模式：private constructor + static final instance",
  "kind": "pattern",
  "doClause": "Implement singletons using private named constructor with static final instance",
  "language": "dart",
  "headers": [],
  "category": "Service",
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\n创建 Dart Manager/Service 单例时，触发 `@dart-singleton` 获取标准模式。",
  "difficulty": "beginner",
  "scope": "universal",
  "reasoning": {
    "whyStandard": "Dart 社区通用单例模式，factory 构造函数是语言特性",
    "sources": ["Effective Dart - Design", "Dart Language Tour - Constructors"],
    "confidence": 0.9
  }
}
```

### 维度 3: 最佳实践 (best-practice) — 参考模板

**Swift 示例：**

```json
{
  "title": "错误处理: 用 typed Error enum + do-catch",
  "trigger": "@swift-error-handling",
  "content": {
    "markdown": "## Swift 错误处理最佳实践\n\n### ✅ 推荐：typed Error enum + do-catch\n```swift\nenum NetworkError: Error {\n  case invalidURL\n  case timeout\n  case serverError(statusCode: Int)\n}\n\nfunc fetchData(from url: String) throws -> Data {\n  guard let url = URL(string: url) else {\n    throw NetworkError.invalidURL\n  }\n  // ...\n}\n\ndo {\n  let data = try fetchData(from: endpoint)\n} catch NetworkError.timeout {\n  showRetryAlert()\n} catch {\n  log(error)\n}\n```\n\n### 要点\n- 用 typed enum Error 使调用者能精确 catch 不同错误类型\n- 避免 generic Error string\n- throws 优于 Result 混合模型（Google Swift Style Guide）",
    "pattern": "enum NetworkError: Error {\n  case invalidURL\n  case timeout\n  case serverError(statusCode: Int)\n}\n\nfunc fetchData(from url: String) throws -> Data { ... }\n\ndo {\n  let data = try fetchData(from: endpoint)\n} catch NetworkError.timeout {\n  showRetryAlert()\n}",
    "rationale": "用 typed enum Error 使调用者能精确 catch 不同错误类型。避免 generic Error string。Google Swift Style Guide 明确推荐 throws 而非 Result 混合模型。"
  },
  "description": "Swift 错误处理：typed Error enum + do-catch 精确捕获不同错误类型",
  "kind": "pattern",
  "doClause": "Use typed Error enum with do-catch for precise error handling instead of generic errors",
  "language": "swift",
  "headers": ["import Foundation"],
  "category": "Service",
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\n在 Swift 中处理可能失败的操作时，触发 `@swift-error-handling` 获取标准错误处理模式。",
  "difficulty": "intermediate",
  "scope": "universal",
  "antiPattern": {
    "bad": "func fetchData() -> String? { return nil /* on error */ }",
    "why": "返回 nil 丢失错误信息，调用者无法区分'无数据'和'发生错误'",
    "fix": "func fetchData() throws -> Data { throw NetworkError.timeout }"
  },
  "reasoning": {
    "whyStandard": "Swift 的 throws/catch 机制强制调用者处理错误，编译器保证完整性",
    "sources": ["Google Swift Style Guide - Error Types", "Swift Language Guide"],
    "confidence": 0.95
  }
}
```

**Go 示例：**

```json
{
  "title": "错误处理: 自定义 error 类型 + errors.Is/As",
  "trigger": "@go-error-handling",
  "content": {
    "markdown": "## Go 错误处理最佳实践\n\n### ✅ 推荐：自定义 error + fmt.Errorf %w + errors.Is/As\n```go\ntype NetworkError struct {\n\tStatusCode int\n\tMessage    string\n}\n\nfunc (e *NetworkError) Error() string {\n\treturn fmt.Sprintf(\"network error %d: %s\", e.StatusCode, e.Message)\n}\n\nvar ErrTimeout = errors.New(\"request timeout\")\n\nfunc fetchData(url string) ([]byte, error) {\n\tresp, err := http.Get(url)\n\tif err != nil {\n\t\treturn nil, fmt.Errorf(\"fetch failed: %w\", err)\n\t}\n\tif resp.StatusCode >= 400 {\n\t\treturn nil, &NetworkError{StatusCode: resp.StatusCode}\n\t}\n\treturn io.ReadAll(resp.Body)\n}\n\n// 调用端\ndata, err := fetchData(endpoint)\nif errors.Is(err, ErrTimeout) {\n\t// 重试\n} else if var ne *NetworkError; errors.As(err, &ne) {\n\tlog.Printf(\"server error: %d\", ne.StatusCode)\n}\n```\n\n### 要点\n- 自定义 error 类型实现 `Error()` 接口\n- `fmt.Errorf(\"%w\")` 包装错误链\n- `errors.Is/As` 解包判断错误类型",
    "pattern": "type NetworkError struct {\n\tStatusCode int\n\tMessage    string\n}\nfunc (e *NetworkError) Error() string { ... }\nvar ErrTimeout = errors.New(\"request timeout\")\nfunc fetchData(url string) ([]byte, error) { ... }",
    "rationale": "Go 用自定义 error 类型 + fmt.Errorf %w 包装 + errors.Is/As 判断，是官方推荐的错误处理模式。"
  },
  "description": "Go 错误处理：自定义 error 类型 + fmt.Errorf %w 包装 + errors.Is/As",
  "kind": "pattern",
  "doClause": "Use custom error types with fmt.Errorf wrapping and errors.Is/As for structured error handling",
  "language": "go",
  "headers": ["import \"errors\"", "import \"fmt\"", "import \"net/http\""],
  "category": "Service",
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\n在 Go 项目中处理错误时，触发 `@go-error-handling` 获取标准错误处理模式。",
  "difficulty": "intermediate",
  "scope": "universal",
  "antiPattern": {
    "bad": "func fetchData() string { return \"\" /* on error */ }",
    "why": "返回空字符串丢失错误信息，调用者无法区分'空结果'和'出错'",
    "fix": "func fetchData() (string, error) { return \"\", fmt.Errorf(\"timeout\") }"
  },
  "reasoning": {
    "whyStandard": "Go 的多返回值 + error 接口是核心错误处理范式，errors.Is/As 支持错误链解包",
    "sources": ["Effective Go - Errors", "Go Blog: Working with Errors in Go 1.13"],
    "confidence": 0.95
  }
}
```

**Java 示例：**

```json
{
  "title": "错误处理: 自定义异常层级 + 特定 catch",
  "trigger": "@java-error-handling",
  "content": {
    "markdown": "## Java 错误处理最佳实践\n\n### ✅ 推荐：自定义异常层级 + 特定 catch\n```java\npublic class NetworkException extends RuntimeException {\n    private final int statusCode;\n    public NetworkException(int statusCode, String message) {\n        super(message);\n        this.statusCode = statusCode;\n    }\n    public int getStatusCode() { return statusCode; }\n}\n\npublic class TimeoutException extends NetworkException {\n    public TimeoutException() { super(408, \"Request Timeout\"); }\n}\n\n// 调用端\ntry {\n    var data = fetchData(endpoint);\n} catch (TimeoutException e) {\n    retryLater();\n} catch (NetworkException e) {\n    log.error(\"Server error: {}\", e.getStatusCode());\n}\n```\n\n### 要点\n- 自定义异常继承层级，精确 catch\n- 避免 `catch (Exception e)` 一揽子处理\n- 携带业务信息（如 statusCode）",
    "pattern": "public class NetworkException extends RuntimeException {\n    private final int statusCode;\n    ...\n}\npublic class TimeoutException extends NetworkException { ... }\ntry { ... } catch (TimeoutException e) { ... } catch (NetworkException e) { ... }",
    "rationale": "用异常层级使调用者能精确 catch 不同错误类型，避免 catch (Exception e) 一揽子处理。"
  },
  "description": "Java 错误处理：自定义异常层级 + 特定 catch 精确处理",
  "kind": "pattern",
  "doClause": "Use custom exception hierarchy with specific catch blocks for precise error handling",
  "language": "java",
  "headers": [],
  "category": "Service",
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\n在 Java 项目中设计错误处理时，触发 `@java-error-handling` 获取自定义异常层级模式。",
  "difficulty": "intermediate",
  "scope": "universal",
  "reasoning": {
    "whyStandard": "Java 的 checked/unchecked exception 体系要求结构化的错误处理",
    "sources": ["Effective Java - Exceptions", "Google Java Style Guide"],
    "confidence": 0.95
  }
}
```

**Dart (Flutter) 示例：**

```json
{
  "title": "错误处理: 自定义 Exception + on-catch + Result 模式",
  "trigger": "@dart-error-handling",
  "content": {
    "markdown": "## Dart 错误处理最佳实践\n\n### ✅ 推荐：自定义 Exception + on-catch\n```dart\nclass NetworkException implements Exception {\n  final int statusCode;\n  final String message;\n  const NetworkException(this.statusCode, this.message);\n\n  @override\n  String toString() => 'NetworkException($statusCode): $message';\n}\n\nclass TimeoutException extends NetworkException {\n  const TimeoutException() : super(408, 'Request timeout');\n}\n\nFuture<User> fetchUser(int id) async {\n  try {\n    return await _api.getUser(id);\n  } on TimeoutException {\n    return _cache.getUser(id) ?? rethrow;\n  } on NetworkException catch (e) {\n    _logger.warning('Network error: $e');\n    rethrow;\n  }\n}\n```\n\n### 要点\n- 自定义 Exception 携带业务信息（如 statusCode）\n- `on Type catch (e)` 精确捕获不同类型\n- `rethrow` 保留原始堆栈信息\n- 避免 `catch (_) { }` 吞掉所有错误",
    "pattern": "class NetworkException implements Exception {\n  final int statusCode;\n  final String message;\n  const NetworkException(this.statusCode, this.message);\n}\n\ntry {\n  ...\n} on TimeoutException {\n  ...\n} on NetworkException catch (e) {\n  rethrow;\n}",
    "rationale": "Dart 用 on .. catch 精确捕获不同异常类型，rethrow 保留原始堆栈。Effective Dart 推荐 implements Exception 而非 extends Error。"
  },
  "description": "Dart 错误处理：自定义 Exception + on-catch 精确捕获",
  "kind": "pattern",
  "doClause": "Use custom Exception types with on-catch blocks for structured error handling",
  "language": "dart",
  "headers": [],
  "category": "Service",
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\n在 Dart/Flutter 项目中设计错误处理时，触发 `@dart-error-handling` 获取自定义 Exception 模式。",
  "difficulty": "intermediate",
  "scope": "universal",
  "antiPattern": {
    "bad": "try { ... } catch (_) { }  // 或 throw 'error string'",
    "why": "吞掉所有错误让 bug 难以排查；throw String 丢失堆栈信息",
    "fix": "自定义 Exception + on .. catch + rethrow"
  },
  "reasoning": {
    "whyStandard": "Effective Dart - Error handling; Dart 的 on-catch 支持按类型精确捕获",
    "sources": ["Effective Dart - Usage (Errors)", "Dart Language Tour - Exceptions"],
    "confidence": 0.95
  }
}
```

### 维度 4: 调用链 (call-chain) — 参考模板

**Swift 示例：**

```json
{
  "title": "用户登录调用链: View → ViewModel → AuthService → API",
  "trigger": "@swift-login-chain",
  "content": {
    "markdown": "## Swift 用户登录调用链\n\n### 完整链路\n```\n1. LoginView: Button tap → viewModel.login()\n2. LoginViewModel: @MainActor func login()\n   → authService.authenticate(email, password)\n3. AuthService: func authenticate() async throws → Token\n   → apiClient.post(\"/auth/login\", body)\n4. APIClient: func post<T>() async throws → T\n   → URLSession.shared.data(for: request)\n5. 返回链: Token → AuthService 存 Keychain → ViewModel 更新状态 → View 刷新\n```\n\n### 边界约束\n- AuthService 不直接 import View 层\n- Token 存取只通过 KeychainService",
    "pattern": "LoginView → LoginViewModel → AuthService → APIClient → URLSession\nToken → Keychain → ViewModel state → View refresh",
    "rationale": "登录是最核心的业务流程之一，新人必须理解完整链路才能修改认证逻辑。"
  },
  "description": "Swift 用户登录调用链：View → ViewModel → AuthService → API 四层链路",
  "kind": "fact",
  "doClause": "Follow the View to ViewModel to AuthService to API call chain for login flow",
  "language": "swift",
  "headers": ["import Foundation"],
  "category": "View",
  "knowledgeType": "call-chain",
  "usageGuide": "### 使用场景\n修改登录流程或认证逻辑时，触发 `@swift-login-chain` 查看完整调用链路。",
  "difficulty": "intermediate",
  "scope": "project-specific",
  "constraints": {
    "boundaries": ["AuthService 不直接 import View 层", "Token 存取只通过 KeychainService"],
    "preconditions": ["网络可用", "API endpoint 已配置"]
  },
  "reasoning": {
    "whyStandard": "登录流程涉及 4 层，任何一层修改都可能影响整个链路",
    "sources": ["Sources/Auth/LoginViewModel.swift", "Sources/Service/AuthService.swift"],
    "confidence": 0.85
  }
}
```

**TypeScript (React) 示例：**

```json
{
  "title": "用户登录调用链: Component → Hook → Service → API",
  "trigger": "@ts-login-chain",
  "content": {
    "markdown": "## TypeScript/React 登录调用链\n\n### 完整链路\n```\n1. LoginPage: form submit → useAuth().login(email, password)\n2. useAuth hook: async login()\n   → authService.authenticate(email, password)\n3. AuthService: authenticate() → fetch('/api/auth/login', { method: 'POST', body })\n4. API route: POST /api/auth/login → validate → JWT\n5. 返回链: Token → localStorage.setItem → hook setState → Component re-render\n```\n\n### 边界约束\n- Component 不直接调用 fetch\n- Token 存取只通过 AuthService",
    "pattern": "LoginPage → useAuth() hook → AuthService.authenticate() → fetch('/api/auth/login')\nToken → localStorage → hook setState → Component re-render",
    "rationale": "登录流程是前端核心链路，涉及 UI → Hook → Service → API 四层。"
  },
  "description": "TypeScript/React 登录调用链：Component → Hook → Service → API",
  "kind": "fact",
  "doClause": "Follow the Component to Hook to Service to API call chain for login flow",
  "language": "typescript",
  "headers": ["import { useState } from 'react'"],
  "category": "View",
  "knowledgeType": "call-chain",
  "usageGuide": "### 使用场景\n修改前端登录流程时，触发 `@ts-login-chain` 查看完整调用链路。",
  "difficulty": "intermediate",
  "scope": "project-specific",
  "constraints": {
    "boundaries": ["Component 不直接调用 fetch", "Token 存取只通过 AuthService"],
    "preconditions": ["API 服务可用", "CORS 配置正确"]
  },
  "reasoning": {
    "whyStandard": "前端登录流程涉及多层，清晰的链路文档帮助新人快速理解",
    "sources": ["src/pages/LoginPage.tsx", "src/services/authService.ts"],
    "confidence": 0.85
  }
}
```

### 维度 7: Bug 修复 (solution + antiPattern) — 参考模板

**Swift 示例：**

```json
{
  "title": "[Bug] 闭包中循环引用导致内存泄漏",
  "trigger": "@swift-retain-cycle",
  "content": {
    "markdown": "## Swift 闭包循环引用修复\n\n### ❌ 内存泄漏\n```swift\nclass ViewModel {\n  var onComplete: (() -> Void)?\n  func start() {\n    service.fetch { result in\n      self.onComplete?()  // strong capture → retain cycle\n    }\n  }\n}\n```\n\n### ✅ 修复：[weak self]\n```swift\nclass ViewModel {\n  var onComplete: (() -> Void)?\n  func start() {\n    service.fetch { [weak self] result in\n      self?.onComplete?()\n    }\n  }\n}\n```\n\n### 要点\n- 闭包默认 strong capture self\n- 如果 self 也持有 closure（直接或间接），形成 retain cycle\n- 用 `[weak self]` 打破循环",
    "pattern": "service.fetch { [weak self] result in\n  self?.onComplete?()\n}",
    "rationale": "Swift 使用 ARC，闭包默认 strong capture。任何可能被持有的闭包都应使用 [weak self] 避免 retain cycle。"
  },
  "description": "Swift 闭包循环引用修复：[weak self] 避免 retain cycle 内存泄漏",
  "kind": "pattern",
  "doClause": "Use [weak self] in closures that may be retained to prevent retain cycle memory leaks",
  "language": "swift",
  "headers": ["import Foundation"],
  "category": "Tool",
  "knowledgeType": "solution",
  "usageGuide": "### 使用场景\n遇到 Swift 闭包中的 self 引用时，触发 `@swift-retain-cycle` 检查是否需要 weak capture。",
  "difficulty": "intermediate",
  "scope": "universal",
  "antiPattern": {
    "bad": "service.fetch { result in self.handle(result) }",
    "why": "closure 强引用 self，如果 self 也持有 closure（直接或间接），形成 retain cycle，对象永不释放",
    "fix": "service.fetch { [weak self] result in self?.handle(result) }"
  },
  "reasoning": {
    "whyStandard": "Swift 使用 ARC，闭包默认 strong capture。任何可能被持有的闭包都应使用 [weak self]",
    "sources": ["Memory Management Best Practices", "Apple ARC Documentation"],
    "confidence": 0.95
  }
}
```

**Go 示例：**

```json
{
  "title": "[Bug] goroutine 泄漏: 未关闭的 channel 导致 goroutine 永久阻塞",
  "trigger": "@go-goroutine-leak",
  "content": {
    "markdown": "## Go goroutine 泄漏修复\n\n### ❌ goroutine 泄漏\n```go\nfunc fetchAll(urls []string) []string {\n\tch := make(chan string)\n\tfor _, url := range urls {\n\t\tgo func(u string) {\n\t\t\tresp, _ := http.Get(u)\n\t\t\tch <- resp.Status  // 如果 fetchAll 提前返回，goroutine 永久阻塞\n\t\t}(url)\n\t}\n\t// 只读取部分结果...\n}\n```\n\n### ✅ 修复: buffered channel + context\n```go\nfunc fetchAll(ctx context.Context, urls []string) []string {\n\tch := make(chan string, len(urls))  // buffered\n\tfor _, url := range urls {\n\t\tgo func(u string) {\n\t\t\treq, _ := http.NewRequestWithContext(ctx, \"GET\", u, nil)\n\t\t\tresp, err := http.DefaultClient.Do(req)\n\t\t\tif err != nil { ch <- \"\"; return }\n\t\t\tch <- resp.Status\n\t\t}(url)\n\t}\n\tresults := make([]string, 0, len(urls))\n\tfor range urls {\n\t\tresults = append(results, <-ch)\n\t}\n\treturn results\n}\n```\n\n### 要点\n- unbuffered channel 在无接收者时阻塞发送方 goroutine\n- 用 buffered channel 或 context 取消避免泄漏",
    "pattern": "ch := make(chan string, len(urls))  // buffered\ngo func(u string) {\n\treq, _ := http.NewRequestWithContext(ctx, \"GET\", u, nil)\n\t...\n\tch <- resp.Status\n}(url)",
    "rationale": "Go goroutine 无自动回收机制，泄漏的 goroutine 会持续占用内存和 CPU。用 buffered channel + context 取消是标准解法。"
  },
  "description": "Go goroutine 泄漏修复：buffered channel + context 取消避免永久阻塞",
  "kind": "pattern",
  "doClause": "Use buffered channels and context cancellation to prevent goroutine leaks from blocking sends",
  "language": "go",
  "headers": ["import \"context\"", "import \"net/http\""],
  "category": "Tool",
  "knowledgeType": "solution",
  "usageGuide": "### 使用场景\n遇到 goroutine 泄漏或 channel 阻塞问题时，触发 `@go-goroutine-leak` 获取修复模式。",
  "difficulty": "intermediate",
  "scope": "universal",
  "antiPattern": {
    "bad": "ch := make(chan string)\ngo func() { ch <- result }()\n// caller 不再读取 → goroutine 永久阻塞",
    "why": "unbuffered channel 在无接收者时阻塞发送方 goroutine，造成泄漏",
    "fix": "ch := make(chan string, 1) // buffered，或用 context 取消"
  },
  "reasoning": {
    "whyStandard": "Go goroutine 无自动回收机制，泄漏的 goroutine 会持续占用内存和 CPU",
    "sources": ["Concurrency in Go", "Go Blog: Go Concurrency Patterns"],
    "confidence": 0.95
  }
}
```

**JavaScript 示例：**

```json
{
  "title": "[Bug] async 函数中未 await 的 Promise 导致静默失败",
  "trigger": "@js-foreach-async",
  "content": {
    "markdown": "## JS forEach + async 陷阱修复\n\n### ❌ 静默失败 — 未 await\n```javascript\nasync function processItems(items) {\n  items.forEach(async (item) => {\n    await saveToDatabase(item);  // forEach 不等待 async 回调！\n  });\n  console.log('Done');  // 实际上 save 还没完成\n}\n```\n\n### ✅ 修复: Promise.all + map\n```javascript\nasync function processItems(items) {\n  await Promise.all(\n    items.map(item => saveToDatabase(item))\n  );\n  console.log('Done');  // 所有 save 完成后才执行\n}\n```\n\n### 要点\n- `Array.forEach` 不处理 async 回调的返回值（Promise）\n- 导致并发不可控且错误被吞\n- 用 `Promise.all + map` 或 `for...of` 替代",
    "pattern": "await Promise.all(\n  items.map(item => saveToDatabase(item))\n);",
    "rationale": "Array.forEach 不处理 async 回调的返回值（Promise），导致并发不可控且错误被吞。用 Promise.all + map 替代。"
  },
  "description": "JS forEach+async 陷阱修复：用 Promise.all + map 替代 forEach",
  "kind": "pattern",
  "doClause": "Replace forEach with Promise.all and map when iterating with async operations",
  "language": "javascript",
  "headers": [],
  "category": "Tool",
  "knowledgeType": "solution",
  "usageGuide": "### 使用场景\n遇到 forEach + async 组合时，触发 `@js-foreach-async` 获取正确的异步迭代模式。",
  "difficulty": "intermediate",
  "scope": "universal",
  "antiPattern": {
    "bad": "items.forEach(async (item) => { await doSomething(item); })",
    "why": "Array.forEach 不处理 async 回调的返回值（Promise），导致并发不可控且错误被吞",
    "fix": "await Promise.all(items.map(item => doSomething(item)))"
  },
  "reasoning": {
    "whyStandard": "forEach + async 是 JS 中最常见的异步陷阱之一，ESLint 有专门规则检测",
    "sources": ["MDN: Array.forEach", "ESLint: no-await-in-loop"],
    "confidence": 0.95
  }
}
```

**Dart (Flutter) 示例：**

```json
{
  "title": "[Bug] BuildContext 跨越 async gap 导致引用已卸载的 Widget",
  "trigger": "@dart-context-async",
  "content": {
    "markdown": "## Flutter BuildContext 跨 async gap 修复\n\n### ❌ 错误: BuildContext 跨越 async gap\n```dart\nFuture<void> _handleTap(BuildContext context) async {\n  final data = await fetchData();\n  // ⚠️ await 后 context 可能已失效（Widget 已卸载）\n  Navigator.of(context).push(...);  // 可能崩溃\n  ScaffoldMessenger.of(context).showSnackBar(...);  // 可能崩溃\n}\n```\n\n### ✅ 修复: 在 await 前缓存所需对象\n```dart\nFuture<void> _handleTap(BuildContext context) async {\n  final navigator = Navigator.of(context);  // await 前缓存\n  final messenger = ScaffoldMessenger.of(context);\n\n  final data = await fetchData();\n\n  navigator.push(...);     // 安全\n  messenger.showSnackBar(...);  // 安全\n}\n\n// ✅ 或在 StatefulWidget 中检查 mounted\nFuture<void> _handleTap() async {\n  final data = await fetchData();\n  if (!mounted) return;  // Widget 已卸载则退出\n  Navigator.of(context).push(...);\n}\n```\n\n### 要点\n- `BuildContext` 绑定到 Widget Element，Widget 卸载后 context 失效\n- `await` 之后当前 Widget 可能已被 dispose\n- 在 `await` 前缓存 `Navigator.of(context)` 等引用，或在 `await` 后检查 `mounted`",
    "pattern": "final navigator = Navigator.of(context);  // await 前缓存\nfinal data = await fetchData();\nnavigator.push(...);  // 安全",
    "rationale": "Flutter 的 BuildContext 绑定到 Widget Element 生命周期，await 后 Widget 可能已卸载导致 context 失效。use_build_context_synchronously lint 规则检测此问题。"
  },
  "description": "Flutter BuildContext 跨 async gap 修复：await 前缓存或 await 后检查 mounted",
  "kind": "pattern",
  "doClause": "Cache context-dependent references before await or check mounted after await",
  "language": "dart",
  "headers": ["import 'package:flutter/material.dart';"],
  "category": "Tool",
  "knowledgeType": "solution",
  "usageGuide": "### 使用场景\n在 Flutter 中使用 BuildContext + async/await 时，触发 `@dart-context-async` 获取安全使用模式。",
  "difficulty": "intermediate",
  "scope": "universal",
  "antiPattern": {
    "bad": "await fetchData();\nNavigator.of(context).push(...);",
    "why": "await 后 Widget 可能已卸载，context 失效，导致运行时异常",
    "fix": "final nav = Navigator.of(context); await fetchData(); nav.push(...);"
  },
  "reasoning": {
    "whyStandard": "Flutter use_build_context_synchronously lint 规则；官方异步最佳实践",
    "sources": ["Flutter Lint: use_build_context_synchronously", "Effective Dart - Usage"],
    "confidence": 0.95
  }
}
```

### 更多语言参考

> 语言特有的最佳实践知识（典型模式、反模式、分析维度等）已内置于 Bootstrap 的 `languageExtension` 字段中，
> 会随 Mission Briefing 自动返回，无需额外加载 Skill。

---

## Troubleshooting

| 问题 | 解决 |
|------|------|
| 文件太多超出 context window | 减小 `maxFiles`，或先分析 high priority 文件 |
| 分析维度太多一次做不完 | 分 Target 分批进行，每次分析 1-2 个 Target |
| 分析质量不高 | 检查 submissionSchema 中的示例，确保字段格式严格匹配 |
| Guard 违规太多 | 先处理 Guard 违规，再做知识分析 |
| 提交后候选在哪里 | Dashboard → Candidates 页面审核 |
| 不知道该语言的最佳实践 | Bootstrap 返回的 languageExtension 已包含语言特有知识 |

---

## MCP Tools Referenced

| Tool | 用途 |
|------|------|
| `autosnippet_bootstrap` | 冷启动 Mission Briefing（无参数，返回项目分析 + 维度任务清单） |
| `autosnippet_dimension_complete` | 维度分析完成通知（提交 recipe 后调用） |
| `autosnippet_enrich_candidates` | 候选字段完整性诊断 |
| `autosnippet_submit_knowledge_batch` | 批量提交候选 |
| `autosnippet_submit_knowledge` | 提交单条候选（内置自动校验 + 去重检查） |
| `autosnippet_search(mode=context)` | 查找已有知识（避免重复） |
| `autosnippet_skill(operation=list)` | 列出可用 Skill 列表 |
| `autosnippet_skill(operation=load)` | 加载指定 Skill 文档获取指引 |

## Related Skills

- **autosnippet-analysis**: 语义字段补全 + 深度分析（用于增量分析）
- **autosnippet-candidates**: 完整候选字段模型 + V3 Schema
- **autosnippet-structure**: 项目结构发现 (targets / files / dependencies)
- **autosnippet-guard**: Guard 规则详情
