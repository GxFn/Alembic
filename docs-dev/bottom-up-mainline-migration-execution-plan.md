# Alembic Bottom-up 主线迁移执行计划

日期：2026-05-10

## 目标

接下来的迁移从底层向上层推进，先稳定数据模型、存储、索引和端口，再接 runtime、daemon、tools、workflows、MCP。这样每一层都有明确依赖和验收门，不再从插件入口反向追旧系统。

当前已经完成的是 Codex 插件外壳和轻量 MCP/CLI shim。后续迁移必须从 `lib/mainline` 底层开始，插件层只在对应底层可用后接线。

## 总依赖梯

```text
L0 workspace/profile foundation
  -> L1 mainline core primitives
  -> L2 knowledge model and markdown codec
  -> L3 data stores and search snapshot
  -> L4 code/graph/project intelligence read model
  -> L5 runtime retrieval and prime injection
  -> L6 daemon and durable jobs
  -> L7 tools v2 and guard
  -> L8 workflows bootstrap/rescan
  -> L9 Codex MCP tool wiring and smoke
```

执行规则：

1. 每层只能依赖更低层或同层纯类型，不能依赖 workflows、service、repository 旧层。
2. 每层必须有独立测试和一个可运行 smoke。
3. 能保留为纯类型、纯算法、codec、store 的文件优先迁移。
4. 任何需要旧 `service/*`、旧 `repository/*`、Wiki、SemanticMemory、ToolForge 的实现先拒绝进入第一阶段。
5. 新代码需要补关键中文注释，尤其是写边界、Ghost mode、daemon/job 生命周期、索引一致性这些非显然逻辑。

## 只读盘点确认

这份计划已经对照 legacy 做了两轮只读盘点，关键结论如下：

- `core/MainlineKernel.ts` 是装配根，会拉入 code/data/graph/search，不能作为 core 第一批迁移。
- `knowledge/SourceRefRepairService.ts` 和 `RecipePathRepairer.ts` 反向依赖 compile 类型，必须后置或拆出底层 repair plan 类型。
- `legacy/LegacyMappers.ts` 直接 import 旧 repository 类型，只能作为迁移膜或一次性导入工具，不能进入 runtime 热路径。
- `ai` 里的 provider/gateway bridge 应后置；第一阶段只迁 port、policy、registry，不迁外部 provider 网关。
- `tools/v2` 的 router/types 可以较早迁，但 `knowledge.search` 和 `knowledge.submit` 必须等 mainline runtime 与 RecipeGateway 可用。
- `daemon` 的 state/job store 依赖较薄，可以在 workspace/dataRoot 稳定后迁；`DaemonJobRunner.ts` 必须等 workflow handler 闭环后再接。
- `workflows` 依赖完整 `MainlineCompileSessionResult`，不能在 compile/runtime 之前迁执行层。

## L0：Workspace/Profile Foundation

状态：已完成首版。

现有文件：

- `lib/codex/workspace.ts`
- `lib/codex/tools.ts`
- `bin/cli.ts`
- `bin/codex-mcp.ts`

职责：

- 解析 projectRoot。
- 管理 `~/.asd/projects.json`。
- 默认 Ghost mode，把数据写到用户目录下的 workspace。
- diagnostics/status/init 不启动 daemon。

后续只允许补：

- profile schema。
- dataRoot version marker。
- 运行期路径 helper。

不允许在 L0 补：

- bootstrap/rescan 逻辑。
- Recipe 或 DB 写入。
- daemon 自动启动。

## L1：Mainline Core Primitives

来源：

- `Alembic-legacy/lib/mainline/core/*`

第一批迁移：

- `assert.ts`
- `Errors.ts`
- `time.ts`
- `Hashing.ts`
- `PathIdentity.ts`
- `Markdown.ts`
- `TextAnalysis.ts`
- `GeneratedProjectFiles.ts`
- `WorkspacePaths.ts`
- `WriteBoundary.ts`
- `AtomicFileStore.ts`
- `JsonStores.ts` 的依赖准备，不直接放 core

第二批迁移：

- `FileSystemPort.ts`
- `ConfigPort.ts`
- `LoggerPort.ts`
- `Environment.ts`
- `OperationScope.ts`
- `DirectoryLock.ts`
- `Concurrency.ts`
- `Scheduler.ts`
- `Lifecycle.ts`
- `SingletonRegistry.ts`

暂缓迁移：

- `MainlineKernel.ts`：它会拉入 code/data/graph/search，等 L4 后再接。
- `GitPort.ts`：先作为 port，真实 git 行为等 compile/workflow。
- `FileWatch.ts`：首批不需要常驻 watcher。
- `WorkerPool.ts`：compile 有并发需求时再迁。

验收：

```bash
npm run typecheck
npm run test:unit -- --runInBand
```

新增测试建议：

- path normalize 不逃逸 projectRoot。
- WriteBoundary 拒绝项目污染和越界写。
- AtomicFileStore 写入是原子替换。

## L2：Knowledge Model and Markdown Codec

来源：

- `Alembic-legacy/lib/mainline/knowledge/*`

第一批迁移：

- `Recipe.ts`
- `RecipeKnowledgePayload.ts`
- `RecipeEdge.ts`
- `SourceRef.ts`
- `ContextBundle.ts`
- `GuardFinding.ts`
- `EvidencePackage.ts`
- `DimensionLens.ts`
- `RecipeSubmission.ts`
- `RecipeSubmissionAdmission.ts`
- `RecipeQualityPolicy.ts`
- `RecipeSimilarityPolicy.ts`
- `RecipeSubmissionPolicy.ts`
- `RecipeMarkdownCodec.ts`

第二批迁移：

- `RecipeMarkdownStore.ts`
- `RecipeMarkdownSyncService.ts`
- `RecipePathRepairer.ts`

暂缓迁移：

- `SourceRefRepairService.ts`：依赖 compile/graph，放到 L4/L8。

注意：

- `RecipeQualityPolicy.ts` 依赖 `code/LanguageCatalog.ts`，可以先迁轻量 language catalog 或改成 port。
- `RecipeMarkdownCodec.ts` 需要 `js-yaml`。迁移时要同步 `package.json` 依赖。

验收：

```bash
npm run test:unit -- RecipeMarkdownCodec
npm run test:unit -- RecipeSubmissionPolicy
```

## L3：Data Stores and Search Snapshot

来源：

- `Alembic-legacy/lib/mainline/data/*`
- `Alembic-legacy/lib/mainline/search/*`

第一批迁移：

- `JsonStores.ts`
- `ArtifactStores.ts`
- `ContextIndex.ts`
- `ContextIndexInvalidation.ts`
- `FileFingerprintSnapshotStore.ts`
- `JobLedger.ts`
- `SearchIndex.ts`
- `SearchProjection.ts`
- `SearchIndexStore.ts`
- `TextTokenizer.ts`
- `FieldWeightedScorer.ts`
- `RrfFusion.ts`
- `HybridSearch.ts`

第二批迁移：

- `SqliteContextIndex.ts`
- `DatabasePort.ts`

暂缓或改写：

- `VectorStore.ts`：第一阶段只保留接口或 no-op，不引入 HNSW/vector compression。

注意：

- `SqliteContextIndex.ts` 依赖 `better-sqlite3`，迁移前必须确认 Node 22、本地构建和 npm 包发布体积。
- SearchIndex snapshot 是运行期默认读路径，不能 fallback 到扫 Markdown。

验收：

```bash
npm run test:unit -- SearchIndex
npm run test:unit -- SearchIndexStore
npm run test:unit -- SqliteContextIndex
```

## L4：Code / Graph / Project Intelligence Read Model

来源：

- `Alembic-legacy/lib/mainline/code/*`
- `Alembic-legacy/lib/mainline/graph/*`
- `Alembic-legacy/lib/mainline/compile/ProjectIntelligence*`

状态：进行中。

第一批迁移：

- `LanguageCatalog.ts`
- `AstPort.ts`
- `LanguageServicePort.ts`
- `MainlineImportParser.ts`
- `MainlineImportPathResolver.ts`
- `MainlineSymbolTableBuilder.ts`
- `SourceFileScanner.ts`
- `StructuralAstParser.ts`
- `ProjectGraph.ts`
- `ProjectIntelligenceArtifact.ts`
- `ProjectIntelligenceQueries.ts`

第二批迁移：

- `ProjectIntelligenceArtifactStore.ts`
- `ProjectIntelligenceArtifactMerge.ts`
- `ProjectIntelligenceMaterializer.ts`

暂缓迁移：

- full compile session。
- content mining。
- panorama summary。
- `ProjectIntelligenceRunner.ts`：它会把扫描、build、store 和 runtime 写入串成编排层，等 L5/L6 后再接。
- `ProjectIntelligenceIncrementalPlanner.ts`：先不迁完整 planner；本批 artifact merge 只保留需要的只读 plan shape，避免 L4 反向拉入文件指纹增量编排。

验收：

```bash
npm run test:unit -- ProjectIntelligence
npm run test:unit -- MainlineSymbolTableBuilder
```

## L5：Runtime Retrieval and Prime

来源：

- `Alembic-legacy/lib/mainline/runtime/*`
- `Alembic-legacy/lib/mainline/agent/MainlinePrimeRunner.ts`
- `Alembic-legacy/lib/mainline/agent/AgentInjectionPlanner.ts`
- `Alembic-legacy/lib/mainline/agent/AgentContextPresenter.ts`

迁移顺序：

1. `ActiveWorkContextBuilder.ts`
2. `MainlineQueryPlanner.ts`
3. `RuntimeContextLoader.ts`
4. `RuntimeRecipeRanker.ts`
5. `GraphExpansion.ts`
6. `ContextBundleBuilder.ts`
7. `RuntimeRetrievalPipeline.ts`
8. `RecipeInjectionCompressor.ts`
9. `AgentInjectionPlanner.ts`
10. `MainlinePrimeRunner.ts`

要求：

- runtime 只能读 ContextIndex/SearchIndex/Recipe store。
- 不允许每次 prime 扫 Markdown。
- stale SourceRef 只降权，不删除。
- 注入输出要保留 do/dont/when/coreCode/usageGuide，但必须压缩。

验收：

```bash
npm run test:unit -- RuntimeRetrievalPipeline
npm run test:unit -- MainlinePrimeRunner
```

## L6：Daemon and Durable Jobs

来源：

- `Alembic-legacy/lib/daemon/*`

迁移顺序：

1. `DaemonState.ts`
2. `JobStore.ts`
3. `DaemonSupervisor.ts`
4. `DaemonJobRunner.ts`
5. HTTP bridge routes

要求：

- MCP stdio 不承载长任务。
- bootstrap/rescan/dashboard 只按需启动 daemon。
- active job 在 daemon 重启后不能永久 running。
- job cancel 必须贯穿 prepare/run/finalize。

验收：

```bash
node dist/bin/cli.js daemon start --json
node dist/bin/cli.js daemon status --json
node dist/bin/cli.js daemon stop --json
```

## L7：Tools V2 and Guard

来源：

- `Alembic-legacy/lib/tools/v2/*`
- `Alembic-legacy/lib/service/guard` 中必要执行器

迁移顺序：

1. `types.ts`
2. `registry.ts`
3. `router.ts`
4. `compressor/*`
5. handlers: `knowledge`, `code`, `graph`, `memory`, `meta`
6. `terminal` capability 最后接 sandbox/policy
7. Guard rule check 只接 mainline Recipe

要求：

- 不恢复 V1 60+ tools。
- knowledge search 默认 mainline-only。
- terminal 必须继续经过 policy。

## L8：Workflows Bootstrap / Rescan

来源：

- `Alembic-legacy/lib/workflows/cold-start/*`
- `Alembic-legacy/lib/workflows/knowledge-rescan/*`
- `Alembic-legacy/lib/workflows/capabilities/mainline/*`

迁移顺序：

1. shared scan lifecycle。
2. cold-start baseline。
3. rescan incremental plan。
4. compile session 写 Recipe/SourceRef/SearchIndex。
5. daemon job 接线。

要求：

- 不恢复 deprecated-cold-start。
- rescan 默认跳过 wiki/delivery/semantic memory。
- finalizer 必须尊重 cancel。

## L9：Codex MCP Wiring and Smoke

接线顺序：

1. `alembic_codex_bootstrap`
2. `alembic_codex_rescan`
3. `alembic_codex_job`
4. `alembic_codex_dashboard`
5. `alembic_codex_cleanup`
6. `alembic_task operation=prime`
7. `alembic_submit_knowledge`
8. `alembic_guard`

最终 smoke：

```text
diagnostics
status
init ghost
bootstrap job
job status
submit knowledge
prime
edit fixture
guard
rescan job
dashboard URL
cleanup dry run
```

## 子 Agent 拆分

### Agent A：Core 基建

负责路径：

- `lib/mainline/core/**`
- `lib/mainline/core/*.test.ts`

任务：

- 迁移 L1 第一批 core primitives。
- 保持纯底层，不导入 data/knowledge/search/workflows。
- 给写边界、路径归一、原子写入补中文注释。

### Agent B：Knowledge 模型

负责路径：

- `lib/mainline/knowledge/**`
- `lib/mainline/code/LanguageCatalog.ts`

任务：

- 迁移 L2 第一批 Recipe/SourceRef/Submission/Codec。
- 需要 `js-yaml` 时同步 `package.json`。
- 不迁 SourceRefRepairService。

### Agent C：Data/Search

负责路径：

- `lib/mainline/data/**`
- `lib/mainline/search/**`

任务：

- 迁移 L3 JSON store、ContextIndex、SearchIndex snapshot。
- 先保留 SQLite 为第二步，避免 native dependency 阻塞纯 TS 层。
- 确保运行期不扫 Markdown。

### Agent D：Runtime Prime

负责路径：

- `lib/mainline/runtime/**`
- `lib/mainline/agent/**`

任务：

- 等 L2/L3 完成后迁移 prime retrieval。
- 输出 Codex 可注入 markdown/context。

### Agent E：Daemon Jobs

负责路径：

- `lib/daemon/**`
- `lib/http/**`
- `bin/cli.ts` daemon 子命令

任务：

- 等 L0/L3/L5 后接 durable job。
- 给 bootstrap/rescan/dashboard 提供按需 daemon。

### Agent F：Tools / Workflows / MCP Wiring

负责路径：

- `lib/tools/**`
- `lib/workflows/**`
- `lib/guard/**`
- `lib/codex/tools.ts`
- `bin/codex-mcp.ts`

任务：

- 等 L5/L6 后接 tools、workflow、MCP tool。
- 不恢复低频 legacy 工具。

## 当前立即执行批次

先并行执行三个不互相覆盖的底层任务：

1. Agent A 迁 L1 core primitives。
2. Agent B 迁 L2 knowledge model 的纯模型和 codec。
3. Agent C 迁 L3 data/search 的纯 TS 部分，SQLite 暂缓。

三条完成后主 agent 做集成：

- 统一 export surface。
- 修 import 风格。
- 补 root tests。
- 跑 `npm run lint && npm run typecheck && npm run test:unit && npm run build`。

当前状态：

- L1 core primitives 已迁入首批，未迁 `MainlineKernel.ts`、`GitPort.ts`、`FileWatch.ts`、`WorkerPool.ts`。
- L2 knowledge model、submission policy、Markdown codec 已迁入首批，未迁 `SourceRefRepairService.ts`、`RecipePathRepairer.ts`。
- L3 data/search 已迁入纯 TS 最小闭环，包括 JSON store、ContextIndex port/in-memory、fingerprint snapshot、sparse SearchIndex、projection、snapshot store、HybridSearch wrapper 和 vector no-op port；未迁 SQLite adapter。
- 当前验证门：`npm run lint`、`npm run typecheck`、`npm run test:unit`、`npm run build`。
