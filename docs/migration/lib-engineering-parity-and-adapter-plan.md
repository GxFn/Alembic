# lib/engineering parity and adapter plan

本文只记录 `lib/engineering` 当前真实实现与 legacy anchor 的能力对照，并给出后续接入 mainline、agent tool、agentRuntime、cold-start/incremental workflow 的 adapter 顺序。范围限定为工程理解核心；DB、HTTP、daemon、dashboard、LLM、Recipe repository、Guard engine 不迁入 `lib/engineering`，只在外层 adapter 对接。

## 代码依据

新实现读取范围：

- 入口：`lib/engineering/index.ts`
- foundation/language/workspace/graph：`foundation/EngineeringCoreTypes.ts`、`language/EngineeringLanguageService.ts`、`language/EngineeringLanguageProfiles.ts`、`workspace/EngineeringWorkspacePaths.ts`、`graph/EngineeringGraphPrimitives.ts`
- code/ast/analysis：`code/EngineeringCodeGraph.ts`、`code/EngineeringCodeGraphModel.ts`、`code/ast/EngineeringCodeAstFacts.ts`、`code/ast/EngineeringCodeAstNormalizer.ts`、`code/analysis/CallGraphAnalyzer.ts`、`CallEdgeResolver.ts`、`CallSiteExtractor.ts`、`SymbolTableBuilder.ts`、`ImportPathResolver.ts`、`DataFlowInferrer.ts`
- entity：`entity/EngineeringEntityGraph.ts`
- discovery：`discovery/DiscovererRegistry.ts`、`ProjectDiscoverer.ts`、`SpmDiscoverer.ts`、`NodeDiscoverer.ts`、`PythonDiscoverer.ts`、`JvmDiscoverer.ts`、`GoDiscoverer.ts`、`DartDiscoverer.ts`、`RustDiscoverer.ts`、`GenericDiscoverer.ts`、`CustomConfigDiscoverer.ts`、`CustomConfigProfiles.ts`、`ConfigWatcher.ts`、`discovery/parsers/*`
- panorama：`panorama/EngineeringModuleDiscoverer.ts`、`EngineeringPanoramaRefiner.ts`、`EngineeringPanoramaSnapshot.ts`、`EngineeringPanoramaService.ts`、`EngineeringTechStackProfiler.ts`、`EngineeringDimensionAnalyzer.ts`、`EngineeringPanoramaTypes.ts`
- workflow：`workflow/EngineeringWorkflowRunner.ts`、`workflow/EngineeringWorkflowTypes.ts`、`workflow/core/EngineeringWorkflowCore.ts`、`workflow/cache/*`、`workflow/incremental/*`、`workflow/optional/*`

legacy anchor：

- `lib/mainline/engineering/legacy-source/core/ast/ProjectGraph.ts`
- `lib/mainline/engineering/legacy-source/core/analysis/*`
- `lib/mainline/engineering/legacy-source/core/discovery/*`
- `lib/mainline/engineering/legacy-source/service/knowledge/CodeEntityGraph.ts`
- `lib/mainline/engineering/legacy-source/service/panorama/*`
- `lib/mainline/engineering/legacy-source/workflows/capabilities/project-intelligence/*`

## 状态图例

- 完全迁入：新模块已经有内存模型、查询 API、测试覆盖，且不依赖 legacy side effect。
- 纯工程化迁入：legacy 算法或语义已改写到纯输入/输出实现，但去除了 DB/repository/HTTP/SignalBus/daemon 等副作用。
- 保留为外部 adapter：核心不接外部服务；后续由 adapter 将 repository、runtime、tool、mainline artifact 转成 `lib/engineering` 输入或消费输出。
- 仍缺真实接入：核心能力存在，但还没有接到 mainline compile、agent tool、agentRuntime 或冷启动主流程。

## 模块 parity

| 模块 | 当前新实现 | legacy 对照 | 状态 | 仍缺 adapter 点 |
| --- | --- | --- | --- | --- |
| foundation | `EngineeringDetection`、`EngineeringTarget`、`EngineeringFile`、`EngineeringDependencyGraph`、`EngineeringDiscoverer`、dependency node normalization、external node 判断。 | `core/discovery/ProjectDiscoverer.ts` 的 target/file/dependency graph 契约。 | 完全迁入。 | mainline/agent 需要统一把旧 `DiscoveredTarget`、`DiscoveredFile`、dependency graph 转成 foundation 类型。 |
| language | `EngineeringLanguageService` 提供 ext→lang、lang alias、display name、test file、scan skip dirs；`EngineeringLanguageProfiles` 提供 third-party/vendor/role/language profile 规则。 | legacy `LanguageService`、Node discoverer 的 `LanguageExtensions`、panorama role/layer hint。 | 纯工程化迁入。 | tree-sitter parser language id 仍由外部 AST adapter 映射；Guard lang id 也应由 adapter 处理。 |
| workspace | `toEngineeringRelativePath`、`engineeringModuleNameForPath`、source/test/third-party path 判断。 | legacy 中 ProjectGraph、GenericDiscoverer、PanoramaScanner、FileDiffSnapshotStore 的路径规整逻辑。 | 纯工程化迁入。 | `.asd` ghost root、本地 `.alembic`、mainline artifact path reconcile 由外部 adapter 决定。 |
| graph | `mergeEngineeringWeightedEdges`、Tarjan SCC `findEngineeringCycles`、fan-in/fan-out metrics。 | `CouplingAnalyzer`、`LayerInferrer`、`CodeEntityGraph` 查询中的图遍历基础。 | 完全迁入。 | 若 agent tool 需要 legacy markdown 展示，应由 tool adapter 渲染。 |
| code | `EngineeringCodeGraph.fromAstSummary/fromJSON`、`toJSON`、class/protocol/category/file index、inheritance/conformance、overview、search、incremental update、call/data-flow query、Guard AST 查询预留。 | `core/ast/ProjectGraph.ts` 的查询、JSON round trip、incremental cleanup；`CodeEntityGraph.populateFromAst` 的 AST 实体输入。 | 完全迁入，且比 legacy ProjectGraph 更纯：不扫描文件、不调用 tree-sitter runtime。 | mainline compile adapter 需要把 `lib/mainline/code` AST/project summary 转成 `EngineeringCodeAstSummaryInput`；agent tool adapter 需要决定公开哪些 query。 |
| analysis | `CallGraphAnalyzer` 编排 `SymbolTableBuilder`、`ImportPathResolver`、`CallSiteExtractor`、`CallEdgeResolver`、`DataFlowInferrer`；支持 direct/import/class-method/inheritance/override/protocol/conformance/rta/inferred/unresolved tier、path hints、text facts fallback、receiver type facts。 | `core/analysis/CallGraphAnalyzer.ts`、`CallEdgeResolver.ts`、`CallSiteExtractor.ts`、`SymbolTableBuilder.ts`、`ImportPathResolver.ts`、`DataFlowInferrer.ts`。 | 纯工程化迁入。legacy 的 async incremental analyze 语义已转移到 workflow/cache/incremental 层。 | AST adapter 还没有接真实 tree-sitter node walker；call graph 结果尚未写回 mainline compile artifact。 |
| ast | `EngineeringCodeAstFacts` 和 `EngineeringCodeAstNormalizer` 归一 classes/protocols/categories/methods/properties/imports/exports/callSites/references/textFacts/propertyTypes/receiverTypes/metrics。 | `ProjectGraph.#indexFileSummary` 和 analysis 输入 shape。 | 纯工程化迁入。 | 缺真实 parser adapter：tree-sitter runtime、mainline `AstPort`、已有 `TreeSitterAstParser` 的产物需要接入 normalizer。 |
| entity | `EngineeringEntityGraph.fromInput` 从 targets/files/dependencyGraph/codeGraph 建图；支持 file/target/module/external/class/protocol/category/method/property/symbol/pattern/recipe，contains/defines/depends_on/imports/inherits/conforms/extends/calls/data_flow/references/matches/uses_pattern/is_part_of，find/search/incoming/outgoing/path/impact/topology/hot nodes/callers/callees/call impact/agent context/clear files/clear call graph。 | `service/knowledge/CodeEntityGraph.ts` 的 populateFromAst、populateFromDependencyGraph、populateFromCandidates、populateCallGraph、findPath、getImpactRadius、generateContextForAgent、call/data-flow 聚合、clearProject/clearCallGraphForFiles。 | 纯工程化迁入。repository 写入改为内存图，agent context 改为结构化对象。 | repository adapter 若仍需要持久化 code_entities/knowledge_edges，应在外部从 `entities/edges` 写入；legacy markdown context 由 agent tool adapter 渲染。 |
| discovery | `DiscovererRegistry` 默认顺序为 spm→node→python→jvm→go→dart→rust→customConfig→generic；支持 detect/detectAll/analyzeConflict/selectPreference；生态 discoverer 覆盖 SPM、Node、Python、JVM、Go、Dart、Rust、Generic；`CustomConfigDiscoverer` 覆盖 Bazel、Buck2、Gradle convention、Melos、EasyBox、Tuist、KS/MT component、Flutter add-to-app、React Native hybrid、Kotlin Multiplatform、Nx、Pants、CMake、XcodeGen；parsers 覆盖 Ruby/YAML/JSON/Gradle/Starlark/CMake；`ConfigWatcher` 提供 config snapshot diff。 | `core/discovery/*`、`core/discovery/parsers/*`、`CustomConfigDiscoverer.ts`、`DiscovererPreference.ts`、`ConfigWatcher.ts`。 | 大部分完全迁入；`ConfigWatcher` 是纯 diff 版，不再直接 watch FS。 | mainline/cold-start adapter 需要选择 registry、传入 projectRoot/dataRoot、持久化 preference；真实 watch loop 由 runtime/daemon adapter 负责。 |
| panorama | `EngineeringModuleDiscoverer` 从 files/dependencyGraph/codeGraph/importFacts 生成 modules/panorama/relationships/enriched dependency graph/signals；支持 config layer、host decomposition、vendor/resource skip、import fallback；`EngineeringPanoramaRefiner` 做 coupling/cycles/fan metrics/externalDeps/role refinement/layer inference/layer violations；`EngineeringPanoramaSnapshotBuilder` 汇总 overview/module detail/cache markers/confidence；`EngineeringPanoramaService` 暴露 buildSnapshot/getOverview/getModule；TechStack/Dimension/Health/Gaps/CallFlow 已在纯输入上计算。 | `ModuleDiscoverer`、`CouplingAnalyzer`、`LayerInferrer`、`RoleRefiner`、`TechStackProfiler`、`DimensionAnalyzer`、`PanoramaAggregator`、`PanoramaService`。 | 纯工程化迁入。DB-backed module discovery、repository recipe matching、SignalBus coverage event、service cache 都被去副作用化。 | Panorama HTTP/MCP/dashboard adapters 需要把 snapshot 映射成旧 overview/module/health/gaps/result shape；Recipe coverage 只能从外部传 `recipeFacts`，不能在核心里查 repository。 |
| workflow | `EngineeringWorkflowRunner` 串联 discover/cache/collectFacts/buildGraphs/panorama，输出 artifact、phase reports、diagnostics、capabilities、truncated、incremental plan、snapshot summary；collectFacts 支持 injected ast summaries/file contents/import facts，并跳过 Alembic generated artifacts；buildGraphs 产出 codeGraph/callGraph/dataFlow/entityGraph；panorama 可注入 service。 | `ProjectIntelligenceRunner.ts`、`ProjectIntelligencePreparation.ts`、`ProjectIntelligenceResultProjection.ts`。 | 纯工程化迁入。legacy materialization、DB/Repository/Bootstrap side effects 未进入核心。 | cold-start adapter 需要接真实文件读取、AST compile、Recipe/Guard/Enhancement 阶段、artifact 持久化和 mainline projection。targeted-rescan 当前明确提示无法复用未扫描历史事实，需要 artifact merge adapter。 |
| cache | `EngineeringWorkflowSnapshotStore` 接口、`InMemoryEngineeringWorkflowSnapshotStore`、`JsonSerializableEngineeringWorkflowSnapshotStore`、file fingerprint、path reconcile、capacity prune、baseline missing/project root mismatch/write/read diagnostics。 | `FileDiffSnapshotStore.ts` 的 snapshot、fingerprint、path reconcile、capacity 控制。 | 纯工程化迁入。DB store 改为内存/JSON 可序列化实现。 | 需要 DB/file adapter 持久化 snapshot store；需要 mainline artifact adapter 将 `dimensionMeta` 与实际 dimension-file refs 对齐。 |
| incremental | `EngineeringProjectIntelligenceIncrementalPlanner` 支持 full-rescan/targeted-rescan/panorama-only/skip；按 changeRatio、move-only、projectRoot mismatch、dimensionMeta.referencedFilesList 和文件类型推断 affected dimensions/modules/files。 | `ProjectIntelligenceIncrementalPlanner.ts`、`FileDiffPlanner.ts`。 | 纯工程化迁入。 | 缺 artifact reuse/merge adapter；agentRuntime 需要决定 skip/panorama-only 时如何复用历史结果。 |
| optional | `runEngineeringWorkflowOptionalStage` 串联 enhancement preprocess、Guard audit、enhancement re-audit、dimension gating；`LEGACY_ENHANCEMENT_PACKS` 覆盖 React、Next.js、Vue/Nuxt、Node server 等增强包；Guard audit 只执行 rule facts/callbacks；Dimension gating 从 panorama gaps/modules/enhancement signals 产生 active dimensions 和 file refs。 | Project Intelligence 的 Enhancement preprocess、Guard audit、dimension gating、dimension-file refs 语义。 | 纯工程化迁入，但仍是 optional 阶段，尚未串入 `EngineeringWorkflowRunner` 主 phases。 | Guard engine/Recipe repository/LLM enhancement 只做外部 adapter；cold-start adapter 负责调用 optional stage 并把结果并入 artifact。 |

## legacy 对照结论

### 完全迁入

- ProjectGraph 风格查询已进入 `EngineeringCodeGraph`：class/protocol/category/method/file/overview/search、JSON round trip、incremental update、deleted file cleanup。
- Discovery registry、detectAll/analyzeConflict/preference、SPM/Node/Python/JVM/Go/Dart/Rust/Generic discoverer 和主要 custom config profiles 已迁入。
- graph primitives 已覆盖 weighted edge merge、cycle detection、fan metrics。

### 纯工程化迁入

- legacy analysis 的 symbol table、import resolution、call resolution、RTA、CHA/inheritance、receiver/property type、data-flow inference 被改写为 `code/analysis/*`，输入来自 normalized facts，而不是直接依赖 tree-sitter runtime。
- legacy `CodeEntityGraph` 的 repository 图操作被改写为 `EngineeringEntityGraph` 内存图；保留 path、impact、callers/callees、call impact、agent context 语义。
- legacy Panorama 的 module discovery、coupling、layer inference、role refinement、tech stack、dimension/health/gap/call-flow 语义被改写为 snapshot builder/service；去掉 DB、repository、SignalBus、service cache。
- legacy file diff snapshot、incremental planning、generated artifact blacklist、capacity prune 被改写为 workflow cache/incremental 纯实现。

### 保留为外部 adapter

- DB/repository：legacy `CodeEntityRepositoryImpl`、`KnowledgeEdgeRepositoryImpl`、`KnowledgeRepositoryImpl`、`BootstrapRepositoryImpl`、`DrizzleDB` 不进入核心。
- HTTP/MCP/dashboard：legacy PanoramaService 的 handler/route/dashboard 返回形态由外层转换。
- LLM/Recipe repository/Guard engine：核心只接收 `recipeFacts`、guard rule facts/callbacks、enhancement facts；不查库、不跑 LLM、不生成 Recipe。
- daemon/runtime/watch loop：`ConfigWatcher` 只提供 snapshot diff，不负责长期 watch。
- tree-sitter runtime：`EngineeringCodeAstNormalizer` 只接 AST facts；真实 parser 由 mainline compile adapter 或 agentRuntime adapter 提供。

### 仍缺真实接入

- `lib/mainline/compile` 尚未用 `EngineeringWorkflowRunner` 或 `EngineeringCodeGraph` 作为主工程事实源。
- agent tool 尚未暴露 entity/code/panorama 查询入口，也尚未把 `EngineeringAgentContext` 渲染成 legacy tool markdown。
- agentRuntime 尚未负责 snapshot store、incremental decision、skip/panorama-only/targeted-rescan 的历史 artifact 复用。
- optional stage 尚未纳入 workflow 主 runner；当前 `EngineeringWorkflowArtifact.dimensionFileRefs` 仍是空数组。
- targeted-rescan 已有 planner，但 `EngineeringWorkflowRunner` 明确不能复用未扫描历史 facts；需要 artifact merge adapter 后才能做到 legacy 增量语义。

## 公共 API 建议

### 建议继续从 `lib/engineering/index.ts` 暴露

- 基础契约：`foundation/EngineeringCoreTypes.ts`
- 语言与路径：`EngineeringLanguageProfiles`、`EngineeringLanguageService`、`EngineeringWorkspacePaths`
- 图算法：`EngineeringGraphPrimitives`
- code graph：`EngineeringCodeGraph`、`EngineeringCodeGraphModel`
- AST normalization：`code/ast/index.ts`
- analysis 编排与结果类型：`code/analysis/index.ts`
- discovery 主入口：`DiscovererRegistry`、`createDefaultDiscovererRegistry`、`ProjectDiscoverer`、生态 discoverers、`CustomConfigDiscoverer`、`CustomConfigProfileRegistry`、`ConfigWatcher`
- entity graph：`EngineeringEntityGraph`
- panorama 服务级 API：`EngineeringPanoramaService`、`EngineeringPanoramaTypes`、`EngineeringModuleDiscoverer`、`EngineeringPanoramaRefiner`、`EngineeringPanoramaSnapshot`、`EngineeringTechStackProfiler`、`EngineeringDimensionAnalyzer`
- workflow 主 API：`EngineeringWorkflowRunner`、`EngineeringWorkflowTypes`
- cache/incremental/optional 的 `index.ts`：snapshot store、file diff planner、incremental planner、optional stage 类型与 runner

### 建议保持内部或谨慎暴露

- `DiscoveryHelpers.ts`：只服务 discoverer 实现，外部依赖会冻结内部扫描细节。
- parser 具体函数可以通过 `discovery/parsers/index.ts` 暴露给 tests/fixtures，但产品 adapter 优先使用 `CustomConfigDiscoverer`，不要直接依赖 parser 私有 shape。
- `analysisUtils.ts`、normalizer 内部 helper、`EngineeringWorkflowCore.ts` 的 phase helper、path utility helper：保持内部，避免 adapter 绕过 runner。
- `EngineeringModuleDiscoverer`/`EngineeringPanoramaRefiner` 可暴露给高级测试和局部 adapter，但普通接入应优先使用 `EngineeringPanoramaService.buildSnapshot`。
- `LEGACY_ENHANCEMENT_PACKS` 可作为 optional catalog 暴露，但不要让 agent tool 直接修改；自定义增强包应通过后续 adapter/registry 机制注入。

## 接入顺序

### 1. mainline compile adapter

目标是让 mainline compile 先消费纯工程核心，不改变 agent/runtime 行为。

- 已新增 `MainlineEngineeringWorkflowCompileAdapter`，从现有 `MainlineProjectIntelligenceArtifact` 投影出 `EngineeringWorkflowInput`。
- 已将 mainline files/projectGraph/externalDependencies/unresolvedDependencies 转为 `EngineeringFile`、`EngineeringTarget`、`EngineeringDependencyGraph`。
- 已将 legacy `astProjectSummary.fileSummaries`、成熟 `callGraph.callEdges`、`dataFlowEdges` 注入 engineering workflow，且 workflow 内部会合并外部注入调用图与自身推断结果，避免迁移期丢边。
- 已在 `MainlineProjectIntelligenceRunner` 增加 `engineeringWorkflow` opt-in sidecar；默认关闭，开启后 sidecar 失败不会阻断已验证的 Project Intelligence artifact。
- 已新增 `MainlineEngineeringWorkflowArtifactStore`，在 compile session 中旁路持久化：
  - `context/engineering-workflow-artifact.json`
  - `context/engineering-code-graph.json`
  - `context/engineering-entity-graph.json`
  - `context/engineering-panorama-snapshot.json`
- `MainlineCompileSession` 已默认开启 engineering sidecar，但仍只作为旁路产物；旧 ContextIndex/SearchIndex 和 ProjectIntelligence materializer 不被替换。
- 已覆盖测试：adapter 投影、runner 默认不触发、开启 sidecar、sidecar 异常隔离。
- 暂不替换 `MainlineProjectIntelligenceArtifact` schema、`ProjectIntelligenceMaterializer`、现有 ContextIndex/SearchIndex 输出和增量 merge。

### 2. agent tool adapter

目标是先提供查询能力，避免 agent 直接读 legacy repository。

- 已新增 `EngineeringGraphQueryProvider` / `EngineeringWorkflowGraphQueryProvider`，统一封装 code graph、entity graph、dependency graph、panorama snapshot 查询。
- 已新增 `MainlineEngineeringGraphProvider`，只负责从 `MainlineEngineeringWorkflowArtifactStore` 读取工程 sidecar artifact，再交给 engineering provider 查询。
- `graph.overview` / `graph.query` 已改为只依赖 `engineeringGraphProvider`，不再分叉读取旧 `projectGraph`、`codeEntityGraph` 或 `ProjectIntelligenceQueries`。
- 工具层只读 engineering artifact/snapshot，不触碰 DB/repository；ProjectIntelligence 只保留为上游编译来源，不作为 agent graph tool 的查询接口。

下一步：

- code tool：包装 `EngineeringCodeGraphReader` 的 class/protocol/file/call/data-flow/Guard AST 查询。
- runtime tool：把 `EngineeringEntityGraph.generateContextForAgent()`、panorama gaps/hotspots 注入 `runtime.inject_context`，但仍通过单一 engineering read provider。
- search/sourceRef 投影：将 engineering entity/module/edge/gap 生成新的 search docs/source refs，保持 ID 命名空间独立。

### 3. agentRuntime adapter

目标是让 runtime 管理缓存、增量和外部副作用。

- 提供 `EngineeringWorkflowSnapshotStore` 的真实持久化实现，可能接 DB、workspace file 或 runtime storage。
- 管理 projectRoot/dataRoot、discoverer preference、ConfigWatcher watch loop、baseline selector。
- 处理 `skip`、`panorama-only`、`targeted-rescan` 的历史 artifact 复用和 merge。
- 将 Recipe repository、Guard engine、LLM enhancement 结果转成 `recipeFacts`、guard callbacks/rule facts、optional dimensions，再喂给 optional stage。

### 4. cold-start / incremental workflow adapter

目标是替换 legacy Project Intelligence 编排，但不把副作用塞回核心。

- 冷启动：调用 discovery → AST compile adapter → `EngineeringWorkflowRunner` → optional stage → artifact projection。
- 增量：用 snapshot store + `EngineeringWorkflowFileDiffPlanner` + `EngineeringProjectIntelligenceIncrementalPlanner` 决策；targeted-rescan 时执行 artifact merge。
- 结果投影：把 `EngineeringWorkflowArtifact`、`EngineeringPanoramaSnapshot`、optional outputs 投影成 mainline/agentRuntime 需要的 Project Intelligence artifact。
- 失败策略：沿用 runner 的 phase diagnostics，adapter 只负责日志、telemetry、持久化和用户可见状态。

## 明确不迁入核心的内容

- DB：不在 `lib/engineering` 内引用 Drizzle、SQLite、repository implementation 或 schema。
- HTTP/MCP/daemon/dashboard：不在核心内注册 route、handler、server、dashboard event。
- LLM：不在核心内发起模型调用；LLM 产物作为 facts 输入。
- Recipe repository：不在核心内查询或生成 Recipe；只接受 `EngineeringRecipeCoverageFact`。
- Guard engine：不在核心内接旧 Guard engine；optional Guard 只执行传入的 rule facts/callbacks。
- mainline DI/runtime singleton：不在核心内引用 mainline container、logger、SignalBus、Bootstrap repository。

## 当前风险和约束

- `lib/engineering/index.ts` 目前暴露面偏宽，方便迁移期测试；接 mainline 前应确认哪些 helper 仍需要 public contract。
- `EngineeringWorkflowRunner` 已有 optional 阶段，但 compile sidecar 默认关闭 optional stage，避免在没有 Guard/Recipe adapter 时污染主线结果；后续 runtime adapter 再显式注入 rule facts、recipe facts 和 dimensions。
- targeted-rescan 现在会过滤 affected files，但不会合并历史未变事实；这是 agentRuntime/cold-start adapter 必须补的缺口。
- panorama 的 recipe coverage 当前是 explicit input facts 或 placeholder；任何 DB-backed recipe count 都必须在 adapter 中生成 `recipeFacts`。
- code/analysis 已迁移 resolver 算法，但真实 AST walker/parser 仍在外部；没有 parser adapter 时只能处理注入 summaries/text facts。
- compile sidecar 已持久化工程产物，`graph.*` agent tool 已切到单一 engineering provider；下一步是把 code/runtime/search/sourceRef 继续收敛到同一工程 read model。
