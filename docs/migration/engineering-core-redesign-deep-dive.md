# Engineering Core 深挖与重设计方案

## 结论

`lib/mainline/engineering` 不能按“薄 parser + 简单依赖图”继续扩展。Alembic-legacy 已经形成一条成熟的冷启动前工程理解链路：工程发现、文件收集、多语言 AST、调用图、数据流、实体图、模块关系、耦合/层级/循环、全景摘要、增量规划。新 Alembic 应该把这条链路作为核心，然后在新仓库内重新设计边界、剔除旧 Runtime/DB/HTTP/UI 冗余。

本阶段的策略是：

1. 已验证算法完整保留，不在迁移阶段先删功能。
2. active 层提供干净接口，让 Codex plugin、agent tools、agentRuntime 能先稳定消费工程事实。
3. raw legacy 只作为算法库和行为基准，不把旧 DI、旧数据库、旧 HTTP、旧前端形态搬进新主线。
4. 后续优化只发生在模块内部，不能把成熟能力替换成更浅的实现。

## Legacy 真实主链路

### Phase 1：工程发现与文件收集

真实来源：

- `workflows/capabilities/project-intelligence/ProjectIntelligenceRunner.ts`
- `core/discovery/DiscovererRegistry.ts`
- `core/discovery/SpmDiscoverer.ts`
- `core/discovery/NodeDiscoverer.ts`
- `core/discovery/PythonDiscoverer.ts`
- `core/discovery/GoDiscoverer.ts`
- `core/discovery/CustomConfigDiscoverer.ts`
- `shared/LanguageProfiles.ts`

主要逻辑：

- registry 按置信度选择 discoverer。
- discoverer 先识别工程家族，再加载 targets、source files、dependency graph。
- 自研/复杂工程通过 `CustomConfigDiscoverer` 和 profile 体系处理，不是写死 EasyBox/SPM 特例。
- 文件进入后续 AST 前要保留 target、language、relativePath、test 标记。

新 Alembic 状态：

- mature discoverer 栈已迁入 active 层。
- `EngineeringProjectAnalyzer` 统一执行 detect/load/listTargets/getTargetFiles/getDependencyGraph。
- SPM、Node、Python、Go、EasyBox 已有测试覆盖。

### Phase 1.5：多语言 AST 与增强预处理

真实来源：

- `core/AstAnalyzer.ts`
- `core/ast/parser-init.ts`
- `core/ast/lang-*.ts`
- `core/analysis/CallSiteExtractor.ts`
- `core/analysis/SymbolTableBuilder.ts`
- `core/analysis/ImportPathResolver.ts`
- `core/enhancement/EnhancementPack.ts`
- `core/enhancement/EnhancementRegistry.ts`

主要逻辑：

- `web-tree-sitter` 是主解析能力，不是可失败装饰。
- 多语言插件抽取 class/protocol/category/method/property/import/export/reference/callSite/metrics/patterns。
- enhancement pack 可做框架特定 preprocess、pattern detector、dimension、guard rule、reference skill。
- 调用图所需 symbol table 和 import resolver 在 AST 后继续工作。

新 Alembic 状态：

- tree-sitter grammars 与多语言插件已迁入 `lib/mainline/code/tree-sitter`。
- `TreeSitterMainlineAstParser` 已作为默认 ProjectIntelligence parser。
- `MainlineProjectIntelligenceArtifact` 已携带 `astProjectSummary` 与 `callGraph`。
- enhancement packs 已完整保留在 raw 区，尚未接 active adapter。

### Phase 1.6：CodeEntityGraph 实体物化

真实来源：

- `service/knowledge/CodeEntityGraph.ts`
- `core/ast/ProjectGraph.ts`

主要逻辑：

- 从 AST 生成 file/class/protocol/category/method/property 等实体。
- 写入 inherits/conforms/declares/contains/extends/calls/data_flow/depends_on 等边。
- 提供 search、incoming/outgoing、impact radius、topology、agent context 查询。
- legacy 版本依赖 repository/DB，这是要剥离的旧实现形态，不是要放弃实体图能力。

新 Alembic 状态：

- `EngineeringCodeGraph` 已提供 ProjectGraph 风格读模型。
- `EngineeringEntityGraph` 已提供 repository-free 内存实体图。
- 下一步要补齐 legacy 的 impact/path/topology/agent context 查询，并接新数据层或缓存层。

### Phase 1.7：CallGraph 与 DataFlow

真实来源：

- `core/analysis/CallGraphAnalyzer.ts`
- `core/analysis/CallEdgeResolver.ts`
- `core/analysis/DataFlowInferrer.ts`
- `core/analysis/ImportRecord.ts`

主要逻辑：

- 建 symbol table。
- 抽取 call site。
- 解析跨文件调用目标。
- 推断 data_flow。
- 将 calls/constructs/data_flow 写回图结构和上层 semantic edges。

新 Alembic 状态：

- call graph 与 data_flow 已进入 `semanticEdges`。
- panorama summary 已融合 import/call/data_flow。
- 还需要把 deeper query API 暴露给 agent tool，避免只能看 summary。

### Phase 2：依赖图与模块关系

真实来源：

- `core/discovery/*`
- `service/panorama/CouplingAnalyzer.ts`
- `shared/LanguageProfiles.ts`

主要逻辑：

- discoverer 从 package manager、workspace、custom config 读取模块依赖。
- fallback 可以用语言 profile 的 import pattern 扫描关系。
- `CouplingAnalyzer` 按 depends_on/calls/data_flow 加权，计算 fan-in/fan-out、外部依赖、Tarjan SCC 循环。

新 Alembic 状态：

- `EngineeringRelationshipGraph` 已统一 config/import/call/data_flow 四类关系。
- `EngineeringPanoramaRefiner` 已迁入 legacy weighted coupling 核心：depends_on/calls/data_flow 权重、Tarjan SCC、fan-in/fan-out、外部依赖 fan-in。
- active `EngineeringPanoramaSnapshot` 已消费 refiner 输出，不再只依赖轻量 topology summary。

### Phase 2.1：模块实体与角色细化

真实来源：

- `service/panorama/ModuleDiscoverer.ts`
- `service/panorama/RoleRefiner.ts`
- `shared/LanguageProfiles.ts`

主要逻辑：

- `ModuleDiscoverer` 基于 target/config/file family 建模块实体。
- `RoleRefiner` 权重融合 AST、CallGraph、DataFlow、EntityGraph、regex、config layer、project-name hint。
- language profile 提供 superclassRoles、protocolRoles、artifact suffix、vendor dirs 等辅助判断。

新 Alembic 状态：

- raw 代码完整保留。
- `EngineeringPanoramaRefiner` 已提供 repository-free active adapter，使用 `EngineeringCodeGraph`、module files、relationship graph、config layer 和 panorama module summary 做多信号角色投票。
- 当前 active adapter 已覆盖 AST superclass/protocol/import hints、call fan-in/out、data-flow producer/consumer、topology fan-in/out、config layer、regex baseline、project-name match。
- 下一步需要把 raw `LanguageProfiles` 的完整 family/profile 数据迁入 active 层，替换 adapter 内的核心 hint 子集。

### Phase 2.2：Panorama 全景

真实来源：

- `service/panorama/PanoramaScanner.ts`
- `service/panorama/PanoramaAggregator.ts`
- `service/panorama/PanoramaService.ts`
- `service/panorama/LayerInferrer.ts`
- `service/panorama/TechStackProfiler.ts`
- `service/panorama/DimensionAnalyzer.ts`

主要逻辑：

- 汇总 modules、roles、layers、cycles、coupling、external deps、tech stack、dimension signals。
- `LayerInferrer` 优先使用配置层级，覆盖不足时走 topology longest path。
- Panorama 是 agent 冷启动前理解工程边界的主输入，不只是展示摘要。

新 Alembic 状态：

- `EngineeringPanoramaSnapshot` 已能输出模块、层级、循环、外部依赖。
- `EngineeringPanoramaRefiner` 已迁入 config-first layer inference：配置层级覆盖率达到 0.5 时优先使用配置；未覆盖模块按依赖补位；否则回退拓扑最长路径。
- `TechStackProfiler`、`DimensionAnalyzer`、`PanoramaAggregator` 仍在 raw 区，下一步迁入 active adapter。

### Phase 3/4：Guard、Dimension、Projection

真实来源：

- `core/enhancement/*`
- `domain/dimension/*`
- `workflows/capabilities/project-intelligence/ProjectIntelligenceResultProjection.ts`

主要逻辑：

- enhancement packs 提供 framework/domain guard rules 与 dimensions。
- result projection 负责把工程事实转换成上层可消费视图。
- 这部分属于工程事实之后的 agentRuntime/cold-start 编排边界。

新 Alembic 状态：

- raw 已保留。
- 不应在纯工程模块中生成 Recipe。
- 需要在 agentRuntime/cold-start runner 中消费工程 facts，再做 guard/dimension/projection。

## 新模块边界

### active 层

路径：`lib/mainline/engineering`

职责：

- 工程发现与目标/文件/依赖图。
- AST、调用图、数据流、实体图、代码图、Panorama 快照。
- 给 agent tool、agentRuntime、cold-start runner 提供 typed facts。

不做：

- 不生成 Recipe。
- 不注入外部 IDE。
- 不承载旧 HTTP route。
- 不带旧 dashboard UI。
- 不强依赖旧 DB/repository。

### raw legacy 层

路径：`lib/mainline/engineering/legacy-source`

职责：

- 保留成熟算法。
- 作为行为回归基准。
- 分批抽出 adapter。

不做：

- 不直接进入 `tsconfig` 编译。
- 不把旧 Runtime 依赖当新架构。
- 不在 raw 区继续开发新功能。

### 能力清单

代码来源：`lib/mainline/engineering/EngineeringCapabilityInventory.ts`

用途：

- `active`：已经进入新接口并可测试的能力。
- `raw-preserved`：成熟代码完整保留，等待 adapter。
- `adapter-planned`：数据路径已有，但需要命名 phase/runner 接入主线。
- `ENGINEERING_DISCARDED_LEGACY_REDUNDANCIES`：明确不迁的旧形态。

当前必须保住的 active 能力：

- project discovery
- project file collection
- tree-sitter AST
- call/data-flow semantic edges
- dependency graph
- project code graph
- code entity graph
- panorama snapshot
- module role refinement
- weighted coupling and layer inference

当前必须保住的 raw-preserved 能力：

- language profiles
- enhancement packs
- project-intelligence incremental planner

明确丢弃的旧冗余：

- legacy DI container
- legacy HTTP routes
- legacy dashboard front-end
- one-off example rewrites

## 后续实施顺序

1. 以 `EngineeringCapabilityInventory` 为保护网，所有工程模块重构先更新能力状态，再改实现。
2. 把 raw `LanguageProfiles` 完整 profile 数据迁入 active adapter，减少硬编码 hint 子集。
3. 补齐 `EngineeringEntityGraph` 的 path/impact/topology/agent context 查询。
4. 把 `ProjectIntelligenceIncrementalPlanner` 与 snapshot store 接入新数据层。
5. 新增 `EngineeringColdStartPhaseRunner`，显式复刻 legacy Phase 1 到 Phase 2.2，但输出新 `EngineeringProjectFacts`。
6. agentRuntime 与 agent tools 只消费 active facts，不直接引用 raw legacy。
