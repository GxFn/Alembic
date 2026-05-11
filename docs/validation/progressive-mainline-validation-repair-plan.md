# Alembic 渐进式主线验证修复方案

本文档把 `progressive-chain-validation` skill 的工作方式落到新 Alembic 主线：先从真实源码推导链路，再逐节点验证；任何失败都只修当前节点，当前节点重新通过后才推进到下游。

这不是一次端到端 smoke test 计划。端到端只作为最后确认，不能替代节点级证据。

## 1. 目标与约束

目标：

- 为 Alembic 新主线设计可执行的验证修复方案，覆盖 Codex 插件入口、daemon bootstrap/rescan、mainline compile、内部 agent tools、AgentRuntime、知识生命周期、AI/embedding/vector 退化路径。
- 每条主线都要有可切断的节点、证据面、失败分类、首选修复模块和推进条件。
- 验证过程中发现缺口时，优先补源码中的观测点、边界测试和局部实现，而不是靠大命令跑通。

硬约束：

- Alembic 仓库本身是开发源码仓库，不是用户项目。验证计划默认不能在源码仓库根目录执行用户态 `alembic` bootstrap/rescan。
- 运行时数据、候选知识、报告、`.asd`、wiki、delivery 产物，必须先经过 `N0-data-location`，并写入隔离目录。
- 当前阶段不做前端验证；Dashboard/UI 只作为未来外部链路，不进入本轮修复闭环。
- Tool 按层分开：`lib/agent/tools` 是内部 AgentRuntime 使用的工具；`lib/codex/tools.ts` 是公开 MCP/Codex 工具。两者不能混用 envelopes，也不能用旧兼容层兜底。
- 全量端到端命令只能在组件节点通过后执行，且必须有 timeout、输出路径、挂起恢复规则。

## 2. N0 数据位置预检

本计划只授权源码阅读、文档维护、源码修复和聚焦测试。任何运行时写入需要执行者在具体 run 中重新声明真实路径。

```json
{
  "targetProjectRoot": "/Users/gaoxuefeng/Documents/AlembicTemp/Alembic",
  "sourceRepositoryRoot": "/Users/gaoxuefeng/Documents/AlembicTemp/Alembic",
  "plannedRunRoot": "/Users/gaoxuefeng/Documents/AlembicTemp/Alembic/scratch/chain-runs/<run-id>",
  "plannedRuntimeRoot": "/Users/gaoxuefeng/Documents/AlembicTemp/Alembic/scratch/chain-runs/<run-id>/isolated-runtime",
  "plannedDataRoot": "/Users/gaoxuefeng/Documents/AlembicTemp/Alembic/scratch/chain-runs/<run-id>/isolated-runtime/.asd",
  "writeMode": "source-repair-and-docs-only-until-a-concrete-run-root-is-declared",
  "sourceTreeMutationAllowed": true,
  "runtimeMutationAllowed": false,
  "adapter": "alembic",
  "adapterFacts": {
    "isAlembicDevRepo": true,
    "packageName": "alembic-ai",
    "codexPluginFirst": true,
    "ghostModePreferred": true,
    "frontendOutOfScope": true
  }
}
```

N0 通过标准：

- 能清晰区分 source repo、isolated fixture、runtime data root。
- 后续命令不会在源码根目录生成 `.asd`、`Alembic/candidates`、wiki、delivery 或用户项目文件。
- 若必须验证真实 bootstrap/rescan，先复制或构造外部 fixture，再通过 daemon 或测试 harness 注入 `projectRoot` 与 `dataRoot`。

## 3. 源码主线地图

### 主线 A：Codex 公开入口到 daemon job

源码路径：

```text
lib/codex/tools.ts
  -> enqueueCodexDaemonJob()
  -> lib/codex/daemon-client.ts
  -> lib/daemon/DaemonHttpBridge.ts
  -> lib/daemon/DaemonJobRunner.ts
  -> bin/daemon-server.ts
  -> ScanLifecycleRunner
  -> MainlineCompileSession
  -> DisabledWorkflowFinalizer
  -> JsonWorkflowReportStore
  -> job result
```

核心风险：公开工具返回“已排队/已完成”，但 daemon 鉴权、取消、进度、finalizer、report 或 scan 结果存在跳过却没有显式标记。

### 主线 B：mainline compile 与运行时读模型

源码路径：

```text
ScanLifecycleRunner
  -> MainlineCompileSession
  -> source scan / fingerprint / recipe markdown
  -> content mining / project intelligence
  -> source-ref repair / recipe impact
  -> search index / context index / vector snapshot
  -> MainlineWorkflowPersistence
```

核心风险：ContextIndex、SearchIndex、VectorStore、ProjectIntelligence、Recipe 文件索引之间不一致，导致 public tools 和 agent 上下文读到不同世界。

### 主线 C：内部 AgentRuntime 与 agent tools

源码路径：

```text
InternalColdStartWorkflow / InternalKnowledgeRescanWorkflow
  -> WorkflowBriefingBuilder
  -> AgentDimensionWorkflow
  -> AgentRuntime
  -> ToolRouter
  -> lib/agent/tools/*
  -> knowledge.submit / knowledge.manage
  -> finalizer/report
```

核心风险：内部工具能力迁移不完整、schema/risk/concurrency 不严格、AgentRuntime 在 provider 缺失时假成功，或者 candidate/decision 写入绕过 lifecycle store。

### 主线 D：公开 read/use/lifecycle tools

源码路径：

```text
lib/codex/tools.ts
  -> runCodexPrime / runCodexSearch / runCodexStructure / runCodexGuard
  -> runCodexKnowledgeTool / submitKnowledgeCandidate
  -> codexReadModelPaths / createMainlineWorkflowPersistence
  -> ContextIndex / SearchIndex / ProjectIntelligence / RecipeLifecycleStore
```

核心风险：公开工具误用内部 agent tool 层，或者在 snapshot 缺失、workspace 未初始化、输入非法时发生隐式写入。

### 主线 E：AI provider、embedding、vector、hybrid search

源码路径：

```text
createCodexRuntimeAiProviderFromEnv()
createCodexEmbeddingProviderFromEnv()
  -> AgentRuntime provider port
  -> MainlineEmbeddingPortBatchEmbedder
  -> MainlineCompileSearchMaterializer
  -> JsonMainlineVectorStore
  -> runCodexSearch hybrid path
```

核心风险：semantic/hybrid 被标记可用但没有 embedding provider 或 vector snapshot；AI provider 缺失时 agentFill 没有明确 degraded 证据。

## 4. 全局执行规则

- 当前游标从 `N0-data-location` 后进入单条主线的第一个节点。
- 每轮只推进一个节点到 terminal 状态；宽命令发现下游问题时，只能作为观察，不可把下游节点标记通过。
- 节点必须写清：假设、上游冻结输入、下游切断点、隔离方式、重置规则、证据、通过标准、失败分类、首选修复模块、复验命令。
- 如果源码没有办法切断节点，先补测试注入点或观测面，再继续执行。
- 修复只碰当前节点 owner；跨节点架构调整要拆成新的阻塞节点。

## 5. 主线 A 验证修复方案：公开入口到 daemon job

| 节点 | 验证假设 | 隔离与切断 | 证据 | 首选修复模块 |
| --- | --- | --- | --- | --- |
| A1-public-tool-contract | `alembic_codex_bootstrap/rescan` 只构造 job input 并 enqueue，不在 stdio 内执行 scan | fake daemon client；切断 daemon worker | 返回 job id、`nextAction`、payload 保留 `agentFill/maxAgentTasks/includeEvolution/changedFiles/removedFiles/diffTextByPath` | `lib/codex/tools.ts`, `lib/codex/daemon-client.ts` |
| A2-daemon-http-bridge | daemon health/job/cancel 路由稳定且 token 鉴权有效 | 只启动 HTTP bridge 或用 request harness；切断 JobRunner | 401/200、route schema、job list/status/cancel body | `lib/daemon/DaemonHttpBridge.ts` |
| A3-job-runner-lifecycle | job 状态从 queued/running 到 completed/failed/cancelled 可恢复 | fake `runWorkflowJob`；切断真实 scan | 状态转移、error message、cancel token、interrupted recovery | `lib/daemon/DaemonJobRunner.ts`, job store |
| A4-scan-lifecycle-boundary | `ScanLifecycleRunner` 能规范化输入、cleanup、compile、project、recommend，并正确处理中断 | isolated fixture；finalizer/report 切断 | phase 记录、cleanup report、compile request、summary/warnings | `lib/workflows/scan/ScanLifecycleRunner.ts` |
| A5-finalizer-policy | Codex 阶段 finalizer 明确记录 disabled，不写 delivery/wiki/panorama/semantic-memory | frozen scan result；只运行 finalizer | 四类步骤 `skipped` 与 reason | `lib/workflows/finalizer/WorkflowFinalizer.ts` |
| A6-report-store | report JSON/Markdown 能捕获 scan、agent、finalizer、warnings、recommendations | isolated reportsDir；冻结 scan/agent/finalizer 输入 | report id、路径、status、markdown 摘要 | `lib/workflows/report/WorkflowReportStore.ts` |
| A7-job-result-contract | daemon job result 不夸大跳过的 work，能区分 scan-only 与 agent-fill | fake workflow result；切断外部命令 | result shape、degraded/skipped 字段、report refs | `bin/daemon-server.ts`, `lib/daemon/*` |

第一轮执行顺序：A1 -> A2 -> A3 -> A6。A4 之后才允许进入 compile/agent 的真实隔离 fixture。

## 6. 主线 B 验证修复方案：compile 与运行时读模型

| 节点 | 验证假设 | 隔离与切断 | 证据 | 首选修复模块 |
| --- | --- | --- | --- | --- |
| B1-source-discovery | scanner 能稳定收集文件、排除低价值目录、处理大文件/二进制 | temp project；切断 materializer | file count、skip reason、content truncation | source scanner / compile session |
| B2-fingerprint-baseline | cold-start 写 baseline，rescan 无 baseline 时失败清晰 | isolated dataRoot；切断 agent | fingerprint snapshot、diff summary、missing-baseline error | `MainlineCompileSession` |
| B3-recipe-markdown-index | Recipe markdown 文件与 ContextIndex recipe refs 可互相恢复 | fixture recipes；切断 search | recipe file index、active ids、source refs | Recipe markdown materializer |
| B4-content-mining | content mining/lens 输出能进入 project docs 和 search docs | fixed source fixture；切断 vector | mined docs、lens hit、warnings | content mining modules |
| B5-project-intelligence | ProjectIntelligence artifact 可被 structure tool 读取 | frozen compile input；切断 public tool | artifact json、graph/meta 摘要 | project intelligence materializer |
| B6-source-ref-repair | rescan 能发现失效 SourceRef 并提出 repair/cleanup | baseline + changed/removed files | repair plan、removed refs、warning | source-ref repair |
| B7-recipe-impact | rescan 能把文件变化映射到 Recipe impact/evolution task | baseline + active recipes | impacted recipe ids、impact reason | recipe impact analyzer |
| B8-search-vector-persistence | SearchIndex 必写；VectorStore 有 provider 时写，无 provider/失败时显式 degraded | deterministic embedding provider 或 failing provider | `search-index.json`、`vector-index.json`、embedding failures | `MainlineCompileSearchMaterializer`, vector store |
| B9-restore-read-models | persistence 重建后能恢复 context/search/vector/project artifacts | 新建 persistence 实例读取同一 dataRoot | restored counts、missing snapshot status | `MainlineWorkflowPersistence` |

第一轮执行顺序：B8 和 B9 优先，因为它们直接支撑 public search/prime/guard，也能暴露 AI/vector 两个真实缺口。

## 7. 主线 C 验证修复方案：AgentRuntime 与内部 agent tools

| 节点 | 验证假设 | 隔离与切断 | 证据 | 首选修复模块 |
| --- | --- | --- | --- | --- |
| C1-provider-branch | 缺少 AI provider 时 agentFill 明确 degraded；有 provider 时创建 runtime port | stub env/fetch；切断真实模型 | provider status、degraded reason、model/baseURL | `lib/codex/ai-provider.ts` |
| C2-briefing-builder | WorkflowBriefingBuilder 能从 scan evidence 推导 tier、gap、impact、budget、allowed tools | frozen scan result；切断 AgentRuntime | briefing json、task order、gap/impact signals | `lib/workflows/agent/WorkflowBriefingBuilder.ts` |
| C3-task-planner | `maxAgentTasks/includeEvolution` 控制 dimension/evolution 任务 | frozen briefing；切断 tool calls | task ids、outputType、decision-only 标记 | `AgentDimensionWorkflow` |
| C4-runtime-session | AgentRuntime 消耗 briefing、预算、system prompt 和 tool schema，abort/timeout 可靠 | fake provider；fake tool router | messages、tool calls、final summary、abort evidence | `lib/agent/runtime/*` |
| C5-tool-router-contract | ToolRouter 只接受内部工具 schema，无旧兼容 fallback | registry/router focused tests | unknown tool error、schema error、risk/concurrency | `lib/agent/tools/registry.ts`, `router.ts` |
| C6-agent-tool-completeness | 内部 agent 所需 `code.*`、`terminal.execute`、`knowledge.*`、`runtime.*`、`graph.*`、`memory.*`、`meta.*` 能独立工作 | 每个 handler 用 fake dependencies；切断 daemon/public tools | 每个 tool 的正反例、中文注释覆盖关键行为 | `lib/agent/tools/*` |
| C7-knowledge-submit | agent 候选写入只能通过 injected lifecycle store | fake lifecycle store；切断 public publish | candidate record、source refs、no active search write | knowledge tool handler |
| C8-knowledge-manage | evolution/decision 任务只能产生 accept/reject/needs-review decision，不绕过 publish policy | fake candidate state | decision record、audit reason | knowledge manage handler |
| C9-agent-summary-report | agent forced summary、candidate counts、degraded reason 进入 workflow report | frozen runtime result | report agent section、warnings | agent workflow + report store |

Agent tool 层补齐原则：

- 内部工具必须全部从 `AgentToolDependencies` 注入能力，不直接读取 public Codex tool runtime。
- 每个 tool 要有正例、schema 失败、缺依赖/权限失败三类证据。
- `terminal.execute` 必须有 timeout、cwd 边界、输出截断和非交互约束。
- knowledge 写入工具不能直接改 active Recipe；active 化只能走 lifecycle publish。

## 8. 主线 D 验证修复方案：公开 read/use/lifecycle tools

| 节点 | 验证假设 | 隔离与切断 | 证据 | 首选修复模块 |
| --- | --- | --- | --- | --- |
| D1-public-internal-boundary | public MCP tools 不 import 内部 `lib/agent/tools`，只读 public persistence/read models | import graph scan；切断 runtime | forbidden import report | `lib/codex/tools.ts` |
| D2-status-diagnostics | status/diagnostics 不启动 daemon，不写 runtime | fake workspace state | initialized/uninitialized/pollution signals | `lib/codex/tools.ts` |
| D3-prime-read-only | prime 只读 ContextIndex/SearchIndex，不触发 scan | prebuilt snapshots | markdown/context hints、no writes | `lib/codex/prime.ts` |
| D4-search-sparse | snapshot 完整但无 embedding provider 时 sparse search 可用且有 warning | search/context fixture | hits、warnings、readiness | `lib/codex/search.ts` |
| D5-structure-read | structure 只读 ProjectIntelligence/graph artifacts | project artifact fixture | structure nodes/targets/files | structure tool |
| D6-guard-read-only | guard 只读 active guard Recipes 和显式目标文件，不扫全仓 | guard recipe fixture + temp files | pass/fail findings、invalid target error | `lib/codex/guard.ts` |
| D7-submit-candidate | public submit 只写 candidate，不进入 active search | isolated lifecycle store | candidate file、list output | `lib/codex/knowledge.ts` |
| D8-publish-reject-coherence | publish/reject 后 lifecycle、ContextIndex、SearchIndex、Recipe file index 一致 | candidate + active recipe fixture | active/rejected records、search visibility | knowledge lifecycle + persistence |

第一轮执行顺序：D1 -> D3 -> D4 -> D8。D1 是层边界守门，D8 是 public lifecycle 与 agent candidate 的汇合点。

## 9. 主线 E 验证修复方案：AI、embedding、vector、hybrid search

| 节点 | 验证假设 | 隔离与切断 | 证据 | 首选修复模块 |
| --- | --- | --- | --- | --- |
| E1-env-provider | 支持的 env 能创建 OpenAI-compatible runtime provider；不支持时返回缺失而非 mock 成功 | stub env/fetch | provider kind、model、baseURL、missing reason | `lib/codex/ai-provider.ts` |
| E2-tool-name-sanitization | OpenAI-compatible tool name sanitize 后能映射回内部 tool id | pure unit test | original/sanitized/reverse map | AI provider adapter |
| E3-embedding-provider | embedding env 能创建 embedding port；失败不阻塞 sparse index | fake embedding response/failure | vectors、failure count、warning | embedding provider |
| E4-vector-write-restore | compile 写入 vector snapshot 后 persistence 可恢复 | deterministic embedding provider | vector item count、ids、restore result | vector store |
| E5-public-hybrid-search | 只有 vector snapshot + embedding provider 同时存在才启用 hybrid；否则 sparse degraded | prebuilt snapshots + provider/no-provider | semantic mode、fusion reasons、warnings | `lib/codex/search.ts` |
| E6-provider-http-failure | provider HTTP error 能进入 degraded/fail policy，不挂死 workflow | fake fetch error/timeout | bounded error、retry/no retry reason | provider adapter/runtime |

E 线通过标准不是“有 AI 就行”，而是三种状态都明确：可用、缺失退化、失败可恢复。

## 10. 与 cold-start/rescan overlay 对齐

| Overlay 节点 | 新 Alembic 对应 | 状态 |
| --- | --- | --- |
| N0 data location | 本文 N0 + 各主线 isolated runtime 声明 | 保留 |
| N1 bootstrap/service lifecycle | A1/A2/A3 daemon + job runner | 拆分 |
| N2 entry params/semantic intent | A1 + A4 normalize | 保留 |
| N3 discovery/file collection | B1 | 保留 |
| N4 non-AI materialization | B3/B4/B5/B8 sparse path | 保留 |
| N5 rescan snapshot/cleanup | B2/B6/B7 | 保留 |
| N6 dimension plan | C2/C3 | 保留 |
| N7 session/task manager | C3/C4 + A3 job runner | 替换旧实现 |
| N8 stage factory/tool policy | C5/C6 | 保留并强化 |
| N9 agent analyze quality | C4/C9 | 保留 |
| N10 evolve/prescreen | C8 + B7 | 保留 |
| N11 produce | C7 candidate submit | 保留 |
| N12 consumers/dedup/persistence | D8 + B9 | 保留 |
| N13 finalizer policy | A5/C9 | 暂时 disabled，但必须显式记录 |
| N14 report/snapshot/history | A6/A7 | 保留 |

## 11. 本轮建议拆分窗口

窗口 1：公开入口与 daemon 边界

- 负责 A1/A2/A3/A7。
- 只改 `lib/codex/*`、`lib/daemon/*`、daemon focused tests。
- 交付：公开工具 job contract、daemon bridge auth、job lifecycle 的节点证据。

窗口 2：compile、persistence、vector

- 负责 B1/B2/B8/B9/E3/E4。
- 只改 mainline compile、persistence、search/vector materializer 相关模块。
- 交付：isolated dataRoot fixture 下的 context/search/vector restore 证据。

窗口 3：AgentRuntime 与内部 agent tools

- 负责 C2/C4/C5/C6/C7/C8。
- 只改 `lib/agent/runtime/*`、`lib/agent/tools/*`、agent workflow focused tests。
- 交付：内部 tool 完整性矩阵、schema/risk/concurrency 失败证据、candidate 写入证据。

窗口 4：public read/use/lifecycle

- 负责 D1/D3/D4/D6/D8/E5。
- 只改 public Codex tool 层、guard/search/knowledge focused tests。
- 交付：public/internal boundary、prime/search/guard/lifecycle 一致性证据。

主控窗口保留职责：

- 维护 `scratch/chain-runs/<run-id>/report/plan.md` 的当前节点状态。
- 合并各窗口证据，决定游标推进。
- 防止同一文件被多个窗口并行修改。

## 12. 第一批执行清单

优先做这些节点，因为它们能最快暴露新 Alembic 当前缺口，同时不会写运行时数据到源码根：

1. `D1-public-internal-boundary`：用 import graph/rg 证明 public tools 和 internal tools 分层。
2. `C5-tool-router-contract`：补 internal tool schema、unknown tool、concurrency/risk 的聚焦测试。
3. `C6-agent-tool-completeness`：逐个核对 agent tools 是否完整迁移；缺工具先补 handler 与注入依赖。
4. `B8-search-vector-persistence`：验证 sparse 必写、vector 可选、embedding failure 不阻塞。
5. `E5-public-hybrid-search`：验证 hybrid 只在 vector + provider 同时满足时启用。
6. `A6-report-store`：报告必须能表达 skipped/degraded，而不是只表达 success。
7. `A1-public-tool-contract`：确认 public bootstrap/rescan 只 enqueue，不在 stdio 内跑长任务。

完成第一批后，再进入隔离 fixture 的 cold-start/rescan confirmation。

## 13. 不进入本轮的内容

- 前端 Dashboard 和交互 UI。
- 旧 Alembic 兼容层、旧 service container、旧 tool adapter 的逐行迁移。
- delivery/wiki/panorama/semantic-memory 的真实产物生成；当前只验证 disabled finalizer 是否诚实记录。
- 在源码仓库根目录运行用户态 bootstrap/rescan 并把结果当成通过证据。

这些内容不是永久放弃，而是不应该阻塞 Codex 插件主线、内部 agent tool 层、AgentRuntime、冷启动/增量扫描链路的验证修复闭环。

## 14. 下一步落地方式

下一轮执行应创建具体 run id，例如：

```text
pcv-20260511-<chain-slug>
```

然后把本文拆成该 run 的执行状态机：

```text
scratch/chain-runs/<run-id>/report/plan.md
```

执行时从第一批清单的 `D1-public-internal-boundary` 或 `C5-tool-router-contract` 开始。任何失败都记录在当前节点，先修当前节点，再复验同一节点，最后才推进到下一节点。
