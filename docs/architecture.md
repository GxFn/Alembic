# 架构设计

AutoSnippet 采用分层领域驱动架构（Layered DDD），核心目标是将代码模式提取为结构化知识，并通过多种通道交付给 AI 编码助手。

---

## 架构总览

```
┌─────────────────────────────────────────────────────────┐
│                    Entry Points                         │
│  bin/cli.js (asd)   bin/mcp-server.js   bin/api-server  │
└──────────┬─────────────────┬──────────────┬─────────────┘
           │                 │              │
┌──────────▼─────────────────▼──────────────▼─────────────┐
│              lib/bootstrap.js                            │
│  .env → Config → Logger → DB → Constitution → Gateway   │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│          lib/injection/ServiceContainer.js               │
│  DI 容器 (懒加载单例) — 40+ 服务注册                      │
└──────┬──────────┬──────────┬──────────┬─────────────────┘
       │          │          │          │
┌──────▼──┐ ┌────▼────┐ ┌───▼───┐ ┌───▼──────────┐
│ HTTP    │ │  MCP    │ │  CLI  │ │  Dashboard   │
│ Express │ │ stdio   │ │ cmdr  │ │ React+Vite   │
│ 17 路由  │ │ 20 工具  │ │ 14 命令│ │ 17 视图       │
└──────┬──┘ └────┬────┘ └───┬───┘ └──────────────┘
       │         │          │
┌──────▼─────────▼──────────▼─────────────────────────────┐
│                   Agent Layer                            │
│  AgentRuntime (ReAct) · Memory · Context · Tools (54)   │
│  IntentClassifier · Router · Presets · Strategies        │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                   Service Layer                          │
│  Knowledge · Guard · Search · Bootstrap                  │
│  Cursor · Quality · Recipe · Skills · Wiki · Automation │
│  Snippet · Module · Task · Vector · Candidate            │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                Core + Domain Layer                        │
│  Gateway (validate→guard→route→audit)                    │
│  Constitution (RBAC) · AST (11 语言) · Discovery (11)   │
│  Enhancement (17 框架) · KnowledgeEntry (统一实体)        │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│               Infrastructure Layer                       │
│  SQLite · VectorStore · Cache · EventBus · Logger       │
│  AuditStore · Realtime(Socket.IO) · PerformanceMonitor  │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                 External Layer                            │
│  AI: OpenAI / Gemini / Claude / DeepSeek / Ollama       │
│  MCP: 16 agent + 4 admin 工具                            │
│  Lark: LarkTransport 飞书消息传输层                       │
│  Native: Xcode / Clipboard / Browser                     │
└─────────────────────────────────────────────────────────┘
```

---

## 分层说明

### 1. Entry Points（入口层）

| 入口 | 文件 | 用途 |
|------|------|------|
| CLI | `bin/cli.js` | `asd` 命令行工具，基于 commander，14 个子命令 |
| MCP Server | `bin/mcp-server.js` | MCP stdio 服务器，供 Cursor / VS Code / Claude Code 调用 |
| API Server | `bin/api-server.js` | HTTP REST API 服务器，供 Dashboard 和外部集成使用 |

所有入口共享同一个初始化流程：`Bootstrap.initialize()` → `ServiceContainer.initialize()`。

### 2. Bootstrap（引导层）

`lib/bootstrap.js` 负责应用的启动序列：

1. **loadDotEnv** — 沿目录树向上查找 `.env` 文件
2. **loadConfig** — `ConfigLoader` 加载 `config/default.json` + 环境变量覆盖
3. **initializeLogger** — Winston 日志实例化
4. **initializeDatabase** — SQLite 连接 + 自动迁移
5. **loadConstitution** — 加载权限宪法 `constitution.yaml`
6. **initializeCoreComponents** — ConstitutionValidator、PermissionManager、AuditStore、SkillHooks
7. **initializeGateway** — Gateway 管线注入（validate → guard → route → audit）

### 3. DI Container（依赖注入）

`lib/injection/ServiceContainer.js` 是全局单例 DI 容器，采用 **懒加载工厂注册** 模式：

- 40+ 服务通过工厂函数注册，首次 `get()` 时实例化并缓存
- 支持 AI Provider 热重载（`reloadAiProvider()`），自动清除依赖链上的缓存单例
- 注册分三阶段：`_registerInfrastructure()` → `_registerRepositories()` → `_registerServices()`

### 4. Agent Layer（Agent 智能层）

独立的 Agent 架构层（`lib/agent/`，路径别名 `#agent/*`），包含 40+ 个文件，5 个子模块：

| 子模块 | 核心类 | 职责 |
|--------|--------|------|
| **根级** | `AgentRuntime` | ReAct 推理循环引擎，统一 ONE Runtime 多配置架构 |
| **根级** | `AgentFactory` | Agent 工厂，根据 Preset 创建不同配置的 Runtime |
| **根级** | `AgentRouter` | Intent → Preset 路由分发 |
| **根级** | `IntentClassifier` | 意图分类（关键词 + LLM 混合） |
| **core/** | `ToolExecutionPipeline` | ReAct 循环核心：Prompt 构建 + 工具执行管线 |
| **memory/** | `MemoryCoordinator` | 多层记忆系统：Session / Active / Persistent / Episodic |
| **context/** | `ContextWindow` / `ExplorationTracker` | Token 窗口管理 + 探索策略 |
| **domain/** | `EpisodicConsolidator` / `InsightProducer` | Agent 领域逻辑：洞察分析、证据收集、扫描任务 |
| **tools/** | `ToolRegistry` + 14 文件 | 54 个内置工具（知识、AST、Guard、搜索、系统等） |
| **forge/** | `ToolForge` / `SandboxRunner` / `DynamicComposer` | 动态工具锻造：复用/组合/生成三模式，沙箱验证 + TTL 临时注册 |

### 5. Service Layer（服务层）

业务服务层，包含 15 个子域服务：

| 子域 | 核心类 | 职责 |
|------|--------|------|
| **knowledge** | `KnowledgeService` | 知识条目 CRUD、图谱、实体图、置信度路由 |
| **guard** | `GuardService` / `GuardCheckEngine` | 50+ 内置规则引擎（正则 + AST 语义），三态输出（pass / violation / uncertain），三维报告（合规度 + 覆盖率 + 置信度） |
| **search** | `SearchEngine` / `MultiSignalRanker` | FieldWeighted + 向量混合检索，7 信号加权排序 |
| **task** | `IntentExtractor` / `PrimeSearchPipeline` | 意图感知多路搜索：Q1 同义词增强 + Q2 技术术语 + Q3 文件上下文 + Q4 聚焦查询，三层质量过滤（绝对阈值 + 相对阈值 + 梯度截断） |
| **bootstrap** | `BootstrapTaskManager` | 冷启动异步任务编排，14 个分析维度 |
| **delivery** | `CursorDeliveryPipeline` | 4 通道交付（Rules + Skills + Token 预算 + 主题分类） |
| **automation** | `AutomationOrchestrator` | 文件监听、指令检测（`as:s` / `as:c` / `as:a`）、处理管线 |
| **quality** | `QualityScorer` | 知识条目质量评分 + 反馈收集 |
| **recipe** | `RecipeParser` | Recipe Markdown 解析与候选校验 |
| **skills** | `SkillAdvisor` / `SkillHooks` | Skill 推荐、生命周期钩子、信号后台分析 |
| **snippet** | `SnippetFactory` | IDE 无关的代码片段工厂（Xcode / VS Code Codec） |
| **wiki** | `WikiGenerator` | 项目 Wiki 自动生成 |
| **module** | `ModuleService` | 多语言模块结构扫描 |
| **candidate** | `SimilarityService` | 候选去重，相似度检测 |
| **evolution** | `KnowledgeMetabolism` / `DecayDetector` / `ContradictionDetector` / `RedundancyAnalyzer` | 知识治理：矛盾检测、冗余分析、衰退评分、进化提案 |
| **signal** | `HitRecorder` | 批量使用信号采集 + 30s buffer flush |

### 6. Core + Domain Layer（核心 + 领域层）

#### Gateway（网关）

统一的请求处理管线，4 步流程：
1. **Validate** — 参数校验
2. **Guard** — 权限 + 宪法规则检查
3. **Route** — `GatewayActionRegistry` 路由到具体 Service 方法
4. **Audit** — `AuditLogger` 记录操作日志

#### AST 分析（11 语言）

基于 `web-tree-sitter` (WASM) 的多语言 AST 解析器：
JavaScript, TypeScript, Python, Swift, Dart, Go, Java, Kotlin, Objective-C, Rust + Generic

每种语言有独立的提取器（`lang-*.js`），输出结构化的类、方法、导入、依赖关系。

#### 项目发现（11 个 Discoverer）

`DiscovererRegistry` 按项目特征自动探测项目类型：
Node, Python, Dart, Go, JVM (Java/Kotlin), Rust, SPM (Swift), Generic 等

#### 框架增强（17 个 Enhancement Pack）

为检测到的框架注入额外的分析逻辑：
React, Vue, Next.js, Node Server, Django, FastAPI, Spring, Android, Go Web, Go gRPC, Rust Web, Rust Tokio, LangChain, ML 等

#### 领域实体

- `KnowledgeEntry` — V3 统一知识条目，含 Content、Constraints、Quality、Reasoning、Relations、Stats 值对象
- `Lifecycle` — 知识条目六态生命周期状态机：`pending → staging → active → evolving/decaying → deprecated`。staging（暂存期自动发布）、evolving（进化提案附着）、decaying（衰退观察期）为由系统驱动的中间状态
- `Snippet` — 代码片段实体

### 7. Infrastructure Layer（基础设施层）

| 模块 | 职责 |
|------|------|
| `DatabaseConnection` | SQLite 连接管理 + 自动迁移 |
| `VectorStore` / `JsonVectorAdapter` | 向量存储（本地 JSON 或 Milvus） |
| `IndexingPipeline` / `Chunker` | 向量索引管线 + 文本分块 |
| `CacheService` / `GraphCache` | 内存缓存 + AST 图谱缓存 |
| `SignalBus` | 统一信号总线（typed pub-sub），9 种信号类型，精确/通配符订阅 |
| `EventBus` | 进程内事件总线 |
| `RealtimeService` | Socket.IO 实时推送（冷启动进度等） |
| `AuditStore` / `AuditLogger` | 操作审计日志持久化 |
| `Logger` | Winston 结构化日志 |
| `ErrorTracker` / `PerformanceMonitor` | 错误追踪 + 性能监控 |
| `PathGuard` | 路径安全守卫，防止文件写逃逸 |

### 8. External Layer（外部集成层）

#### AI Provider

`AiFactory` 自动探测可用 Provider，支持热切换：

| Provider | 环境变量 |
|----------|---------|
| Google Gemini | `ASD_GOOGLE_API_KEY` |
| OpenAI | `ASD_OPENAI_API_KEY` |
| Claude | `ASD_CLAUDE_API_KEY` |
| DeepSeek | `ASD_DEEPSEEK_API_KEY` |
| Ollama (本地) | `ASD_AI_PROVIDER=ollama` |

多个 API Key 同时存在时自动 fallback。

#### MCP 服务器

20 个工具分为 16 个 Agent Tier（IDE AI 可用）+ 4 个 Admin Tier（管理员/CI），通过 stdio 协议与 IDE 通信。

---

## 数据流

### 知识提取流程

```
源代码 → AST 解析 → Discovery (项目类型) → Enhancement (框架增强)
     → Bootstrap (14 维度分析) → AI 提取 → Candidates (草稿)
     → Dashboard 审核 → Recipes (批准) → 搜索索引 + Guard 规则
```

### IDE 交付流程

```
IDE AI 请求 → MCP Server → Gateway (权限校验)
           → IntentExtractor (意图提取: 同义词展开 + 技术术语 + 场景分类)
           → PrimeSearchPipeline (多路并行搜索 + RRF 融合 + 三层质量过滤)
           → KnowledgeCompressor (Token 预算)
           → 返回 Recipes + Guard 规则 + sourceRefs
```

### Guard 检查流程

```
源文件 → SourceFileCollector → GuardCheckEngine
      → 正则规则 (50+) + AST 语义规则 + 跨文件规则
      → 三态输出: pass / violation / uncertain
      → ComplianceReporter → 三维报告 (合规度 + 覆盖率 + 置信度)
      → ReverseGuard → Recipe↔Code 反向验证 (API 符号存活检测)
```

---

## 宪法系统（RBAC）

三层权限架构：

| 层 | 说明 |
|----|------|
| **能力层** | 运行时能力探测（如 `git_write`） |
| **角色层** | 3 个角色：`external_agent`（IDE AI）、`chat_agent`（内置 AI）、`developer`（开发者） |
| **治理层** | 4 条硬规则：删除需确认、创建需内容、AI 不可直接发布、批量需授权 |

---

## 关键设计决策

1. **ESM Only** — 全项目使用 ES Modules，Node.js ≥ 22
2. **SQLite as Cache** — Markdown 文件是 Source of Truth，SQLite 是读缓存，`asd sync` 可重建
3. **无编译步骤** — 纯 JavaScript，不需要 TypeScript 编译（Dashboard 除外）
4. **DI without Framework** — 自实现轻量 DI 容器，无外部 DI 框架依赖
5. **WASM AST** — `web-tree-sitter` 替代原生 `tree-sitter`，消除 C++ 编译依赖
6. **Convention over Configuration** — 项目结构约定（`AutoSnippet/recipes/`、`AutoSnippet/candidates/`），最小化配置
