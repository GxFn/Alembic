# lib/engineering 总体实现计划

## 总目标

`lib/engineering` 是 Alembic 新的工程理解核心。它必须先作为独立模块完整成立，之后再由 agent tool、agentRuntime、cold-start、mainline compile 去适配它。

当前原则：

1. 不再围绕 `lib/mainline/engineering` 继续建设；旧目录最终会删除。
2. `lib/engineering` 内部先自底向上完成：foundation → language/workspace/graph → code → discovery → entity → panorama → workflow。
3. 迁移以 legacy 成熟能力为核心，先完整迁入，再做内部剪枝。
4. 新模块不直接依赖旧 DB、旧 repository、旧 DI、旧 HTTP、旧 dashboard。
5. 每一层必须有独立测试，功能等价后才能删除 raw legacy 对应部分。

## 当前状态

已完成底层：

- `lib/engineering/foundation`
- `lib/engineering/language`
- `lib/engineering/workspace`
- `lib/engineering/graph`
- `lib/engineering/code/EngineeringCodeGraphModel.ts`
- `lib/engineering/panorama/EngineeringPanoramaTypes.ts`
- `lib/engineering/panorama/EngineeringPanoramaRefiner.ts`

已验证：

- `npm run typecheck`
- `npm run test:unit`
- `npm run build`

## 真实代码依据

这轮迁移计划以 legacy 的实际实现为准，不以新仓库已经写出的薄层为准。当前对齐的代码锚点：

- AST/工程图：`lib/mainline/engineering/legacy-source/core/ast/ProjectGraph.ts`、`lib/mainline/code/tree-sitter/AstAnalyzer.ts`、`lib/mainline/code/tree-sitter/analysis/*`。
- 调用/数据流：`CallGraphAnalyzer.ts`、`CallEdgeResolver.ts`、`CallSiteExtractor.ts`、`SymbolTableBuilder.ts`、`ImportPathResolver.ts`、`DataFlowInferrer.ts`。
- EntityGraph：`lib/mainline/engineering/legacy-source/service/knowledge/CodeEntityGraph.ts`，重点保留 `findPath`、`getImpactRadius`、`generateContextForAgent`、call/data-flow 聚合语义。
- Discovery：`core/discovery/DiscovererRegistry.ts`、`ProjectDiscoverer.ts`、`SpmDiscoverer.ts`、`NodeDiscoverer.ts`、`PythonDiscoverer.ts`、`JvmDiscoverer.ts`、`GoDiscoverer.ts`、`DartDiscoverer.ts`、`RustDiscoverer.ts`、`GenericDiscoverer.ts`、`CustomConfigDiscoverer.ts` 和 `parsers/*`。
- Panorama：`service/panorama/ModuleDiscoverer.ts`、`PanoramaService.ts`、`PanoramaScanner.ts`、`PanoramaAggregator.ts`、`TechStackProfiler.ts`、`DimensionAnalyzer.ts`、`RoleRefiner.ts`、`CouplingAnalyzer.ts`、`LayerInferrer.ts`。
- Workflow：`workflows/capabilities/project-intelligence/ProjectIntelligenceRunner.ts`、`ProjectIntelligencePreparation.ts`、`ProjectIntelligenceIncrementalPlanner.ts`、`FileDiffPlanner.ts`、`FileDiffSnapshotStore.ts`、`ProjectIntelligenceResultProjection.ts`。

迁移判断标准：

1. legacy 中已经成熟验证过的能力默认迁入，之后在 `lib/engineering` 内部再剪枝。
2. 如果新仓库已有实现比 legacy 薄，以 legacy 行为补齐或替换。
3. 如果 legacy 实现绑定 DB、HTTP、Repository、Dashboard，先抽出纯工程事实和算法，外部副作用留到后续 adapter。
4. 每个阶段以功能 parity 和测试覆盖为准，不以文件搬运完成为准。

## Phase 1：code 层完整建设

目标：把 AST/ProjectGraph/code graph 能力迁到 `lib/engineering/code`，不再只有薄 reader。

必须迁入：

- AST summary 原始结构：classes、protocols、categories、methods、properties、imports、exports、callSites、references、inheritanceGraph、patterns、metrics。
- ProjectGraph 查询：`getClassInfo`、`getProtocolInfo`、`getInheritanceChain`、`getSubclasses`、`getAllDescendants`、`getCategoryExtensions`、`getMethodOverrides`、`getClassMethods`、`getFileSymbols`、`searchClasses`、overview。
- 生命周期：`toJSON/fromJSON`、incremental update、deleted file cleanup。
- Call/DataFlow 类型：call edges、data-flow edges、resolve metadata。
- Guard AST 查询预留：`findCallExpressions`、`findPatternInContext`、`checkProtocolConformance`。

暂不做：

- 不接 tree-sitter runtime。
- 不接 mainline artifact adapter。
- 不接 agent tool。

建议 worker：

- Worker Code-A：负责 `lib/engineering/code` 类型模型与 `EngineeringCodeGraph` 查询索引。
- Worker Code-B：负责 code graph 序列化、增量 update、Guard 查询预留和测试。

验收：

- `lib/engineering/code/*.test.ts` 覆盖 class/protocol/category/inheritance/conformance/method override/file overview/serialization/incremental。
- 不引用 `lib/mainline`。

## Phase 2：entity 层完整建设

目标：迁入 CodeEntityGraph 的纯内存等价能力，支撑 agent 做影响分析。

必须迁入：

- 实体类型：file、target、module、external、class、protocol、category、method、property、symbol、pattern、recipe。
- 边语义：defines、contains、depends_on、inherits、conforms、extends、calls、data_flow、uses_pattern、is_part_of。
- 构建入口：from code graph、from dependency graph、from candidate relations、from call graph。
- 查询入口：find/list/search、incoming/outgoing、inheritance chain、descendants、conformances、findPath、impact radius、topology、callers/callees、call impact radius。
- agent context：保留 legacy `generateContextForAgent` 的语义，可改成结构化对象再渲染 markdown。
- 增量清理：clear files / clear call graph for files。

建议 worker：

- Worker Entity-A：负责 entity/edge 数据模型、构建入口、基础查询。
- Worker Entity-B：负责 path/impact/topology/callers/callees/agent context/incremental cleanup。

验收：

- `lib/engineering/entity/*.test.ts` 覆盖 BFS path、impact radius、call impact、descendants、conformance、agent context。
- 不依赖旧 DB/repository。

## Phase 3：discovery 层完整建设

目标：把成熟 discoverer 栈迁到 `lib/engineering/discovery`。

必须迁入：

- API：`detect/load/listTargets/getTargetFiles/getDependencyGraph`。
- Registry：注册顺序 `spm → node → python → jvm → go → dart → rust → customConfig → generic`。
- Conflict/Preference：`detectAll/analyzeConflict`、DiscovererPreference、用户偏好。
- Parsers：RubyDsl、YamlConfig、Starlark、GradleDsl、CMake、JsonConfig。
- Discoverers：SPM、Node、Python、JVM、Go、Dart、Rust、CustomConfig、Generic。
- Language gaps：C/C++ import pattern、cross-platform libraries、detectProfile、detectProjectLanguages、sourceExtRegex、toGuardLangId。
- Workspace/dataRoot：明确 `.asd` ghost root 与本地 `.alembic` 的边界，先做接口，不急接写入。
- ConfigWatcher：作为 optional incremental discovery service，后置。

建议 worker：

- Worker Discovery-A：只迁 parsers 与 parser golden tests。
- Worker Discovery-B：迁 SPM/Node/Python/JVM/Go/Dart/Rust/Generic。
- Worker Discovery-C：迁 CustomConfigDiscoverer，拆 profile registry、parser dispatch、target builder、graph builder。
- Worker Discovery-D：迁 registry/preference/workspace/config watcher。

验收：

- 每个 parser 有 golden fixture。
- 每个 discoverer 有单项目和 workspace/monorepo fixture。
- CustomConfig 覆盖 EasyBox、Bazel、Gradle Convention、Melos、Tuist、Nx、CMake、XcodeGen。
- Graph contract 不丢 `scope/configuration/bridgeType/tags/visibility/conventionRole/layer`。

## Phase 4：panorama 层补完整

目标：在已独立的 refiner 之上补齐 legacy Panorama 的聚合与治理视图。

必须迁入：

- ModuleDiscoverer 纯事实版：文件补全、config layer、host 分解、vendor/resource 跳过。
- Import fallback dependency inference。
- PanoramaSnapshot/Service：overview、module detail、gaps、health、result、stale/cache 标记。
- TechStackProfiler。
- DimensionAnalyzer。
- HealthRadar、KnowledgeGap、CallFlowSummary。
- coverage、recipeCount、module neighbors。

建议 worker：

- Worker Panorama-A：ModuleDiscoverer + import fallback + tests。
- Worker Panorama-B：Snapshot/Service/overview/module detail。
- Worker Panorama-C：TechStackProfiler + DimensionAnalyzer + health/gaps/call-flow。

验收：

- config layer 覆盖率阈值 0.5。
- topology longest path。
- role conflict/uncertain/fallback。
- external dep hotspots。
- module detail file groups/neighbors/summary。
- healthScore/gap priority。

## Phase 5：workflow 层完整建设

目标：在 `lib/engineering/workflow` 建立冷启动前工程流水线，不接 agent/runtime。

阶段：

- Phase A：Workflow 类型与结果壳。
- Phase B：Discovery/collect，输出 targets/files/dependencyGraph/langStats/truncated。
- Phase C：Fact compile，输出 AST summary、call graph、codeGraph、entityGraph。
- Phase D：Panorama enrichment，输出 roles/layers/cycles/externalDeps/health/gaps。
- Phase E：Guard/Enhancement optional stage，输出 dimensions、patterns、guard findings。
- Phase F：cache/incremental store，支持 artifact/fingerprint/dimension-file map。

必须迁入：

- Alembic 生成物黑名单。
- Enhancement preprocess。
- Guard audit 与 enhancement re-audit。
- Dimension gating 和 dimension-file refs。
- EpisodicMemory/SessionStore 恢复语义。
- 增量 diff、路径 reconcile、快照容量控制。

建议 worker：

- Worker Workflow-A：workflow 类型、phase runner、phase report。
- Worker Workflow-B：incremental planner/cache/snapshot store。
- Worker Workflow-C：Enhancement/Guard/Dimension optional stage。
- Worker Workflow-D：golden cold-start + incremental e2e tests。

验收：

- Golden cold-start：Node/Swift/Python 混合小项目。
- Incremental：新增、修改、删除、移动文件。
- Cache：baseline 缺失、projectRoot mismatch、写入失败。
- 不生成 Recipe，不接 runtime。

## Phase 6：接入准备

只有 Phase 1-5 完成并测试稳定后，才考虑接入：

- mainline compile adapter。
- agent tool adapter。
- cold-start workflow adapter。
- Codex plugin tool adapter。

接入阶段不再补核心功能，只做转换与边界。

## 子 agent 总分工

长期分工：

- Code Agent：`lib/engineering/code/**`
- Entity Agent：`lib/engineering/entity/**`
- Discovery Parser Agent：`lib/engineering/discovery/parsers/**`
- Discovery Ecosystem Agent：`lib/engineering/discovery/{spm,node,python,jvm,go,dart,rust,generic}/**`
- CustomConfig Agent：`lib/engineering/discovery/custom-config/**`
- Panorama Agent：`lib/engineering/panorama/**`
- Workflow Agent：`lib/engineering/workflow/**`
- Verification Agent：只跑测试和 parity 检查，不改实现。

并行规则：

- 每个 worker 只写自己的目录和对应测试。
- 统一导出 `lib/engineering/index.ts` 由主 agent 合并。
- 文档由主 agent 维护。
- 不让多个 worker 同时改同一个 index 或 shared type，避免冲突。

## 最近三步

1. 先实现 Phase 1 Code-A：独立 `EngineeringCodeGraph` 和完整 code model。
2. 再实现 Phase 2 Entity-A：entity graph 基础构建和 BFS 查询。
3. 同时让 Discovery-A 迁 parser golden tests，为后续 discoverer 迁移铺路。

## 当前执行窗口

已完成：

- Code-A：`lib/engineering/code` 已具备独立 `EngineeringCodeGraph`、AST summary 输入、ProjectGraph 风格查询、overview、JSON round trip。
- Entity-A：`lib/engineering/entity` 已具备独立 `EngineeringEntityGraph`、实体/边模型、builder、基础查询、BFS path、impact radius、topology、hot nodes。
- Discovery-A：`lib/engineering/discovery/parsers` 已具备 parser 类型与 Ruby/YAML/JSON 三类 parser，覆盖 EasyBox、XcodeGen、Melos、workspace、Nx、tsconfig references 等结构信号。

基础层验证结果：

- `npm run typecheck` 通过。
- `npx vitest run --config vitest.config.ts lib/engineering` 通过，5 files / 30 tests。
- `npm test` 通过，44 files / 198 tests。
- `npx biome check lib/engineering` 通过，剩余 2 个静态工具类形态警告，暂按 API 稳定性保留。

已完成基础层：

- Code-B：`lib/engineering/code` 已具备 call/data-flow 类型、增量 update/delete cleanup、Guard AST 查询预留。
- Entity-B：`lib/engineering/entity` 已具备 callers/callees、call impact、agent context、recipe/pattern、按文件清理。
- Discovery-B：`lib/engineering/discovery/parsers` 已具备 Gradle DSL、Starlark/Bazel、CMake parser。

第二阶段已完成：

- Discovery-C：`lib/engineering/discovery` 已具备 `ProjectDiscoverer`、SPM/Node/Python/JVM/Go/Dart/Rust/Generic discoverer、registry/preference/conflict，默认顺序保持 `spm -> node -> python -> jvm -> go -> dart -> rust -> customConfig -> generic`。
- Panorama-A：`lib/engineering/panorama` 已具备 `EngineeringModuleDiscoverer` 纯事实版、模块文件归组、host 拆分、vendor/resource skip、import fallback dependency inference。

第二阶段验证结果：

- `npm run typecheck` 通过。
- `npx vitest run --config vitest.config.ts lib/engineering` 通过，7 files / 45 tests。
- `npm test` 通过，46 files / 213 tests。
- `npx biome check lib/engineering` 通过，剩余 2 个静态工具类形态警告，暂按 API 稳定性保留。

后续执行：

- Code-C：迁入 SymbolTableBuilder、ImportPathResolver、CallSiteExtractor、CallEdgeResolver、DataFlowInferrer 的纯工程 analysis 子模块。
- Discovery-D：迁入完整 CustomConfigDiscoverer、profile registry、Boxfile.local/多配置合并、ConfigWatcher、跨文件深聚合。
- Panorama-B：迁入 Snapshot/Service/overview/module detail。
- Panorama-C：迁入 TechStackProfiler、DimensionAnalyzer、Health/Gaps/CallFlow。
- Workflow-A：等 panorama facts 成型后迁入 cold-start 前工程流水线 phase runner。

第三阶段执行窗口：

- Code-C：负责 `lib/engineering/code/analysis/**`，把 legacy 调用图/数据流的真实解析能力从 summary 层继续补厚。
- Discovery-D：负责 `lib/engineering/discovery/**`，补 CustomConfig/ConfigWatcher/跨文件深聚合。
- Panorama-B：负责 `lib/engineering/panorama/**`，补 Snapshot/Service/module detail。

第三阶段已完成：

- Code-C：`lib/engineering/code/analysis` 已具备 `SymbolTableBuilder`、`ImportPathResolver`、`CallSiteExtractor`、`CallEdgeResolver`、`DataFlowInferrer`、`CallGraphAnalyzer`，覆盖 direct/import/class method/inheritance override/protocol conformer/RTA/fallback unresolved 和 source/sink/transform/store 等数据流推断。
- Discovery-D：`lib/engineering/discovery` 已具备完整 `CustomConfigDiscoverer`、`CustomConfigProfiles`、`ConfigWatcher`，覆盖 EasyBox、Bazel/Buck2/Pants、Gradle Convention、Melos、Tuist、Nx、CMake、XcodeGen、KMP、RN/Flutter hybrid 等 profile，并保留 `scope/configuration/bridgeType/tags/visibility/conventionRole/layer` metadata。
- Panorama-B：`lib/engineering/panorama` 已具备 `EngineeringPanoramaSnapshot`、`EngineeringPanoramaService`、module detail、overview、stale/cache marker，纯服务内部串联 `EngineeringModuleDiscoverer` 与 `EngineeringPanoramaRefiner`。

第三阶段验证结果：

- `npm run typecheck` 通过。
- `npx vitest run --config vitest.config.ts lib/engineering` 通过，9 files / 59 tests。
- `npm test` 通过，48 files / 227 tests。
- `npx biome check lib/engineering` 通过，剩余 2 个静态工具类形态警告，暂按 API 稳定性保留。

下一批重点：

- Panorama-C：迁入 `TechStackProfiler`、`DimensionAnalyzer`、Health/Gaps/CallFlow/Recipe coverage。
- Workflow-A/B：建立 cold-start 前工程流水线 phase runner、artifact/cache/incremental planner。
- Code-D：接真实 tree-sitter runtime summary 填充入口，让 parser/walker 产出标准化 `callSites/textFacts/propertyTypes/importFacts/receiverTypes`。

第四阶段执行窗口：

- Panorama-C：负责 `lib/engineering/panorama/**`，补 `EngineeringTechStackProfiler`、`EngineeringDimensionAnalyzer`、Health/Gaps/CallFlow，并扩展 snapshot/service 的纯事实输出。
- Workflow-A：负责 `lib/engineering/workflow/core/**`、`EngineeringWorkflowTypes.ts`、`EngineeringWorkflowRunner.ts`，实现 `discover -> facts -> graphs -> panorama` phase runner。
- Workflow-B：负责 `lib/engineering/workflow/cache/**`、`lib/engineering/workflow/incremental/**`，实现 file diff、snapshot store、incremental planner、容量控制。

第四阶段已完成：

- Panorama-C：`lib/engineering/panorama` 已具备 `EngineeringTechStackProfiler`、`EngineeringDimensionAnalyzer`、Health/Gaps/CallFlow，并把 `techStack`、`dimensions`、`health`、`gaps`、`callFlow` 接入 `EngineeringPanoramaSnapshot` 与 `EngineeringPanoramaService`。
- Workflow-A：`lib/engineering/workflow` 已具备纯工程 `EngineeringWorkflowRunner`，串联 `discover -> collectFacts -> buildGraphs -> panorama`，输出 targets/files/dependencyGraph/codeGraph/callGraph/dataFlow/entityGraph/panoramaSnapshot artifact。
- Workflow-B：`lib/engineering/workflow/cache` 与 `lib/engineering/workflow/incremental` 已具备 file fingerprint/snapshot/diff、in-memory/json snapshot store、capacity prune、baseline/projectRoot diagnostics、`full-rescan/targeted-rescan/panorama-only/skip` incremental plan。

第四阶段验证结果：

- `npm run typecheck` 通过。
- `npx vitest run --config vitest.config.ts lib/engineering` 通过，14 files / 80 tests。
- `npm test` 通过，53 files / 248 tests。
- `npx biome check lib/engineering` 通过，剩余 2 个静态工具类形态警告，暂按 API 稳定性保留。

下一批重点：

- Workflow-C：把 cache/incremental 与 `EngineeringWorkflowRunner` 串成可选执行路径，支持 baseline 存在时定向重扫、跳过或 panorama-only。
- Workflow-D：迁入 Enhancement/Guard/Dimension optional stage，输出 patterns、guard findings、dimension-file refs。
- Code-D：接真实 tree-sitter runtime summary 填充入口，让 parser/walker 产出标准化 `callSites/textFacts/propertyTypes/importFacts/receiverTypes`。

第五阶段执行窗口：

- Workflow-C：负责 `lib/engineering/workflow/**`，把 cache/incremental 编排接入 runner，支持 full/targeted/panorama-only/skip。
- Workflow-D：负责 `lib/engineering/workflow/optional/**`，迁入 Enhancement/Guard/Dimension optional stage 的纯工程壳。
- Code-D：负责 `lib/engineering/code/**`，建设 AST facts normalizer，让真实 parser/walker 输出统一 summary facts。

第五阶段已完成：

- Code-D：`lib/engineering/code/ast` 已具备 `EngineeringCodeAstFacts` 与 `EngineeringCodeAstNormalizer`，支持 legacy AstAnalyzer-like summary、多语言 walker 输出、轻量 tree-sitter-like 节点，标准化 TS/JS、Python、Swift、ObjC、Java/Kotlin、Go、Rust、Dart 的 imports/exports/callSites/propertyTypes/receiverTypes/textFacts，并接入 `SymbolTableBuilder` 与 `CallSiteExtractor`。
- Workflow-C：`EngineeringWorkflowRunner` 已具备 cache phase 和 incremental orchestration，支持 baseline read、file diff、incremental plan、`full-rescan/targeted-rescan/panorama-only/skip`，并输出 baseline missing、projectRoot mismatch、generated skip、capacity prune、snapshot write failure 等 diagnostics。
- Workflow-D：`lib/engineering/workflow/optional` 已具备 Enhancement pack catalog、preprocessor、Guard audit 壳、Dimension gating、OptionalStage，覆盖 React/Next/Vue/Node/Django/FastAPI/Spring/Android/Rust/Go/ML/LangChain 主要 legacy pack，并保留真实 Guard/Recipe DB/LLM 接入点。
- Workflow-E：`EngineeringWorkflowRunner` 已正式挂载 optional phase，artifact 输出 optionalStage、enhancement signals、guard findings、dimension gates、dimension-file refs、diagnostics；`skip` 返回 cached-adapter placeholder，`panorama-only` 默认执行 optional。
- Parity 文档：`docs/migration/lib-engineering-parity-and-adapter-plan.md` 已完成，明确核心模块与 adapter 边界。

第五阶段验证结果：

- `npm run typecheck -- --pretty false` 通过。
- `npx vitest run --config vitest.config.ts lib/engineering` 通过，16 files / 98 tests。
- `npm test` 通过，55 files / 266 tests。
- `npx biome check lib/engineering` 通过，剩余 2 个静态工具类形态警告，暂按 API 稳定性保留。

下一批重点：

- Adapter-A：在 `lib/mainline` 或后续 adapter 层接入 `lib/engineering`，替换旧 `lib/mainline/engineering` 使用点；核心模块本身不再新增 legacy 依赖。
- Runtime-A：进入 agentRuntime/agent tool 接入前，整理 `lib/engineering` 公共 API 与迁移 parity 清单，准备删除 `lib/mainline/engineering`。
