# Alembic 主要方向与核心链路重思考

本文档只基于当前新 Alembic 代码与顶层 `docs` 里的迁移/验证文档，不把仓库 README 当作产品方向依据。README 描述的是旧版本外观；当前 Alembic 的核心已经转向 AI IDE 插件模式下的本地项目智能底座。

## 1. 当前主要方向

Alembic 不是一个前端优先的知识库，也不是一次性生成文档的工具。它现在应该被定义为：

> 给 Codex 这类 AI IDE 提供本地、可恢复、可验证的项目智能层；后台持续挖掘项目事实与可复用规范，前台在每次 Codex 工作前把当前任务意图同步成可注入上下文。

这个方向下有两条主线：

1. **内置 AgentRuntime 项目挖掘链路**
   - 面向后台、daemon、冷启动和增量扫描。
   - 目标是把项目源码、Recipe、SourceRef、搜索索引、ProjectIntelligence 和 Agent 候选知识沉淀到 `dataRoot`。
   - 内部 Agent 可以调用 `lib/agent/tools`，但只能提交候选、记录证据或做 evolution decision，不能直接绕过生命周期发布 active Recipe。

2. **外部 prime 与 Codex 交互同步意志链路**
   - 面向前台、Codex MCP、公有工具和实时工作现场。
   - 目标是把 Codex 当前任务、文件、symbol、diff、错误、命令意图和用户关注点归一成 `ActiveWorkContext`，再从已编译索引召回 `ContextBundle`，压缩成 Codex 可直接使用的注入文本。
   - 这条链路必须只读运行期快照，不启动扫描、不调用内部 Agent tools、不产生旧兼容副作用。

两条主线共享同一套运行时产物，但写入和读取责任必须分开：

- `projectRoot`：只读项目源码。
- `dataRoot`：唯一运行时写入边界，保存 context/search/vector/project intelligence/recipe lifecycle/report/job 状态。
- Codex MCP public tools：只做 init/status/diagnostics/job enqueue/prime/search/structure/guard/submit 这类明确入口。
- Internal agent tools：只服务 AgentRuntime，不对外暴露旧 `resource.action` 兼容层。

## 2. 总体架构定位

```text
                 ┌────────────────────────────────────────┐
                 │              Codex / AI IDE             │
                 │ task, files, symbols, diff, errors      │
                 └───────────────────┬────────────────────┘
                                     │ public MCP tools
                                     │
        read-only prime/search/guard │ enqueue bootstrap/rescan/submit candidate
                                     │
┌────────────────────────────────────▼────────────────────────────────────┐
│                         Alembic Codex Plugin Layer                      │
│ lib/codex/tools.ts                                                      │
│ - prime/search/structure/guard only read runtime snapshots              │
│ - bootstrap/rescan only enqueue durable daemon jobs                     │
│ - submit only writes candidate lifecycle                                │
└───────────────────┬───────────────────────────────────┬────────────────┘
                    │                                   │
                    │ foreground intent sync            │ background mining
                    │                                   │
┌───────────────────▼──────────────────┐   ┌────────────▼────────────────┐
│ Prime / Injection Runtime             │   │ Daemon Durable Workflow       │
│ ActiveWorkContext -> ContextBundle     │   │ ScanLifecycleRunner           │
│ RuntimeRetrievalPipeline               │   │ MainlineCompileSession         │
│ AgentInjectionPlanner                  │   │ Internal AgentRuntime workflow │
└───────────────────┬──────────────────┘   └────────────┬────────────────┘
                    │                                   │
                    └──────────────┬────────────────────┘
                                   │
┌──────────────────────────────────▼──────────────────────────────────────┐
│                               dataRoot                                  │
│ context-index.json / search-index.json / vector-index.json              │
│ ProjectIntelligence / Recipe lifecycle / candidates / reports / jobs    │
└─────────────────────────────────────────────────────────────────────────┘
```

## 3. 主线一：内置 AgentRuntime 项目挖掘链路

这条链路负责“让 Alembic 自己理解项目”。它是异步、可恢复、可报告的后台链路。

### 3.1 入口

入口来自公开 Codex 工具，但公开工具只排队：

- `alembic_codex_bootstrap`
- `alembic_codex_rescan`
- daemon HTTP bridge/job runner

公开入口不直接执行扫描，是为了避免 Codex MCP stdio 阻塞，也为了让长任务、取消、恢复、报告有统一状态。

### 3.2 扫描与编译

主路径：

```text
DaemonJobRunner
  -> ScanLifecycleRunner
    -> normalize / plan / track / compile-session / project / persist / recommend
    -> MainlineCompileSession
      -> source scan
      -> fingerprint baseline/diff
      -> Recipe Markdown load/write
      -> content mining
      -> ProjectIntelligence
      -> SourceRef repair
      -> Recipe impact
      -> SearchIndex / VectorStore
      -> JobLedger
```

这部分的责任是产生可信运行时事实，而不是生成给用户看的页面。当前代码已经把核心能力落在：

- `lib/workflows/scan/ScanLifecycleRunner.ts`
- `lib/mainline/compile/MainlineCompileSession.ts`
- `lib/workflows/mainline/MainlineWorkflowPersistence.ts`
- `lib/mainline/compile/*`

### 3.3 Agent 维度补齐

扫描完成后，内部 AgentRuntime 接管“高价值知识挖掘”：

```text
InternalColdStartWorkflow / InternalKnowledgeRescanWorkflow
  -> WorkflowBriefingBuilder
  -> AgentDimensionWorkflow
  -> AgentRuntime
  -> ToolRouter
  -> internal agent tools
  -> knowledge.submit / knowledge.manage / memory.note_finding
  -> finalizer/report
```

这个阶段不应该复刻 legacy 的 taskManager、Socket.io、旧 DB container 或旧 tool envelope。新主线已经形成更清晰的职责：

- `WorkflowBriefingBuilder`：把 `ScanLifecycleResult` 投影成任务 tier、gap、impact、预算和 prompt。
- `AgentDimensionWorkflow`：选择 dimension/evolution 任务，控制 `maxAgentTasks/includeEvolution`。
- `AgentRuntime`：执行 ReAct loop、预算、工具白名单、诊断、强制总结。
- `lib/agent/tools`：只给内部 Agent 使用，包含 code/terminal/knowledge/runtime/graph/memory/meta 等工具。
- `WorkflowReportStore`：记录 scan/agent/finalizer 三段结果。

### 3.4 挖掘链路的产品意义

后台链路的输出不是“马上给 Codex 一段回答”，而是持续改善下一次 prime/guard/search 的事实基础：

- 新项目首次 bootstrap 后有项目结构、源文件事实、检索索引和初始 Recipe 缺口。
- 后续 rescan 后能识别变更文件、失效 SourceRef、Recipe impact 和 evolution 决策。
- AgentRuntime 提交的是候选知识与证据，active 化必须继续走生命周期审核边界。

## 4. 主线二：外部 prime 与 Codex 交互同步意志链路

这条链路负责“让 Codex 每次行动前获得当前项目知识”。它是同步、只读、低延迟的前台链路。

### 4.1 Codex 当前意图的输入

Codex 与 Alembic 同步的不是泛泛的“项目上下文”，而是当前工作意图。当前代码里的 `runCodexPrime` 和 `ActiveWorkContextBuilder` 已经支持这些信号：

- `task` / `prompt` / `taskText`
- `activeFile` / `files`
- `symbols`
- `diff`
- `errors` / `diagnostics`
- `commandIntent`
- `userFocus`

这些字段应该被视为 Alembic 与 Codex 之间的“意志同步 envelope”。它表达的是：Codex 此刻想做什么、正在看哪里、有哪些变化和错误、用户关注点是什么。

### 4.2 Prime 只读召回路径

主路径：

```text
alembic_run_task(operation=prime)
  -> runCodexPrime
    -> inspectWorkspace
    -> createMainlineWorkflowPersistence
    -> MainlinePrimeRunner
      -> ActiveWorkContextBuilder
      -> RuntimeRetrievalPipeline
      -> ContextBundleBuilder
      -> AgentInjectionPlanner
      -> AgentContextPresenter markdown
```

这条路径的边界非常重要：

- 只读 `dataRoot` 中已编译的 context/search 快照。
- 不扫描项目。
- 不启动 daemon。
- 不调用内部 AgentRuntime。
- 不发布知识。
- 不读取旧 docs-dev/README 作为实时事实来源。

Prime 的成功输出应该是 Codex 可直接消化的“少而准”的上下文：

- 命中的 Recipe。
- 与当前文件/symbol/diff/error 相关的 SourceRef。
- 风险提示，例如 stale/missing SourceRef 或 Recipe graph conflict。
- 建议 Codex 关注的 action。
- 压缩后的 markdown 注入文本。

### 4.3 Codex 交互同步闭环

Prime 不是一次性读取，而应该成为 Codex 工作循环的一部分：

```text
用户任务/当前编辑现场
  -> Codex 调用 prime
  -> Alembic 返回 ContextBundle/markdown
  -> Codex 按 Recipe 和风险提示执行修改/验证
  -> Codex 可调用 guard/search/structure 继续只读查证
  -> Codex 发现新规范时 submit candidate
  -> 文件变化进入 rescan changedFiles/diffTextByPath
  -> 后台挖掘链路更新 dataRoot
  -> 下一次 prime 更准
```

这个闭环里，Codex 是实时执行者；Alembic 是记忆、检索、约束、候选沉淀和后台挖掘层。

## 5. 两条主线的边界

| 维度 | 后台 AgentRuntime 挖掘链路 | 前台 prime/Codex 同步链路 |
| --- | --- | --- |
| 运行方式 | daemon durable job | MCP 同步调用 |
| 目标 | 挖掘、补齐、演化项目知识 | 给当前 Codex 工作注入上下文 |
| 数据写入 | `dataRoot` runtime、candidate、report、job | 默认只读；submit/job enqueue 是显式写入口 |
| AI 使用 | 内部 AgentRuntime，可退化 | 不直接调用模型 |
| 工具层 | `lib/agent/tools` 内部工具 | `lib/codex/*` 公共工具 |
| 失败语义 | degraded/failed/cancelled/report | uninitialized/missing snapshot/error/hints |
| 频率 | 冷启动、增量扫描、后台任务 | 每个用户任务、编辑现场、验证前后 |

关键原则：

- public Codex tools 不能 import 或执行 internal agent tools。
- internal AgentRuntime 不应该调用 public MCP tool envelope。
- candidate 不能默认进入 active Recipe；active 化要通过 lifecycle。
- prime 只消费已编译运行时快照，不能隐式启动扫描。
- rescan/agentFill 是后台事实更新，不是 prime 的同步阻塞步骤。

## 6. 当前代码已具备的能力

从真实代码看，新 Alembic 已经具备这些主线骨架：

- daemon job 排队与执行：`lib/daemon/*`、`bin/daemon-server.ts`
- 冷启动/增量统一生命周期：`ScanLifecycleRunner`
- 编译期项目事实：`MainlineCompileSession`
- dataRoot 持久化和读模型恢复：`MainlineWorkflowPersistence`
- 内部 AgentRuntime：`lib/agent/runtime/*`
- 内部 Agent tools：`lib/agent/tools/*`
- agent briefing 和 dimension/evolution 任务：`WorkflowBriefingBuilder`、`AgentDimensionWorkflow`
- public prime/search/structure/guard/submit：`lib/codex/*`
- report/finalizer 的可插拔端口：`lib/workflows/report/*`、`lib/workflows/finalizer/*`

也就是说，接下来的重点不是“继续搬旧仓库目录”，而是把这些链路的边界、输入输出契约、验证节点和缺口补齐。

## 7. 需要补齐的核心缺口

### 7.1 把 Codex 意志同步 envelope 明确成一等概念

当前 `runCodexPrime` 已经接收 task/files/symbols/diff/errors/commandIntent/userFocus，但它仍然只是 prime input。建议下一步抽象成明确的 `InteractionIntent` 或 `CodexIntentEnvelope`：

- 统一 public prime/search/guard/submit/rescan 的现场字段。
- 给每次 prime 输出 trace id、snapshot 信息和命中依据。
- 支持 Codex 在修改前、验证失败后、提交候选前复用同一意图 envelope。

### 7.2 强化 prime 输出的结构化契约

现在 prime 返回 markdown、recipeIds、hints、searchHitCount 和 activeContext。建议补齐：

- `bundleId`
- `snapshot`：context/search/vector artifact 路径或生成时间。
- `risks`：从 ContextBundle 风险直接透出。
- `suggestedActions`：给 Codex 的下一步建议。
- `capturePrompts`：没有命中 Recipe 时提示是否沉淀候选。

这样 Codex 可以更稳定地把 Alembic 输出当作“同步意志后的执行约束”，而不是只读一段 markdown。

### 7.3 让后台挖掘链路反哺前台 prime

AgentRuntime 挖掘提交 candidate 后，前台 prime 默认不应该直接消费 candidate；但 Codex 应该能看到“存在待审核候选”的提示。建议：

- prime 可透出与当前 active context 相关的 candidate 摘要，但标记为 candidate/non-active。
- guard/search 默认仍只使用 active Recipe，除非显式开启 candidate preview。
- rescan report 里记录 agent candidate/evolution 对下次 prime 的影响。

### 7.4 Job result 与 report 继续向链路契约收敛

后台 job result 应该稳定区分：

- scan-only completed。
- agentFill completed/degraded/failed。
- finalizer disabled/skipped/completed。
- report reference。
- cancelled before scan / cancelled after scan。

这会让 Codex 侧能判断下一步是 prime、查看 job、重跑 rescan，还是补 provider。

### 7.5 完整验证从两条链路分别推进

不建议只跑端到端命令。下一步验证应按两条链路拆：

- 后台链路：daemon job -> scan lifecycle -> compile persistence -> agent workflow -> report。
- 前台链路：workspace readiness -> prime read-only -> ContextBundle -> injection markdown -> guard/search/submit feedback。

只有两条链路各自节点稳定后，再做完整冷启动/增量闭环验证。

## 8. 明确不做或暂缓

当前阶段不应该迁回或扩展这些内容：

- 旧 README 描述的产品形态。
- legacy ServiceContainer、Socket.io、旧 taskManager、旧数据库 service。
- V1/V2 tool envelope 兼容层。
- 前端 Dashboard 作为主线阻塞项。
- Cursor/Vscode/Trae/Qoder 等多 IDE delivery adapter。
- Wiki/semantic memory/delivery 的默认同步副作用。
- 让 prime 隐式触发 bootstrap/rescan。

这些都可以作为后续插件或 finalizer adapter，但不应该污染 Codex 插件第一阶段的核心链路。

## 9. 下一步实施顺序

建议按以下顺序继续建设：

1. **定义 Codex 意志同步 envelope**
   - 把 prime 当前输入抽成共享类型。
   - public prime/search/guard/rescan 复用字段清洗逻辑。
   - 测试非法字段、路径归一、limit、diff/errors 的裁剪。

2. **增强 prime 结构化输出**
   - 从 `ContextBundle` 透出 risks/suggestedActions/capturePrompts。
   - 保留 markdown 注入，但不让 markdown 成为唯一契约。
   - 补 prime read-only 测试，确保无写入、无 daemon、无 AgentRuntime。

3. **收敛 daemon job result/report 契约**
   - 抽出 daemon workflow orchestrator 的可测试模块。
   - report save 带 jobId。
   - 覆盖 scan-only、agentFill degraded、cancelled 三种结果。

4. **强化 AgentRuntime 挖掘反哺**
   - agent candidate 与 prime candidate preview 分层。
   - evolution decision 进入 report 与 rescan impact 摘要。
   - 无 provider 时 degraded 证据清晰，不假装挖掘完成。

5. **做两条链路的渐进验证**
   - 后台链路先用 isolated fixture。
   - 前台链路用预置 runtime snapshots。
   - 最后才执行完整 bootstrap -> prime -> modify -> rescan -> prime 的闭环。

## 10. 结论

Alembic 现在的核心不是“把旧主线原样搬完”，而是把成熟能力重构成两个清晰闭环：

- **后台：AgentRuntime 项目挖掘链路**，负责生成、修复、演化和报告本地项目智能。
- **前台：prime/Codex 意志同步链路**，负责把当前任务现场变成可执行、可验证、低噪音的上下文注入。

只要这两条链路边界稳定，Alembic 就能先作为 Codex 插件独立跑起来；后续多 IDE、Dashboard、Wiki、delivery 都可以作为 adapter 接入，而不是反过来决定主线架构。
