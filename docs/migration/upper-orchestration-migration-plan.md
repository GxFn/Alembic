# Alembic Upper Orchestration Migration Plan

## 目标

新 Alembic 已经把 `lib/mainline`、`lib/agent/runtime` 和内部 Agent tools 迁成独立主线。下一阶段要迁的是 legacy 中成熟的上层编排思想：任务规划、维度准入、内部 Agent 执行、报告/完成态、交付边界和可恢复状态。

迁移原则：

- 保留成熟能力，不迁 legacy 容器、Socket.io、旧数据库服务和 V1/V2 tool envelope。
- 所有上层编排都落到新主线的 `ScanLifecycleRunner`、`MainlineCompileSession`、`AgentDimensionWorkflow`、daemon durable jobs 和 `dataRoot` read models。
- Codex 插件先不做前端；Dashboard、IDE 多通道交付和 Wiki 进入可插拔 finalizer，不阻塞 Codex 主线闭环。
- 运行期输出必须有明确写入边界：`projectRoot` 只读源码，`dataRoot` 承载 runtime、Recipe、candidate、report、vector 和 job 状态。

## Legacy 成熟能力分层

### 必须迁移

1. Mission briefing / execution briefing
   - 从编译结果生成 Agent 可执行任务上下文。
   - 保留维度说明、证据 starter、提交 schema、预算压缩和增量证据提示。
   - 新落点：`lib/workflows/agent` 下的 briefing/projector，而不是旧 `MissionBriefingBuilder`。

2. Dimension admission / tier scheduling
   - 从 ProjectIntelligence、Recipe gaps、rescan impact 推导要补齐的维度。
   - 保留 skill/candidate/decision 三类输出。
   - 新落点：扩展 `AgentDimensionWorkflow.planAgentWorkflowTasks()`，不要迁旧 taskManager。

3. Internal agent execution pipeline
   - 保留 preparation -> runtime -> session -> finalizer 的阶段思想。
   - 执行器统一用新 `AgentRuntime` 和 `lib/agent/tools`。
   - 新落点：`InternalColdStartWorkflow` / `InternalKnowledgeRescanWorkflow` 分阶段拆小，而不是回迁旧 internal-agent 目录。

4. Workflow report history
   - 保留每次 bootstrap/rescan 的可追踪结果、phase、warnings、recommendations、agent results。
   - 新落点：daemon job result + `dataRoot/.asd/reports/` JSON/Markdown snapshot。

5. Completion finalizer
   - 保留 completion step 的思想：delivery、wiki、panorama refresh、semantic memory 作为可选后置步骤。
   - 新落点：`ScanLifecycleRunner` 完成后可调的 mainline finalizer port。
   - Codex 首阶段默认禁用 delivery/wiki，只记录 skipped/disabled 原因。

6. External mission / user delivery boundary
   - 保留外部 Agent 任务说明和交付安全边界。
   - 新落点：公共 MCP/Codex 工具只暴露稳定 read/write adapter，不暴露内部 resource.action tools。

### 剪枝不迁

- 旧 ServiceContainer、BootstrapTaskManager、Socket.io event emitter。
- 旧 SQLite context index adapter。
- 旧 workflow capabilities 的层层 presenter 中间态。
- 旧 external/internal 双目录的重复 workflow wrapper。
- 旧 mock bootstrap pipeline，测试改用 fake `RuntimeAiProvider` 和 focused fixtures。
- 旧 IDE delivery 的同步执行默认值。新主线只把 delivery 作为 finalizer step。

## 新主线目标形态

```text
Codex MCP tool
  -> daemon durable job
    -> ScanLifecycleRunner
      -> MainlineCompileSession
        -> ContextIndex / SearchIndex / VectorStore / ProjectIntelligence
      -> AgentDimensionWorkflow (optional agentFill)
        -> AgentRuntime
        -> internal Agent tools
      -> WorkflowFinalizer (optional, port-based)
      -> report history / job result / read models
```

## 迁移批次

### P0 已完成或本轮补齐

- Codex public tools 与内部 Agent tools 分层。
- `ScanLifecycleRunner` 串起冷启动和增量扫描。
- `MainlineCompileSession` 写入 ContextIndex/SearchIndex/ProjectIntelligence/SourceRef repair/Recipe impact。
- daemon job durable queue 承载 bootstrap/rescan。
- 本轮补齐：daemon `agentFill` 从环境读取真实 AI provider。
- 本轮补齐：embedding provider 存在时默认写入 JSON vector store，并为 hybrid search 留出 runtime 快照。

### P1 下一批迁移

- 新增 `WorkflowBriefingBuilder`：从 `ScanLifecycleResult` 生成 Agent 任务 briefing。
- 扩展 `AgentDimensionWorkflow` 的维度准入：加入 tier、gap、rescan impact、skill-worthy 输出。
- 新增 `WorkflowReportStore`：持久化 scan/agent/finalizer 汇总，不依赖前端。
- 新增 `WorkflowFinalizer` port：delivery/wiki/panorama/semantic memory 默认 disabled，可由后续 IDE/Dashboard 插件打开。

### P2 再下一批迁移

- Project Skill 生成链路接入 finalizer，但不作为 Codex 插件默认行为。
- 交付通道抽象：Cursor/Vscode/Trae/Qoder 作为 delivery adapter。
- 语义记忆 consolidation 迁成后台 job，不与 bootstrap/rescan 主事务耦合。
- 迁移 external mission briefing，服务非 Codex IDE 的后续插件。

## 完成标准

- Codex bootstrap/rescan 在无 AI provider 时完成 deterministic scan，并明确 degraded agent fill。
- 配置真实 provider 后，`agentFill=true` 能进入 AgentRuntime 并产出候选/发现/决策。
- embedding provider 存在时，compile report 中 `search.embedded > 0`，`dataRoot/.asd/context/vector-index.json` 可恢复。
- workflow job result 能说明 scan、agent、finalizer 三段状态。
- 所有写入路径都能从 status/job/report 中追溯到 `dataRoot`。
