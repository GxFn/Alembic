# Alembic-legacy 与新 Alembic 核心功能实现对比

> 基线：`Alembic-legacy@229039c9`（`Prepare Alembic Codex 0.1.0`）对比新 `Alembic` 当前主线。  
> 范围：只对比文档和真实核心代码，不以旧 README 为准。Legacy 证据主要来自 `docs-dev/`、`lib/agent`、`lib/tools`、`lib/workflows`、`lib/service`、`lib/external`、`lib/daemon`、`lib/http`、`lib/injection`；新仓库证据主要来自 `docs/`、`lib/agent`、`lib/mainline`、`lib/workflows`、`lib/codex`、`lib/daemon`。

## 1. 总体结论

Alembic-legacy 已经是一个完整的本地知识平台：它以 `ServiceContainer` 为中心，串起数据库、AI Provider、AgentRuntime、V2 Tool、ProjectIntelligence、Knowledge/Recipe 生产、SourceRef 修复、Evolution、Search/Vector、Guard、HTTP/Dashboard/MCP/CLI 等多入口能力。它成熟但耦合面很宽，平台支线很多。

新 Alembic 当前更像“脱胎后的 Codex 插件主线内核”：核心方向已经转成 Codex-first、Ghost dataRoot、public Codex tool 与 internal Agent tool 分离，底层主线以 `MainlineCompileSession`、`ContextIndex`、`SearchIndex`、`ProjectIntelligenceArtifact`、`ScanLifecycleRunner` 和 `AgentRuntime` 为中心。它不是完整复刻 legacy，而是已经抽出了主线骨架，并刻意砍掉旧 Dashboard、通用 HTTP API、前端任务管理、旧兼容层和大量低频支线。

从功能完整度看：

| 功能域 | Legacy 成熟度 | 新 Alembic 现状 | 结论 |
|---|---:|---:|---|
| Codex 插件入口 | 中，已有 `CodexMcpServer` 适配 | 高，已成为主要产品入口 | 新仓库方向正确，public tool 面更干净 |
| daemon durable job | 高，HTTP/Job/状态完整 | 中高，bootstrap/rescan queue 已落地 | 新仓库可用，但 HTTP 面刻意收窄 |
| 内部 Agent tool | 高，V2 全量工具 + sandbox + capability | 中高，新 `resource.action` 工具已成型 | 主要功能已迁，但 sandbox/gateway 注入仍需补强 |
| AgentRuntime | 高，策略、能力、预算、hook、tracker 成熟 | 中高，ReAct 核心迁入，策略层被简化 | 核心循环已迁，上层 profile/strategy/coordinator 仍缺 |
| ProjectIntelligence | 高，Tree-sitter/增强包/依赖/Guard/视图 | 中，轻量结构解析 + artifact/read model | 主线可跑，但语义深度低于 legacy |
| Recipe 生产治理 | 高，Gateway + Validator + Similarity + Consolidation + ConfidenceRouter | 中，SubmissionPolicy + LifecycleStore 已迁核心规则 | 候选创建可用，统一 Gateway/合并提案不完整 |
| SourceRef/RecipeImpact/Evolution | 高，DB 桥接、git rename、FileChangeHandler、EvolutionGateway | 中，SourceRefRepair + RecipeImpact + decision-only 任务 | 增量判断已迁，治理闭环未满 |
| 冷启动/增量扫描链路 | 高，内部/外部/异步维度填充完整 | 中高，scan -> compile -> agent fill 已落地 | 新主线可验证，Project Skill/finalizer 缺 |
| Search/Vector | 高，SearchEngine/VectorService/ContextualEnricher/SyncCoordinator | 中，Sparse hard path + HybridSearch + JSON vector | 基础召回可用，高级语义增强较少 |
| Guard | 高，RuleLearner/ReverseGuard/Coverage/HTTP | 中，mainline guard engine + public/internal guard | 核心检测可用，治理闭环不足 |
| Dashboard/HTTP/UI | 高 | 低，刻意不做前端 | 当前阶段应继续剪枝，不迁移 |

判断：新 Alembic 已经可以开始“自验证、自修复”的主线试跑，但还不能完全脱离 legacy 作为成熟参考。最合理策略是：先让新仓库在自身项目上跑通 `bootstrap/rescan -> prime -> internal agent tool -> Recipe candidate -> guard/search`，同时继续按缺口把 legacy 的成熟治理能力迁入新内核，而不是回到旧平台形态。

## 2. 产品方向与文档方向对比

Legacy 文档里的方向是“本地项目知识平台”。`docs-dev/tool-system/tool-system-v2.md` 把工具系统定义成 V2 全面接管：6 个资源型工具、Capability V2、V2 router、V2 adapter、SandboxExecutorBridge、Capability 迁移、冷启动 E2E、token 压缩与并发控制。`docs-dev/workflows-*` 和 `docs-dev/evolution/*` 则把冷启动、增量扫描、Recipe evolution、SourceRef、ProjectIntelligence、外部 agent 协作都放进一个更完整的平台链路。

新文档方向更明确：`docs/migration/core-direction-and-mainline-chains.md` 把目标收束为两个主链：

1. 内置 AgentRuntime 项目挖掘链：在 Alembic daemon/本地 runtime 内完成扫描、编译、维度补齐、Recipe 候选、Guard、SourceRef 修复。
2. 外部注入 prime 与 Codex 交互同步链：Codex public MCP tool 只读已编译索引，向 Codex 注入当前任务相关的 Recipe、SourceRef 和项目结构上下文。

这个方向和用户要求一致：插件先做 Codex，暂不做前端；Tool 作为新模块，内部 agent tool 与其他层面的 tool 明确分开；底层先迁移，再向上补 agentRuntime 和冷启动/增量工作流。

## 3. 仓库形态与入口面

Legacy 的入口面较大：

- `lib/external/mcp/McpServer.ts`、`lib/external/mcp/CodexMcpServer.ts`：通用 MCP 与 Codex MCP。
- `lib/http/HttpServer.ts` 和大量 `lib/http/routes/*`：Dashboard、知识、Guard、Search、Evolution、Jobs、Wiki、AI、文件变化等 HTTP API。
- `lib/daemon/*`：daemon supervisor、job store、job runner、状态文件。
- `lib/workflows/cold-start/*`、`lib/workflows/knowledge-rescan/*`：内部/外部两套 workflow。
- `lib/injection/*`：服务容器与模块注册。

新 Alembic 的入口面明显收窄：

- `lib/codex/tools.ts`：Codex public MCP 工具的唯一清单。
- `bin/daemon-server.ts`：Codex 插件后台 daemon，执行 bootstrap/rescan durable job。
- `lib/daemon/DaemonHttpBridge.ts`：只暴露 health、job list/status/cancel、bootstrap/rescan enqueue。
- `lib/workflows/*`：只保留主线 scan、internal cold-start、internal rescan、agent fill、report/finalizer。
- `lib/mainline/*`：编译期和运行期读模型内核。

这不是功能退化，而是产品边界重设：新仓库把“给各 AI IDE 插件使用的本地知识内核”作为主目标，不再把 Dashboard 和通用管理 API 当首屏能力。

## 4. Bootstrap/DI/持久化边界

Legacy 使用 `ServiceContainer` 作为全局依赖中心。`lib/injection/ServiceContainer.ts` 会初始化 AI、Infra、Signal、App、Knowledge、Vector、Guard、Agent、Panorama 等模块，还包含多项目防护、AI Provider 热重载、跨进程缓存协调、工具上下文构造等能力。这个容器让 legacy 功能完整，但也带来强耦合：几乎所有 workflow、HTTP route、MCP handler 都可以从容器拿到任意服务。

新 Alembic 没有迁移这个全局容器，而是引入更窄的主线端口：

- `MainlineWorkspacePaths` 定义 projectRoot/dataRoot/runtime/recipes/candidates/reports 等路径。
- `MainlineWriteBoundary` 约束写入必须落在 dataRoot，不污染用户项目。
- `createMainlineWorkflowPersistence()` 组装 `PersistentMainlineContextIndex`、`PersistentMainlineSearchIndex`、`JsonMainlineVectorStore`、`RecipeLifecycleStore`、`MainlineCompileSession`、`ScanLifecycleRunner` 和 internal agent tool dependencies。
- `ContextIndex` 与 `SearchIndex` 以 JSON snapshot/read model 为主，不再默认使用 SQLite。

对比判断：

- 已迁移：路径边界、runtime artifact、context/search/vector snapshot、Recipe lifecycle 写入边界、agent tool dependency 注入。
- 剪枝：全局 DI、HTTP route 共享容器、Dashboard 操作、跨进程 DB cache coordinator。
- 缺口：legacy 容器里部分成熟服务仍未用新端口重建，例如统一 RecipeProductionGateway、EvolutionGateway、Search/Vector 高级增强、Guard 治理服务。

## 5. Tool 分层对比

### 5.1 Legacy Tool 系统

Legacy 最后状态是 V2 工具系统接管，但仍带着旧平台适配：

- `lib/tools/v2/registry.ts`：V2 单一注册表。
- `lib/tools/v2/router.ts`：解析、schema 校验、action 白名单、并发策略。
- `lib/tools/v2/adapter/V2ToolRouterAdapter.ts`：把 V2 工具接到 legacy `ToolRouterContract`。
- `lib/tools/v2/adapter/ToolContextFactory.ts`：包含 `SandboxExecutorBridge`，把 terminal 执行纳入 sandbox policy。
- `lib/tools/catalog/UnifiedToolCatalog.ts`：合并 CapabilityCatalog 与 ToolRegistry，支持 handler、manifest、schema projection、lightweight schemas、temporary forged tools。
- `lib/tools/adapters/*`：Dashboard、Terminal、Skill、Mac、Workflow 等平台适配器仍存在。

Legacy V2 的主要工具是 `code`、`terminal`、`knowledge`、`graph`、`memory`、`meta`，由 `{ name, action, params }` 风格驱动，能力丰富但仍有 V1/V2 adapter 和平台兼容痕迹。

### 5.2 新 Alembic Internal Agent Tool

新仓库把内部 agent tool 单独放在 `lib/agent/tools`，不和 Codex public MCP tool 共用 registry。`lib/agent/tools/registry.ts` 直接定义 `resource.action` 形态：

- `code.search`
- `code.read`
- `code.outline`
- `code.structure`
- `code.write`
- `code.guard`
- `terminal.execute`
- `knowledge.search`
- `knowledge.detail`
- `knowledge.submit`
- `knowledge.manage`
- `runtime.inject_context`
- `runtime.guard_finding`
- `runtime.source_ref_repair`
- `graph.overview`
- `graph.query`
- `memory.save`
- `memory.recall`
- `memory.note_finding`
- `memory.get_previous_evidence`
- `meta.capabilities`
- `meta.tools`
- `meta.plan`
- `meta.review`

`ToolRouter.invoke()` 只走新 handler、schema 校验、并发控制和结果压缩。它保留了 `parseToolCall()` 对 `{name, action}` 的解析便利，但这只是输入解析，不是旧兼容运行层。

### 5.3 Tool 逐项对比

| Tool 域 | Legacy V2 | 新 Alembic | 状态 |
|---|---|---|---|
| code.search/read | V2 handler + cache/压缩 | `rg --json` + fallback 搜索，read 支持行范围和大文件 outline | 基本迁移 |
| code.outline/structure | V2 结构工具 | `StructuralAstParser` + directory tree | 已迁，但 AST 深度较轻 |
| code.write | V2 项目写入 | 新 handler 限制 projectRoot，保护 `.git`、`node_modules`、`.env` | 已迁 |
| code.guard | legacy Guard 多服务 | 新增 internal `code.guard` 接 `MainlineGuardCheckEngine` | 核心迁移 |
| terminal | legacy 有 `SandboxExecutorBridge` 与 terminal policy | 新 `terminal.execute` 有危险命令拦截、cwd 限制、timeout，但 fallback 是 direct `exec` | 功能迁移，sandbox 深度不足 |
| knowledge.search/detail | legacy 接 DB/Search/KnowledgeService | 新接 `SearchIndex`、`ContextIndex`、Recipe repository/lifecycle | 基本迁移 |
| knowledge.submit | legacy 走 `RecipeProductionGateway` | 新优先走注入的 `knowledgeGateway`，否则用 `RecipeSubmissionPolicy + RecipeLifecycleStore` | 核心迁移，Gateway 缺省不完整 |
| knowledge.manage | legacy 支持 publish/reject/evolve/deprecate/quality | 新通过 repository/lifecycle/evolutionGateway 能做部分操作 | 部分迁移 |
| graph | legacy ProjectGraph/ProjectIntelligence 查询强 | 新 `ProjectIntelligenceArtifact` + graph query | 基础迁移 |
| memory | legacy MemoryCoordinator/PersistentMemory/Evidence | 新有 `MemoryStore` 风格内部工具 | 部分迁移 |
| meta | legacy capability/schema/plan/review | 新有 capabilities/tools/plan/review | 基本迁移 |
| runtime.* | legacy 分散在 prime/guard/source-ref 工作流 | 新显式加入 `runtime.inject_context`、`runtime.guard_finding`、`runtime.source_ref_repair` | 新仓库更清晰 |

结论：新 Alembic 的 internal agent tool 层已经独立成型，并且更符合“内部 agent 专用工具”的目标；后续重点不是再迁旧 adapter，而是补齐 backend port：sandbox executor、RecipeProductionGateway、EvolutionGateway、Search/Vector、Guard repository。

## 6. Codex Public Tool 对比

新仓库的 public tool 面在 `lib/codex/tools.ts` 中集中定义：

- `alembic_codex_diagnostics`
- `alembic_codex_status`
- `alembic_codex_init`
- `alembic_codex_bootstrap`
- `alembic_codex_rescan`
- `alembic_codex_job`
- `alembic_task`（目前支持 `prime`）
- `alembic_search`
- `alembic_structure`
- `alembic_knowledge`
- `alembic_submit_knowledge`
- `alembic_guard`

这个设计比 legacy 更清晰：

- status/diagnostics/init 是轻量工具，不启动 daemon。
- bootstrap/rescan 只排 durable daemon job，不在 MCP stdio 内跑长任务。
- `alembic_task prime` 只读已编译 runtime snapshot，不回扫 Markdown、不触发长任务。
- public search/structure/knowledge/guard 只读或受控写候选，不能直接调用 internal agent tool registry。

与 legacy 相比，丢弃了大量外部 MCP handler：browse、task、skill、wiki-external、dimension-complete-external、evolve-external、consolidate、panorama 等。当前阶段这是合理剪枝，因为 Codex 插件的主线不需要把所有管理面都暴露给 public MCP。

缺口在于 public tool 与 internal workflow 之间还缺少更成熟的“任务意志同步”协议：现在 `prime` 已能返回 markdown、recipeIds、hints、searchHitCount，但还没有把 Codex 会话中的执行结果、失败诊断、修复反馈持续写回 Alembic 的 evolution/knowledge governance。

## 7. AgentRuntime 对比

Legacy `lib/agent/runtime/AgentRuntime.ts` 是成熟的统一执行引擎：

- Capability + Strategy + Policy 配置驱动。
- Strategy 支持 Single、Pipeline、Adaptive、FanOut。
- ContextWindow、ExplorationTracker、BudgetController、ExitController、DiagnosticsCollector、HookSystem、EventBus。
- consecutive AI error 2-strike、空响应 retry、forced summary、tool call cap。
- `ToolExecutionPipeline` 支持 allowlist、forge fallback、submit dedup、tracker signal、trace、observation record。
- 与 `UnifiedToolCatalog`、V2 adapter、ServiceContainer、MemoryCoordinator 深度集成。

新 `lib/agent/runtime/AgentRuntime.ts` 明确保留了核心 ReAct 能力：

- 统一 message envelope。
- `reactLoop()` ReAct 循环。
- tool allowlist。
- budget/compaction。
- AI 错误恢复。
- forced summary。
- event bus、hooks、diagnostics、state machine。
- 只连接 `lib/agent/tools`，不回连 V1/V2 action 兼容层。

新 `ToolExecutionPipeline` 已有：

- allowlistGate。
- evolutionDecisionGate。
- observationRecord。
- trackerSignal。
- traceRecord。
- submitDedup。

但新 runtime 的上层策略被明显简化：

- 没有迁 legacy 的 `AgentService`、`AgentRuntimeBuilder`、`ProfileCompiler`、`StrategyRegistry`。
- 没有完整的 `AgentRunCoordinator` 并发/排队能力。
- 没有 legacy 冷启动里基于 Analyzer/Producer/Gate 的多阶段 profile。
- `AgentDimensionWorkflow` 当前按任务顺序执行 runtime，没有 legacy 异步维度填充、Socket.io 推送和 taskManager 状态。

结论：新仓库已经迁入“脑干”，但还没迁完“上层编排大脑”。下一阶段应该迁的是 profile/strategy/coordinator 的精华，而不是 legacy UI/taskManager。

## 8. ProjectIntelligence 对比

Legacy ProjectIntelligence 是冷启动和增量扫描的核心事实层。旧内部 cold-start 文档和代码显示它有阶段化流程：

- Phase 1 文件收集。
- Phase 1.5 AST 代码结构分析，文档明确提到 Tree-sitter。
- Phase 2 依赖关系与 knowledge_edges。
- Phase 3 Guard 规则审计。
- Phase 4 响应骨架、filesByTarget、analysisFramework、任务清单。
- Phase 5 内部 agent 按维度异步填充 Candidate。
- Phase 5.5 宏观维度聚合 Project Skill。

Legacy 代码里还有：

- `ProjectIntelligenceCapability`
- `ProjectIntelligenceRunner`
- `ProjectIntelligenceIncrementalPlanner`
- `ProjectGraph`
- enhancement registry
- panorama scanner
- Guard/Dependency/AST 相关服务

新 ProjectIntelligence 已经重建为主线 artifact：

- `MainlineProjectIntelligenceBuilder` 产出 `MainlineProjectIntelligenceArtifact`。
- artifact 包含 files、symbols、callSites、projectGraph、semanticEdges。
- `StructuralMainlineAstParser` 支持 TypeScript/JavaScript/Python/Swift/Rust/Go/Java/Kotlin 的正则结构提取。
- `MainlineProjectGraphBuilder` 结合 import parser 生成文件图。
- `MainlineProjectIntelligenceRunner` 支持 cold/incremental，增量路径会加载上轮 artifact、计算 filesToParse、merge patch artifact。
- `ProjectIntelligenceMaterializer` 把 file/symbol SourceRef 与 file/symbol/graph-node search document 写入 `ContextIndex` 和 `SearchIndex`。

差异：

- 新仓库不启动 tree-sitter，当前是轻量 structural parser。
- 新仓库暂不把 Guard findings、框架 enhancement、依赖版本洞察、模块目标视图完整写入 ProjectIntelligence artifact。
- 新仓库 ProjectIntelligence 不直接生成 Recipe，生成 Recipe 仍交给 content mining 与 agent fill。

结论：新 ProjectIntelligence 已经能支撑 prime/search/structure/source-ref/impact 的底座，但和 legacy 的语义深度仍有差距。应迁移 legacy 的“成熟分析维度”，但保持新 artifact/read model 风格，不回到旧容器和 DB 耦合。

## 9. Content Mining 与 Recipe 编译

Legacy 的 Recipe 生产能力集中在 `RecipeProductionGateway` 与 KnowledgeService 周边。Gateway 明确串起：

1. `UnifiedValidator`
2. Similarity Check
3. Consolidation Scan
4. `KnowledgeService.create()`，包含 `ConfidenceRouter`
5. Quality Scoring
6. Supersede Proposal
7. Audit

这套能力成熟，覆盖 agent-tool、mcp-external、ide-agent、batch-import 多入口，并支持 bootstrap session dedup、相似 Recipe、merge/reorganize、pending semantic review、evolutionGateway。

新仓库把其中一部分迁成纯主线：

- `Recipe` 成为 runtime bundle 消费的稳定知识单元，刻意避开 presentation/wiki/dashboard 字段。
- `RecipeSubmissionPolicy` 把 UnifiedValidator、ConsolidationAdvisor、ConfidenceRouter 的核心策略落入 mainline：必填字段、内容质量、唯一性、相似度、质量评分、route decision、consolidation action。
- `RecipeLifecycleStore` 实现 candidate/active/rejected 最小状态机。
- `submitCodexKnowledge()` 默认只写 candidate，不 publish。
- `IndexingRecipeLifecycleStore` 明确 candidate 不进入 Context/Search；active 才进入运行期知识集合。
- `ContentMiningRunner` 固定串起“增量证据编译 -> 内容挖掘 -> artifact 写入”。

缺口：

- 新仓库还没有一个完整默认启用的 `RecipeProductionGateway` 等价物。
- `knowledge.submit` 只有注入 `knowledgeGateway` 时才走完整 gateway，否则走本地 policy + lifecycle fallback。
- merge/reorganize/supersede/proposal/audit 目前更多是 policy result 或可选 port，不是完整闭环。

结论：Recipe 候选写入和审核边界已经正确，但“成熟生产治理”还没有完全迁完。下一步应把 legacy Gateway 的管线改写为 mainline 端口，而不是保留旧 KnowledgeService/DB 依赖。

## 10. 冷启动与增量扫描工作流

Legacy 内部冷启动是完整异步填充流程：

- 清理 DB + 文件缓存。
- ProjectIntelligenceCapability 跑 Phase 1-4。
- 构建 ProjectSnapshot。
- 构建 targetFileMap、维度清单、cached session。
- `startInternalDimensionExecutionSession()` 生成任务。
- `dispatchInternalDimensionExecution()` 后台逐维度填充。
- SkillHooks、Socket.io/EventBus 推送进度。
- Phase 5.5 可把宏观维度聚合为 Project Skill。

Legacy 增量 rescan 还连接 FileDiff、SourceRef、RecipeImpact、Evolution audit、external/internal workflows。

新工作流已经形成更窄但清晰的主线：

- `ScanLifecycleRunner`：Normalize/Plan/Track/Execute/Project/Persist/Recommend。
- `MainlineCompileSession`：scan、fingerprint、content mining、ProjectIntelligence、Recipe Markdown、SourceRefRepair、RecipeImpact、SearchIndex、VectorStore、JobLedger。
- `InternalColdStartWorkflow`：cold-start scan + optional internal agent dimension fill + finalizer/report。
- `InternalKnowledgeRescanWorkflow`：rescan scan + gap fill + Recipe evolution decision-only tasks + finalizer/report。
- `AgentDimensionWorkflow`：把 scan result 投影为 dimension/evolution tasks，并用新 `AgentRuntime` 顺序执行。
- `WorkflowBriefingBuilder`：把 scan evidence、gap signals、impact signals、budget、prompt 统一转为 briefing。
- `JsonWorkflowReportStore`：写入 reports。

当前新仓库的关键剪枝：

- 没有 Socket.io/taskManager。
- 没有 legacy Dashboard loading card。
- 没有旧外部 agent dimension_complete 协议。
- 默认 finalizer 是 `DisabledWorkflowFinalizer`。
- Project Skill 聚合还没有接回。

结论：新工作流已经可以开始跑“冷启动/增量扫描主线验证”，但如果目标是功能完全承接 legacy 的成熟能力，后续要补 finalizer、Project Skill、Agent profile、多任务协调、evolution proposal 审核闭环。

## 11. SourceRef、RecipeImpact 与 Evolution

Legacy 的 SourceRef 链路非常成熟：

- `SourceRefReconciler` 从 `knowledge_entries.reasoning.sources` 填充 recipe_source_refs 桥接表。
- 验证路径存在性，active/stale/renamed 状态机。
- 通过 `git log` 检测 rename。
- `rewriteRecipePaths` 可写回 markdown。
- stale sourceRef 会通过 SignalBus 发出 quality signal。
- `FileChangeHandler`、`FileChangeDispatcher` 把文件变化接入 recipe evolution。
- `EvolutionGateway` 用于统一提交 update/deprecate/valid 等进化决策。

新仓库已迁入主线核心：

- `SourceRefRepairService` 负责 source ref repair。
- `RecipeImpactAnalyzer` 根据 changed/deleted/moved/source refs/diff token/full content 判断 Recipe 影响。
- `runtime.source_ref_repair` 暴露给 internal agent。
- `AgentDimensionWorkflow` 将 `recipeImpact` 投影为 evolution decision-only 任务，只允许 `knowledge.manage`。
- `WorkflowBriefingBuilder.buildEvolution()` 生成 evolution prompt。

但新仓库做了重要边界调整：

- `RecipeImpactAnalyzer` 不直接修改 markdown、不创建 proposal、不调用旧 `FileChangeHandler`。
- evolution task 目前是 decision-only，没有完整 `EvolutionGateway` 默认实现。
- 没有 realtime file watcher 或 Dashboard file-change collector。

结论：增量影响分析已经迁入，但治理动作被上移。下一步应补一个新 mainline `EvolutionGateway`，让 `knowledge.manage` 的 evolve/deprecate/skip_evolution 能产生可审计 proposal 或 lifecycle 变更。

## 12. Search 与 Vector

Legacy 有较完整的 Search/Vector 子系统：

- `SearchEngine`
- `VectorService`
- `ContextualEnricher`
- `SyncCoordinator`
- Embedding fallback
- DB/data_version cache coordinator
- 与 KnowledgeService/SourceRef/Guard 事件联动

新仓库的搜索实现更轻：

- `InMemoryMainlineSearchIndex` 是 hard path，支持 structured sparse search。
- `MainlineSearchIndexStore` 落 JSON snapshot。
- `HybridSearch` 是 sparse + vector RRF facade。
- 没有 embedding provider/vector store 时自动降级到 sparse。
- `CompileSearchMaterializer` 把 ProjectIntelligence 和 content mining 产物 materialize 到 search index。
- embedding failures 被记录，不阻断 bootstrap/rescan。

结论：新仓库已经具备可恢复的 SearchIndex 和可选 vector 增强，但缺少 legacy 的 contextual enrichment、sync coordination、服务级热更新和多源质量信号。短期足够支撑 Codex prime；长期应迁回高级召回增强。

## 13. Guard

Legacy Guard 是完整服务域：

- `GuardCheckEngine`
- `GuardService`
- `ReverseGuard`
- `RuleLearner`
- `CoverageAnalyzer`
- `ComplianceReporter`
- `GuardFeedbackLoop`
- `GuardCrossFileChecks`
- `ViolationsStore`
- HTTP routes 与 Dashboard 报告。

新仓库保留了主线检测能力：

- `alembic_guard` 是 public Codex tool。
- internal `code.guard` 调用 `MainlineGuardCheckEngine`。
- `runtime.guard_finding` 构建 runtime guard finding。
- `RecipeGuardRuleLoader` 可从 Recipe/ContextIndex 读取 guard-rule。

缺口是治理闭环：

- rule learning、reverse guard、coverage report、violations store 没有完整迁入。
- Guard 结果与 Recipe evolution 的自动联动仍弱。
- public guard 目前主要是 read-only check，而不是完整治理服务。

## 14. Prime 与外部 Codex 同步链

Legacy 外部路径强调 Mission Briefing、external dimension complete、wiki plan、target file map 等协作流程，适合外部 agent 或 Dashboard 驱动。

新仓库把外部交互收束为 Codex prime：

- `runCodexPrime()` 检查 workspace initialized。
- 只读 `context/context-index.json` 与 `context/search-index.json`。
- `MainlinePrimeRunner` 构造 `ActiveWorkContext`。
- `RuntimeRetrievalPipeline` 按当前 task/files/symbols/diff/errors 检索。
- `ContextBundleBuilder` 构建 bundle。
- `AgentInjectionPlanner` 输出 markdown、recipeIds、hints、searchHitCount。

这条链路已经符合新方向：外部 Codex 不直接操作旧平台，只拿到当前任务相关上下文。缺口是“交互同步意志”还偏单向：Codex 能 prime，但 Codex 的执行结果、失败诊断、修复意图、最终验证结果还没有稳定回写成 AgentRuntime 可消费的 evolution/memory/knowledge signal。

## 15. Daemon 与 Job

Legacy daemon 与 HTTP 是平台服务的一部分，配套 supervisor、jobs、routes、logs、monitoring、remote、dashboard。

新 daemon 更专注：

- `DaemonHttpBridge` 只提供 `/api/v1/daemon/health`、`/api/v1/jobs`、`/api/v1/jobs/:id`、`/api/v1/jobs/:id/cancel`、`/api/v1/jobs/bootstrap|rescan`。
- `DaemonJobRunner` 支持 queued/running/completed/failed/cancelled、progress、autoStart、markInterrupted。
- `bin/daemon-server.ts` 初始化 workflow persistence、AI provider、embedding provider、compile session、scan lifecycle、internal workflows，然后注册 bootstrap/rescan handlers。
- MCP stdio 只 enqueue job，长任务在 daemon 执行。

这是新仓库比 legacy 更适合 Codex 插件的地方：小入口、durable queue、不会把长任务压在 MCP stdio 里。短板是缺少 legacy 的 rich monitoring/logs/dashboard routes，但当前阶段不必迁。

## 16. AI Provider

Legacy AI 层较完整：

- `AiFactory`
- `AiProviderManager`
- `LLMGateway`
- OpenAI/Claude/Google/DeepSeek/Ollama providers
- transport 层与 model registry
- ParameterGuard、token tracking、provider hot reload

新仓库更窄：

- `lib/mainline/ai` 定义 embedding/AI 端口。
- `lib/codex/ai-provider.ts` 从环境变量构造 runtime AI provider 和 embedding provider。
- `AgentRuntime` 可直接接 `RuntimeAiProvider` 或 gateway。
- daemon 在启动时注入 runtimeAiProvider/embeddingProvider。

结论：新仓库已满足 Codex 插件本地运行的最小 AI 接入，但没有迁完整 provider manager/model registry/hot reload。短期可接受，长期若要跨 IDE/跨模型稳定运行，需要重建一层轻量 provider manager。

## 17. Dashboard、Wiki、Skill、Delivery

Legacy 有：

- HTTP Dashboard 操作。
- Wiki external workflow。
- Skill hooks。
- Project Skill 自动聚合。
- Presentation/target classifier/panorama presenter。
- DashboardOperationAdapter、SkillAdapter、MacSystemAdapter 等。

新仓库当前：

- `WorkflowFinalizer` 默认 disabled。
- `WorkflowReportStore` 有 JSON report。
- 没有前端。
- 没有完整 Wiki delivery。
- 没有 Project Skill finalizer。

判断：这些不应第一批完整迁移。当前用户明确“不做前端”，所以 Dashboard/Mac/Dashboard adapter 可以继续剪枝；但 Project Skill finalizer、report delivery、Wiki/devdocs 作为 agent runtime 的上层产物，应该后续迁入新主线。

## 18. 已迁移内容清单

新 Alembic 已经迁入或重建的核心内容：

- Codex public MCP tool 清单与 handler。
- Codex Ghost workspace init/status/diagnostics。
- daemon HTTP bridge 与 durable job runner。
- bootstrap/rescan daemon enqueue。
- dataRoot runtime persistence。
- ContextIndex/SearchIndex/Vector snapshot。
- MainlineCompileSession。
- source file scanning、fingerprint diff、incremental baseline。
- ProjectIntelligence artifact、轻量结构 parser、project graph、semantic edges。
- ProjectIntelligence materialization 到 SourceRef/SearchDocument。
- ContentMiningRunner、EvidencePackage、Recipe relation/sourceRef 编译。
- Recipe model、RecipeMarkdownStore、RecipeLifecycleStore。
- RecipeSubmissionPolicy。
- SourceRefRepairService 与 RecipeImpactAnalyzer。
- Sparse SearchIndex 与 HybridSearch facade。
- public `prime/search/structure/knowledge/submit_knowledge/guard`。
- internal `lib/agent/tools` 全新 resource.action tool registry。
- internal AgentRuntime ReAct 核心。
- ToolExecutionPipeline 核心 gate/dedup/trace/tracker。
- ScanLifecycleRunner。
- InternalColdStartWorkflow。
- InternalKnowledgeRescanWorkflow。
- AgentDimensionWorkflow。
- WorkflowBriefingBuilder。
- JsonWorkflowReportStore。

## 19. 部分迁移但仍需补齐

以下能力不是没迁，而是只迁了主线骨架：

| 能力 | 新仓库已有 | 仍缺 |
|---|---|---|
| Tool system | resource.action registry/router/handlers | legacy sandbox executor、完整 capability/preset 映射、tool eval |
| AgentRuntime | ReAct loop/budget/diagnostics/hook/pipeline | StrategyRegistry、AgentRunCoordinator、profile compiler、stage preset |
| Recipe production | SubmissionPolicy/LifecycleStore/candidate-only | Gateway 默认实现、merge/reorganize/proposal/audit |
| ProjectIntelligence | artifact/parser/graph/materializer/incremental | tree-sitter/enhancement/deep dependency/guard findings/panorama signals |
| Evolution | RecipeImpact + decision-only task | EvolutionGateway/proposal/lifecycle writeback/realtime file change |
| Search | sparse + optional vector | contextual enrichment/sync coordinator/circuit breaker |
| Guard | guard check + rule loader | rule learner/reverse/coverage/violations store |
| Cold-start finalization | report store | Project Skill finalizer/Wiki/devdocs delivery |
| Codex sync | prime injection | result feedback/writeback memory/evolution signals |

## 20. 建议不迁移或暂缓迁移

这些 legacy 能力建议继续剪枝，不进入当前 Codex 插件主线：

- Dashboard 前端任务卡片、Socket.io loading UI。
- MacSystemAdapter、DashboardOperationAdapter 等 UI/桌面专用 adapter。
- 通用 HTTP route 大集合，除 daemon job/status 必需面外暂不迁。
- 旧 MCP handlers 的管理面全集，如 browse/wiki-external/evolve-external/dimension-complete-external。
- V1/V2 兼容层、CapabilityV2Wrapper、CompositeRouter fallback。
- SQLite-first repository 大容器，除非某个能力必须事务化。
- 旧 README/发布说明里与当前 Codex 插件方向冲突的方案。

这些不迁移并不代表能力消失，而是用新主线重新表达：public tool 更少，internal agent tool 更强，持久化更贴近 dataRoot snapshot，治理能力通过 mainline ports 补回。

## 21. 真实主要缺口

### 缺口 1：内部 Agent tool 的 backend port 还不够成熟

tool 名称和 handler 已经完整，但部分 handler 背后的能力还只是 fallback。例如 `knowledge.submit` 没有默认完整 Gateway，`terminal.execute` 没有默认 sandbox executor，`knowledge.manage` 的 evolution 依赖外部 `evolutionGateway` 注入。

建议：先补 `ToolRuntimeDependencies` 的标准装配，把 sandbox executor、RecipeProductionGateway、EvolutionGateway、Guard/Search/Memory port 作为 daemon persistence 的一等依赖。

### 缺口 2：AgentRuntime 上层编排缺失

ReAct loop 已迁，但 legacy 的 profile/strategy/coordinator 是冷启动和增量扫描成熟度的关键。现在 `AgentDimensionWorkflow` 已能跑 briefing tasks，但还不能表达 legacy 的 Analyzer/Producer/Gate、维度分层并发、证据累积、阶段回放、失败恢复策略。

建议：迁入精简版 `ProfileCompiler + StrategyRegistry + AgentRunCoordinator`，只服务 internal cold-start/rescan，不迁旧 UI taskManager。

### 缺口 3：RecipeProductionGateway 未完整落地

`RecipeSubmissionPolicy` 很强，但 Gateway 的“统一生产入口”还没有成为默认路径。legacy 的 validation/similarity/consolidation/confidence/quality/supersede/audit 是经过验证的成熟能力。

建议：在 `lib/mainline/knowledge` 或 `lib/workflows/knowledge` 新建 mainline gateway，实现纯端口版，不依赖旧 KnowledgeService/DB。

### 缺口 4：ProjectIntelligence 语义深度不足

新 structural parser 足够启动，但不等价于 legacy Tree-sitter + enhancement + dependency + guard + panorama。长期自验证时，浅解析会影响 graph.query、impact radius、agent evidence quality。

建议：按语言/框架逐步增强 parser 和 artifact 字段，而不是一次性迁旧 analyzer。

### 缺口 5：Evolution 闭环缺失

现在能发现 impact，也能让 agent 做 decision-only，但还缺 proposal、审核、应用、写回、审计。

建议：迁 `EvolutionGateway` 思想，落成 mainline proposal store，与 `knowledge.manage` 和 `RecipeLifecycleStore` 打通。

### 缺口 6：Codex 交互结果回写不足

prime 是单向注入，Codex 使用上下文后的结果没有稳定回写。Alembic 要能“自己验证修复问题”，必须把验证结果、失败命令、修复决策、最终 diff 反馈进 memory/Recipe/evolution。

建议：新增 public 或 internal sync tool，例如 `alembic_codex_feedback` 或 internal `runtime.record_outcome`，先写 report/memory，再进入候选 Recipe/evolution。

## 22. 推荐迁移顺序

按照“底层向上层”的依赖关系，建议下一步继续：

1. 补 internal agent tool backend port：sandbox executor、knowledge gateway、evolution gateway、memory/search/guard 标准注入。
2. 补 RecipeProductionGateway mainline 版：让 public submit 与 internal knowledge.submit 共享同一生产治理管线。
3. 补 AgentRuntime 上层编排：ProfileCompiler、StrategyRegistry、AgentRunCoordinator、stage briefing。
4. 增强 ProjectIntelligence：先补 artifact 查询能力和 deep dependency，再补语言增强。
5. 补完整 cold-start/rescan finalizer：Project Skill、report delivery、Wiki/devdocs 可后置。
6. 补 Codex feedback loop：prime 后的验证/修复结果回写，形成自验证闭环。
7. 最后再评估 Guard/Search/Vector 高级治理：RuleLearner、ContextualEnricher、SyncCoordinator。

## 23. 当前可验证主线

新 Alembic 现在已经可以用自己验证以下链路：

1. `alembic_codex_init` 初始化 Ghost workspace。
2. `alembic_codex_bootstrap` enqueue daemon bootstrap。
3. daemon 执行 `ScanLifecycleRunner + MainlineCompileSession`。
4. 生成 `context-index.json`、`search-index.json`、ProjectIntelligence artifact、fingerprint snapshot。
5. 如果 `agentFill=true` 且有 AI provider，执行 `AgentDimensionWorkflow`。
6. `alembic_task prime` 从 snapshot 生成 Codex 注入 markdown。
7. `alembic_search`、`alembic_structure`、`alembic_guard` 读取运行期索引。
8. `alembic_submit_knowledge` 写 candidate，等待 publish。

这条链足够作为“新主线自举验证链”。但它还不是 legacy 成熟链路的 100% 替代，因为缺少 Gateway、上层 agent orchestration、Project Skill finalizer、Evolution proposal 和 Codex feedback。

## 24. 最终判断

Alembic-legacy 可以稳定停在 `0.1.0`，把后续升级交给新 Alembic。新仓库已经不是空壳，核心底座已经搭起来，并且方向比 legacy 更适合 Codex 插件：

- public tool 面更安全、更小。
- internal agent tool 与 public MCP tool 分层明确。
- dataRoot/Ghost mode 写入边界更适合插件。
- scan/compile/read model 更清楚。
- ReAct runtime 和 workflow briefing 已经能承接内部 agent 挖掘。

但新 Alembic 还不能宣称“完整替代 legacy 成熟能力”。真正需要继续迁的是 legacy 的成熟治理内核：RecipeProductionGateway、AgentRuntime 上层编排、ProjectIntelligence 深层分析、Evolution 闭环、Search/Guard 高级治理。Dashboard、旧兼容层、通用 HTTP 管理面则不应迁。

下一步最应该做的不是继续扩 public tools，而是把 internal agent tool 背后的成熟服务补齐，让 Alembic 能在自身项目上跑完整的“扫描 -> 注入 -> agent 修复 -> 结果回写 -> Recipe/evolution 更新”闭环。
