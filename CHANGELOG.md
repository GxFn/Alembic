# Changelog

本文档记录 AutoSnippet 的版本变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

---

## [3.0.9] - 2026-02-22

### 改进

- **全平台兼容（macOS / Linux / Windows）**：深度审计并修复 7 处 macOS 专属依赖，基础设施层现在可在三大平台运行
- **ClipboardManager 跨平台重写**：macOS pbcopy/pbpaste 保留；Linux 自动检测 Wayland（wl-copy/wl-paste）与 X11（xclip/xsel），结果缓存；Windows 使用 PowerShell `Get-Clipboard`/`Set-Clipboard`
- **NativeUi.notify() 跨平台**：macOS osascript 保留；Linux 使用 `notify-send`（libnotify）；Windows 使用 PowerShell UWP ToastNotificationManager
- **SetupService IDE 发现跨平台**：`which` → Windows 使用 `where`，stderr 通过 `stdio` 选项抑制而非 shell `2>/dev/null`；新增 Windows（`%LOCALAPPDATA%\Programs\*`）及 Linux（`/usr/share/code/`、`/usr/bin/`、`~/.local/bin/`）IDE 路径
- **路径解析跨平台**：`readlink -f` shell 命令替换为 Node.js 原生 `fs.realpathSync()`
- **Paths.js 平台感知**：`getSnippetsPath()` 在非 macOS 返回 `~/.autosnippet/snippets/`，macOS 保留 Xcode CodeSnippets 路径
- **PathGuard 平台条件允许列表**：Xcode snippets 路径仅在 macOS 加入默认 allowlist，其余平台使用 `~/.autosnippet/snippets`

### 修复

- **`os.getenv` Windows 崩溃**：`install-vscode-copilot.js` 中 `os.getenv('APPDATA')` 不是 Node.js API，替换为 `process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')`

---

## [3.0.8] - 2026-02-21

### 改进

- **web-tree-sitter WASM 迁移**：从原生 `tree-sitter` 迁移至 `web-tree-sitter@0.25.0`（WASM），消除 C++ 编译依赖，全 11 语言（Go/Python/Java/Kotlin/Swift/JS/TS/Rust/ObjC/Dart/C#）均通过 286 文件零错误解析验证
- **Guard 规则误报大幅降低**：总违规从 261 降至 118（-55%），新增 `skipComments`（跳过注释行）、`skipTestBlocks`（跳过 Rust `#[cfg(test)]` 内联测试模块）、扩展 `excludePaths`（8 条规则增加测试/mock/bench 目录排除）
- **Dart (Flutter) Guard 优化**：`dart-avoid-dynamic` 排除 `Map<String, dynamic>` JSON 标准模式（-87.5%），`dart-no-set-state-after-dispose` 降级为 info
- **Go 规则精调**：`go-no-global-var` 排除 `var _ Interface = ...` 接口满足断言模式，测试文件排除覆盖 `_test.go`

### 新增

- **`_buildCommentMask()` 方法**：按语言构建注释行布尔掩码（支持 `//`/`///`/`/* */`/`#`/`"""`），供规则级 `skipComments` 标志使用
- **`_buildTestBlockMask()` 方法**：追踪 Rust `#[cfg(test)] mod tests { ... }` 花括号深度，精确标记内联测试块行
- **AppFlowy 测试项目**：新增第 10 个测试项目（1976 Dart 文件的真实 Flutter 应用），覆盖全部 9 条 Dart Guard 规则

### 修复

- **`getRules()` 属性传播 bug**：内置规则的 `skipComments` / `skipTestBlocks` 属性未被复制到重构的规则对象中，导致这两个标志静默失效

---

## [3.0.7] - 2026-02-21

### 新增

- **VS Code 扩展项目作用域**：扩展仅在工作区包含 AutoSnippet 项目（存在 `AutoSnippet/` 或 `.autosnippet/` 目录）时激活状态栏、CodeLens 和 onSave 指令检测，非项目零开销
- **projectScope 模块**：新增 `projectScope.ts`，提供 `hasAnyProject()` / `isFileInScope()` / `isDocumentInScope()` / `invalidateCache()` 等 API

### 修复

- **轮询定时器泄漏**：`StatusBar.hide()` 不再连带停止 health check 轮询，避免切换编辑器后轮询永久丢失；新增独立 `stopPolling()` 方法
- **重复定时器**：`startPolling()` 增加防重保护，防止工作区目录变化时创建多个 `setInterval`

---

## [3.0.6] - 2026-02-21

### 修复

- **package-lock.json 同步**：`tree-sitter-rust` 缺失导致 `npm ci` 失败，重新同步 lock 文件

---

## [3.0.5] - 2026-02-21

### 改进

- **项目描述统一**：package.json、README.md、README_CN.md 使用统一的短句/长句描述体系
- **package.json keywords 扩充**：从 3 个扩至 21 个，覆盖核心功能、AI 生态、支持语言

---

## [3.0.4] - 2026-02-21

### 修复

- **AI 提取输出语言链路**：AI 提取和富化的输出现在尊重用户 locale，中文环境下不再输出英文描述。修改涉及 ChatAgent、tools.js、AiProvider、candidates 路由
- **Module Explorer 自定义文件夹不持久化**：`api.fetchData()` 中 `projectRoot` 硬编码为空字符串，导致 localStorage key 失效。改为并行请求 `/modules/project-info` 获取真实路径
- **Help 页面展开/折叠跳顶**：`Section` 组件定义在 `HelpView` 函数体内，React 每次 state 变化都 unmount/remount，导致滚动位置丢失。将 `Section` 提取到模块作用域
- **Guard 页面暗色模式**：违反记录展开区域、代码片段与卡片背景在暗色模式下融为一体。为展开区域添加 `dark:bg-[#283040]`，代码片段改用 `bg-[#f1f5f9]` + `dark:bg-[#0f1219]` 绕过全局覆盖冲突
- **index.css 注释语法错误**：透明度变体区域注释中 `*/N` 被 CSS 解析器误判为注释结束符

### 改进

- **README / README_CN 重写**：去除 AI 生成感的营销语气，改为直接的技术文档风格
- **暗色模式全局覆盖补充**：新增 `hover:bg-slate-50/50`、`bg-blue-50/50` 的 dark 覆盖规则
- **VS Code 工作区配置**：添加 `.vscode/settings.json`，忽略 Tailwind v4 `@custom-variant` 的未知规则警告
- **package.json**：keywords 从 3 个扩充至 21 个，覆盖核心功能、AI 生态、支持语言

---

## [3.0.3] - 2026-02-21

### 变更

- **VSCode MCP 配置迁移至 `.vscode/mcp.json`**：`asd setup` / `asd upgrade` 现在按照 [VSCode 最新 MCP 标准](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) 将 MCP 服务器配置写入独立的 `.vscode/mcp.json` 文件，不再写入 `settings.json` 的 `github.copilot.mcp` 字段
- **同步更新所有 MCP 配置入口**：`SetupService`、`UpgradeService`、`setup-mcp-config.js`、`install-vscode-copilot.js` 统一使用新格式
- **`bin/mcp-server.js` 注释更新**：补充 VSCode `.vscode/mcp.json` 配置示例
- **README / README_CN 目录结构更新**：`.vscode/` 下展示 `mcp.json` + `extensions.json`

---

## [3.0.2] - 2026-02-21

### 新增功能

- **Dart (Flutter) 全语言支持**：新增 `DartDiscoverer`（534L）自动识别 Flutter/Dart 项目、`lang-dart.js`（661L）AST 解析器、8 条 Guard 规则、7 个 DimensionCopy 维度条目、SUMMARY_EXTRACTORS 以及 Dashboard 中文/英文标签
- **Dart (Flutter) Reference Skill**：新增 `autosnippet-reference-dart`（15 个章节、543 行），覆盖命名、空安全、Widget 设计、状态管理、异步、不可变模型、错误处理、DI、Clean Architecture、Extension/Mixin、测试、路由、平台通道/FFI、性能优化、12 个 extraDimensions
- **Coldstart Dart 示例**：Coldstart Skill 新增 4 个 Dart 维度模板（命名规范、单例模式、错误处理、BuildContext 异步安全），所有 8 个语言参考 Skill 均添加 Dart 交叉引用
- **多语言 Discovery 体系重构**：从单一 `ProjectDiscoverer` 拆分为 `DiscovererRegistry` + 专用 Discoverer（Node/Go/Jvm/Python/Dart/Spm/Generic），每个 Discoverer 独立识别项目结构与生态
- **AST 解析器独立化**：按语言拆分为 9 个独立 `lang-*.js` 文件 + `ensure-grammars.js` 按需安装 tree-sitter 语法包 + `ProjectGraph` 统一入口
- **Dashboard 国际化（i18n）**：新增 `i18n/` 模块（zh.ts、en.ts、types.ts、index.tsx），清理约 117 处硬编码中文字符串，覆盖 Guard 规则消息、冷启动维度标签、SSE 进度文本
- **Dashboard 暗色模式**：新增 `theme/index.tsx`，全局支持亮色/暗色主题切换
- **Agent 语言特性**：Agent 可感知项目语言并动态切换 Skill 和分析策略
- **VSCode 扩展**：新增 `resources/vscode-ext/`（extension.ts、apiClient、codeLens、statusBar、directiveDetector、codeInserter）
- **模块服务与 Snippet Codec 体系**：新增 `ModuleService`、`LanguageService`，Snippet 编解码拆分为 `SnippetCodec`/`VSCodeCodec`/`XcodeCodec` + `PlaceholderConverter`
- **Go 语言参考 Skill**：新增 `autosnippet-reference-go`（539 行），覆盖模块结构、命名、错误处理、接口、并发等 12 个章节
- **多语言参考 Skills**：新增 `autosnippet-reference-java`、`autosnippet-reference-kotlin`、`autosnippet-reference-python`
- **SPM Explorer → Module Explorer**：`SPMExplorerView` 移除，替换为通用 `ModuleExplorerView`
- **iOS 平台层**：SPM 相关代码（SpmService、DependencyGraph、PackageSwiftParser、PolicyEngine）和 Xcode 相关代码（XcodeAutomation、XcodeIntegration、SaveEventFilter）迁移至 `lib/platform/ios/`
- **条件性 Watch 启动**：File Watch 仅在检测到适用场景时自动启动
- **集成测试**：新增 GoSupport、I18nLang、RealProjectAst/Bootstrap/Discovery/Enhancement/Language 等集成测试
- **性能基准**：新增 `scripts/bench-real-projects.mjs`、`scripts/collect-test-project-stats.mjs` 及配套 fixtures

### 清理

- **移除 asd-entry 完整性校验**：删除 `resources/asd-entry/`（main.swift + README）、`scripts/build-asd-entry.js`、`bin/asd-verify`；CLI 入口已改为 `bin/cli.js` 直连，校验链路不再使用
- **移除过时文件**：删除 `.eslintrc.cjs`（已迁移 Biome）、`template.json`、`scripts/init-xcode-snippets.js`、`dashboard/src/pages/XcodeSimulator.tsx`、`nohup.out`
- **package.json 瘦身**：移除 `prepublishOnly` 中的 `build-asd-entry` 步骤、`files` 中的 `resources/asd-entry/main.swift`
- **.gitignore 精简**：移除 `bin/asd-verify`、`checksums.json`、`!resources/asd-entry/main.swift` 等已废弃条目
- **SECURITY.md 更新**：移除 ASD Entry 相关描述

### 改进

- **README 重写**：全面更新项目文档（554 行变更）
- **新增 README_CN.md**：中文版 README
- **新增 biome.json**：代码格式化与 lint 配置
- **Coldstart Skill 扩充**：新增多语言维度参考模板（+593 行），支持 Swift/Go/Python/TypeScript/Java/Dart 示例
- **ChatAgent / tools.js 大幅重构**：tools.js +1590 行改进，ChatAgent +915 行，增强对话和工具调用能力
- **bootstrap handler 增强**：+859 行，改进冷启动 pipeline 的编排和 Skill 集成
- **搜索引擎优化**：SearchEngine、MultiSignalRanker、RetrievalFunnel 等重构
- **Guard 引擎增强**：GuardCheckEngine 增加 Dart 规则，GuardHandler 改进

---

## [2.19.8] - 2026-02-19

### 修复

- **Dashboard 白屏: syntax-highlighter TDZ 错误**：`react-syntax-highlighter` 单独拆分 chunk 时与 `refractor`/`prismjs` 产生循环引用，导致 `Cannot access 'ge' before initialization`。移除 `syntax-highlighter` 和 `react-markdown` 的 manualChunks 配置，合并到 vendor chunk

---

## [2.19.7] - 2026-02-19

### 修复

- **Dashboard 生产模式页面无法打开**：404 handler 使用 `app.use('*')` 注册时不具有 `layer.route` 属性，导致 `mountDashboard()` 无法定位并移除它，静态文件中间件被 404 handler 拦截。改为 `app.all('*')` 修复
- **Dashboard 生产模式白屏**：helmet 默认 CSP `script-src 'self'` 阻止了 Vite 构建的 `<script type="module" crossorigin>` 执行。放宽 CSP 配置，允许 `'unsafe-inline'` 脚本、WebSocket 连接（`ws: wss:`）和 blob 图片

---

## [2.19.5] - 2026-02-19

### 新增功能

- **`asd coldstart` CLI 命令**：新增命令行冷启动入口，与 Dashboard 点击冷启动流程完全一致（复用 `bootstrap_knowledge` handler），支持 `--wait` 等待 AI 异步填充、`--json` 输出、`--skip-guard`、`--no-skills` 等选项

### 清理

- **移除死依赖**：从 package.json 删除零引用的 `xml2js`、`@zilliz/milvus2-sdk-node`、`redis`
- **移除 Redis 缓存层**：删除 `RedisService.js`（365 行），简化 `UnifiedCacheAdapter` 为纯内存模式，清理 `HttpServer` 中 Redis 初始化代码
- **移除死代码**：删除空目录 `lib/service/qoder/`，`Defaults.js` 中 `STORAGE_ADAPTERS` 去除 `milvus`

### 修复

- **Snippet 同步空内容过滤**：`POST /commands/install` 新增 `.filter(r => r.code.trim().length > 0)`，跳过无代码内容的 Recipe 避免生成空 `.codesnippet` 文件

---

## [2.19.0] - 2026-02-19

### 新增功能

- **Native Tool Calling**：AI Provider 支持原生函数调用（Gemini / OpenAI / Claude），ChatAgent 新增 tool-call 循环
- **Structured Output**：`chatWithStructuredOutput()` 支持 schema 驱动的结构化输出
- **Cross-Encoder Reranker**：搜索管线新增 AI 交叉编码重排序层，提升检索精度
- **ContextWindow 动态适配**：对话上下文窗口根据模型 token 限制自动调整

### 前端 API 连通性修复

- **恢复 6 个缺失后端路由**：v2.10.0 V1→V3 迁移时 `candidates.js`（559 行 18 个路由）被删除后未完整迁移，导致 v2.10.0–v2.18.0 间 6 个前端 URL 返回 404
  - 新增 `POST /candidates/enrich` — AI 语义字段补齐
  - 新增 `POST /candidates/bootstrap-refine` — 批量 Bootstrap 润色
  - 新增 `POST /candidates/refine-preview` — 对话式润色预览
  - 新增 `POST /candidates/refine-apply` — 对话式润色应用
  - 新增 `POST /search/similarity` — 语义相似度搜索
  - 新增 `POST /search/xcode-simulate` — Xcode 模拟搜索

### 对话式润色重构

- **直接 AI 提示词润色**：`refine-preview` / `refine-apply` 不再委托 `bootstrapRefine` 批量逻辑，改为直接调用 `aiProvider.chatWithStructuredOutput()` 以用户输入为主指令
- **Preview 数据直传应用**：确认应用时前端将预览阶段的 AI 输出直传后端，避免二次 AI 调用导致结果不一致
- **润色提示词强化**：增加字段名→UI 标签映射表，严格约束只修改用户指定字段

### Bug 修复

- **SPM 保存崩溃修复**：`toCandidatePayload()` 补齐 `title`/`content` 必填字段；4 处错误处理器修复对象直传 `notify()` 导致 React 渲染崩溃
- **KnowledgeService.update() context 缺失**：`refine-apply` 和 `enrich` 端点补齐第三参数 `{ userId }` 避免 `Cannot read properties of undefined (reading 'userId')` 错误
- **GoogleGeminiProvider 递归 sanitize** 修复
- **ToolRegistry 死代码清理**
- **UI 标签修复**："次" → "次调用"

---

## [2.18.0] - 2026-02-19

### 集成测试扩展

- **SearchPipeline 集成测试**：tokenize 中英文分词、BM25Scorer 评分排序、SearchEngine 端到端（索引构建/缓存命中/模式降级/trigger 匹配/ranking），使用独立 in-memory SQLite 避免并行数据竞争
- **GuardCheck 集成测试**：多语言规则检查（ObjC/Swift/JS/Python/Java/Go/Rust）、自定义 DB 规则、auditFile 审计、跨文件 Category 重复检测
- **DirectiveDetector 集成测试**：ObjC/Swift 全指令类型（create/search/audit/include/import）、REGEX/MARKS 常量验证、多指令共存与边界条件
- **KnowledgeCRUD 集成测试**：完整 CRUD 生命周期（创建/列表/搜索/统计/更新/删除）、lifecycle 状态转换、backward compatibility（approve/reject 别名）、真实 Repository + DB

### Bug 修复

- **lifecycleHistory 双重序列化修复**：`KnowledgeService._lifecycleTransition()` 移除多余的 `JSON.stringify()` 包装，修复生命周期二次转换时 `lifecycleHistory.push is not a function` 崩溃 — repository.update() 内部已通过 `_entityToRow()` 处理序列化

---

## [2.16.1] - 2026-02-18

### Wiki 修复与改进

- **代码高亮样式修复**：CodeBlock 的 `<code>` 标签添加 `language-highlighted` 类名，解决 Wiki CSS `:not([class*="language-"])` 选择器误匹配导致代码块出现浅色背景/边框的问题
- **Mermaid 渲染架构分离**：`splitMermaidSegments()` 在 ReactMarkdown 之前提取 Mermaid 块，独立渲染为 SVG，避免 DOM 时序问题
- **硬换行处理修复**：`enableMarkdownHardBreaks` 改为逐行处理、跳过围栏块，防止代码块内容被意外修改
- **Wiki 快捷入口修复**：首页「组件清单」「代码模式」替换为实际存在的「快速上手」「协议与组件」，并根据 meta.json 动态过滤
- **pre → div 替换**：ReactMarkdown 的 `<pre>` 用 `<div className="min-w-0">` 替换,避免 `white-space:pre` 溢出容器

---

## [2.16.0] - 2026-02-18

### Wiki 渲染与布局优化

- **Mermaid 图表渲染**：Wiki 中 `mermaid` 代码块自动渲染为可视化 SVG 图表，失败时回退显示原始代码
- **代码块样式修复**：无语言标注的多行代码块现在也使用 CodeBlock 深色主题渲染
- **Wiki 生成进度提示**：生成中显示紧凑进度条 + 文件树底部提示 + 内容区沉浸式动画，轮询期间实时刷新文件列表
- **文件树常驻布局**：重构 split layout，文件树与内容区独立滚动，滚动内容时左侧文件列表始终可见
- **精简页面布局**：移除顶部大 header，关键信息（标题、版本、文件数、更新按钮）收入 Sidebar 头部，最大化内容区域

---

## [2.14.0] - 2026-02-18

### Dev Document 知识管道 — 全链路实现

> 18 files changed, +374 / -20

#### Channel D: Dev Document 投递通道

- **feat(CursorDeliveryPipeline):** 新增 Channel D — `knowledgeType: 'dev-document'` 条目独立分流，生成 SKILL.md 索引 + 独立 reference MD 文件至 `.cursor/skills/autosnippet-devdocs/`
- **feat(CursorDeliveryPipeline):** `_classify()` 四分类 — rules / patterns / facts / documents；dev-document 不进入 Channel A/B 压缩
- **feat(Lifecycle):** KIND_MAP 新增 `'dev-document': 'fact'` 映射

#### MCP + Chat 工具

- **feat(MCP):** 新增 `autosnippet_save_document` 工具 (第 39 号) — Agent 可直接提交 MD 文档至知识库，自动设置 knowledgeType/kind/source，自动发布
- **feat(Chat):** 新增 `save_document` Chat tool (第 58 号) — ChatAgent 同等能力
- **feat(Gateway):** 注册 save_document action 映射
- **feat(McpServer):** 路由 `autosnippet_save_document` 到 knowledge handler

#### Skill 引导

- **feat(Skills):** 新建 `autosnippet-devdocs` Skill — 教导 Agent 何时、如何保存开发文档
- **docs(Skills):** `autosnippet-create`、`autosnippet-recipes`、`autosnippet-candidates` 同步更新工具列表与 knowledgeType 枚举

#### 统计 & UI

- **feat(orchestrator/cli/UpgradeService):** Cursor Delivery 日志输出包含 Channel D documents 计数
- **feat(Dashboard):** types.ts 新增 `'dev-document'` 类型
- **docs(README):** 工具总数 38→39，新增「开发文档」分类行

#### 测试

- **test(CursorDeliveryPipeline):** +2 Channel D 测试 — 文档生成验证 + dev-document 排除 A/B 验证
- **test:** 更新 KnowledgeAPI / AgentV8Enhancements / V10DomainBrain 工具计数断言

---

## [2.13.0] - 2026-02-18

### Guard 深度增强 — AST 语义规则 + 合规报告 + CI/CD + 反馈闭环

> 17 files changed, +1541 / -59

#### Phase 1: AST 语义规则

- **feat(AstAnalyzer):** 新增 `findCallExpressions()`、`findPatternInContext()`、`checkProtocolConformance()` 三个查询 API
- **feat(GuardCheckEngine):** AST 规则分支 — 支持 `mustCallThrough`、`mustNotUseInContext`、`mustConformToProtocol` 三种查询类型
- **feat(GuardService):** `type='ast'` 规则验证，要求 `astQuery` 字段替代 `pattern`

#### Phase 2: ComplianceReporter + Quality Gate

- **feat(ComplianceReporter):** 全项目合规扫描模块 — 文件收集 → 批量审计 → 分组聚合 → 打分 → Quality Gate 评估
- **feat(SourceFileCollector):** 从 GuardHandler 抽取的可复用文件收集器，支持扩展名/目录过滤
- **feat(ViolationsStore):** 新增 `getStatsByRule()` (按规则聚合统计) 和 `getTrend()` (最近两次对比趋势)
- **feat(config):** `qualityGate` 配置段 — maxErrors / maxWarnings / minScore 阈值
- **feat(guardRules):** `GET /api/v1/rules/compliance` HTTP 端点

#### Phase 3: CI/CD 集成

- **feat(cli):** `guard:ci [path]` — 完整合规扫描 + Quality Gate，支持 --report json/text/markdown，退出码 0/1/2
- **feat(cli):** `guard:staged` — 仅检查 git staged 文件，适用于 pre-commit hook
- **feat(templates):** `guard-ci.yml` GitHub Actions 工作流模板 (含 PR 评论)
- **feat(templates):** `pre-commit-guard.sh` 预提交钩子脚本

#### Phase 4: Guard ↔ Recipe 反馈闭环

- **feat(GuardFeedbackLoop):** 检测已修复违规 → 自动确认 Recipe 使用，闭合 Guard → Recipe 数据回路
- **feat(mcp/guard):** `guardAuditFiles` Handler 集成 GuardFeedbackLoop
- **feat(GuardHandler):** `_auditSingleFile()` 展示 `fixSuggestion` + fire-and-forget 反馈检测

#### Phase 5: RuleLearner 增强

- **feat(RuleLearner):** `suggestRules()` — 三策略推荐 (tune_existing / specialize / review_unused)
- **feat(RuleLearner):** `trackRuleEffectiveness()` — 14 天窗口有效性跟踪 (effective/ineffective/monitoring/no_data)

#### Bug Fixes

- **fix(GuardCheckEngine):** `getRules()` 现在合并 `_astRulesCache` 到返回数组，外部调用方可获取 AST 规则的 `fixSuggestion`
- **fix(ViolationsStore):** `getRecentRuns()` 使用 `ORDER BY created_at DESC, rowid DESC` 确保同秒写入的稳定排序
- **fix(ComplianceReporter):** 移除对不存在的 `isGloballyExcluded()` 调用 (`isRuleExcluded()` 已内含全局排除)

---

## [2.12.0] - 2026-02-18

### Agent Memory 四层架构 + 增量 Bootstrap + 迁移合并 + 前端抽屉统一

> 32 files changed, +1666 / -2122

#### Agent Memory 四层架构 (v4.0)

- **feat(WorkingMemory):** Tier 1 工作记忆 — Scratchpad 关键发现追踪，上下文压缩后仍保留早期分析洞察
- **feat(EpisodicMemory):** Tier 2 情景记忆 — 跨维度发现共享 + 维度级 Digest + Tier Reflection 聚合
- **feat(ProjectSemanticMemory):** Tier 3 语义记忆 — EpisodicConsolidator 将情景记忆固化到 SQLite `semantic_memories` 表，供二次冷启动复用
- **feat(ToolResultCache):** Tier 4 工具结果缓存 — 跨维度 `read_project_file` / `search_project` 去重，避免重复 I/O
- **feat(ChatAgent):** 集成 WorkingMemory + EpisodicMemory + ToolResultCache + SemanticMemory，execute() 接收四层记忆参数
- **feat(ServiceContainer):** 注册 `codeEntityGraph` 服务 (Phase E: 代码实体关系图谱)

#### 新增 Agent 工具 (3 个)

- **feat(tools.js):** `note_finding` — 记录关键发现到 WorkingMemory Scratchpad，分析后期不会遗忘早期重要发现
- **feat(tools.js):** `get_previous_evidence` — 查询前序维度的证据和发现，实现知识跨维度传递
- **feat(tools.js):** `query_code_graph` — 查询代码实体关系图谱 (search/descendants/impact/relations)

#### 增量 Bootstrap (v5.0)

- **feat(bootstrap.js):** 增量 Bootstrap 评估 — 自动检测文件变更，仅重跑受影响维度
- **feat(orchestrator.js):** Tier Reflection — 每个 Tier 完成后规则化聚合维度发现 (无需 AI 调用)
- **feat(orchestrator.js):** EpisodicMemory → ProjectSemanticMemory 固化 + Code Entity Graph 关系写入
- **feat(AnalystAgent.js):** 语义记忆注入 Analyst prompt，二次冷启动时携带上次分析成果

#### 数据库迁移合并 (V3 统一)

- **refactor(migrations):** 删除 13 个旧迁移文件 (005–017)，统一到 `001_initial_schema.js` 单文件 V3 schema
- **refactor(001_initial_schema.js):** 新增 `contentHash` 列 (file-sync 完整性校验)
- **refactor(api-spec.js):** 移除旧 `/candidates` API spec，统一使用 V3 Knowledge API

#### 前端抽屉样式统一 + 代码显示修复

- **refactor(KnowledgeView):** 抽屉重构 — 渐变头部 + ChevronLeft/Right 导航 + 带图标的分段布局 (对齐 RecipesView)
- **refactor(KnowledgeView):** 列表布局从单列改为 `grid-cols-2` 双列卡片网格
- **refactor(CandidatesView):** 抽屉重构 — 同 KnowledgeView 对齐 RecipesView 风格
- **fix(CodeBlock):** 新增 `normalizeCode()` — 修复 AI 生成代码的 regex 转义 (`\[`/`\*`/`\^`) 和字面量 `\n` 显示问题
- **fix(KnowledgeView + CandidatesView):** `codePreview()` 应用 normalizeCode，列表卡片代码预览恢复正常

#### 其他

- **feat(SearchEngine + SearchHandler):** 适配 Agent Memory 查询接口
- **feat(ProducerAgent):** 容错规则增强 — 文件读取失败时直接使用分析文本提交
- **test:** 24 suites / 579 tests 全部通过

---

## [2.11.0] - 2026-02-18

### V3 全链路统一 + 字段审计修复 + 前端 V3 内容展示重构

> 69 files changed, +2569 / -2496

#### V3 后端统一 — 6 值对象 + camelCase 全链路

- **refactor(KnowledgeEntry):** 6 值对象（Content, Reasoning, Quality, Stats, Relations, Constraints）全部 camelCase，废弃 snake_case 兼容
- **refactor(KnowledgeRepository.impl):** `_entityToRow` / `_rowToEntity` 全量 camelCase 列映射
- **refactor(KnowledgeService):** update 白名单重构，值对象字段统一 JSON 序列化
- **refactor(KnowledgeFileWriter):** 落盘文件 frontmatter 从 snake_case 迁移到 camelCase
- **refactor(Lifecycle):** `normalizeLifecycle()` 简化为 3 状态 (pending/active/deprecated)

#### V3 Pipeline 字段审计 — 9 项改进 (高+中+低优先级全覆盖)

- **feat(tools.js):** `submit_knowledge` schema 扩展 `scope`/`complexity`/`headers`/`sourceFile` 参数，Bootstrap 管线可传递完整 V3 字段
- **feat(AiScanService):** 注入 `recipe.moduleName = file.targetName` + `recipe.sourceFile = file.relativePath`
- **feat(tools.js + AiScanService):** Bootstrap + AiScan 管线创建条目后自动调用 `knowledgeService.updateQuality()` 评分
- **feat(AiProvider):** `_buildExtractPrompt()` comprehensive + standard 两套 prompt 新增 `content.rationale`、`constraints`、`aiInsight` 输出要求
- **feat(tools.js):** Bootstrap 管线注入 `agentNotes`（维度元数据）+ `aiInsight`（从 reasoning.whyStandard 取）
- **feat(tools.js):** `sourceFile` 回退从 `reasoning.sources[0]` 推断（Bootstrap 场景）
- **feat(KnowledgeService):** `_autoDiscoverRelations()` — 创建条目后自动查找同 moduleName/category 的已有条目，建立 `related` 边并回写 relations 字段
- **fix(api.ts):** `toRecipe()` version 字段从硬编码 `''` 改为 `r.version || ''`

#### V3 字段审计 Bug 修复 — 4 条链路 Bug

- **fix(values/\*.js):** 6 个值对象 `from()` 新增 `typeof input === 'string' → JSON.parse()` 防御，修复 repository partial merge 时 JSON 字符串被当 object 传入导致字段归零
- **fix(KnowledgeService):** `_adaptForScorer()` 从引用 V2 已废弃字段 (`summaryCn`/`usageGuideCn`) 改为 V3 字段 (`description` + `content.markdown`)
- **fix(tools.js):** QualityScorer 评分从手动 `update({quality: JSON.stringify(...)})` 改为 `updateQuality()`，修复 quality 不在 UPDATABLE 白名单导致静默失败
- **fix(tools.js):** `agentNotes` 从预序列化字符串改为原始对象，修复 `_entityToRow` 二次 `JSON.stringify()` 导致双重嵌套

#### 前端 V3 内容展示重构

- **refactor(types.ts):** `Recipe.content` 从 `string` 改为 `RecipeContent` 结构化对象，移除全部 `v2Content` 字段
- **refactor(RecipesView):** 卡片同时展示 Markdown 预览 + 代码预览；详情抽屉"使用指南"改为"Markdown 文档"取 `content.markdown`
- **refactor(RecipeEditor):** 完整重写编辑/预览模式，支持 V3 structured content（markdown + pattern + rationale 三编辑器）
- **refactor(App.tsx):** `handleSaveExtracted` 从 frontmatter 序列化改为直调 `api.knowledgeCreate()`；`handleSaveRecipe` 改为 `api.knowledgeUpdate()`
- **fix(CandidatesView):** 修复 `content` 类型不匹配 + `onEditRecipe` 签名适配
- **fix(SPMCompareDrawer + SPMExplorerView):** content-to-string 转换修复
- **fix(api.ts):** `getRecipeContentByName` 序列化 V3 content 对象

#### 全局 camelCase 统一 (Dashboard)

- **refactor(11 files):** Dashboard 前端从 snake_case（`knowledge_type`/`usage_guide`/`summary_cn` 等）全量迁移到 camelCase，与后端 V3 API 一致
- **refactor(ScanResultCard):** 移除 compat 字段映射逻辑

#### 其他

- **feat(HttpServer):** 根路径 `/` 新增 API 元信息 handler，消除外部探测 `POST /` 产生的 404 噪音
- **feat(SearchEngine + SpmService + ChatAgent):** 下游消费者适配 V3 值对象 API
- **refactor(SKILL.md × 4):** `article` 参数全部重命名为 `content`
- **test:** 24 suites / 579 tests 全部通过

---

## [2.10.0] - 2026-02-17

### Guard Audit 三维度项目扫描 + 指令修复 + V1 遗产清理

#### Guard — `// as:a` 三种 scope 支持

- **feat(GuardHandler):** `// as:a file` — 单文件审计（默认），仅应用 file 维度规则
- **feat(GuardHandler):** `// as:a target` — 扫描当前文件所在目录树，应用 file + target 维度规则
- **feat(GuardHandler):** `// as:a project` — 扫描整个项目所有源文件，应用全部维度规则
- **feat(GuardCheckEngine):** 新增 `_runCrossFileChecks()` — 跨文件 ObjC Category 重名检查，识别 `.h`/`.m` 成对（合法）vs 同类型文件重复声明（冲突）
- **feat(GuardCheckEngine):** `auditFiles()` 返回新增 `crossFileViolations` 字段
- **feat(MCP guard):** `guardAuditFiles` 和 `scanProject` MCP 响应补充 `crossFileViolations`

#### Guard — 精确度修复

- **fix(DirectiveDetector):** `_isGuardDirective` 从 `startsWith("// as:a")` 改为正则 `/^\/\/\s*as:(?:audit|a)(?:\s|$)/`，避免误匹配 `// as:abc`、`// as:auto` 等
- **fix(FileWatcher):** `handleGuard` 传入 `this`（watcher 实例），使 GuardHandler 可访问 `projectRoot`
- **fix(GuardHandler):** scope 参数正确传递到 `engine.checkCode()`，SCOPE_HIERARCHY 过滤真正生效

#### `// as:c` 指令修复

- **fix(App.tsx):** action 参数处理后 `window.history.replaceState()` 清除 URL，确保重复触发 `// as:c` 时浏览器检测到 URL 变更
- **fix(FileWatcher._appendCandidates):** 传入 `context: { userId: 'filewatcher' }`，修复 `knowledgeService.create()` 因缺少 context 导致 TypeError
- **fix(FileWatcher._appendCandidates):** 空 `catch {}` 改为 error 日志 + 错误传播 + HTTP 回退
- **fix(FileWatcher._appendCandidates):** HTTP 端点从不存在的 `/api/v1/candidates`（404）改为正确的 `/api/v1/knowledge`
- **fix(FileWatcher._appendCandidates):** 增加 title/code 空值过滤，防止空标题提交后 validation error

#### `// as:c -c` 语义修正

- **fix(CreateHandler):** `-c` 模式从 `extract_recipes`（AI 拆分为多条）改为 `summarize_code`（AI 生成标题/摘要），剪贴板内容整体作为单条候选的 `code` 字段

#### AI 提取增强

- **feat(AiProvider):** `_buildExtractPrompt` 新增 `comprehensive` 模式 — 全量分析文件，不跳过"简单"方法，强制返回至少一条 Recipe
- **feat(tools.js):** `extract_recipes` handler 透传 `comprehensive` 参数
- **fix(extract.js):** `/extract/text` 补全 3 阶段 AI pipeline（之前只有注释声称调用 AI，实际直接返回空）；`/extract/path` 和 `/extract/text` 均传入 `comprehensive: true`

#### V1 遗产清理 (90 files, +4024 / -9962 lines)

- **refactor:** 删除 V1 Candidate/Recipe 双轨残留代码（CandidateService、RecipeService、CandidateFileWriter、RecipeFileWriter 等），统一到 V3 KnowledgeService / KnowledgeFileWriter
- **refactor:** 删除 V1 domain 模型（Candidate.js、Recipe.js、Reasoning.js 等）及其 Repository
- **refactor:** Dashboard 前端组件适配 V3 API，移除 V1 candidates/recipes 专用视图逻辑
- **refactor:** 测试套件清理，移除依赖已删除 V1 服务的测试文件

---

## [2.8.3] - 2026-02-16

### Bug Fixes — MCP 响应体积过大 & Health 版本号错误

- **fix(bootstrap):** MCP `bootstrapKnowledge` 响应从 **1.2MB → 68KB** (94.5% 减少)。`filesByTarget` 不再包含文件内容 (`content`)，改为每个 target 返回 top-10 高优先级文件摘要 + `totalFiles` 计数。完整文件列表保留在服务端内存供 Phase 5 异步 AI pipeline 使用。之前 Cursor 因响应过大 (1,241,857 bytes / 5506 lines) 将输出 dump 到文件而非内联处理，导致冷启动流程中断
- **fix(health):** `autosnippet_health` 版本号不再 hardcoded `2.0.0`。改用 `import.meta.url` 定位 AutoSnippet 自身的 `package.json`，不受 MCP 服务器 `cwd` 影响
- **refactor(system.js):** 移除未使用的 `import * as Paths` 导入

---

## [2.8.2] - 2026-02-16

### Bug Fixes — DB 路径逃逸防护 & 孤儿候选修复

- **fix(DatabaseConnection):** 相对 DB 路径现在通过 `pathGuard.projectRoot` 解析，不再依赖 `process.cwd()`。即使 MCP 服务器的 cwd 是用户主目录，DB 也会正确创建在项目的 `.autosnippet/` 下
- **fix(PathGuard):** 全局白名单收窄：`~/.autosnippet` → `~/.autosnippet/cache`。之前整个 `~/.autosnippet/` 被白名单放行，导致 DB 意外写到主目录时 PathGuard 未拦截
- **test(PathGuard):** 新增测试 `should BLOCK ~/.autosnippet/autosnippet.db`，验证白名单收窄后的拦截行为

---

## [2.8.1] - 2026-02-16

### Bug Fixes — 候选项不可见 & 路径解析

- **fix(cli/mcp/api-server):** 当 projectRoot 与 cwd 不同时（如 `asd ui -d <path>` 或 `ASD_PROJECT_DIR` 环境变量），自动 `process.chdir(projectRoot)`，确保 DB 路径 `./.autosnippet/autosnippet.db` 正确解析到目标项目而非执行目录
- **fix(candidates route):** `GET /api/v1/candidates` 的 `pageSize` 上限从 100 提升到 1000，与前端 `limit=1000` 请求一致，避免候选项超过 100 条时分页截断

---

## [2.8.0] - 2025-02-16

### MCP Skills CRUD 完善 + 进程级错误兜底 + AlinkHandler 实现

#### MCP — delete_skill / update_skill 新工具

- 新增 `autosnippet_delete_skill` MCP 工具：删除项目级 Skill 目录，自动刷新编辑器索引
- 新增 `autosnippet_update_skill` MCP 工具：部分更新 Skill 的 description / content，保留 createdBy/createdAt 元数据
- Gateway 权限 gating 新增 `delete:skills`、`update:skills` 两条写操作映射
- TOOLS 数组从 36 → 38，McpServer 工具计数同步更新
- HelpView / README MCP 工具表同步更新

#### CLI / MCP Server — 进程级错误兜底

- `bin/cli.js`：新增 `uncaughtException`、`unhandledRejection`、`SIGTERM`、`SIGINT` 处理器
- `bin/mcp-server.js`：新增同等 4 项处理器，防止 Cursor/VSCode 进程异常退出时无日志

#### AlinkHandler — 缓存链路实现

- 替换原有 TODO 空壳，通过 DI 容器获取 DB 实例
- 精确匹配 `trigger` 字段 → 回退到模糊搜索 `trigger/title`
- 构建 Dashboard URL 并调用 `open` 打开浏览器

#### Dashboard 版本同步

- `dashboard/package.json` 版本从 2.2.0 同步至 2.8.0

---

## [2.7.1] - 2026-02-16

### PathGuard 路径安全守卫 + LLM 配置面板 + Bootstrap 断点续传

#### 安全 — PathGuard 双层防护

- 新增 `lib/shared/PathGuard.js` 路径安全守卫（单例），防止文件写操作逃逸到项目外
- **Layer 1** `assertSafe(path)`：边界检查，拦截写到 projectRoot 外的操作
- **Layer 2** `assertProjectWriteSafe(path)`：项目内作用域检查，仅允许 `.autosnippet/`、知识库目录、`.cursor/`、`.vscode/`、`.github/` 等白名单前缀
- 三入口（CLI / API Server / MCP Server）统一在启动时调用 `Bootstrap.configurePathGuard(projectRoot)`
- `Paths.ensureDir()` 增加 PathGuard 校验，所有目录创建均经过安全检查
- 新增 `test/unit/PathGuard.test.js` 单元测试

#### Dashboard — LLM 配置面板 + HelpView 优化

- 新增 `LlmConfigModal` 组件：Dashboard 内可视化配置 .env 中的 LLM Provider / Model / API Key
- Header 增加 LLM 就绪状态指示，未配置时高亮提醒并可快速打开配置面板
- 新增后端 API `GET/PUT /ai/env-config`：读写用户项目 .env 中的 LLM 相关变量
- HelpView 全面更新：Skills 10 个（移除 3 个 reference-*，后续优化）、编辑器指令增加 `asc`/`ass`/`asa` 快捷写法、核心概念 Gateway 卡片替换为 Dual-Agent、V2 架构卡片替换为 Bootstrap 引擎 + 4 层检索管线
- CandidatesView 修复：点击 Refine 图标同时打开详情抽屉

#### Bootstrap — 断点续传 + 维度调度优化

- Orchestrator 新增 Checkpoint 机制：维度级断点保存/恢复（1h TTL），支持 `resume` 从上次中断处继续
- TierScheduler 优化维度调度策略
- ProducerAgent 增强：提交候选时增加更多上下文注入

#### AI Provider — 多提供商增强

- Claude / Gemini / OpenAI 三个 Provider 增加 structured output 与错误恢复优化
- AI 路由新增 .env LLM 配置读写端点（`/ai/env-config`）

#### 基础设施

- `SetupService._ensureGitignore()` 新增 `logs/` 和 `.autosnippet-drafts/` 规则
- DatabaseConnection 增加连接安全检查
- 多个 Service 模块增加 PathGuard 安全校验（CandidateFileWriter / RecipeFileWriter / ExclusionManager 等）
- README.md 全面重写，反映 v2.7 实际架构
- `.gitignore` 增加 `.DS_Store`、`nohup.out`、`.vscode/`、`.cursor/` 等规则
- 新增 `resources/native-ui/combined-window.swift`：macOS 原生搜索弹窗 UI 原型（AppKit, 494 行）

---

## [2.7.0] - 2026-02-16

### v3 AI-First Bootstrap — 双 Agent 架构 + 废弃代码清理

> Bootstrap 管线从 v2 手工提取器模式重写为 v3 AI-First 双 Agent 架构，大幅精简代码量。

#### 核心 — Analyst → Gate → Producer 双 Agent 管线

- **AnalystAgent**（216 行）：负责信号收集与维度分析，通过 Agent-Pull 架构主动调用 `list_project_structure` / `get_file_summary` / `semantic_search_code` 等 7 个工具探索项目
- **ProducerAgent**（240 行）：接收 Analyst 产出，生成结构化候选并调用 `submit_candidate` 提交
- **HandoffProtocol**（180 行）：Analyst → Producer 交接协议，传递维度分析上下文
- **CandidateGuardrail**（134 行）：候选质量门控，最低 200 字符，硬拒无代码块候选
- **TierScheduler**（162 行）：分层并行调度，9 维度按优先级分 Tier 执行

#### v10 Agent-Pull 架构演进

- **Minimal Prompt 模式**：从 v9 的 ~20K tokens prompt 精简到 ~500 tokens（`buildMinimalPrompt`），让 Agent 主动拉取上下文
- **DIMENSION_EXPLORATION_GOALS**：9 维度各自定义独立探索目标映射
- **PROJECT_SNAPSHOT_STYLE_GUIDE**：「项目特写」风格定义（选择了什么 / 为什么 / 禁止什么 / 怎么写）
- **Few-shot 范例**：候选类 + 深度扫描类两种范例模板
- 新增 4 个 Agent 工具：`search_project_code` / `read_project_file` / `plan_task` / `review_my_output`
- 默认模式从 `full-signal` 切换到 `minimal-prompt`，`ASD_PROMPT_MODE='full-signal'` 可回退

#### Pipeline 完整性修复（v9 Bug Fix）

- Fix Bug1：连续用户消息合并—— Gemini/Claude Provider `#convertMessages` 增加 `pushOrMerge`
- Fix Bug2：空响应死循环——独立计数器防止无限重试
- Fix Bug3：P5 pre-check 空操作——改为有意义的 warning
- 移除死代码：`ContextWindow.setInitialPrompt()`、`ToolRegistry` 参数规范化（snake_case → camelCase）

#### BiliDemo 冷启动 12 项修复

- ChatAgent 注入 PRODUCE 过渡提示，修复 0 条提交问题
- PhaseRouter 即时 PRODUCE 提示 + 阶段特定 grace rounds
- 长 Skill 自动拆分（category-scan / deep-scan）为多 part 文件，不再截断
- `createSkill` frontmatter 新增 `title`（自动从 `# heading` 提取）
- `referenceSnippets` 保留最多 3 个代码块（≤15 行）写入 Skill
- 测试结果：428 tests, 23 suites，BiliDemo 13 AI 提交候选、6 Skills、9/9 维度完成

#### 代码清理 — 删除 v2 管线 ~10,300 行

- 删除 v2 pipeline 全部代码：orchestrator / extractors / patterns / shared 等 23 个文件
- 删除 v9 残留：`production-prompts.js`、ChatAgent `promptMode` 分支
- `orchestrator-v3.js` 重命名为 `orchestrator.js`
- 移除 `USE_V3_BOOTSTRAP` 特性开关
- 删除 3 个测试文件（ProductionPrompts / ProjectSkills / SignalExtractor）

#### Dashboard

- Bootstrap 进度条替换为已用时间 + 预计剩余 + 工具调用次数
- 9 维度合并为 4 个显示分组（架构与设计 / 规范与实践 / 事件与数据流 / 深度扫描）
- 新增 GlobalChatDrawer 全局对话抽屉（522 行）+ PageOverlay
- Sidebar 重构（170 行改动）

#### 测试

- 测试基线：20 套件 / 351 测试全部通过

---

## [2.6.0] - 2026-02-13

### SignalCollector AI 引擎 + ChatAgent 持久化 + 工具增强

> 后台信号收集从规则引擎重写为 AI 驱动引擎，ChatAgent 新增对话持久化与跨对话摘要能力。

#### SignalCollector — AI 驱动信号引擎

- **SkillAdvisor**（322 行）：新增使用模式分析服务，4 维度（Guard 违规 / Memory 偏好 / Recipe 分布缺口 / 候选积压率）生成 Skill 创建建议
- **SignalCollector 初版**（0a58d71）：3 种模式（off / suggest / auto），周期性执行 SkillAdvisor 分析，快照持久化到 `.autosnippet/signal-snapshot.json`
- **SignalCollector AI 重写**（25ccdc6，**BREAKING**）：规则引擎替换为 ChatAgent ReAct 循环，6 维度（+chat memory / +code changes），AI 动态调整 tick 间隔（5min~24h），auto 模式直接调用 `create_skill`
- 默认模式从 `suggest` 改为 `auto`
- MCP `autosnippet_suggest_skills` 工具新增（#36）
- Dashboard SkillsView 新增「推荐」按钮 + 建议面板 + Sidebar 建议 badge
- HTTP API `GET /api/v1/skills/suggest` / `GET /api/v1/skills/signal-status`
- Gateway `auditSuccess` / `auditFailure` 事件触发，EventBus 恢复到 ServiceContainer

#### ChatAgent 持久化体系升级

- **ConversationStore**（377 行）：对话持久化存储 + token 预算上下文窗口管理 + AI 自动摘要
- **Memory 升级**：source 标签隔离（user/system）+ 去重 + 按 source 过滤
- ChatAgent 新增 `conversationId` 支持、AI 驱动记忆提取（`[MEMORY]` 标签）、`#autoSummarize`
- AuditStore 新增 `cleanup()` TTL 清理（默认 90 天）
- `Skill createdBy` 创建者追踪：4 种类型（manual / user-ai / system-ai / external-ai），Dashboard 显示创建者标签

#### 工具增强

- **Lazy Tool Schema**：ChatAgent 工具 schema 延迟加载，减少初始化开销
- **AutoCondense**（AiProvider）：AI 响应过长时自动压缩上下文
- **EventAggregator**（187 行）：事件聚合器，合并高频事件减少处理次数
- **CircuitBreaker**（SignalCollector）：错误重试 + 指数退避

#### 修复

- 修复 7 处 SQL schema 不匹配（SignalCollector/SkillAdvisor 列名/表名错误）
- ChatAgent ReAct 循环错误恢复：AI 调用 / 工具执行 / 最终总结三层 try/catch + 降级
- 知识图谱节点缺失时静默处理（不再打印 error 日志）
- 终端噪音精简：HTTP GET 2xx 降为 debug，轮询路径静默，ToolRegistry 汇总日志
- ChatAgent 实时调试日志：cyan/magenta 高亮，每轮 ReAct 迭代详情

#### 测试

- 测试基线：276 单元测试 + 17 集成测试通过

---

## [2.5.0] - 2026-02-13

### Dashboard UX 大幅升级 + AI 响应截断修复

#### RecipesView — 详情抽屉重构

- 新增详情抽屉（800px）：view / edit 双模式切换，支持 Markdown 内联编辑与保存
- Title 改为 `break-words` 避免截断；时间戳增加有效性校验（`isValidTimestamp`），无效值显示「从未使用」
- 内容解析 YAML frontmatter 元数据并分区渲染，正文通过 `MarkdownWithHighlight` 展示
- `updatedAt` / `createdAt` 字段自动格式化为 `yyyy/MM/dd HH:mm`
- 移除内部搜索栏（使用顶层搜索过滤）
- **关联 Recipes 管理**：始终显示关联区域，支持按 8 种关系类型（关联/依赖/继承/调用等）添加和移除关系
- 关联搜索面板：下拉选择关系类型 + 实时搜索 Recipe 名称，已关联项标灰
- 点击关联项打开左侧并列预览抽屉（与 CandidatesView 润色抽屉同模式），底部可切换到完整视图
- 新增 API `updateRecipeRelations()` 通过 `PATCH /recipes/:id` 持久化关系

#### SPMExplorerView — 组件提取与交互优化

- 提取 `ScanResultCard` 组件（~540 行），SPMExplorerView 从 835 行精简到 ~400 行
- 新增 `SPMCompareDrawer` 左右分栏对比抽屉（候选 vs Recipe 并排展示，1280px 宽）
- 空状态文案优化：「知识提取」+ 清晰描述
- 头文件编辑升级：引用状态指示（绿●引用/黄●未引用/灰●未知）、格式化按钮、清理未引用按钮

#### CandidatesView — 重构抽屉交互

- 将 `SimilarRecipe` 类型抽至 `types.ts` 集中管理

#### AI 截断 JSON 修复（AiProvider）

- `_repairTruncatedArray` 升级为双路径策略：字符级深度追踪（主路径）+ 正则回退（`_repairByRegexFallback`）
- 正则回退不依赖 `inString` 追踪，解决代码字段含未转义引号时修复失败的问题
- 提取 `_tryRepairAt()` 公用方法
- 新增 12 个测试用例覆盖各类截断场景（含真实 VideoPlayerViews 案例）

#### 其他

- Skills 页面新增（SkillsView.tsx + `/api/v1/skills` 路由）
- `index.css` 新增 `slideInRight` 动画帧

---

## [2.4.0] - 2026-02-13

### ChatAgent 增强 — 项目感知 + 信心信号 + 工具链 + 轻量记忆

> 参考 Anthropic Tool Use / OpenAI Function Calling / LangGraph 业界实践，对 ChatAgent 进行 4 批次增强。

#### Batch 1: Project Briefing（项目概况注入）

- **`#buildProjectBriefing()`**：每次 `execute()` 入口自动聚合项目状态（Recipe 分布、Guard 规则数、候选积压量），注入系统提示词
- 单次 SQL 聚合 < 5ms，DB 不可用时静默降级
- 空知识库自动提示"建议先执行冷启动"

#### Batch 2: Confidence Signal（信心信号）

- **`search_recipes`**：搜索结果附加 `reasoning: { whyRelevant, rank }`，根据匹配分生成分级信心标注
- **`search_knowledge`**：返回 `_meta: { confidence, hint }`（high/medium/low/none 四级）
- **`check_duplicate`**：返回 `_meta` 查重信心标注（高相似 → 建议人工审核）
- 系统提示词新增规则 9：confidence=none 时告知用户无匹配，不凭空编造

#### Batch 3: Tool Chains（组合工具）

- **`analyze_code`**（#34）：Guard 规范检查 + 相关 Recipe 搜索，并行执行
- **`knowledge_overview`**（#35）：全局知识库概览（Recipe 分布 + 候选状态 + 知识图谱 + 质量概览）
- **`submit_with_check`**（#36）：查重 → 条件提交，发现高相似则阻止并返回相似列表
- 系统提示词新增规则 10：优先使用组合工具减少 ReAct 轮次
- 工具总数从 33 扩展至 37

#### Batch 4: Lightweight Memory（跨对话轻量记忆）

- **新增 `Memory.js`**（~104 行）：JSONL 文件存储，TTL 自动过期，上限 50 条自动截断
- 三种记忆类型：preference（用户偏好）、decision（关键决策）、context（项目上下文）
- `#extractMemory()`：从用户消息正则匹配偏好性表述（"我们不用…"、"以后都…"、"记住…"），零延迟写入
- `toPromptSection()` 生成历史记忆摘要注入系统提示词

#### P2 预留接口

- **`executeEvent(event)`**：事件驱动入口，支持 file_saved / candidate_backlog / scheduled_health 三种事件类型
- `#eventToPrompt()`：事件到自然语言提示词的映射

### 链路修复

- `#buildProjectBriefing()` SQL 修复：`kind='rule'` → `knowledge_type IN (...)`，`status='PENDING'` → `status='pending'`，`guard_rules` 表引用 → `recipes WHERE knowledge_type='boundary-constraint'`

---

## [2.2.0] - 2026-02-13

### 重构 — 治理架构精简

> 跨项目架构对比后的 4 阶段精简行动，削减 ~1,090 行死代码，简化 Constitution / Gateway / Validator 管线。

#### Phase 1: 死代码清理

- **移除 RoleDriftMonitor**（~300 行）：角色漂移监控从未被调用，已从 bootstrap / ServiceContainer / McpServer 清除
- **移除 SessionManager**（~280 行）：会话管理仅 RoleDriftMonitor 依赖，连带删除
- **移除 ReasoningLogger**（~250 行）：推理日志组件无消费者，已清除
- **移除 ComplianceEvaluator**（~260 行）：合规评估器无调用方，已清除
- 清理残留引用：bootstrap.js、ServiceContainer.js、McpServer.js、api-server.js、cli.js、Gateway.js、search.js、browse.js、init-db.js

#### Phase 2: Constitution v3.0 + Gateway 精简

- **Constitution v3.0**：`constitution.yaml` 从 v2.0 P1–P4 优先级格式改为 v3.0 扁平 `rules` 数组（135→65 行）
- **角色精简**：6 个角色缩减为 3 个（external_agent / chat_agent / developer）；移除 guard_engine、developer_contributor、visitor
- **ConstitutionValidator 重写**（260→150 行）：rule-based checker 模式替代优先级遍历，4 个检查器映射表
- **Gateway 管线精简**（321→250 行，7→4 步）：移除 Plugin 系统（`use()` / `getPlugins()` / `runPlugins()`），合并 `checkPermission()` + `validateConstitution()` 为单一 `guard()` 方法；管线：validate → guard → route → audit

#### Phase 3: AI 人格 & 技能扩展

- **SOUL.md**（新文件）：AI 身份/人格定义文件，注入 ChatAgent 系统提示词；包含 "我是谁"、"思考方式"、"面对模糊"、"硬约束" 四节
- **项目级 Skills**：ChatAgent / tools.js / MCP skill.js 均支持从 `.autosnippet/skills/` 加载项目级技能，同名覆盖内置技能
- **SkillHooks 生命周期钩子**（新文件，~125 行）：支持 4 个钩子点（onCandidateSubmit / onRecipeCreated / onGuardCheck / onBootstrapComplete）；从内置与项目级 skills 目录加载 `hooks.js`
- **Reasoning 字段扩展**：Guard 违规结果附加 `reasoning: { whatViolated, whyItMatters, suggestedFix }`；搜索结果附加 `reasoning: { whyRelevant, rank }`

### 变更

- Constitution `toJSON()` 保留 `priorities`（空数组）向后兼容，新增 `rules` 字段
- `init-db.js` 显示 `rules` 数量替代 `priorities`
- 测试套件从 291→264（移除已删除组件/角色/Plugin 相关用例）
- Dashboard 版本号同步升级至 2.2.0

---

## [2.3.0] - 2026-02-13

### 链路打通 — 7 个断裂点修复 + 3 个废弃清理

> 架构审计发现 7 个断裂点和 3 个废弃残留，全部修复并打通。

#### Batch 1: 基础修复

- **CapabilityProbe 角色映射统一**：`contributor` / `visitor` 探针结果统一映射为 `developer`（本地用户 = 项目 Owner）
- **GatewayActionRegistry 修复**：新增 `candidate:update` action（MCP enrich/refine 工具的 Gateway gating 引用）
- **SearchService 名称修复**：`search:query` action 从 `container.get('searchService')` 改为 `container.get('searchEngine')`
- **EventBus / PluginManager 清理**：移除 ServiceContainer 中零消费者的注册（源文件保留）

#### Batch 2: SkillHooks 触发集成

- **CandidateService.createCandidate** 新增 `onCandidateSubmit` blocking hook（可拦截不合规候选）
- **RecipeService.createRecipe** 新增 `onRecipeCreated` fire-and-forget hook
- **MCP guard handler** 新增 `onGuardCheck` passthrough hook（允许 hooks 修改 violations）
- **MCP bootstrap handler** 新增 `onBootstrapComplete` fire-and-forget hook
- SkillHooks 通过 ServiceContainer 构造函数注入 CandidateService / RecipeService

#### Batch 3: Guard Reasoning 全路径

- **Reasoning 下沉到引擎层**：`GuardCheckEngine.checkCode()` 内置 `reasoning` 字段附加，MCP / CLI / ChatAgent 三条路径统一生效
- **ChatAgent tools.js** 移除重复的 reasoning 包装代码

#### Batch 4: 前端对齐 + DI 完善

- **Dashboard 角色系统同步**：`usePermission.ts` RoleId 从 6 个角色更新为 3 个（external_agent / chat_agent / developer）
- **Sidebar / HelpView** 角色标签全部对齐（开发者 / Agent / ChatAgent）
- **Constitution 注册到 ServiceContainer**：三个入口点均传入 `constitution` 组件，`container.get('constitution')` 可用
- **SetupService 模板更新**：`asd setup` 生成的 constitution.yaml 模板同步为 v3.0 格式

---

## [2.1.0] - 2026-02-13

### 新增

- **知识图谱分组布局**：节点按 Recipe category 自动分组，同组聚拢、异组分离；每组渲染虚线椭圆 hull 背景 + 分组标签；10 色循环配色方案
- **AI 发现关系**：知识图谱新增「AI 发现关系」按钮，调用 ChatAgent 批量分析 Recipe 间关系（requires / extends / enforces / calls 等）
- **异步任务模型**：`POST /recipes/discover-relations` 转为非阻塞异步执行，新增 `GET /discover-relations/status` 轮询端点；前端 3s 轮询 + 12 分钟超时保护
- **编辑器性能优化**：HighlightedCodeEditor 高亮层 debounce（短文件即时、长文件延迟）、行号虚拟化渲染、React.memo 减少重绘
- **Xcode 模拟器文件树**：后端 `files/tree` 路由改为递归扫描 .h / .m / .swift 源文件；前端支持空状态提示
- **知识图谱节点交互**：hover 高亮关联节点和边、degree badge、curved 边路径、边标签 tooltip

### 修复

- **知识图谱数据源**：`/graph/all` 默认过滤 `nodeType=recipe`，不再混入 SPM module 依赖边；`/graph/stats` 同步过滤
- **Recipe not found 错误**：仅对 recipe 类型节点查 recipeService，module 类型直接使用 ID 作为标签
- **`.substring` 崩溃**：ChatAgent `#taskDiscoverAllRelations` 中 `a.content` 可能为对象，用 `String()` 包裹
- **Socket hang up**：AI 分析耗时过长导致 Vite 代理断开，改为异步模型彻底解决
- **滚动条样式冲突**：`.scrollbar-light` 加 `!important` 防止被 Xcode 深色滚动条覆盖；模态对话框滚动条规则排除 `.scrollbar-light`

### 变更

- `KnowledgeGraphService.getAllEdges(limit, nodeType)` 新增可选 `nodeType` 过滤参数
- `KnowledgeGraphService.getStats(nodeType)` 新增可选 `nodeType` 过滤参数
- `/search/graph/all` 响应新增 `nodeTypes`、`nodeCategories` 字段
- `ChatAgent.#taskDiscoverAllRelations` 返回新增 `totalBatches`、`batchErrors` 字段；单批失败不终止整体
- Dashboard 版本号同步升级至 2.1.0

---

## [2.0.2] - 2026-02-13

### 新增

- **Tree-sitter AST 分析**：bootstrap 管线新增 Phase 1.5 AST 分析阶段，6 个维度提取器融合 AST 上下文，ChatAgent 提示词注入 AST 结构信息
- **JSON 截断修复**：`extractJSON` 新增 `_repairTruncatedArray()` 方法，当 AI 输出被 token 限制截断时自动回收已完成的 JSON 对象
- **bootstrap 分离执行**：`/spm/bootstrap` 路由拆分为同步阶段（结构收集）+ 异步阶段（AI 润色），避免前端超时
- **AI 提取诊断日志**：`extractRecipes` 新增 3 级日志（空响应 / JSON 解析失败 / 空数组），tool context 注入 logger

### 修复

- **Dashboard 冷启动按钮卡死**：bootstrap 路由同步返回候选列表，AI enrich/refine 后台执行
- **SPM Target 点击卡死**：`scanTarget` AI 提取添加 120 秒超时，前端透传 `message` 字段并显示错误通知
- **AI 提取静默返回空**：Gemini 响应被 token 截断时 `extractJSON` 返回 null 被静默吞掉，现在通过截断修复回收已完成条目

### 变更

- `ChatAgent.#getToolContext()` 新增 `logger` 属性
- `AiProvider` 新增 `_log()` 辅助方法
- Dashboard `api.scanTarget()` 返回值新增 `message` 字段
- 前端 axios bootstrap 超时 120s → 300s

---

## [2.0.1] - 2025-07-25

### 移除

- **Swift 解析器**：移除 `tools/parse-package/` 全部代码；V2 内置 AST-lite 解析器（`lib/service/spm/PackageSwiftParser.js`）已完全覆盖所有字段，无需外部 Swift 编译
- `postinstall-safe.js` 中 `checkSwiftParser()` 检查
- `package.json` 中 `build:parser` 脚本及 `files` 中 4 条 `tools/parse-package/*` 条目
- `.env.example` 中 `ASD_SWIFT_PARSER_*` / `ASD_USE_DUMP_PACKAGE` 环境变量
- README "Swift 解析器（可选）" 章节及 `--parser` 参数说明

### 修复

- CI 工作流升级至 V2 路由（`/api/v1/`），移除兼容别名
- CI `asd ui --no-open` 选项支持
- Dashboard 构建修复（删除废弃 `DashboardPage.tsx`，补齐 `trigger` 字段）
- V1 残留清理（9 文件：文档路由、注释、路径引用）

---

## [2.0.0] - 2026-02-12

### 重大变更

- **Node.js 运行时要求** ≥ 20（原 ≥ 18），package.json `engines` 字段已更新
- **V2 统一架构**：Gateway 控制平面 + Constitution 宪法体系 + 6 角色权限模型全面上线

### 架构

- **Gateway 控制平面**：324 行，完整流水线 validate → permission → constitution → plugin → dispatch → audit
- **GatewayActionRegistry**：27 个 Action（candidate 9 / recipe 12 / guard_rule 9 / search 1）
- **ConstitutionValidator**：P1-P4 四优先级逐级验证
- **PermissionManager**：3-tuple (actor, action, resource) 权限模型
- **SessionManager**：4 作用域 (project/target/file/developer) SQLite 持久化
- **CapabilityProbe**：`git push --dry-run` 写权限探测，24h TTL 缓存

### 新增

- **SaveEventFilter (3 层保存事件过滤)**：区分用户手动保存与 Xcode 自动保存，避免误触发自动化流程 (`lib/service/automation/SaveEventFilter.js`, ~160 行)
- **Header 格式自动解析**：
  - `_parseHeaderString()` — 解析 `#import "..."` / `#import <...>` / `@import` / `import` 等各种格式
  - `_resolveHeaderFormat()` — 根据当前文件 target 与 header 所属模块关系，自动选择 quote (`#import "Header.h"`) 或 angle bracket (`#import <Module/Header.h>`) 格式
- **同 target 相对路径计算**：
  - `_findHeaderRelativePath()` — 在磁盘上搜索头文件物理位置，计算相对于当前文件的路径（如 `../SubDir/Foo.h`）
  - `_findFileRecursive()` — 递归查找，深度限制 6，跳过隐藏目录/build/DerivedData
- **SPM 跨 Package 依赖支持**：
  - `#targetPackageMap` / `#packageDepGraph` 数据结构，`getPackageForTarget()` 查询
  - `#buildPackageDepGraph()` — 构建 Package 级依赖关系图
  - `_canReachPackage()` — 跨 Package 循环依赖检测
  - `addDependency()` 增强：跨 Package 时自动生成 `.product(name:, package:)` 语法并调用 `#ensurePackageDependency()`
- **依赖审查对话框增强**：新增 "提示操作插入"（第 3 按钮）和 "自动修复依赖"（第 4 按钮），在 `insertHeaders` 和 `_preflightDeps` 中同步实现
- **Fix Mode 配置**：`getFixMode()` 返回 `'fix'` / `'suggest'` / `'off'`（默认 `'suggest'`），控制依赖检查行为
- **窗口上下文验证**：`insertCodeToXcode` 中检查 Xcode 前台窗口是否匹配目标文件

- **Recipe .md Source of Truth**：
  - RecipeFileWriter (457 行)：领域对象 → YAML frontmatter + Markdown body 落盘
  - SyncService：增量同步 `.md` → DB，`_contentHash` 完整性校验
  - CLI `asd sync` 命令：手动触发同步

- **MCP Server 工具扩展**：31 个工具（原 15+），7 个写操作通过 Gateway Gating 保护
  - 工具编号统一为 1-31 顺序编号（修复原 10.1/10.2 子编号混乱）

- **Skills 体系重组**：10 个（原 13 个）
  - 删除废弃：autosnippet-when、autosnippet-search、autosnippet-batch-scan
  - 扩展 guard/structure/recipes Skill 能力

- **CLI 新命令**：`asd compliance`（合规评估）、`asd sync`（.md 同步）、`asd upgrade`（IDE 集成升级）

- **Service 层单元测试**（+70 测试）：
  - `CandidateService.test.js`（16 测试）
  - `RecipeService.test.js`（27 测试）
  - `SearchEngine.test.js`（27 测试）

- **ComplianceEvaluator** (327 行)：P1-P4 加权合规评分
- **RoleDriftMonitor** (260 行)：角色漂移检测
- **ReasoningLogger** (270 行)：AI 推理过程透明记录

### 修复

- **Paste 行号偏移 Bug**：`_computePasteLineNumber` 使用实际已插入的 `headerInsertCount` 而非 `headersToInsert.length`
- **搜索空结果不再跳转 Dashboard**：`SearchHandler` 搜索出错或无结果时仅打印 `未找到「${query}」的相关结果`，移除 `_openDashboard()` 调用
- **tokenize() 大写前缀切分**：camelCase 展开移至 toLowerCase 之前；新增 `([A-Z]+)([A-Z][a-z])` 正则处理 URLSession → `['url','session']` 等全大写前缀
- **auth.js 默认凭证警告**：使用 admin/autosnippet 默认凭证时打印 `console.warn`
- **BaseRepository tableName 校验**：构造器中添加 `SAFE_IDENTIFIER_RE` 防 SQL 注入
- **BaseError.js**：移除未使用的 `export default` 对象

### 改进

- **Header 去重增强**：同时检查原始格式和 resolved 格式，避免 `#import "Foo.h"` 与 `#import <Module/Foo.h>` 重复插入
- **依赖审查逻辑 DRY**：提取 `_handleDepReview()` 公共函数，消除 `insertHeaders` 和 `_preflightDeps` 中的重复代码
- **避免冗余 SPM 加载**：`spmService.load()` 结果缓存传递给 `insertHeaders`，避免二次加载
- **Package 依赖图构建优化**：使用 `dirname→pkgPath` Map 索引替代逐文件遍历
- **Header 模块推断缓存**：`_inferModulesFromHeaders` 结果缓存复用
- **VectorStore 并行 batchUpsert**：从逐条 `for await` 改为 `Promise.all` 批量（batch size=50），大幅提升批量写入性能
- **SearchEngine DRY 优化**：内联 BM25 content_json 补充逻辑抽取为 `_supplementDetails(items)` 复用
- **错误可观测性**（6 个文件 silent catch → Logger.warn）：
  - ExclusionManager、RuleLearner、MemoryManager、RecipeStatsTracker、FileWatcher、ErrorRecovery
- **代码清理**：
  - 删除空目录 `lib/external/api/`、`lib/external/cli/`
  - 清理死代码 Feature Flags：`RECIPE_KNOWLEDGE_GRAPH`、`COMPLIANCE_EVALUATOR_V2`
  - 删除 20 个 V1 遗留死文件、36 个 V1 废弃测试
  - 删除根目录死文件：`index.js`（空）、`format-indent.js`（一次性脚本）、`import-guard-data.mjs`（V1 迁移脚本）、`ecosystem.config.cjs`（PM2 失效配置）
  - 删除失效脚本：`generate-checksums.js`、`verify-checksums.js`、`check-paths.js`（V1 路径）
  - 删除死代码：`SnippetRepository.impl.js`、`ContextAnalyzer.js`、`RecallEngine.js`（零引用，共 414 行）
  - 清理 git 索引中 345 个 V1 幽灵文件
  - 测试目录扁平化：`test/v2/` → `test/`

### 测试

- 测试基线：**16 套件 / 307 测试**（原 12/210）
- Jest + `--experimental-vm-modules` ESM 支持
- 单元测试 11 个 + 集成测试 4 个（Jest）+ 2 个（node:test）

---

## [1.7.3] - 2026-02-06

### 修复

- **搜索结果前缀问题**：移除搜索结果中的 `recipe_` 和 `AutoSnippet/recipes/` 前缀，确保 Web Dashboard 和 Native UI 显示一致的干净文件名
  - 修复 Dashboard 搜索 API 中的 `normalizePath()` 函数
  - 修复 SearchServiceV2 中的语义搜索结果标准化
  - 支持向后兼容旧索引数据

### 新增

- **清除工具脚本**：
  - `scripts/clear-old-vector-index.js` - 删除旧格式向量索引（含前缀）
  - `scripts/clear-vector-cache.js` - 清除向量缓存

- **基础设施增强**：
  - `lib/context/WindowContextManager.js` - 窗口上下文管理
  - `lib/simulation/SimulatorInsertionManager.js` - 模拟器插入管理

## [1.7.2] - 2026-02-06

### 新增

- Xcode Simulator 面板：高亮编辑器、文件树与指令列表。
- 模拟器后端 API：文件树/保存/执行/原生弹窗调用。
- 模拟器核心库：`lib/simulation/` 模块化能力。

### 修复

- CLI 创建流程：补齐全局 `--preset`/`--yes` 支持与预置创建逻辑，修正 AI 参数解析。
- 测试稳定性：非交互创建、默认跳过 install 测试、修正 search/spm-map 测试用例。

### 改进

- Dashboard 样式与模态交互细节优化。

## [1.7.0] - 2026-02-05

### 重大改进

- **Recipe 标准化（7 个必填字段）**：
  - `title`, `trigger`, `category`, `language`, `summary_cn`, `summary_en`, `headers` 为必填
  - Category 限定为 8 个标准值（View/Service/Tool/Model/Network/Storage/UI/Utility）
  - headers 必须为完整 import/include 语句数组
  - 更新所有模板和文档以反映新标准

- **MCP 服务器增强**：
  - 统一 JSON Envelope 格式（`{ success, errorCode, message, data, meta }`）
  - 新增工具：`autosnippet_health`, `autosnippet_capabilities`, `autosnippet_context_analyze`, `autosnippet_validate_candidate`, `autosnippet_check_duplicate`, `autosnippet_get_target_metadata`
  - 完整的 20+ 错误码支持（SEARCH_FAILED、RATE_LIMIT、ELICIT_FAILED 等）
  - 鉴权支持（ASD_MCP_TOKEN）
  - 限流保护（提交频率控制）
  - OpenAI Provider 支持 Target 类型检测与专用提示


### 新增

- **候选管理增强**：
  - 候选去重与聚合功能（`aggregateCandidates`）
  - 候选校验模块（`validateRecipeCandidate`）
  - 支持 intro-only Recipe（纯介绍无代码）
  - 草稿提交流程增强（自动校验、去重、限流）

- **Skills 重组（v2.0）**：
  - 新增 `autosnippet-intent`（路由 Skill，替代 autosnippet-when）
  - 新增 `autosnippet-structure`（结构发现，替代 autosnippet-dep-graph）
  - 新增 `autosnippet-candidates`（统一候选生成，合并 autosnippet-batch-scan 和 autosnippet-recipe-candidates）
  - 所有 Skills 添加自检与回退指导
  - 弃用标记：autosnippet-when, autosnippet-search, autosnippet-batch-scan, autosnippet-recipe-candidates, autosnippet-dep-graph

- **诊断与审计工具**：
  - `npm run diagnose:mcp`：MCP 健康诊断脚本
  - `scripts/demo-candidates-submit.js`：候选提交演示
  - `scripts/recipe-audit.js`：Recipe 审计脚本（检查必填字段与格式）
  - `docs/Recipe-审核检查清单.md`：人工审核标准
  - `docs/交付自检说明.md`：交付前自检清单

### 修复

- **Dashboard 修复**：
  - RecipeEditor headers 验证逻辑（移除引号误报）
  - SPMExplorerView 和 CandidatesView 相似度点击 404（规范化 .md 后缀）
  - Snippet 删除 API 方法错误（改用 readSpecFile/deleteSnippet）
  - 重新构建 Dashboard（3 次，确保所有更新生效）

- **术语统一**：
  - `// as:guard` → `// as:audit`（guardViolations.js、statusCommand.js、test/README.md）
  - 文档与代码保持一致

### 改进

- **文档完善**：
  - `.github/copilot-instructions.md`：Recipe 字段详细说明（7 个必填 + 格式要求）
  - `templates/cursor-rules/autosnippet-conventions.mdc`：英文版 Recipe 规则
  - `templates/recipes-setup/`：三个模板文件完全更新（_template.md, example.md, README.md）
  - `skills/` 目录：14 个 Skills 文件更新（Envelope 读取、错误码处理、自检回退）

- **测试完善**：
  - 新增 `test-current-features.js`：快速功能验证测试（10/10 通过）
  - `TEST_REPORT.md`：集成测试报告
  - 集成测试全部通过（39/39，100% 成功率）

---

## [1.6.2] - 2026-02-05

### 新增

- **UI 优化增强**：
  - Dashboard AI Assistant 支持完整 Markdown 渲染（代码块、列表、标题等）
  - 搜索结果显示优化，移除冗余的百分比和图标展示
  - 改进搜索服务 V2 结果标题格式
  - 更新模式预览中的结果展示逻辑

- **原生 UI 改进**：
  - 移除列表项中的文件图标，简化视觉设计
  - 调整文本布局位置，提升界面整洁度
  - 改进窗口控制器的单元格视图配置

### 修复

- **浏览器打开机制优化**：
  - 修复 macOS 上重复弹出浏览器选择对话框的问题
  - 增加应用程序安装检查，避免系统错误
  - 改进 AppleScript 调用的稳定性
  - 移除强制打开 Safari 的逻辑

- **日志系统优化**：
  - 将 AI Provider（DeepSeek）的冗余日志改为条件输出
  - 仅在 `ASD_DEBUG=1` 环境变量设置时显示调试信息
  - 减少测试执行时的日志噪声

### 改进

- **测试框架稳定性**：
  - 修正跨项目测试中的路径判断逻辑
  - 增加对环境变量的灵活支持（ASD_TEST_PROJECT_ROOT、ASD_TEST_PROJECT_BASENAME）
  - 所有 39 个集成测试保持 100% 通过率

- **开发体验**：
  - .gitignore 更新，避免版本控制中包含临时文件和缓存
  - 删除不必要的测试脚本，保持项目结构清洁
  - 改进版本管理与发布流程

---

## [1.6.0] - 2026-02-04

### 新增

- **CLI 版本选项**：新增 `-v, --version` 选项，方便快速查看当前版本。
- **完整的集成测试框架**：新增全面的 Dashboard API 集成测试套件，提供零依赖的测试基础设施。相关内容：
  - 新增 `test/integration/` 目录，包含完整测试框架和 39 个测试用例
  - 框架组件：TestClient（HTTP 客户端）、TestAssert（13+ 断言方法）、TestContext（数据管理）、TestRunner（测试执行）、TestResults（报告生成）
  - 测试覆盖：Recipe API（15 个测试）、权限系统（12 个测试）、跨项目功能（12 个测试），总体 92% 覆盖率
  - 自动报告生成：JSON + HTML 格式，含详细的执行统计和失败分析
  - npm 脚本：`npm run test:integration` 及其变体（recipes/permissions/cross-project）
  - 文档：[测试指南](docs/TESTING.md)、[快速参考](docs/TESTING_QUICKREF.md)、[项目文档](test/integration/README.md)、[速查表](test/integration/QUICKSTART.md)
  - 详见：`test/integration/README.md` 和 `docs/TESTING.md`

- **Dashboard 智能复用**：运行 `asd ui` 时会自动检测端口 3000 是否已运行 Dashboard 服务。如果已运行，则直接复用并打开浏览器标签页，避免启动多个服务实例。相关实现：
  - 新增端口检测和 Dashboard 识别逻辑（`isPortAvailable`、`isDashboardRunning`）
  - 新增健康检查接口 `GET /api/health`
  - 端口被其他服务占用时提示使用 `--port` 参数
  - 详见：[Dashboard 复用功能文档](docs/dashboard-reuse.md)

### 修复

- **GitHub Actions CI 集成测试支持**：修复集成测试在 CI 环境下的兼容性问题：
  - 新增 `ASD_DISABLE_WRITE_GUARD` 环境变量，允许 CI 环境跳过 git push --dry-run 权限检查
  - 新增 `ASD_DISABLE_RATE_LIMIT` 环境变量，允许测试环境跳过速率限制
  - Recipe API 接口规范化：record-usage 支持 `name` 参数，get 接口返回一致的错误格式
  - Recipe 名称验证：拒绝路径遍历攻击（`..`、`/`、`\`）
  - 更新 `.github/workflows/ci.yml` 配置，确保 Dashboard 在后台启动并通过健康检查
  - 所有 39 个集成测试在 CI 环境 100% 通过

- **候选文件存储位置**：修复 `candidateService` 硬编码 `Knowledge` 目录的问题。现在会根据 `AutoSnippet.boxspec.json` 中的 `recipes.dir` 配置来决定候选文件（`candidates.json`）的存储位置。例如：
  - 如果 `recipes.dir` 为 `\"AutoSnippet/recipes\"`，候选文件保存到 `AutoSnippet/.autosnippet/candidates.json`
  - 如果 `recipes.dir` 为 `"docs/recipes"`，候选文件保存到 `docs/.autosnippet/candidates.json`
  - 这确保了项目的所有 AutoSnippet 相关文件都在统一的目录结构下

### 改进

- **单元测试改进**：修复 checksums-verify 测试在不同环境下的稳定性问题：
  - 测试环境变量隔离：确保测试不受当前 shell 环境变量影响
  - 更新测试命令：使用 `help` 替代已废弃的 `status` 命令
  - 改进测试断言：更准确地验证预期行为

---

## [待发布] - 2026-02-04

### 新增

- **完整的集成测试框架**：新增全面的 Dashboard API 集成测试套件，提供零依赖的测试基础设施。相关内容：
  - 新增 `test/integration/` 目录，包含完整测试框架和 39 个测试用例
  - 框架组件：TestClient（HTTP 客户端）、TestAssert（13+ 断言方法）、TestContext（数据管理）、TestRunner（测试执行）、TestResults（报告生成）
  - 测试覆盖：Recipe API（15 个测试）、权限系统（12 个测试）、跨项目功能（12 个测试），总体 92% 覆盖率
  - 自动报告生成：JSON + HTML 格式，含详细的执行统计和失败分析
  - npm 脚本：`npm run test:integration` 及其变体（recipes/permissions/cross-project）
  - 文档：[测试指南](docs/TESTING.md)、[快速参考](docs/TESTING_QUICKREF.md)、[项目文档](test/integration/README.md)、[速查表](test/integration/QUICKSTART.md)
  - 详见：`test/integration/README.md` 和 `docs/TESTING.md`

- **Dashboard 智能复用**：运行 `asd ui` 时会自动检测端口 3000 是否已运行 Dashboard 服务。如果已运行，则直接复用并打开浏览器标签页，避免启动多个服务实例。相关实现：
  - 新增端口检测和 Dashboard 识别逻辑（`isPortAvailable`、`isDashboardRunning`）
  - 新增健康检查接口 `GET /api/health`
  - 端口被其他服务占用时提示使用 `--port` 参数
  - 详见：[Dashboard 复用功能文档](docs/dashboard-reuse.md)

### 修复

- **候选文件存储位置**：修复 `candidateService` 硬编码 `AutoSnippet` 目录的问题。现在会根据 `AutoSnippet.boxspec.json` 中的 `recipes.dir` 配置来决定候选文件（`candidates.json`）的存储位置。例如：
  - 如果 `recipes.dir` 为 `"AutoSnippet/recipes"`，候选文件保存到 `AutoSnippet/.autosnippet/candidates.json`
  - 如果 `recipes.dir` 为 `"docs/recipes"`，候选文件保存到 `docs/.autosnippet/candidates.json`
  - 这确保了项目的所有 AutoSnippet 相关文件都在统一的目录结构下

---

## [1.5.9] - 2025-02-02

### 修复

- **asd status 项目根未找到**：CMD_PATH 改为优先使用 `process.env.ASD_CWD`（asd 脚本传入的调用目录），避免 dev:link 等场景下 process.cwd() 与用户所在目录不一致导致找不到 AutoSnippet.boxspec.json。
- **asd ui 端口占用**：asd-verify 收到 SIGINT/SIGTERM 时转发给 Node 子进程，避免 Ctrl+C 后仅 Swift 退出、Node 成为孤儿进程占用 3000 端口。

### 测试

- **Swift 二进制**：`test/unit/checksums-verify.test.js` 新增 `testSwiftVerifyBinary()`，在存在 bin/asd-verify 时运行 `asd-verify -v` 并断言通过。
- **Node 回退路径**：新增 `testNodeFallbackStatus()`，验证无 asd-verify 时 ASD_CWD 仍生效、status 能正确找到项目根。

---

## [1.5.8] - 2025-02-02

### 变更

- 版本号更新至 1.5.8。

---

## [1.5.7] - 2025-02-02

### 新增

- **Recipe 保存频率限制**：按「项目根 + 客户端 IP」固定窗口限流，防止短时间内多次保存；超限返回 429，前端提示「保存过于频繁，请稍后再试」。配置：`ASD_RECIPE_SAVE_RATE_LIMIT`（默认 20）、`ASD_RECIPE_SAVE_RATE_WINDOW_SECONDS`（默认 60），设为 0 表示不限制。
- **Recipe 保存防重复点击**：编辑 Recipe 弹窗「Save Changes」、SPM 审核页「保存为 Recipe」、对比弹窗「审核候选」在请求进行中禁用按钮并显示「保存中...」，避免重复提交。
- **完整性校验入口（Swift）**：原生入口为 Swift 实现（`resources/asd-entry/main.swift`），仅 macOS 构建为 `bin/asd-verify`；使用 CryptoKit 做 SHA-256 校验。`bin/asd` 优先执行 `asd-verify`，不存在则回退 `node bin/asd-cli.js`。项目仅在 macOS 运行，故保留 Swift 入口。

### 文档

- **提交前检查清单**：`docs/提交前检查清单.md`，用于发布前自检。
- **权限设置说明重写**：精简为「写权限探针、频率控制、完整性校验」配置与行为；明确探针目的为「保证管理员能够正确提交 Recipe」；适用场景改为「Recipe 上传由 Git 服务端权限拦截」。
- **README / 权限表述**：Knowledge 与 Git 小节强调上传由 Git 拦截；`ASD_RECIPES_WRITE_DIR` 表述为「保证管理员能够正确提交 Recipe」。
- **context 配置说明**：新增「为什么 .autosnippet 里有两个 vector_index.json」「manifest.json 有什么用处」两节。

### 测试

- **完整性入口校验**：`test/unit/checksums-verify.test.js` 新增 `testEntryCheck()`，覆盖存在 checksums 时「无 ASD_VERIFIED 警告且 exit 0」「ASD_STRICT_ENTRY=1 拒跑」「ASD_VERIFIED/ASD_SKIP 无警告」四种场景。

---

## [1.5.6] - 2025-02-02

### 新增

- **写权限探针（阶段一）**：保存/删除 Recipe、保存/删除 Snippet 前在配置的探针目录（如子仓库 `auth-data`）执行 `git push --dry-run`，非零退出则返回 403（`RECIPE_WRITE_FORBIDDEN`）；探针通过后仍写主项目原路径。配置：`ASD_RECIPES_WRITE_DIR` 或 rootSpec `recipes.writeDir`，未设则不启用；`ASD_PROBE_TTL_SECONDS` 默认 24h，进程内缓存。
- **完整性校验（阶段二）**：`bin/asd` 优先执行原生入口 `bin/asd-verify`（Swift），存在 `checksums.json` 时对关键文件做 SHA-256 校验，不通过则 exit(1)，通过则 spawn `node bin/asd-cli.js`；无 checksums 或未构建 asd-verify 时回退到 `node bin/asd-cli.js`。发布前 `prepublishOnly` 自动生成 `checksums.json`。
- **Node 校验脚本**：`npm run verify-checksums` 复现 Swift 校验逻辑（无 Swift 环境/CI 可用）；拒绝 `..`、绝对路径与路径逃逸。
- **单元测试**：`test/unit/checksums-verify.test.js` 覆盖合法清单通过、错误哈希/无效 JSON/路径逃逸/缺失文件失败；已加入 `test/unit/run-all.js`。

### 文档

- **安全等级说明**：BiliDemo/docs 下新增 `AutoSnippet-安全等级说明.md`（防护范围、不防护、适用场景）；实现清单小结增加安全等级与文档引用。

---

## [1.5.5] - 2025-02-02

### 修复

- **asd status AI 配置**：getConfigSync 正确解析并返回 hasKey，修复「未配置 API Key」误报。
- **asd status 语义索引**：检测路径改为 `context/index/vector_index.json`、`context/index/lancedb/`、`manifest.json`，修复 embed 后仍提示「未构建」。
- **asd status Dashboard**：未运行时使用 ℹ️ 而非 ❌，文案为「需时请执行 asd ui」，属于正常情况。

### 变更

- **移除 bin/native-ui**：仅保留 `resources/native-ui/native-ui`（由 build 生成），bin/native-ui 为冗余且未被引用。

---

## [1.5.4] - 2025-02-02

### 新增

- **asd status 增强**：Dashboard 未运行时明确提示「as:create、as:guard、as:search 保存后不会触发」；新增「下一步建议」汇总，根据当前状态给出具体操作建议。
- **asd setup 引导**：setup 完成后输出下一步建议（asd ui、.env、embed、install:cursor-skill）。
- **as:search / Guard 无结果通知**：macOS 上无匹配时弹出系统通知，避免用户漏看终端输出。
- **检索 language filter**：`// as:search` 根据当前文件扩展名（.m/.h→objc、.swift→swift）自动过滤 Recipe；索引时从 Recipe frontmatter 写入 category、language 到 metadata。

### 变更

- **IndexingPipeline**：Recipe 索引时解析 frontmatter，写入 category、language 到 chunk metadata。
- **searchService**：semanticSearch 支持 options.filter（language、category）；关键词搜索回退时不受 filter 影响。
- **JsonAdapter / LanceAdapter**：_applyFilter 支持 language、category；language 支持 objc/objectivec 别名。
- **parseRecipeMd**：导出 parseFrontmatter 供 IndexingPipeline 使用。

---

## [1.5.3] - 2025-02-02

### 新增

- **候选 vs Recipe 对比弹窗**：删除候选、审核候选、审核 Recipe 操作；复制候选/Recipe 内容；快速切换相似 Recipe（top3 标签）；候选格式与 Recipe 一致（Snippet / Code Reference + AI Context / Usage Guide）。
- **审核页相似度**：SPM 审核页（深度扫描、当前页进入审核）支持相似 Recipe 展示与对比；深度扫描结果（无 candidateId）也可计算相似度。
- **相似度 API**：`POST /api/candidates/similarity` 支持 `candidate` 对象入参，用于无 candidateId 的项。

### 变更

- **对比弹窗**：加宽至 95vw/1600px；Recipe 侧移除 frontmatter 元数据展示；CSS Grid 实现左右 header 等高、Snippet / Code Reference 对齐。
- **CodeBlock**：增加 `objective-c`、`obj-c` 语言映射，修复 Cursor 批量候选高亮。
- **Guard 页**：移除前置条件提示条。
- **质量分**：候选质量分仅用于排序，不再展示。

---

## [1.5.2] - 2025-02-01

### 新增

- **Guard 页面**：增加「提交误报/建议」入口，链接到 GitHub Issues 预填标题，便于反馈误报或规则建议。
- **文档**：新增 [Guard-误报与排除策略](docs/Guard-误报与排除策略.md)，汇总误报场景、排除策略与 Knowledge 目录说明；文档内增加前置条件说明。
- **使用文档**：增加前置条件小节（环境、项目根、watch/ui、Dashboard/MCP）；文档索引补充 Guard-误报与排除策略。
- **CHANGELOG**：新增本文件。

### 变更

- **Guard 规则**：block 循环引用排除扩展为枚举（`enumerateObjectsUsingBlock:` 等）、`performWithoutAnimation:`、`addOperationWithBlock:`；init 检查支持委托初始化 `[self initWith...]`；Swift ui-off-main 规则移除对 `DispatchQueue.main.async` 的误报。
- **Guard 页**：增加前置条件提示条（需 `asd ui`、违反记录由 `// as:guard` 触发）。
- **asnip setup**：成功提示文案由「AutoSnippet.boxspec.json」改为「AutoSnippetRoot.boxspec.json」，与实际文件名一致。

### 文档

- 补全 [context 配置说明](docs/context配置说明.md)、[MCP 配置说明](docs/MCP配置说明.md)，消除文档索引死链。
- 文档索引中移除不存在的 `guard-checks-catalog.json` 条目，规则示例改为指向 Dashboard Guard 页或 `Knowledge/.autosnippet/guard-rules.json`。

### 修复

- **LanceDB 适配器**：where/delete 谓词使用 `"id"` 导致查询与删除失效；改为 `id = '...'`（列名不加双引号）以符合 LanceDB/DataFusion SQL 语法，修复 getById、searchByFilter、remove。

### 新增（候选质量与相似度）

- **质量评估**：`lib/candidate/qualityRules.js` 对候选打分，仅用于 Candidates 列表排序（高分靠前），不展示。
- **相似度分析**：`lib/candidate/similarityService.js` 基于向量检索；Dashboard Candidates 展开时展示相似 Recipe，点击可打开双栏对比弹窗（候选 vs Recipe）。
- **API**：`POST /api/candidates/similarity`、`GET /api/recipes/get?name=xxx`。

历史变更未在此逐条列出，可参考 Git 提交记录与各版本 Release 说明。
