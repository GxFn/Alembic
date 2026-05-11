# Alembic-legacy 0.1.0 核心链路与真实实现深挖

本文档基于 `/Users/gaoxuefeng/Documents/AlembicTemp/Alembic-legacy` 的真实代码实现，基线提交为 `229039c93bb740f06ca65eee14476653d0daa9bd`，提交信息为 `Prepare Alembic Codex 0.1.0`。

目标不是复述 README，也不是继续沿用旧项目后续升级设想，而是把 legacy 0.1.0 中已经验证成熟的核心链路、功能边界、实现关系和迁移判断梳理清楚，供新 Alembic 继续“从底层到上层”迁移。

## 1. 总体判断

Alembic-legacy 0.1.0 的核心不是 Dashboard，也不是单次文档生成工具，而是一套本地项目智能底座：

```text
项目源码
  -> ProjectIntelligence 扫描与图谱
  -> Recipe / Candidate 知识本体
  -> Search / Vector / Guard / Panorama 可消费索引
  -> AgentRuntime 自动挖掘和进化
  -> MCP / Codex / IDE 外部工具入口
```

旧项目已经成熟的能力主要集中在这些主链：

| 主链 | 作用 | 迁移判断 |
| --- | --- | --- |
| Bootstrap/DI/Daemon | 统一运行时、数据库、路径守卫、服务注入、长任务托管 | 必须保留语义，重建实现边界 |
| ProjectIntelligence | 文件、AST、调用图、依赖图、Guard、维度和增强包扫描 | 必须完整迁移 |
| 内部 Agent tools | AgentRuntime 专用 code/terminal/knowledge/graph/memory/meta 工具 | 必须完整迁移，但与外部工具彻底分层 |
| AgentRuntime | ReAct loop、能力白名单、策略、预算、压缩、工具执行管线 | 必须完整迁移 |
| 冷启动 workflow | 全清理、项目扫描、维度任务、内部/外部 Agent 执行、finalizer | 必须完整迁移 |
| 增量 rescan workflow | 保留 Recipe、SourceRef 修复、影响分析、进化审计、gap-fill | 必须完整迁移 |
| Knowledge lifecycle | file-first Recipe、DB 索引、生命周期、去重、合并、质量、演化 | 必须完整迁移 |
| Search/Vector/Guard/Panorama | 知识消费、语义检索、规则检查、全景分析 | 必须作为底层能力迁移 |
| Delivery/Wiki/Dashboard/Realtime | 把知识输出给 IDE、文档或可视化页面 | 可做成插件化 finalizer，不进入 Codex 首阶段默认链路 |

新 Alembic 的方向应该是：保留 legacy 已经验证的“项目智能、AgentRuntime、知识治理、冷启动和增量链路”，同时剪掉旧兼容 envelope、旧 UI 默认副作用、多 IDE 交付硬耦合和低频外部适配。

## 2. 进程与入口拓扑

legacy 0.1.0 有四类入口，它们不是同一层工具。

```text
bin/cli.ts
  -> 直接命令: setup / coldstart / rescan / guard / search / ai / daemon

bin/daemon-server.ts
  -> HTTP daemon
  -> ServiceContainer
  -> jobs / mcp bridge / dashboard / file-change collector

bin/codex-mcp.ts
  -> Codex stdio MCP shim
  -> local status/init/job tools
  -> lazy daemon bridge for heavy tools

lib/external/mcp/McpServer.ts
  -> 通用 IDE MCP server
  -> core alembic_* tools
  -> Gateway governance
```

### 2.1 CLI

`bin/cli.ts` 是 legacy 的本地命令总入口，包含 setup、codex、ai、daemon、coldstart、rescan、evolve-check、guard、panorama、server、ui 等命令。

其中 `coldstart` 和 `rescan` 是重要事实：

- `coldstart` 会初始化 `Bootstrap` 和 `ServiceContainer`，再动态加载 `lib/external/mcp/handlers/bootstrap-internal.ts`，调用 `bootstrapKnowledge()`。
- `rescan` 会动态加载 `lib/external/mcp/handlers/rescan-internal.ts`，调用 `rescanInternal()`。
- 加 `--wait` 时会轮询 `bootstrapTaskManager.getSessionStatus()`，否则任务可以异步执行。

这说明 legacy 的 CLI 不是简单 wrapper，而是可以直接进入内部工作流。

### 2.2 Daemon

`bin/daemon-server.ts` 是长驻运行时入口。它做的事情包括：

- 设置 `ALEMBIC_API_SERVER=1`、`ALEMBIC_DAEMON_MODE=1`。
- 解析项目根目录、daemon host/port/token/state path。
- `Bootstrap.configurePathGuard(projectRoot)` 后执行 `new Bootstrap().initialize()`。
- 初始化全局 `ServiceContainer`，注入 db、audit、gateway、constitution、config、skillHooks、projectRoot、workspaceResolver。
- 启动 `HttpServer`。
- 启动 `DaemonFileChangeCollector` 作为 VSCode extension 不在线时的 fallback。
- 写 daemon ready state，包括 token、url、dashboardUrl、db schema。
- 启动和关闭时调用 `markInterruptedDaemonJobs`，把未完成任务标记为中断失败。

迁移含义：新 Alembic 的 daemon 必须保留“可恢复 job、token bridge、运行时状态文件、启动恢复中断任务”的语义，但不需要继承旧 Dashboard 和所有 HTTP route。

### 2.3 Codex MCP shim

`bin/codex-mcp.ts` 是 Codex 插件专用轻入口：

- 设置 `ALEMBIC_MCP_MODE=1`、`ALEMBIC_CODEX_MCP_MODE=1`、`ALEMBIC_MCP_TIER=agent`。
- 启动 `startCodexMcpServer()`。
- Codex MCP 初始只列出本地工具。
- 真正重工具通过 daemon bridge 延迟启动或调用。

这是新 Alembic Codex 插件应该继承的关键形态：Codex stdio 端不能跑长任务，必须把 bootstrap/rescan 投递给 daemon job。

### 2.4 通用 MCP server

`lib/external/mcp/McpServer.ts` 是 IDE agent 通用 MCP server：

- MCP 模式必须有 `ALEMBIC_PROJECT_DIR`，避免多根工作区下 `process.cwd()` 不可靠。
- 非 Ghost 模式下会拒绝在排除项目里创建运行时数据。
- 初始化 `Bootstrap` 和 `ServiceContainer`。
- 按 `ALEMBIC_MCP_TIER` 过滤工具。
- 工具调用进入 `LightweightRouter` 和 `McpToolAdapter`。
- 写操作通过 `TOOL_GATEWAY_MAP` 映射 Gateway governance。
- 会追踪 session、工具调用、intent 行为和 search/files drift。

迁移含义：通用 MCP 的 governance、actor/source/surface、工具 tier 思想可以保留；旧 handler envelope 和过多工具暴露不应原样迁。

## 3. Bootstrap 与依赖注入根

### 3.1 Bootstrap 初始化顺序

核心文件：`lib/bootstrap.ts`。

真实初始化顺序：

1. 读取 `WorkspaceSettingsStore`。
2. 确保 `PathGuard` 已配置。MCP 模式要求 `ALEMBIC_PROJECT_DIR`。
3. 初始化 `WorkspaceResolver`，Ghost 模式会把 dataRoot 加入允许写入边界。
4. 加载 Config。
5. 初始化 Logger，Ghost 模式日志路径会重定向。
6. 连接 Database 并跑迁移。
7. 初始化 Constitution。
8. 初始化 ConstitutionValidator、PermissionManager、AuditStore、AuditLogger、SkillHooks。
9. 初始化 Gateway。

这说明 legacy 的底层边界很清晰：先确定路径和 workspace，再开数据库和治理组件，最后才进入服务容器。

### 3.2 ServiceContainer 模块

核心文件：`lib/injection/ServiceContainer.ts`、`lib/injection/ServiceMap.ts` 和 `lib/injection/modules/*`。

`ServiceContainer.initialize()` 的职责：

- 接收 Bootstrap 注入的 db、auditLogger、gateway、constitution、config、skillHooks、projectRoot、workspaceResolver。
- 初始化 AiModule。
- 初始化 AppModule 的 recipe extractor。
- 注册 Infra、Signal、App、Knowledge、Vector、Guard、Agent、Ai、Panorama 模块。
- 初始化 enhancement registry、vector service、knowledge services。
- MCP/API 模式下启动 CacheCoordinator。

模块关系：

| 模块 | 主要服务 |
| --- | --- |
| InfraModule | database、logger、eventBus、jobStore、bootstrapTaskManager、repositories、WriteZone、ReportStore |
| AiModule | AiFactory、AiProviderManager、dedicated embed provider、token usage |
| KnowledgeModule | KnowledgeService、RecipeProductionGateway、KnowledgeGraph、CodeEntityGraph、SearchEngine、VectorStore、EvolutionGateway、SourceRef、FileChange |
| VectorModule | ContextualEnricher、VectorService、IndexingPipeline、HybridRetriever |
| GuardModule | GuardService、GuardCheckEngine、RuleLearner、ReverseGuard、CoverageAnalyzer |
| AgentModule | 内部 ToolRouter、V2 tool context、AgentService、ProfileService、WorkflowRegistry、ToolForge |
| PanoramaModule | ModuleDiscoverer、RoleRefiner、CouplingAnalyzer、LayerInferrer、DimensionAnalyzer、PanoramaService |
| SignalModule | SignalBus、HitRecorder、SignalBridge、SignalTraceWriter、SignalAggregator |

迁移含义：新 Alembic 可以不用旧 ServiceContainer 形态，但必须保留依赖分层顺序，尤其是 `WorkspaceResolver -> DB -> Knowledge/Search/Vector -> AgentRuntime` 的依赖方向。

## 4. 工具层必须拆成两套

legacy 中存在两套工具体系。迁移时必须清晰分开，不能继续混在一个 `tool` 模块里。

### 4.1 外部 MCP/Codex 工具

核心文件：

- `lib/external/mcp/tools.ts`
- `lib/external/mcp/McpServer.ts`
- `lib/external/mcp/CodexMcpServer.ts`
- `lib/http/routes/mcp.ts`

外部工具是给 Codex、Cursor、VSCode Copilot 等外部 AI IDE 调的工具，名称是 `alembic_*` 或 `alembic_codex_*`。

Codex local tools：

- `alembic_codex_status`
- `alembic_codex_diagnostics`
- `alembic_codex_init`
- `alembic_codex_dashboard`
- `alembic_codex_bootstrap`
- `alembic_codex_rescan`
- `alembic_codex_job`
- `alembic_codex_stop`
- `alembic_codex_cleanup`

core MCP tools 包括：

- `alembic_health`
- `alembic_search`
- `alembic_knowledge`
- `alembic_structure`
- `alembic_graph`
- `alembic_call_context`
- `alembic_guard`
- `alembic_submit_knowledge`
- `alembic_skill`
- `alembic_bootstrap`
- `alembic_rescan`
- `alembic_evolve`
- `alembic_consolidate`
- `alembic_dimension_complete`
- `alembic_wiki`
- `alembic_panorama`
- `alembic_task`
- `alembic_enrich_candidates`
- `alembic_knowledge_lifecycle`

外部工具特点：

- 以 MCP schema 暴露给外部 Agent。
- 通过 `TOOL_GATEWAY_MAP` 做写操作治理。
- Codex MCP 在 knowledge 未初始化前会隐藏项目知识工具，只保留 status/diagnostics/init/bootstrap/job。
- Codex 重工具经 daemon bridge 调用 `/api/v1/mcp/call`，使用 `x-alembic-daemon-token` 做本地鉴权。

### 4.2 内部 Agent tools

核心文件：

- `lib/tools/v2/registry.ts`
- `lib/tools/v2/router.ts`
- `lib/tools/v2/adapter/ToolContextFactory.ts`
- `lib/tools/v2/adapter/V2ToolRouterAdapter.ts`
- `lib/tools/v2/handlers/*`

内部工具只给 `AgentRuntime` 用，不应暴露给 Codex public MCP。

内部工具列表：

| 工具 | action | 作用 |
| --- | --- | --- |
| `code` | `search/read/outline/structure/write` | 代码搜索、阅读、AST 轮廓、目录结构、受控写文件 |
| `terminal` | `exec` | 通过 sandbox 执行命令，网络默认 none，文件系统 project-write |
| `knowledge` | `search/submit/detail/manage` | 搜索知识、提交候选、查看详情、生命周期和 evolution 决策 |
| `graph` | `overview/query` | 项目 AST/实体/调用关系查询 |
| `memory` | `save/recall/note_finding/get_previous_evidence` | Agent 工作记忆、跨维度证据、QualityGate 证据 |
| `meta` | `tools/plan/review` | 工具 schema 查询、计划记录、自审 |

内部工具的执行链：

```text
AgentRuntime
  -> ToolExecutionPipeline
  -> ToolRouterContract
  -> V2ToolRouterAdapter
  -> ToolRouterV2
  -> TOOL_REGISTRY handler
  -> ToolContextFactory 注入的服务
```

`ToolRouterV2.execute()` 做：

1. 工具和 action 存在性校验。
2. 参数 required/enum 校验。
3. capability allowedTools 权限检查。
4. 并发控制：parallel、single、exclusive。
5. handler 分发。
6. 输出 token 截断。

`ToolContextFactory` 注入：

- projectGraph、codeEntityGraph、searchEngine。
- recipeProductionGateway、knowledgeRepository、evolutionGateway。
- astAnalyzer、safetyPolicy、sandboxExecutor。
- deltaCache、searchCache、compressor、sessionStore。
- tokenBudget、abortSignal、memoryCoordinator、runtime。

迁移结论：

- 新 Alembic 需要单独的 `agent-tools` 模块承载这些内部工具。
- 外部 `alembic_*` 工具属于 `surface-tools` 或 `codex-tools`。
- 两者不能共用旧兼容 envelope。
- 内部 `knowledge.submit` 必须走 RecipeProductionGateway，不允许直接写 active Recipe。
- 外部 public submit 也可以走相同 domain gateway，但入口 schema、权限和 lifecycle 语义必须单独定义。

## 5. AgentRuntime 实现关系

核心文件：

- `lib/agent/runtime/AgentRuntime.ts`
- `lib/agent/runtime/ToolExecutionPipeline.ts`
- `lib/agent/service/AgentService.ts`
- `lib/agent/service/AgentRuntimeBuilder.ts`
- `lib/agent/coordination/AgentRunCoordinator.ts`
- `lib/agent/profiles/presets.ts`
- `lib/agent/profiles/definitions/bootstrap.profile.ts`
- `lib/agent/profiles/AgentStageFactoryRegistry.ts`

### 5.1 AgentService 到 Runtime

链路：

```text
AgentService.run(input)
  -> validate input
  -> AgentProfileCompiler.compile()
  -> 如果 profile 可并发，交给 AgentRunCoordinator
  -> AgentRuntimeBuilder.build()
  -> AgentRuntime.execute()
```

`AgentService` 会组装：

- profile/preset。
- fileCache。
- `AgentMessage`。
- runtime options：systemRunContext、strategyContext、budgetOverride、toolChoiceOverride、contextWindow、trace、memoryCoordinator、sharedState、source。

### 5.2 AgentRuntime ReAct loop

`AgentRuntime.reactLoop()` 的主要阶段：

```text
#initLoop
  -> resolve capabilities
  -> build system prompt
  -> collect allowed tools
  -> capabilityCatalog.toMixedSchemas()
  -> BudgetController / ExitController / LoopContext

#prepareIteration
  -> progress
  -> ExplorationTracker nudge
  -> context compaction
  -> token precheck
  -> dynamic context

#callLLM
  -> LLMGateway 或 aiProvider.chatWithTools
  -> toolChoice 兼容 DeepSeek/Gemini
  -> token usage
  -> empty response retry
  -> AI error recovery

#processToolCalls
  -> 每轮最多 8 个 tool calls
  -> ToolExecutionPipeline
  -> tool result limit
  -> ExplorationTracker phase transitions
  -> capability hooks

#processTextResponse / #finalize
  -> tracker endRound
  -> forced summary
  -> diagnostics/state/result
```

### 5.3 ToolExecutionPipeline

中间件顺序：

1. `allowlistGate`：阻止 hallucinated tool id。
2. `evolutionDecisionGate`：evolution retry 阶段只允许 `knowledge.manage` 的 evolve/deprecate/skip_evolution。
3. `observationRecord`。
4. `trackerSignal`。
5. `traceRecord`。
6. `submitDedup`。

执行 request 会带上 runtime bag：

- agentId、preset、iteration、policy。
- memory、diagnostics、safetyPolicy。
- fileCache、dataRoot、lang、aiProvider。
- sharedState、dimensionMeta、projectLanguage。
- submittedTitles/submittedTriggers/submittedPatterns。
- bootstrapDedup、dimensionScopeId。

### 5.4 profile、preset 与 bootstrap 分层

重要 profile：

- `bootstrap-session`：basePreset 是 `insight`，有 tiered concurrency，partitioner 是 `bootstrapSessionDimensions`，childProfile 是 `bootstrap-dimension`。
- `bootstrap-dimension`：basePreset 是 `insight`，stage factory 是 `bootstrapDimensionPipeline`。

`bootstrapDimensionPipeline` 的逻辑：

- 从 `PRESETS.insight` 继承 Analyze、QualityGate、Produce、RejectionGate。
- 根据 terminal policy hints 限制工具。
- rescan 且已有 Recipe 时，前置插入 evolution stages。
- 无候选需求时，只跑 analyze。
- 标准路径：analyze -> quality gate -> produce -> rejection gate。
- rescan 路径：evolve -> evolution gate -> analyze -> quality gate -> produce -> rejection gate。

迁移含义：AgentRuntime 不只是 LLM loop。必须连同 profile compiler、stage factory、capability allowedTools、ToolExecutionPipeline、ExplorationTracker、BudgetController 一起迁移，否则上层冷启动和增量链路会退化。

## 6. ProjectIntelligence 底层扫描链路

核心文件：

- `lib/workflows/capabilities/project-intelligence/ProjectIntelligenceCapability.ts`
- `ProjectIntelligencePreparation.ts`
- `ProjectIntelligenceRunner.ts`
- `ProjectIntelligenceIncrementalPlanner.ts`

### 6.1 统一 Phase 1 到 Phase 4

内部冷启动和增量 rescan 都依赖同一套 `ProjectIntelligenceCapability.run()`。

```text
ProjectIntelligenceCapability.run()
  -> prepareProjectAnalysisRun()
  -> runAllPhases()
```

`runAllPhases()` 的真实阶段：

1. Phase 1：文件收集。
   - DiscovererRegistry 检测项目类型。
   - 读取 targets。
   - 收集文件，跳过 Alembic 自己生成的文件。
   - 统计语言。
2. 增量计划：
   - 如果启用 incremental，基于 allFiles 和 dimensions 调 `FileDiffPlanner.evaluate()`。
3. Phase 1.5：AST 分析。
   - tree-sitter 分析项目。
   - 支持 grammar install。
   - 支持增强包预处理，例如 SFC。
4. Phase 1.6：CodeEntityGraph。
   - 从 AST 物化实体图。
5. Phase 1.7：CallGraph。
   - `CallGraphAnalyzer` 分析和物化调用图。
6. Phase 2：依赖图。
   - discoverer 解析 dependency graph。
   - 写入 module depends_on edges。
7. Phase 2.1：模块实体物化。
8. Phase 2.2：Panorama。
   - `panoramaService.invalidate()`、`getResult()`、`getOverview()`。
9. Phase 3：Guard audit。
   - `GuardCheckEngine.auditFiles()`。
   - 写 guard violations。
10. Phase 4：维度和增强包。
   - `resolveActiveDimensions()`。
   - enhancement packs 注入 extra dimensions/rules/patterns。
   - Guard 可再次审计。
   - LanguageService.detectProfile。
   - DimensionCopy.applyMulti。

### 6.2 输出对象

ProjectIntelligence 输出包括：

- allFiles、langStats、primaryLang。
- discoverer、allTargets、targetsSummary。
- astProjectSummary、codeEntityResult、callGraphResult、depGraphData。
- guardAudit、activeDimensions、enhancement 信息。
- localPackageModules、warnings、report。
- incrementalPlan、panoramaResult、isEmpty。

迁移含义：这是冷启动、rescan、structure、guard、panorama、agent evidence 的共同底座，必须比上层工具先迁。

## 7. 冷启动主链

legacy 0.1.0 的 handler 文件已经只是兼容 re-export：

- `lib/external/mcp/handlers/bootstrap-internal.ts` -> `lib/workflows/cold-start/internal/InternalColdStartWorkflow.ts`
- `lib/external/mcp/handlers/bootstrap-external.ts` -> `lib/workflows/cold-start/external/ExternalColdStartWorkflow.ts`

这说明实际主线已经在 `lib/workflows/cold-start`。

### 7.1 外部 Agent 冷启动

核心文件：`ExternalColdStartWorkflow.ts`。

链路：

```text
bootstrapExternal
  -> runFullResetPolicy
  -> ProjectIntelligenceCapability.run()
  -> build ProjectSnapshot
  -> createExternalWorkflowSession
  -> buildExternalMissionBriefing
  -> 返回 Mission Briefing
```

特点：

- 不启动内部 AI pipeline。
- 面向外部 IDE Agent。
- 返回 project snapshot、dimension tasks、提交说明、执行计划。
- 外部 Agent 后续通过 `submit_knowledge` 和 `dimension_complete` 完成。

迁移含义：新 Alembic 如果先做 Codex 插件，可以保留 external briefing 思想，但不用恢复旧 external handler 兼容层。

### 7.2 内部 Agent 冷启动

核心文件：`InternalColdStartWorkflow.ts`。

链路：

```text
bootstrapKnowledge
  -> runFullResetPolicy
  -> ProjectIntelligenceCapability.run()
  -> build ProjectSnapshot / report / targetFileMap
  -> selectColdStartDimensions
  -> cacheProjectAnalysisSession
  -> startInternalDimensionExecutionSession
  -> dispatchInternalDimensionExecution
  -> SkillHooks.onBootstrapComplete
  -> 返回 skeleton / async session
```

特点：

- 冷启动会 full reset。
- 前 4 个扫描阶段同步完成。
- 内部维度填充可以异步 fire-and-forget。
- `skipAsyncFill` 可以只返回任务骨架。
- SkillHooks 是非阻塞后置扩展。

迁移含义：新 Alembic 要保留“同步扫描骨架 + 后台 Agent 填充”的体验，Codex MCP 只应返回 job id 和报告引用。

## 8. 增量 rescan 主链

rescan handler 同样只是兼容 re-export：

- `lib/external/mcp/handlers/rescan-internal.ts` -> `lib/workflows/knowledge-rescan/internal/InternalKnowledgeRescanWorkflow.ts`
- `lib/external/mcp/handlers/rescan-external.ts` -> `lib/workflows/knowledge-rescan/external/ExternalKnowledgeRescanWorkflow.ts`

### 8.1 外部 Agent rescan

核心文件：`ExternalKnowledgeRescanWorkflow.ts`。

链路：

```text
rescanExternal
  -> snapshot existing recipes
  -> clean by policy
  -> syncKnowledgeStoreForRescan
  -> ProjectIntelligenceCapability.run()
  -> auditRecipesForRescan
  -> buildKnowledgeRescanPlan
  -> select requested dimensions
  -> buildRescanPrescreen
  -> projectExternalRescanEvidencePlan
  -> createExternalWorkflowSession
  -> buildExternalMissionBriefing
```

外部 Agent briefing 里会包含：

- 旧 Recipe 内容和 audit hint。
- evolution 指南。
- gap-fill 任务。
- 每个维度的 evidence plan。

### 8.2 内部 Agent rescan

核心文件：`InternalKnowledgeRescanWorkflow.ts`。

链路：

```text
rescanInternal
  -> snapshot / clean
  -> syncKnowledgeStoreForRescan
  -> SourceRefReconciler.reconcile()
  -> SourceRefReconciler.repairRenames()
  -> SourceRefReconciler.applyRepairs()
  -> ProjectIntelligenceCapability.run()
  -> RecipeImpactPlanner.plan(diff)
  -> submitRescanImpactDecisions()
  -> runEvolutionAudit(uncovered candidates)
  -> auditRecipesForRescan
  -> buildKnowledgeRescanPlan
  -> buildRescanPrescreen
  -> projectInternalRescanGapPlan
  -> cacheProjectAnalysisSession
  -> startInternalDimensionExecutionSession
  -> dispatchInternalDimensionExecution
  -> SkillHooks.onRescanComplete
```

特点：

- 先处理旧知识影响，再补 gap。
- 高置信 impact 可以直接进 EvolutionGateway。
- 不确定 impact 交给 Evolution Agent。
- gap plan 会决定哪些维度需要 producer。
- 如果没有 gap 或 skip async，会保存 diff snapshot 并结束。

迁移含义：这条链是 mature 的核心资产，应完整迁移。不能把 rescan 简化成“重新扫一遍源码”。

## 9. 内部维度执行链

核心文件：

- `lib/workflows/capabilities/execution/InternalDimensionExecutionWorkflow.ts`
- `InternalDimensionExecutionPipeline.ts`
- `BootstrapRuntimeInitializer.ts`
- `BootstrapDimensionRuntimeBuilder.ts`
- `BootstrapInputBuilders.ts`
- `InternalDimensionFillSessionRunner.ts`
- `InternalDimensionFillFinalizer.ts`

### 9.1 执行流程

```text
startInternalDimensionExecutionSession
  -> dispatchInternalDimensionExecution
  -> prepare run
  -> initializeBootstrapRuntime
  -> runInternalDimensionAgentSession
  -> finalizeInternalDimensionFill
```

### 9.2 Runtime 初始化

`initializeBootstrapRuntime` 会构造：

- ProjectGraph。
- fileCache。
- projectInfo。
- DimensionContext。
- sessionStore。
- PersistentMemory。
- CodeEntityGraph。
- MemoryCoordinator。

### 9.3 Dimension run input

`BootstrapDimensionRuntimeBuilder` 会为每个维度构造：

- dimension config。
- existingRecipes。
- rescan execution decision。
- needsCandidates。
- `SystemRunContext`。
- `ContextWindow`。
- `ExplorationTracker`。
- memoryCoordinator。
- sharedState。
- panorama、evidenceStarters、rescanContext、projectOverview。

### 9.4 并发和准入

`InternalDimensionFillSessionRunner`：

- 默认并发来自 `ALEMBIC_BOOTSTRAP_CONCURRENCY`，默认 3。
- 支持 `ALEMBIC_PARALLEL_BOOTSTRAP`。
- 使用 `resolveBootstrapDimensionAdmissions` 做 checkpoint/incremental 准入。
- 父 profile 是 `bootstrap-session`，子输入由 child factories 生成。
- 执行后消费 child results，记录 candidates、stats、sessionStore、tier reflection。

### 9.5 Finalizer

`InternalDimensionFillFinalizer`：

- 清理 bootstrapDedup。
- `consumeBootstrapSkills` 生成 skills。
- 消费候选关系。
- rescan 模式跳过 delivery/wiki/semantic memory，保持 pipeline isolation。
- bootstrap 模式调用 `runWorkflowCompletionFinalizer`，可做 delivery、wiki、panorama、semantic memory。
- `persistWorkflowResult` 保存工作流结果。

迁移含义：内部 Agent 执行不是单个 Agent 循环，它包含 runtime 初始化、维度上下文、准入、并发、结果消费和 finalizer。新 Alembic 迁移 AgentRuntime 后必须把这层编排补上。

## 10. Knowledge 与 Recipe 生命周期

核心文件：

- `lib/domain/knowledge/KnowledgeEntry.ts`
- `lib/service/knowledge/KnowledgeService.ts`
- `lib/service/knowledge/RecipeProductionGateway.ts`
- `lib/service/knowledge/KnowledgeFileWriter.ts`
- `lib/repository/knowledge/KnowledgeRepository.impl.ts`
- `lib/service/knowledge/SourceRefReconciler.ts`

### 10.1 KnowledgeEntry 本体

`KnowledgeEntry` 是统一知识实体，核心字段包括：

- 标识：id、title、description。
- lifecycle：pending、staging、active、evolving、decaying、deprecated。
- 分类：language、dimensionId、category、knowledgeType、kind、tags。
- Cursor/Agent 消费字段：trigger、topicHint、whenClause、doClause、dontClause、coreCode、usageGuide。
- 值对象：content、relations、constraints、reasoning、quality、stats。
- 来源：source、sourceFile、sourceCandidateId。
- AI 和 review 字段。

它有 publish、stage、evolve、decay、restore、deprecate、reactivate 等领域方法，并通过 `isValidTransition` 限制生命周期转换。

### 10.2 file-first 存储

`KnowledgeFileWriter` 明确写着：`.md 文件 = 完整唯一数据源，DB = 索引缓存`。

落盘规则：

- candidate 阶段写 `candidates/`。
- active/deprecated 写 `recipes/`。
- bucket 使用 `recipeStorageBucket(entry)`。
- 文件名优先 trigger，其次 title slug，最后 id 前 8 位。
- Markdown 是 YAML frontmatter 加 body。
- frontmatter 写标量字段、数组字段和值对象 JSON。
- `_contentHash` 用 SHA-256 的 16 位 hash。
- lifecycle 或 category 变更时会清理旧文件，但有安全保护：只允许清理 candidates/recipes 目录内的普通 `.md` 文件，避免误删源码。

迁移含义：新 Alembic 应继承 file-first 的原则，尤其是 `sourceFile` 与 DB 索引缓存的关系。

### 10.3 RecipeProductionGateway

`RecipeProductionGateway` 是所有 Recipe 创建的统一入口。

调用来源：

- `agent-tool`
- `mcp-external`
- `ide-agent`
- `batch-import`

create pipeline：

```text
Schema Validation
  -> Bootstrap session-level dedup
  -> Similarity Check
  -> Consolidation Scan
  -> KnowledgeService.create()
  -> Quality Scoring
  -> Supersede Proposal
```

重要细节：

- 普通 agent/mcp/ide 提交通道不允许跳过相似度检测。
- 只有 `batch-import` 可以 skipSimilarityCheck。
- consolidation 可以把候选转成 update/deprecate/reorganize proposal。
- pending semantic review 会记录到结果里。
- 创建成功后会注册到 bootstrapDedup，防止跨维度重复。
- quality scoring 是 best effort，不阻塞创建。
- supersedes 优先通过 EvolutionGateway 提交 deprecate，降级才直接写 ProposalRepository。

### 10.4 内部 knowledge tool

`lib/tools/v2/handlers/knowledge.ts` 是内部 Agent 使用入口。

`knowledge.submit` 的关键行为：

- 校验 title、description、content.markdown、content.rationale、kind、trigger、whenClause、doClause、reasoning.sources。
- 自动剥离项目名前缀。
- 从 dimensionMeta 注入 dimensionId、allowedKnowledgeTypes、tags。
- source 在 bootstrap 时设为 `bootstrap`，否则设为 `agent`。
- 通过 `recipeGateway.create({ source: 'agent-tool' })` 提交。
- 提交成功后写 sessionStore。
- duplicate 返回 `duplicate_blocked`。
- validation/consolidation 失败返回明确错误。

`knowledge.manage` 支持：

- approve、reject、publish、update、score、validate。
- evolve、deprecate、skip_evolution 会走 EvolutionGateway。
- evolution source 会从 runtime sharedState 中解析，默认 `ide-agent`。

迁移含义：内部 Agent 使用的 knowledge tool 功能已经完整，迁移时应全量保留，不要只迁 submit/search。

## 11. SourceRef、文件变化与 Evolution

核心文件：

- `lib/service/knowledge/SourceRefReconciler.ts`
- `lib/service/evolution/RecipeImpactPlanner.ts`
- `lib/service/evolution/FileChangeHandler.ts`
- `lib/service/evolution/DaemonFileChangeCollector.ts`
- `lib/service/FileChangeDispatcher.ts`

### 11.1 SourceRefReconciler

职责：

- 从 `knowledge_entries.reasoning.sources` 填充 `recipe_source_refs` 桥接表。
- 验证 source path 是否存在。
- 24 小时 TTL 内可跳过重复验证。
- 标记 active、stale、renamed。
- 通过 `git log --diff-filter=R --name-status` 检测 rename。
- `applyRepairs()` 会调用 `rewriteRecipePaths()`，把旧路径写回 DB 字段和 `.md` 文件。
- stale 会通过 SignalBus 发 quality signal。

### 11.2 RecipeImpactPlanner

这是 rescan 批量影响分析器，输入来自 file hash diff，不是 git diff。

影响类型：

- `source-deleted`：所有引用来源都删除。
- `source-deleted-partial`：部分来源删除。
- `source-modified-pattern`：文件变化触及 Recipe 关键 token。
- `source-missing`：SourceRef stale。

阶段：

1. deleted 文件：查 source refs，判断是否还有 active ref。
2. modified 文件：查关联 Recipe，提取 Recipe tokens，调用 `assessImpactUnified()`。
3. stale refs：补充 source-missing 候选。
4. 合并候选，按 reason priority、impactScore、affectedFiles、matchedTokens 汇总。

高置信决策：

- `source-modified-pattern` 转成 update。
- `source-deleted` 转成 deprecate。
- 其他情况交给 Evolution Agent。

### 11.3 FileChangeHandler

这是实时文件变化驱动的 evolution 链路。

事件类型：

- renamed：修复 sourceRef 路径，调用 ContentPatcher 和 `rewriteRecipePaths()`。
- deleted：如果 Recipe 没有其他 active ref，走 EvolutionGateway deprecate。
- modified：diff-based 内容影响评估，pattern 级别会创建 update proposal。
- created：默认跳过。

它不做全量扫描，只处理传入事件。

### 11.4 DaemonFileChangeCollector

这是 Codex/plugin fallback 文件变化收集器。

策略：

- 如果 VSCode extension heartbeat 新鲜，daemon 只更新 baseline，不抢事件。
- 否则周期性采样 git worktree。
- 采集 unstaged、staged、untracked。
- 忽略 `.asd/`、`.git/`、`node_modules/`。
- 最多每次派发 500 个事件。

迁移含义：新 Alembic 要保留 SourceRef 和 Recipe impact 的成熟逻辑。VSCode extension fallback 可以后置，但 daemon 侧的 git worktree collector 对 Codex 插件很有价值。

## 12. Search、Vector、Guard、Panorama 消费层

### 12.1 SearchEngine

核心文件：`lib/service/search/SearchEngine.ts`。

搜索模式：

- keyword：SQL LIKE，trigger/title/description/content/tags。
- weighted/bm25：FieldWeightedScorer。
- semantic：VectorService。
- auto：先 weighted，计算 confidence；高 confidence 跳过 embed，低 confidence 调 hybrid search。

排序管线：

```text
recall
  -> optional CrossEncoder
  -> CoarseRanker
  -> MultiSignalRanker
  -> contextBoost
```

特点：

- sessionHistory 存在时不缓存。
- cache 默认 5 分钟。
- 搜索命中后通过 SignalBus 发 search signal。
- semantic 失败会优雅降级到 weighted。

### 12.2 VectorService

核心文件：`lib/service/vector/VectorService.ts`。

职责：

- 全量向量索引构建。
- 增量更新接口。
- 清空和健康检查。
- 语义搜索。
- hybrid search，Dense + Sparse RRF 融合。
- CRUD 事件自动同步。

关键点：

- 没有 embedProvider 时 graceful degrade。
- embed 连续失败 3 次后打开 circuit breaker，60 秒内跳过 embed。
- hybridSearch 如果 embed 失败，会 sparse-only 降级。
- SyncCoordinator 可绑定 EventBus，知识 CRUD 后自动同步向量。

### 12.3 Guard

Guard 由 `GuardModule` 注册：

- GuardService。
- GuardCheckEngine。
- ExclusionManager。
- RuleLearner。
- ViolationsStore。
- ComplianceReporter。
- GuardFeedbackLoop。
- ReverseGuard。
- CoverageAnalyzer。

Guard 在 ProjectIntelligence Phase 3 中审计文件，也可以被外部 `alembic_guard` 调用。

KnowledgeEntry 中 `getGuardRules()` 会把 active rule 和 boundary constraint 转为 GuardCheckEngine 可消费规则。

### 12.4 Panorama

核心文件：`lib/service/panorama/PanoramaService.ts`。

operation：

- overview：项目骨架、层级、覆盖率、health radar。
- module：单模块详情、邻居、文件组、Recipe 匹配、摘要。
- gaps：知识空白。
- health：覆盖率、耦合度、循环、gap 综合健康度。

依赖：

- ModuleDiscoverer。
- RoleRefiner。
- CouplingAnalyzer。
- LayerInferrer。
- DimensionAnalyzer。
- PanoramaAggregator。
- PanoramaScanner。

Panorama 会订阅 guard/lifecycle/usage 信号来失效缓存。

迁移含义：Search/Vector/Guard/Panorama 是 AgentRuntime 和 public tools 的共同消费层，应跟 Knowledge/ProjectIntelligence 一起迁移，而不是作为 UI 附属功能。

## 13. Delivery、Wiki 与 Completion Finalizer

### 13.1 CompletionFinalizer

核心文件：`lib/workflows/capabilities/completion/WorkflowCompletionFinalizer.ts`。

步骤：

```text
delivery
  -> runCursorDelivery
  -> verifyDelivery
panorama
  -> refreshPanorama
wiki
  -> schedule generateWiki
semantic memory
  -> immediate 或 scheduled consolidateSemanticMemory
```

支持 `shouldAbort()`，并且 wiki 和 semantic memory 默认可以异步调度。

### 13.2 CursorDeliveryPipeline

核心文件：`lib/service/delivery/CursorDeliveryPipeline.ts`。

6 个交付通道：

- Channel A：`.cursor/rules/alembic-project-rules.mdc` alwaysApply rules。
- Channel B：`.cursor/rules/alembic-patterns-{topic}.mdc` smart rules。
- Channel C：`.cursor/skills/` project skills。
- Channel D：`.cursor/skills/alembic-devdocs/` dev documents。
- Channel F：`AGENTS.md`、`CLAUDE.md`、`.github/copilot-instructions.md`。
- Mirror：`.qoder/`、`.trae/`，但 legacy 0.1.0 已不自动执行，只由 `alembic mirror` 触发。

Delivery 会读取 active、staging、evolving 和高置信 pending 知识，过滤 mock 条目，按 rule/pattern/fact/dev-document 分类，压缩、排序、写入 IDE 可消费物料。

### 13.3 WikiGenerator

核心文件：`lib/service/wiki/WikiGenerator.ts`。

V3 设计：

- 数据收集：Scan、AST、SPM、KB。
- 主题发现：基于数据丰富度决定文章。
- AI 优先写完整文章。
- 内容不足则跳过。
- AI 不可用时模板降级。

阶段：

1. init。
2. scan。
3. ast-analyze。
4. spm-parse。
5. knowledge。
6. generate。
7. ai-compose。
8. sync-docs。
9. dedup。
10. finalize。

迁移含义：Delivery/Wiki 是成熟上层能力，但 Codex 插件第一阶段不应默认写 `.cursor/`、`AGENTS.md` 或 wiki。它们应迁成可配置 finalizer adapter。

## 14. Cleanup 与状态保留策略

核心文件：

- `lib/service/cleanup/CleanupService.ts`
- `lib/workflows/capabilities/WorkflowCleanupPolicies.ts`

### 14.1 fullReset

用于冷启动。

特点：

- 垃圾桶模式，移动旧 candidates、recipes、skills、wiki 到 `.asd/.trash/<timestamp>/`。
- 导出 DB 快照 `db-snapshot.jsonl`。
- 清空所有数据表，包括 lifecycle、source refs、evolution proposals、knowledge entries、snapshots、guard、audit、sessions、semantic memories、code entities 等。
- 保留 config、constitution、boxspec、IDE 集成配置。
- 清除 vector index、bootstrap-report、signals logs。
- 下次 fullReset 会清除超过 7 天的 trash。

### 14.2 rescanClean

用于普通 rescan。

保留：

- recipes/。
- active/published/staging/evolving 知识。
- knowledge_edges。
- evolution_proposals。
- bootstrap_snapshots。
- bootstrap_dim_files。
- recipe_source_refs。

清理：

- code_entities、guard_violations、semantic_memories、sessions、audit、remote。
- pending/rejected/deprecated 知识。
- candidates、skills、wiki、vector index、bootstrap-report。

### 14.3 forceRescanClean

用于强制 rescan，但仍保留增量证据：

- 保留 bootstrap_snapshots、bootstrap_dim_files、recipe_source_refs。
- 清理会话态缓存、旧候选和衍生物。

迁移含义：新 Alembic 的冷启动和增量扫描必须保留不同 cleanup policy，不能用一个 rm-all 或 scan-all 覆盖。

## 15. HTTP 与 daemon job

核心文件：

- `lib/http/HttpServer.ts`
- `lib/http/routes/jobs.ts`
- `lib/http/routes/mcp.ts`
- `lib/daemon/DaemonJobRunner.ts`
- `lib/daemon/JobStore.ts`

`HttpServer` 启动时：

- 初始化 cache、perf monitor、ErrorTracker。
- 注册 Gateway actions。
- 装 middleware：helmet、requestLogger、JSON、CORS、roleResolver、gatewayMiddleware、timeouts。
- 注册 `/api/v1` 下的 health、daemon、mcp、jobs、auth、monitoring、guard、task、search、ai、extract、commands、skills、candidates、modules、violations、knowledge、recipes、wiki、remote、panorama、evolution、file-changes、signals、audit、logs。
- 初始化 RealtimeService，把 EventBus 的 lifecycle/signal/guard/audit 桥接到 websocket。

`DaemonJobRunner`：

- `enqueueDaemonJob()` 入队后 microtask 运行。
- bootstrap/rescan 会动态 import internal workflow。
- 如果 workflow 返回 running bootstrapSession，job 保持 running，并订阅 `bootstrap:all-completed` 后再完成。
- daemon restart/shutdown 时 `markInterruptedDaemonJobs` 把 active job 标记失败。

迁移含义：新 Alembic Codex 插件需要 daemon job 和 mcp bridge，不需要完整 HTTP route 面。先保留 health、jobs、mcp bridge、daemon state、logs/report 即可。

## 16. AI Provider 与 embedding

核心文件：

- `lib/external/ai/AiFactory.ts`
- `lib/external/ai/AiProviderManager.ts`
- `lib/injection/modules/AiModule.ts`

Provider 支持：

- google。
- openai。
- deepseek。
- claude。
- ollama。
- mock。

`AiFactory` 会基于环境变量和 key 自动探测 provider，也支持 dedicated embed provider。

`AiProviderManager` 是 provider/embed provider 的单一权威：

- `switchProvider()` 会重建 token tracking。
- 重建 embed fallback。
- 同步 DI singleton。
- 清理 AI-dependent singleton。
- 通知 listeners。

迁移含义：新 Alembic 需要保留 provider manager 的“切换后清理依赖、embed 与 chat 分离、mock/缺失明确退化”的语义。不要把 AI provider 写死到 Codex 单一 provider。

## 17. 核心关系图

```text
Bootstrap
  -> WorkspaceResolver / PathGuard / DB / Gateway / SkillHooks
  -> ServiceContainer
     -> KnowledgeModule
        -> KnowledgeService
        -> RecipeProductionGateway
        -> SearchEngine
        -> VectorService
        -> EvolutionGateway
        -> SourceRefReconciler
     -> AgentModule
        -> V2ToolRouterAdapter
        -> ToolContextFactory
        -> AgentService
     -> GuardModule
     -> PanoramaModule

ColdStart / Rescan workflow
  -> CleanupPolicy
  -> ProjectIntelligence
  -> SourceRef / RecipeImpact
  -> InternalDimensionExecution
     -> AgentService
     -> AgentRuntime
     -> internal tools
     -> RecipeProductionGateway
  -> Finalizer

Codex MCP
  -> local status/init/job tools
  -> daemon job enqueue
  -> daemon mcp bridge
  -> external MCP tools
```

## 18. 迁移顺序建议

用户希望先迁 agent tool 层，再迁 AgentRuntime，再迁冷启动增量工作流。基于真实依赖，推荐顺序如下。

### P0：底层运行时边界

先稳定：

- projectRoot/dataRoot/ghost/write boundary。
- runtime config。
- DB 或 file store 抽象。
- JobStore 和 report store。
- EventBus/SignalBus 可先简化，但事件名和关键通知保留。

### P1：内部 Agent tools 完整迁移

迁移内容：

- registry。
- router。
- ToolContextFactory。
- V2ToolRouterAdapter。
- code/terminal/knowledge/graph/memory/meta handlers。
- capability allowedTools。
- sandbox executor bridge。

验收：

- 每个 tool/action 有独立正例、参数失败、缺依赖失败。
- knowledge.submit 走 RecipeProductionGateway。
- terminal.exec 有 sandbox、timeout、cwd 边界和输出压缩。
- memory.note_finding 能进入 QualityGate 证据。

### P2：知识生产与 lifecycle

迁移内容：

- KnowledgeEntry。
- KnowledgeFileWriter。
- KnowledgeRepository 或新持久层等价能力。
- KnowledgeService。
- RecipeProductionGateway。
- UnifiedValidator、ConfidenceRouter、QualityScorer。
- SourceRefReconciler。
- EvolutionGateway/ProposalExecutor。

验收：

- file-first。
- DB 或 read model 可重建。
- candidate、staging、active、deprecated 生命周期明确。
- source refs 可 reconcile/repair/apply。

### P3：Search/Vector/Guard/Panorama

迁移内容：

- SearchEngine。
- VectorService。
- GuardCheckEngine 和 active rule 消费。
- PanoramaService。
- CodeEntityGraph。

验收：

- 无 embed provider 时 sparse 可用。
- embed 失败有 degraded/circuit breaker。
- knowledge changed 能触发索引失效或同步。
- Guard 可以消费 active Recipe。

### P4：AgentRuntime 完整迁移

迁移内容：

- AgentRuntime。
- ToolExecutionPipeline。
- AgentService、AgentRuntimeBuilder。
- ProfileCompiler、presets、stage factory。
- CapabilityCatalog。
- BudgetController、ContextWindow、ExplorationTracker、MemoryCoordinator。
- AgentRunCoordinator。

验收：

- provider 缺失明确 degraded。
- fake provider 能跑完整 tool loop。
- capability 限制生效。
- evolution retry gate 生效。
- forced summary 和 diagnostics 进入 report。

### P5：ProjectIntelligence

迁移内容：

- file collection。
- incremental planner。
- AST。
- CodeEntityGraph。
- CallGraph。
- dependency graph。
- Guard audit。
- dimensions/enhancements。
- Panorama refresh。

验收：

- fixture 项目可生成稳定 report。
- incremental diff 可复现。
- AST/call graph/dep graph/guard/panorama 任一失败不应吞掉整体 degraded 证据。

### P6：冷启动和增量 workflow

迁移内容：

- CleanupPolicies。
- InternalColdStartWorkflow。
- InternalKnowledgeRescanWorkflow。
- External briefing projector。
- InternalDimensionExecution。
- finalizer port。
- daemon job runner。

验收：

- coldstart：full reset -> scan -> dimension session -> internal agent fill。
- rescan：snapshot -> sourceRef repair -> impact decisions -> evolution audit -> gap-fill。
- Codex MCP 只 enqueue job，不阻塞 stdio。
- job/report 能追踪每个阶段。

### P7：可插拔上层 adapter

后置迁移：

- CursorDeliveryPipeline。
- WikiGenerator。
- dashboard/realtime。
- VSCode extension heartbeat。
- Lark/remote。
- mirror adapters。

默认策略：

- Codex 插件第一阶段禁用这些写入副作用。
- 只保留 finalizer port 和 skipped reason。

## 19. 明确不做或暂缓迁移的内容

建议不做：

- 旧 handler re-export 兼容层。
- 旧 MCP 39 工具历史兼容。
- Dashboard 前端。
- Socket.io 实时 UI 强依赖。
- Lark remote。
- Mac system adapter。
- 旧 ToolForge 和动态工具铸造。
- 自动写 `.cursor/`、`AGENTS.md`、wiki 的默认行为。
- 多 IDE mirror 的默认执行。

建议暂缓：

- VSCode extension 前端。
- Dashboard route 全量迁移。
- remote command。
- lark/remote-exec presets。
- candidate enrichment admin tool。

必须保留但可重写接口：

- Gateway governance。
- Audit。
- SignalBus。
- SkillHooks。
- ReportStore。
- JobStore。

## 20. 新 Alembic 当前缺口判断

按用户目标“让 Alembic 偶尔参考旧项目后，能自己验证修复问题”，真正缺口不是单个文件，而是三条闭环：

1. 内部 Agent tools 闭环：
   - tool registry、router、context、handlers、schema、risk、concurrency、sandbox。
   - 必须先完整，因为 AgentRuntime 依赖它。
2. AgentRuntime 闭环：
   - profiles、capabilities、strategy、tool pipeline、budget、memory、diagnostics。
   - 不能只有 chat loop。
3. coldstart/rescan 闭环：
   - cleanup、ProjectIntelligence、SourceRef、RecipeImpact、dimension execution、finalizer、report、daemon job。
   - 不能只迁 bootstrap 命令。

文档和源码迁移时要以这三条闭环为验收，而不是以“旧目录搬了多少”为验收。

## 21. 验证建议

建议用 progressive chain validation 对应节点验证：

| 节点 | 验证内容 |
| --- | --- |
| T1 | 内部 tool registry 列表和 handler 全 action 可用 |
| T2 | ToolRouterV2 参数、权限、并发、输出截断 |
| T3 | knowledge.submit 走 Gateway，能产生 candidate 文件和索引 |
| T4 | SourceRefReconciler 能从 reasoning.sources 填桥接表并修复 rename |
| T5 | RecipeImpactPlanner 能从 diff 生成 update/deprecate/evolution candidates |
| T6 | AgentRuntime fake provider 能执行 tool loop 和 forced summary |
| T7 | bootstrap-session profile 能分维度执行 |
| T8 | ProjectIntelligence fixture 能产出 AST、call graph、dep graph、guard、panorama |
| T9 | coldstart job 可恢复、可报告、可异步完成 |
| T10 | rescan job 可完成 sourceRef repair、impact decision、gap-fill |
| T11 | Codex MCP status/init/job 不启动重扫描，bootstrap/rescan 只 enqueue |
| T12 | Search/Vector 无 embed provider 有 sparse degraded，有 embed provider 可 hybrid |

## 22. 结论

Alembic-legacy 0.1.0 的成熟核心应被理解为“项目智能 + 知识生命周期 + 内部 AgentRuntime + 冷启动/增量工作流”的组合，而不是一堆旧工具或 UI。

新 Alembic 应完整继承：

- 内部 Agent tools 的全部功能。
- AgentRuntime 和 profile/stage/capability/tool pipeline。
- ProjectIntelligence。
- coldstart/rescan 的 internal/external 双执行模型。
- KnowledgeService、RecipeProductionGateway、file-first lifecycle。
- SourceRef、RecipeImpact、EvolutionGateway。
- Search、Vector、Guard、Panorama 消费层。
- daemon job、report、cleanup policy。

应剪枝或插件化：

- Dashboard/front-end。
- Cursor/多 IDE delivery 默认写入。
- Wiki 默认生成。
- Lark/remote。
- 旧兼容 handler 和多层 envelope。

这样迁移后的 Alembic 才能“脱胎”于 legacy，而不是把旧项目壳子搬过来。
