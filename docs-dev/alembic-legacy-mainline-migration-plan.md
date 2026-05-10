# Alembic Legacy 新主线迁移与裁剪方案

日期：2026-05-10

## 结论

新仓库 `Alembic` 不应承接 `Alembic-legacy` 的完整平台形态。迁移目标是把 legacy 已经跑通的新主线抽出来，做成面向 AI IDE 的插件 runtime。第一阶段只做 Codex 插件。

核心保留链路是：

```text
Codex Plugin
  -> lightweight MCP shim
  -> daemon on demand
  -> tools
  -> workflows / agent
  -> mainline
```

`agent / tools / workflows / mainline` 都是主线，不是旧包袱。但它们进入新仓库时必须瘦身：只保留服务 Codex 插件、项目知识、Recipe、Guard、bootstrap/rescan job、prime 注入的高频闭环。

## 迁移原则

1. 新仓库不做 legacy 兼容平台，只做插件化 Alembic runtime。
2. 先服务 Codex，后续再复用同一套 agent-plugin profile 做 VS Code、Cursor、Claude Code。
3. Ghost mode 是默认模式，插件安装和初始化不得污染用户项目。
4. Codex 插件只暴露 agent tier，publish/deprecate/admin 放到 Dashboard 或显式 admin 模式。
5. 长任务必须由 daemon + JobStore 承载，不能绑在 MCP stdio 生命周期上。
6. 查询和 prime 不扫 Markdown，运行期只读 SQLite ContextIndex 和 SearchIndex snapshot。
7. Markdown 是人和 AI 可维护的外显真相，DB 是运行期索引缓存。
8. 低频能力保留为 advanced/manual 的参考，不进入新仓库第一阶段。

## 新仓库目标形态

```text
Alembic/
  bin/
    alembic.ts
    alembic-codex-mcp.ts
    daemon-server.ts
  lib/
    mainline/
    tools/
    workflows/
    agent/
    daemon/
    external/
      mcp/
      ai/
    platform/
    config/
  plugins/
    alembic-codex/
  skills/
    alembic/
    alembic-recipes/
    alembic-create/
    alembic-guard/
    alembic-structure/
    alembic-devdocs/
  dashboard/
  resources/
    vscode-ext/        # 后续，不作为 Codex 首批阻塞
  docs-dev/
```

第一批不要创建 `service/` 作为大杂烩。确实需要从 legacy 搬来的执行器，应放进更明确的目录：

- Guard 执行器如果暂时无法主线化，可放 `lib/guard/`，不要恢复 `service/guard`。
- Provider transport 可放 `lib/external/ai/`，由 `mainline/ai` 端口约束。
- Dashboard HTTP route 可放 `lib/http/`，但默认读 mainline read model。

## 必须迁移的主线内容

### 1. Codex 插件外壳

来源：

- `plugins/alembic-codex/`
- `docs-dev/skills-plugins/codex-plugin-transition-design.md`
- `docs-dev/skills-plugins/codex-plugin-local-install-status.md`

目标：

```text
plugins/alembic-codex/
  .codex-plugin/plugin.json
  .mcp.json
  README.md
  RELEASE-PLAYBOOK.md
  skills/
  assets/
```

必须保留：

1. `alembic_codex_diagnostics`
2. `alembic_codex_status`
3. `alembic_codex_init`
4. `alembic_codex_dashboard`
5. `alembic_codex_bootstrap`
6. `alembic_codex_rescan`
7. `alembic_codex_job`
8. `alembic_codex_cleanup`

关键行为：

- MCP 启动轻，不初始化 DB，不启动 daemon。
- status/diagnostics 不启动 daemon。
- init 默认 Ghost profile，不写 `.cursor`、`.vscode/mcp.json`、`AGENTS.md`、`.env`。
- bootstrap/rescan 返回 durable job id。
- cleanup dry-run first，不删除知识数据。

### 2. Daemon 与 Job

来源：

- `lib/daemon/*`
- `docs-dev/skills-plugins/codex-plugin-transition-design.md`
- `docs-dev/mainline-core-connectivity-audit.md`

目标：

```text
lib/daemon/
  DaemonSupervisor.ts
  DaemonState.ts
  JobStore.ts
  DaemonHttpBridge.ts
```

必须保留：

- dynamic localhost port。
- `daemon.json` / `daemon.pid` / lock / log。
- health 校验 `projectRoot`、`dataRoot`、`projectId`、version、schema。
- `/api/v1/mcp/call` 本地 token bridge。
- `/api/v1/jobs/*` 查询、取消、恢复。
- daemon 重启时 active job 必须变成 recoverable failed，不能永久 running。

第一阶段不做：

- 多项目单 daemon。
- 远程 daemon。
- 自动 idle shutdown。
- 分布式 job。

### 3. Mainline 编译期

来源：

- `lib/mainline/core`
- `lib/mainline/data`
- `lib/mainline/code`
- `lib/mainline/graph`
- `lib/mainline/compile`
- `docs-dev/mainline-round7-implementation-plan.md`
- `docs-dev/mainline-round8-implementation-plan.md`
- `docs-dev/mainline-round9-gap-analysis-and-agent-split.md`

必须迁移：

```text
lib/mainline/
  core/
  data/
  code/
  graph/
  compile/
  knowledge/
  search/
  runtime/
  agent/
  ai/
  legacy/              # 只保留必要 mapper，不放新逻辑
```

编译期最小闭环：

```text
Project files / diff
  -> MainlineCompileSession
  -> ProjectIntelligence artifact
  -> Recipe / SourceRef / RecipeEdge
  -> RecipeMarkdownStore
  -> SqliteContextIndex
  -> SearchIndexSnapshot
```

必须保留的关键类：

- `MainlineCompileSession`
- `ProjectIntelligenceRunner`
- `ProjectIntelligenceArtifactStore`
- `RecipeMarkdownCodec`
- `RecipeMarkdownStore`
- `RecipeMarkdownSyncService`
- `RecipeSubmissionPolicy`
- `RecipeSimilarityPolicy`
- `RecipeQualityPolicy`
- `RecipeImpactAnalyzer`
- `RecipeEvidenceLinker`
- `MainlineDecayPolicy`
- `MainlineReverseHealthCheck`
- `SourceRefRepairService`
- `SqliteContextIndex`
- `SearchIndexStore`

不要迁移：

- 旧 `KnowledgeEntry` 作为运行期实体。
- 旧 DB-first repository 体系。
- 旧 SearchEngine 自动 fallback。
- 旧 CodeEntityGraph repository 写入路径。
- 旧 ReverseGuard 自动优化闭环。

### 4. Mainline 运行期

来源：

- `lib/mainline/runtime`
- `lib/mainline/agent`
- `docs-dev/mainline-core-connectivity-audit.md`

运行期最小闭环：

```text
ActiveWorkContext
  -> RuntimeContextLoader
  -> RuntimeRetrievalPipeline
  -> ContextBundleBuilder
  -> RuntimeRecipeRanker
  -> RecipeInjectionCompressor
  -> AgentInjectionPlanner
  -> Codex markdown/context
```

必须保留：

- `alembic_task operation=prime` mainline-first。
- `files / symbols / diff / errors / diagnostics` 上下文信号。
- Recipe relation expansion 会补齐 neighbor Recipe 内容。
- stale SourceRef、reverse health、decay score 只降权，不删除。
- do/dont/when/coreCode/usageGuide 进入注入输出，但必须压缩。

第一阶段不要恢复：

- CrossEncoder。
- CoarseRanker。
- MultiSignalRanker。
- 每次运行扫 Markdown。
- 完整 Wiki 文档生成。

### 5. Tools V2

来源：

- `lib/tools/v2`
- `docs-dev/tool-system/tool-system-v2.md`

迁移目标：

```text
lib/tools/
  v2/
    registry.ts
    router.ts
    adapter/
    handlers/
    compressor/
    capabilities/
```

保留 6 个资源导向工具：

1. `code`
2. `terminal`
3. `knowledge`
4. `graph`
5. `memory`
6. `meta`

关键要求：

- V2 直接接管，不恢复 60+ V1 工具。
- 输出压缩器保留在 tools 层，不搬进 mainline。
- terminal capability 保留，但必须继续走 sandbox / policy。
- `knowledge.search` 默认 mainline-only；legacy 搜索必须显式 legacy mode，第一阶段可以不带。

### 6. Workflows

来源：

- `lib/workflows/cold-start`
- `lib/workflows/knowledge-rescan`
- `lib/workflows/capabilities/mainline`
- `docs-dev/workflows-scan/four-scan-pipelines-reorganization-plan.md`
- `docs-dev/workflows-scan/rescan-pipeline-isolation-and-cancellation.md`
- `docs-dev/workflows-scan/bootstrap-rescan-chain-test-plan.md`

新仓库不要恢复旧 “bootstrap 万能入口”。第一阶段只落三条：

```text
lib/workflows/
  mainline/
    MainlineWorkflowEntrypoint.ts
  cold-start/
  rescan/
  scan/                # 共享 lifecycle kernel，先轻量
```

后续可演进为：

```text
scan/
cold-start/
deep-mining/
incremental-correction/
maintenance/
```

第一阶段迁移口径：

- cold-start 建 baseline。
- rescan 做增量刷新和 impact/evolution signal。
- internal job 由 daemon 承载。
- external Mission Briefing 可保留，但 Codex 第一阶段优先 internal job + prime/guard。
- rescan finalizer 必须轻量，不能复用 cold-start 的 wiki/delivery/semantic memory 全链路。

必须保留：

- cancel 不只看 session running，finalize 阶段也要尊重 userCancelled。
- rescan 跳过 wiki、delivery、semantic memory 默认副作用。
- bootstrap/rescan 长链路按 N0-N14 节点验证。

第一阶段不迁：

- 四条管线完整目录化重拆。
- deep-mining 独立 agent profile。
- maintenance recommendation scheduler。
- deprecated-cold-start 兼容目录。

### 7. Agent

来源：

- `lib/agent`
- `docs-dev/agent-runtime/*`
- `docs-dev/mainline-legacy-detail-logic-inventory.md`

保留原因：

`agent` 是内部 bootstrap/rescan 内容生产和 evolution audit 的执行层，不是可删除旧层。

迁移口径：

- 保留 AgentRuntime 主循环，但冻结扩张。
- 产物必须进入 `RecipeSubmission -> RecipeSubmissionPolicy -> Recipe -> Markdown/SQLite/SearchIndex`。
- session-level dedup 必须接主线 similarity。
- BudgetController、ContextWindow、OutputCompressor 这类稳定能力保留。
- ToolForge 不进默认路径。

不要迁移：

- AI mock bootstrap pipeline。
- Semantic memory 作为默认 completion。
- AgentRuntime 继续长成通用 agent 平台。

## 必须丢弃或后置的内容

| 内容 | 处置 | 理由 |
| --- | --- | --- |
| WikiGenerator 默认生成 | 后置 advanced/manual | 低频，拖慢 completion |
| ToolForge | 后置 experimental | 动态工具风险高，不服务 Codex 首批 |
| ReverseGuard 自动优化 | 后置 advanced audit | 保留报告型 health，不自动 proposal |
| Panorama 全控制台 | 后置 Dashboard advanced | 主线已有 ProjectIntelligence summary |
| SemanticMemory completion | 不进第一阶段 | 会形成第三条主线 |
| Lark / remote command | 不迁 | 不服务 AI IDE 插件 MVP |
| Remote Recipe Repo | 不迁 | 共享知识后置 |
| Xcode snippets | 不迁 | 插件 MVP 不需要 |
| VS Code extension 发布链 | 后置 | Codex 插件先行 |
| Plugin Factory | 后置 | 方向有价值，但不是迁移第一阶段 |
| HNSW / vector compression | 后置 | sparse + optional embedding 足够首批 |
|旧 dashboard governance 边缘接口| 不迁或空状态 | 使用频率低，阻碍脱胎 |

## 新仓库第一阶段目录建议

```text
lib/
  mainline/
  tools/
  workflows/
    mainline/
    cold-start/
    rescan/
    scan/
  agent/
  daemon/
  external/
    mcp/
    ai/
  guard/
  http/
  platform/
  config/
plugins/
  alembic-codex/
skills/
dashboard/
scripts/
test/
```

不要新建：

- `lib/service/`
- `lib/repository/knowledge/` 的旧 DB-first 形态
- `lib/workflows/deprecated-cold-start/`
- `lib/core/analysis/` 旧 AST 大平台
- `lib/infrastructure/vector/` 旧向量体系

## 迁移批次

### Batch 0：仓库骨架

目标：新仓库可安装、可构建、可运行空诊断。

动作：

1. 创建 package、tsconfig、vitest、biome。
2. 创建 `docs-dev` 和本迁移文档。
3. 引入最小 CLI bin。
4. 加 `verify:codex-plugin` 脚本占位。

验收：

```bash
npm run typecheck
npm run test:unit
```

当前状态：已完成。新仓库已有 `package.json`、`tsconfig.json`、`vitest.config.ts`、`biome.json`、`.gitignore`、README、验证脚本和本迁移文档。

### Batch 1：Codex 插件 shim

目标：Codex 可以安装插件，diagnostics/status 不启动 daemon。

动作：

1. 搬 `plugins/alembic-codex`。
2. 搬 `alembic-codex-mcp`。
3. 搬 codex status/diagnostics/init tools。
4. 搬 Ghost setup profile 的最小实现。

验收：

```bash
npm run verify:codex-plugin
npx -y --prefix /tmp --package ./ alembic-codex-mcp
```

当前状态：已完成首段。已经迁入 Codex plugin manifest、MCP config、skills、assets、README、release playbook，并实现 `alembic_codex_diagnostics`、`alembic_codex_status`、`alembic_codex_init` 的轻量 MCP/CLI runtime。`dashboard/bootstrap/rescan/job/cleanup` 仍留给 Batch 2/4/5 接 daemon 和 mainline。

### Batch 2：Daemon + JobStore

目标：Dashboard/bootstrap/rescan 可按需唤醒本地 daemon。

动作：

1. 搬 `DaemonSupervisor`、JobStore、daemon state。
2. 搬本地 HTTP health、ready、mcp bridge、jobs route。
3. 搬 dashboard 启动和 URL 返回。

验收：

```bash
alembic daemon start --dir <fixture> --json
alembic daemon status --dir <fixture> --json
alembic daemon stop --dir <fixture>
```

### Batch 3：Mainline 数据与运行期

目标：prime 可以从主线 ContextIndex/SearchIndex 返回 ContextBundle。

动作：

1. 搬 `mainline/core/data/knowledge/search/runtime/agent`。
2. 搬 Recipe Markdown codec/store/sync。
3. 搬 RuntimeContextLoader、MainlinePrimeRunner。
4. 搬 `alembic_task prime` handler。

验收：

```bash
npx vitest run test/unit/MainlineRuntime.test.ts
npx vitest run test/unit/MainlineRecipeMarkdownStore.test.ts
```

### Batch 4：Compile + workflows

目标：bootstrap/rescan job 能写主线 artifact、Recipe、SourceRef、SearchIndex。

动作：

1. 搬 `MainlineCompileSession` 与 ProjectIntelligence。
2. 搬 cold-start/rescan mainline workflow entrypoint。
3. 搬 RecipeImpact、Decay、EvidenceLinker。
4. 接 daemon job。

验收：

```bash
npx vitest run test/unit/MainlineCompileSession.test.ts
npx vitest run test/unit/MainlineWorkflowEntrypoint.test.ts
npx vitest run test/unit/KnowledgeRescanPlan.test.ts
```

### Batch 5：Tools V2 + Guard

目标：Codex 可以 search/submit/guard，写完代码后有主线 Guard 修复建议。

动作：

1. 搬 tools v2 registry/router/handlers。
2. 搬 GuardCheckEngine 到 `lib/guard`。
3. 搬主线 guard-rule Recipe 注入。
4. 搬 `alembic_submit_knowledge` 同步 Markdown/SQLite/SearchIndex。

验收：

```bash
npx vitest run test/unit/V2ToolSystem.test.ts
npx vitest run test/unit/MainlineGuardRules.test.ts
npx vitest run test/unit/MainlineRecipeSubmissionPolicy.test.ts
```

### Batch 6：真实 Codex smoke

目标：证明新仓库已经脱离 legacy。

流程：

```text
diagnostics
status
init ghost
bootstrap job
job status
submit knowledge
prime
edit fixture
close
guard
rescan job
dashboard URL
cleanup dry run
```

验收：

- 项目目录没有 `.asd`、`Alembic`、`.cursor`、`.vscode/mcp.json`、`.env`。
- dataRoot 有 Markdown、SQLite、SearchIndex、ProjectIntelligence artifact。
- Codex 新提交 Recipe 立即能 prime 召回。
- daemon 重启后 job 不永久 running。

## 裁剪检查清单

迁移每个文件前必须回答：

1. 是否服务 Codex 插件第一阶段？
2. 是否在 `agent / tools / workflows / mainline` 主链上？
3. 是否可由 mainline ContextIndex/SearchIndex 替代旧服务？
4. 是否默认触发长任务或项目写入？
5. 是否有 Ghost mode 项目污染风险？
6. 是否需要 daemon 生命周期，而不是 MCP stdio 生命周期？
7. 是否可以降为 advanced/manual？

任一答案指向低频或副作用不清，就不进第一阶段。

## 源文档索引

本方案基于 legacy 中这些文档整理：

- `docs-dev/rearchitecture/README.md`
- `docs-dev/rearchitecture/04-pruning-and-migration-plan.md`
- `docs-dev/rearchitecture/06-legacy-pruning-execution-map.md`
- `docs-dev/mainline-remaining-implementation-board.md`
- `docs-dev/mainline-two-round-migration-plan.md`
- `docs-dev/mainline-replacement-and-retirement-map.md`
- `docs-dev/mainline-core-connectivity-audit.md`
- `docs-dev/mainline-legacy-detail-logic-inventory.md`
- `docs-dev/skills-plugins/codex-plugin-transition-design.md`
- `docs-dev/skills-plugins/codex-plugin-local-install-status.md`
- `docs-dev/tool-system/tool-system-v2.md`
- `docs-dev/workflows-scan/four-scan-pipelines-reorganization-plan.md`
- `docs-dev/workflows-scan/rescan-pipeline-isolation-and-cancellation.md`
- `docs-dev/workflows-scan/bootstrap-rescan-chain-test-plan.md`

## 下一步

1. 搬 `lib/daemon` 的 supervisor/state/job store/http bridge，补 `alembic_codex_bootstrap`、`alembic_codex_rescan`、`alembic_codex_job` 的 durable job shell。
2. 搬 mainline runtime 的 ContextIndex/SearchIndex/Recipe retrieval，让 `prime` 先能从主线读空或 fixture knowledge。
3. 再接 compile/workflows，把 bootstrap/rescan job 写入 Recipe Markdown、SQLite、SearchIndex。
4. 每搬一个批次都删除隐式 legacy fallback，不允许新仓库长出旧平台。
