# Alembic-legacy 主要方向与核心链路盘点

本文档基于 `../Alembic-legacy` 的真实源码与 `docs-dev` 设计文档，重新梳理旧项目的主要方向、核心链路、支路能力和功能作用。它不把旧项目理解成一个单点功能，而是把它拆成多条互相交织的产品/工程链路，供新 Alembic 迁移时判断“保留什么、裁剪什么、以什么形态重建”。

## 1. 总体判断

Alembic-legacy 的核心方向可以概括为：

> 以 Recipe 为项目知识本体，通过冷启动/增量扫描挖掘项目事实，用内部或外部 Agent 生产候选知识，再通过 Guard、Evolution、Delivery、Wiki、Dashboard 和 IDE 插件把知识用于开发现场。

旧项目的“成熟能力”不是 UI，也不是 README 中的单一体验，而是这些已经跑通的链路：

1. **编译期项目智能链路**：源码/Recipe/diff -> ProjectIntelligence、SourceRef、SearchIndex、RecipeImpact、ContextIndex。
2. **外部 Agent 任务发放链路**：compile -> Mission Briefing -> 外部 IDE Agent submit/evolve/complete。
3. **内部 AgentRuntime 自动挖掘链路**：compile -> dimension task -> AgentRuntime -> tools -> candidate/evolution/report。
4. **运行期 prime/ContextBundle 链路**：Codex/IDE 当前任务现场 -> ActiveWorkContext -> ContextBundle -> 注入/Guard/search。
5. **知识生命周期与治理链路**：candidate/Recipe -> validation/dedup/consolidation -> lifecycle/evolution/proposal。
6. **交付与展示链路**：Delivery/Wiki/Panorama/Dashboard/Realtime，把知识变成 IDE 文件、文档和可视化状态。
7. **插件化链路**：MCP tools、injectable skills、Codex/Cursor/Claude 插件包，把 Alembic 能力暴露给 AI IDE。

新 Alembic 迁移时应优先继承 1-5 的“主线语义”，谨慎继承 6-7 的“外部 adapter”，不要把旧平台层、旧 handler envelope 和旧 UI 默认副作用一起搬回来。

## 2. 方向一：编译期项目智能

### 2.1 功能作用

编译期链路负责把项目事实变成可恢复、可检索、可验证的运行时 artifact。它回答的问题是：

- 项目有哪些文件、模块、symbol、调用关系和依赖方向？
- 已有 Recipe 引用了哪些 SourceRef？
- 哪些 SourceRef 已过期、丢失、重命名？
- 文件变化影响了哪些 Recipe？
- 哪些文档应进入 SearchIndex/ContextIndex？

这条链路是所有上层能力的地基。没有它，外部 Mission Briefing、内部 Agent 任务、prime/search/guard 都只能回到旧式全仓扫描和文本搜索。

### 2.2 实际代码链路

核心入口：

```text
lib/workflows/capabilities/mainline/MainlineWorkflowEntrypoint.ts
  -> runMainlineProjectIntelligence()
  -> lib/mainline/compile/MainlineCompileSession.ts
```

`MainlineCompileSession` 的真实阶段：

```text
scanCompileFiles
  -> createMainlineFileFingerprintSnapshot
  -> diffMainlineFileFingerprintSnapshots / explicit changedFiles
  -> RecipeMarkdownStore.loadAll/writeMany
  -> ContentMiningRunner.compileAndWrite
  -> MainlineProjectIntelligenceRunner
  -> ProjectPanoramaSummary
  -> linkMainlineRecipeEvidence
  -> RecipeImpactAnalyzer
  -> MainlineCompileSearchMaterializer
  -> FileFingerprintSnapshotStore / SearchIndexStore / JobLedger
```

关键实现文件：

- `lib/mainline/compile/MainlineCompileSession.ts`
- `lib/mainline/compile/ProjectIntelligenceRunner.ts`
- `lib/mainline/compile/ContentMiningRunner.ts`
- `lib/mainline/compile/RecipeImpactAnalyzer.ts`
- `lib/mainline/compile/RecipeEvidenceLinker.ts`
- `lib/mainline/compile/SourceRefReconcileReport.ts`
- `lib/mainline/search/*`
- `lib/mainline/data/*`

### 2.3 支路内容

| 支路 | 作用 | 代表代码 |
| --- | --- | --- |
| Source scan / fingerprint | 发现文件、记录 hash baseline、支持增量 diff | `MainlineSourceFileScanner`, `FileFingerprintSnapshotStore` |
| ProjectIntelligence | 生成文件、symbol、semantic edge、project graph | `ProjectIntelligenceRunner`, `ProjectIntelligenceMaterializer` |
| Content mining | 从 Recipe/notes/diff 中形成编译期内容文档 | `ContentMiningRunner`, `ContentMiningPipeline` |
| Recipe evidence | 把 Recipe 与 SourceRef、文件、symbol 关联 | `RecipeEvidenceLinker` |
| Recipe impact | 根据变更文件和 token 影响分析生成 evolution 候选 | `RecipeImpactAnalyzer`, `RecipeImpactPlan` |
| Search / vector | 写 SearchIndex，支撑 search/prime/agent tools | `SearchIndexStore`, `HybridSearch`, `VectorStore` |
| Job ledger/report | 给编译任务可追踪状态 | `JobLedger`, `CompileReport` |

### 2.4 迁移判断

必须迁移，而且应作为新 Alembic 的底层主线。旧项目里这部分已经从 legacy workflow 中抽出来，说明方向已经被验证。需要剪掉的是旧 workflow wrapper 和旧 DB/handler 反向依赖，而不是这条编译链本身。

## 3. 方向二：冷启动与增量 workflow

### 3.1 功能作用

workflow 层负责把“项目智能编译”组织成用户可触发的业务生命周期：

- cold-start：清空旧状态，从零建立项目知识。
- knowledge-rescan：保留已有 Recipe，重扫项目事实，验证旧知识，补齐缺口。
- internal executor：由 Alembic 内部 AgentRuntime 自动执行维度任务。
- external executor：给外部 IDE Agent 发 Mission Briefing，等待它提交结果。

这不是简单的 scan 命令，而是完整生命周期：

```text
Intent -> Plan -> Cleanup -> Mainline compile -> Mission context
  -> Execution contract
  -> Dimension execution/completion
  -> Finalizer
  -> Report/Snapshot/History
```

### 3.2 四条真实主链

#### 内部 Agent 冷启动

入口：

```text
lib/workflows/cold-start/internal/InternalColdStartWorkflow.ts
```

链路：

```text
createInternalColdStartIntent
  -> buildColdStartWorkflowPlan
  -> runFullResetPolicy
  -> runMainlineWorkflow(mode=cold-start)
  -> readMainlineMissionFileContents
  -> buildMainlineMissionContext
  -> selectColdStartDimensions
  -> cacheProjectAnalysisSession
  -> startInternalDimensionExecutionSession
  -> dispatchInternalDimensionExecution
  -> SkillHooks.onBootstrapComplete
  -> presenter response
```

作用：快速返回任务骨架，后台用内部 Agent 自动填充维度知识。

#### 外部 Agent 冷启动

入口：

```text
lib/workflows/cold-start/external/ExternalColdStartWorkflow.ts
```

链路：

```text
createExternalColdStartIntent
  -> buildColdStartWorkflowPlan
  -> runFullResetPolicy
  -> runMainlineWorkflow(mode=cold-start)
  -> buildMainlineMissionContext
  -> createExternalWorkflowSession
  -> buildMainlineExternalMissionBriefing(profile=cold-start-external)
  -> external Agent: submit_knowledge
  -> alembic_dimension_complete
```

作用：不需要 Alembic 自带 AI provider，把项目事实与维度任务交给 Codex/Cursor/Claude 等外部 Agent 执行。

#### 内部 Agent 知识重扫

入口：

```text
lib/workflows/knowledge-rescan/internal/InternalKnowledgeRescanWorkflow.ts
```

链路：

```text
createInternalKnowledgeRescanIntent
  -> buildKnowledgeRescanWorkflowPlan
  -> runKnowledgeRescanCleanupPolicy(snapshot recipes + clean derived caches)
  -> syncKnowledgeStoreForRescan
  -> runMainlineWorkflow(mode=incremental)
  -> SourceRefReconciler.reconcile/repair/apply
  -> mainlineRecipeImpactCandidates
  -> submitMainlineRescanImpactDecisions
  -> runEvolutionAudit(for uncovered candidates)
  -> auditRecipesForRescan
  -> buildKnowledgeRescanPlan
  -> buildRescanPrescreen
  -> projectInternalRescanGapPlan
  -> cacheProjectAnalysisSession
  -> startInternalDimensionExecutionSession
  -> dispatchInternalDimensionExecution(gap dimensions)
  -> SkillHooks.onRescanComplete
```

作用：先处理旧 Recipe 的影响与衰退，再只让 AgentRuntime 补齐 gap 维度，避免 Producer 误承担旧知识验证。

#### 外部 Agent 知识重扫

入口：

```text
lib/workflows/knowledge-rescan/external/ExternalKnowledgeRescanWorkflow.ts
```

链路：

```text
createExternalKnowledgeRescanIntent
  -> buildKnowledgeRescanWorkflowPlan
  -> runKnowledgeRescanCleanupPolicy
  -> syncKnowledgeStoreForRescan
  -> runMainlineWorkflow(mode=incremental)
  -> submitMainlineRescanImpactDecisions
  -> auditRecipesForRescan
  -> buildKnowledgeRescanPlan
  -> buildRescanPrescreen
  -> projectExternalRescanEvidencePlan
  -> createExternalWorkflowSession
  -> buildMainlineExternalMissionBriefing(profile=rescan-external)
  -> external Agent: evolve / gap-fill / dimension_complete
```

作用：把旧知识影响、维度 gap、evolution guide 投影给外部 Agent，由外部 Agent 完成验证和提交。

### 3.3 workflow 支路内容

| 支路 | 作用 | 代表代码 |
| --- | --- | --- |
| Intent/Plan | 清洗参数，区分 cold-start/rescan/internal/external | `ColdStartIntent`, `KnowledgeRescanIntent`, `*WorkflowPlan` |
| Cleanup policy | cold-start 全清理，rescan 保留 Recipe、清衍生缓存 | `WorkflowCleanupPolicies.ts` |
| Mission context | 把 compile result 投影为 ProjectSnapshot 和 briefing 字段 | `MainlineMissionBriefing.ts` |
| External session | 给外部 Agent 跨调用保存维度状态 | `ExternalMissionWorkflow.ts`, `BootstrapSession.ts` |
| Dimension completion | 绑定提交 Recipe、生成 skill、checkpoint、quality、finalizer | `ExternalDimensionCompletionWorkflow.ts` |
| Internal execution | 任务会话、维度准入、runtime builder、session runner、consumer | `execution/internal-agent/*` |
| Finalizer | delivery、panorama、wiki、semantic memory | `WorkflowCompletionFinalizer.ts`, `CompletionSteps.ts` |
| Persistence | workflow report、history、snapshot、checkpoint cleanup | `WorkflowResultPersistence.ts`, `WorkflowReportWriter.ts` |

### 3.4 迁移判断

必须保留 lifecycle 语义，但新仓库应简化执行面：

- 保留 cold-start/rescan 两类业务生命周期。
- 保留 internal/external 两种 executor 的思想。
- 保留 finalizer/report 的端口概念。
- 去掉旧 handler helper、Socket.io 默认推送、Dashboard 强耦合、文件命名中的 bootstrap 泛化污染。

## 4. 方向三：AgentRuntime 与内部 Agent

### 4.1 功能作用

AgentRuntime 是旧项目内部自动挖掘能力的执行引擎。它不是很多个 Agent 类，而是：

```text
Preset + Capability + Strategy + Policy + ToolRegistry
  -> AgentRuntime.execute
  -> reactLoop
  -> ToolExecutionPipeline
  -> tool handler
  -> AgentResult
```

它支撑：

- cold-start 的维度分析与候选提交。
- rescan 的 gap-fill。
- evolution audit 的源码验证与决策提交。
- 远程执行、聊天、系统交互等扩展场景。

### 4.2 实际代码链路

入口和装配：

```text
AgentMessage
  -> AgentRouter
  -> AgentFactory / AgentService
  -> CapabilityRegistry
  -> StrategyRegistry
  -> AgentRuntime.execute
  -> strategy.execute
  -> AgentRuntime.reactLoop
```

核心运行时：

```text
SystemPromptBuilder
  -> MessageAdapter
  -> BudgetController / ContextWindow
  -> ExplorationTracker / ActiveContext / MemoryCoordinator
  -> aiProvider.chatWithTools
  -> ToolExecutionPipeline
  -> ToolRegistry.execute
  -> forced summary / diagnostics / AgentResult
```

代表代码：

- `lib/agent/runtime/AgentRuntime.ts`
- `lib/agent/strategies/PipelineStrategy.ts`
- `lib/agent/capabilities/CapabilityRegistry.ts`
- `lib/agent/context/ExplorationTracker.ts`
- `lib/agent/memory/MemoryCoordinator.ts`
- `lib/agent/runs/evolution/EvolutionAgentRun.ts`

### 4.3 支路内容

| 支路 | 作用 |
| --- | --- |
| Preset | chat、insight、evolution、lark、remote-exec 等行为组合 |
| Capability | conversation、code_analysis、knowledge_production、scan_production、system_interaction、evolution_analysis |
| Strategy | single、pipeline、fan_out、adaptive；pipeline 支持阶段隔离、重试、超时、预算 |
| Memory | ActiveContext scratchpad、cross-dimension evidence、PersistentMemory consolidation |
| Exploration control | 判断搜索是否充分、是否 nudge、是否 graceful exit |
| Evolution run | 对受影响 Recipe 强制每条给出 evolve/deprecate/skip 决策 |

### 4.4 迁移判断

用户明确要求迁移成熟的 AgentRuntime，所以新 Alembic 应保留 ReAct runtime、预算、工具白名单、诊断、forced summary 和 pipeline 思想。需要裁剪的是 ToolForge、remote-exec、Lark、旧多 preset 泛化场景；新仓库第一阶段只服务内部 mainline workflow。

## 5. 方向四：内部 Agent tools

### 5.1 功能作用

工具层是内部 AgentRuntime 的真实行动面。旧项目后来已把工具收敛到 V2 registry：

```text
ToolSpec(tool)
  -> actions
  -> JSON schema
  -> handler
  -> cache / concurrency / risk / maxOutputTokens
```

代表代码：

- `lib/tools/v2/registry.ts`
- `lib/tools/v2/types.ts`
- `lib/tools/v2/handlers/code.ts`
- `lib/tools/v2/handlers/knowledge.ts`
- `lib/tools/v2/handlers/terminal.ts`
- `lib/tools/v2/handlers/graph.ts`
- `lib/tools/v2/handlers/memory.ts`
- `lib/tools/v2/handlers/meta.ts`

### 5.2 实际工具组

旧项目 docs 记录过 50+ 工具；真实 V2 registry 已收敛成 6 个 tool namespace：

| Namespace | Actions | 作用 |
| --- | --- | --- |
| `code` | search/read/outline/structure/write | 项目源码查找、读取、结构、写文件 |
| `terminal` | exec | 沙箱命令执行与输出压缩 |
| `knowledge` | search/submit/detail/manage | 搜索、提交候选、查询详情、生命周期/evolution 决策 |
| `graph` | overview/query | AST/代码图谱、调用/影响查询 |
| `memory` | save/recall/note_finding/get_previous_evidence | 工作记忆、跨维度证据复用 |
| `meta` | tools/plan/review | 工具自省、任务规划、自我复核 |

`ToolAction` 上的关键字段是迁移重点：

- `cache`: none/session/delta。
- `concurrency`: parallel/single/exclusive。
- `risk`: read-only/write/side-effect。
- `maxOutputTokens`: 输出预算。
- `ToolContext`: 通过 DI 注入 projectRoot、mainlineRuntime、recipeGateway、evolutionGateway、memoryCoordinator、sandboxExecutor 等。

### 5.3 知识工具链路

`knowledge.submit` 是最关键写入工具：

```text
knowledge.submit params
  -> validateSubmitParams
  -> 注入 dimension/runtime meta
  -> admitRecipeSubmission
  -> RecipeProductionGateway.create
  -> mainline writer + legacy mirror + quality scoring
```

`knowledge.manage` 则是 evolution 的内部入口：

```text
knowledge.manage(operation=evolve/deprecate/skip_evolution)
  -> evolutionGateway.submit
  -> proposal-created / immediately-executed / verified / skipped
```

### 5.4 迁移判断

必须完整迁移内部 Agent 所需工具能力，但新仓库不应迁旧 50+ 平铺工具名和 public MCP envelope。应保留 V2 的 namespace/action 结构，面向 AgentRuntime 内部使用，并继续强化 DI、风险、并发和输出压缩。

## 6. 方向五：外部 MCP / AI IDE 工具面

### 6.1 功能作用

MCP 层是旧项目对外部 Agent 的协议面。它既给 Cursor/Codex/Claude 暴露工具，也把工具调用转成 workflow、query、guard、submit、evolve、task lifecycle。

代表代码：

- `lib/external/mcp/tools.ts`
- `lib/external/mcp/McpServer.ts`
- `lib/external/mcp/handlers/consolidated.ts`
- `lib/external/mcp/handlers/task.ts`
- `lib/external/mcp/handlers/search.ts`
- `lib/external/mcp/handlers/guard.ts`
- `lib/external/mcp/handlers/evolve-external.ts`

### 6.2 主要工具方向

`tools.ts` 声明了 agent/admin tier 和 Gateway gating。主要 public tools：

| 工具 | 作用 |
| --- | --- |
| `alembic_health` | 服务和知识库状态 |
| `alembic_search` | mainline knowledge search，支持 auto/keyword/bm25/semantic/context |
| `alembic_knowledge` | list/get/insights/confirm_usage/source_ref_repair |
| `alembic_structure` | ProjectIntelligence targets/files/metadata |
| `alembic_graph` | Recipe graph query/impact/path/stats |
| `alembic_call_context` | 代码调用上下文 |
| `alembic_guard` | Recipe 标准检查 |
| `alembic_submit_knowledge` | 外部 Agent 候选提交 |
| `alembic_bootstrap` | 外部 cold-start Mission Briefing |
| `alembic_rescan` | 外部 rescan Mission Briefing |
| `alembic_evolve` | 外部 evolution 决策 |
| `alembic_dimension_complete` | 外部维度完成 |
| `alembic_task` | prime/create/close/fail/record_decision |
| `alembic_wiki` | Wiki plan/finalize |
| `alembic_panorama` | panorama/governance/decay/staging/enhancement |
| admin tools | enrich_candidates、knowledge_lifecycle |

### 6.3 task/prime 意志同步链路

旧项目已经有前台 prime 雏形：

```text
alembic_task(operation=prime)
  -> IntentExtractor
  -> MainlinePrimeRunner
  -> loadMainlineRuntimeContext(readonly)
  -> KnowledgeInjectionRunner
  -> ContextBundle
  -> AgentInjectionPlanner
  -> markdown + risks + recipe refs
  -> IntentState in session
```

`close` 会提示必须调用 `alembic_guard`，`record_decision` 会把用户偏好放进 intent chain，最后通过 `SignalBus` 持久化。这说明旧项目已经在尝试“Codex 当前意图同步 + 任务闭环”，只是还绑在旧 MCP session 和 signal bus 上。

### 6.4 迁移判断

新 Alembic 应保留 public tool 的能力分层，但不要迁旧的全量 MCP 工具面。Codex 插件第一阶段更适合：

- public tools：status/init/bootstrap/rescan/job/prime/search/structure/guard/submit。
- internal tools：完全独立给 AgentRuntime。
- admin/wiki/panorama/dashboard：作为后续 adapter。

## 7. 方向六：知识生命周期、生产、治理与演化

### 7.1 功能作用

知识治理是旧项目的核心业务域。它保证 Agent 提交的内容不是随便写入 active 知识，而是经过验证、去重、融合、生命周期和演化判断。

### 7.2 生产链路

核心代码：

```text
lib/service/knowledge/RecipeProductionGateway.ts
```

真实管线：

```text
Agent Tool / MCP / IDE Agent / Batch Import
  -> RecipeProductionGateway.create
    -> UnifiedValidator
    -> BootstrapDedup(session-level)
    -> SimilarityService
    -> ConsolidationAdvisor
    -> writeRecipeToMainlineRuntimeArtifacts
    -> KnowledgeService.create(legacy mirror)
    -> QualityScorer
    -> supersede proposal
    -> audit
```

作用：统一所有知识创建入口，避免 agent tool、MCP handler、batch import 各写各的。

### 7.3 演化链路

核心代码：

```text
lib/service/evolution/EvolutionGateway.ts
```

真实管线：

```text
File diff / rescan impact / Agent decision / MCP evolve
  -> EvolutionGateway.submit
    -> check recipe exists
    -> action=valid: update lastVerifiedAt + reject proposals
    -> action=update: create proposal / upgrade existing proposal
    -> action=deprecate:
        high confidence agent source -> LifecycleStateMachine.transition(deprecated)
        otherwise -> proposal
```

配套支路：

- `FileChangeHandler`：文件改动事件转 evolution proposal 或 deprecate。
- `ContentImpactAnalyzer`：diff token 与 Recipe token 匹配。
- `ProposalExecutor`：Dashboard/CLI 下执行 proposal。
- `LifecycleStateMachine`：active/deprecated/evolving 等状态转换。
- `runEvolutionAudit`：AgentRuntime 验证所有 impact candidate 必须有决策。

### 7.4 迁移判断

必须保留 Gateway 思想。新 Alembic 可以不迁旧数据库和 Dashboard proposal 细节，但要保留：

- candidate 不直接成为 active。
- submit 走统一 validation/admission/dedup。
- evolution 只有 update/deprecate/valid/skip 这类受控结果。
- SourceRef/RecipeImpact 是 rescan 的核心输入，不是可选装饰。

## 8. 方向七：运行期 ContextBundle / prime / Guard

### 8.1 功能作用

运行期链路负责把编译期知识变成当前开发现场可用的上下文。

```text
ActiveWorkContext(task/files/symbols/diff/errors/intent)
  -> RuntimeRetrievalPipeline
  -> ContextBundleBuilder
  -> AgentInjectionPlanner
  -> markdown / risks / actions / capture prompts
```

代表代码：

- `lib/mainline/agent/MainlinePrimeRunner.ts`
- `lib/mainline/agent/KnowledgeInjectionRunner.ts`
- `lib/mainline/runtime/RuntimeRetrievalPipeline.ts`
- `lib/mainline/runtime/ContextBundleBuilder.ts`
- `lib/mainline/agent/AgentInjectionPlanner.ts`
- `lib/mainline/runtime/GuardFindingBuilder.ts`

### 8.2 Guard 支路

旧 Guard 很重，包含规则检查、学习、报告、coverage、reverse guard、feedback loop。但新主线设计文档已经明确 Guard 应收敛为：

```text
ActiveWorkContext + ContextBundle + file/diff
  -> GuardFinding
  -> suggested fix / capture draft / rescan request
```

代表旧代码：

- `lib/service/guard/GuardCheckEngine.ts`
- `lib/service/guard/ReverseGuard.ts`
- `lib/service/guard/ComplianceReporter.ts`
- `lib/external/mcp/handlers/guard.ts`

### 8.3 迁移判断

保留运行期 prime/ContextBundle 和前向 Guard。暂缓 ReverseGuard、ComplianceReporter、RuleLearner、CoverageAnalyzer 这类大平台支路。

## 9. 方向八：Delivery、Wiki、Panorama、Dashboard

### 9.1 功能作用

这部分把知识从内部结构变成可视化和外部可读材料：

- Delivery：写 Cursor/VS Code/agent 文件、rules、skills。
- Wiki：生成项目文档页面。
- Panorama：项目全景、治理/衰退/候选状态视图。
- Dashboard/Realtime：展示候选、任务进度、后台任务状态。

真实完成链：

```text
runWorkflowCompletionFinalizer
  -> runCursorDelivery
  -> verifyDelivery
  -> refreshPanorama
  -> generateWiki(schedule)
  -> consolidateSemanticMemory(schedule/immediate)
```

代表代码：

- `lib/workflows/capabilities/completion/WorkflowCompletionFinalizer.ts`
- `lib/workflows/capabilities/completion/CompletionSteps.ts`
- `lib/service/delivery/*`
- `lib/service/wiki/*`
- `dashboard/src/*`
- `lib/http/*`

### 9.2 迁移判断

这些能力有价值，但不应进入 Codex 插件主线默认路径。新 Alembic 应把它们降级为可插拔 finalizer/adapter：

- 第一阶段默认 disabled/skipped。
- Dashboard 不阻塞 bootstrap/rescan。
- Wiki 不作为知识质量证明。
- Delivery 不再默认写 IDE 项目文件，除非具体插件 adapter 显式开启。

## 10. 方向九：插件、Skills、Ghost mode 与 daemon

### 10.1 功能作用

旧项目后期已经开始转向插件化：

- `plugins/alembic-codex`：Codex 插件包、skills、release playbook。
- `injectable-skills/alembic-*`：可注入到 AI IDE 的操作说明。
- `.cursor-plugin`, `.claude-plugin`：其他 IDE 插件形态。
- Ghost mode：把运行时数据放到外部 dataRoot，项目根目录只保留源码。
- Daemon：承载 Dashboard、DB、Realtime、内部 Agent 和长任务。

### 10.2 Codex 插件方向

`docs-dev/skills-plugins/codex-plugin-transition-design.md` 的真实判断是：

```text
Codex Marketplace Plugin
  -> lightweight MCP
  -> ensureDaemon()
  -> daemon durable jobs
  -> Alembic Core
```

旧设计中 Codex 插件应支持：

- status/diagnostics/init/dashboard。
- bootstrap/rescan 返回 durable job id。
- job 可恢复查询。
- prime 在编码前使用。
- cleanup 默认 dry-run，不删除知识。

### 10.3 迁移判断

新 Alembic 当前方向与旧项目后期判断一致：先做 Codex 插件，走 Ghost/dataRoot，daemon 按需承载长任务。需要避免的是旧 `alembic-mcp` 启动时初始化全平台的重入口。

## 11. 哪些能力是主线，哪些是支路

### 11.1 必须作为新 Alembic 主线迁移

| 能力 | 原因 |
| --- | --- |
| Mainline compile | 所有 read/write/agent 能力的事实地基 |
| SourceRef / RecipeImpact / incremental diff | rescan 和 evolution 的成熟核心 |
| Internal AgentRuntime | 用户明确要求迁移成熟自动挖掘链路 |
| Internal agent tools | AgentRuntime 的行动面，必须完整 |
| External Mission Briefing 思想 | Codex 插件需要外部 Agent 协作路径 |
| prime / ContextBundle | Codex 工作现场同步的核心 |
| RecipeProductionGateway / EvolutionGateway 思想 | 保证知识生命周期不失控 |
| Report / job result | 长任务可恢复与可解释 |

### 11.2 应迁为可插拔 adapter

| 能力 | 新形态 |
| --- | --- |
| Wiki | finalizer adapter，默认 disabled |
| Delivery | IDE-specific adapter，Codex 首阶段不默认写 |
| Dashboard | daemon 管理界面，不阻塞主线 |
| Panorama | read model/report adapter |
| Skills generation | 候选能力，先作为外部插件/skill 资源 |
| Guard advanced report | 后续 audit/report adapter |
| Semantic memory consolidation | 后台 job，避免绑主事务 |

### 11.3 不应迁或只保留参考

| 能力 | 原因 |
| --- | --- |
| legacy ServiceContainer 全平台初始化 | 太重，和 Codex 插件按需启动冲突 |
| 旧 Socket.io 进度默认链路 | Codex 首阶段不需要前端实时进度 |
| ToolForge/TemporaryToolRegistry | 可控性差，主线不需要动态造工具 |
| ReverseGuard 完整平台 | 可先拆成 SourceRef freshness，不迁完整引擎 |
| ComplianceReporter/RuleLearner/CoverageAnalyzer | 低频高级治理，不是主线 |
| 旧 V1/V2 混合 tool envelope | 新仓库应只保留清晰分层 |
| Lark/remote-exec | 非 Codex 首阶段范围 |

## 12. 对新 Alembic 的落地启发

旧项目真正成熟的地方，是“项目事实 -> 知识生产 -> 生命周期治理 -> 开发现场使用 -> 增量演化”的闭环。新 Alembic 不需要复制旧项目的重量，但要保持这条闭环完整：

```text
bootstrap/rescan daemon job
  -> mainline compile
  -> AgentRuntime/tool dimension fill
  -> Recipe candidate/evolution decision
  -> report/job result
  -> prime/search/guard read models
  -> Codex current task
  -> submit/rescan feedback
```

下一步设计实现时，建议用这份盘点作为迁移边界：

1. 先补前台 prime 的结构化意志同步 envelope。
2. 再补 daemon job/report contract。
3. 同步继续完善内部 AgentRuntime/tool 的完整能力和测试。
4. 冷启动/增量链路只迁主线语义，不迁旧 UI/Socket/handler 兼容层。
