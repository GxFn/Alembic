# lib/engineering 成熟工程底座迁移计划

## 结论

`lib/engineering` 后续不按“新薄模块”继续扩写，而按成熟工程底座恢复路线推进。迁移完成的判断标准不再是编译通过或运行引用切换，而是 legacy/mainline 工程底座能力逐项进入 `lib/engineering`，并在新模块内形成清晰接口和测试。

本计划的迁移对象是工程理解底座，不是旧 UI、旧 daemon、旧 HTTP、旧 DB repository 或旧 IDE 兼容层。凡是属于工程事实解析、工程关系建模、增量判断、项目全景与 agent 可查询图谱的能力，默认迁入。

## 不再采用的判断方式

以下信号只能说明接入链路可运行，不能作为功能完整依据：

- `lib/mainline` 或 agent tool 不再直接引用旧目录。
- `lib/engineering` 已经有同名模块。
- `npm test` 或 typecheck 通过。
- 文档里写了最终要删除旧目录。

删除、剪枝、丢弃成熟实现之前，必须先给出能力级映射与不迁移理由。

## 迁移铁律

1. 工程底座默认迁入。包括 AST、语言 profile、ProjectGraph、调用图、数据流、依赖图、模块关系、实体图、路径查找、影响半径、项目发现、workspace 边界、snapshot、incremental、panorama、dimension/enhancement 中和工程扫描直接相关的能力。
2. 不迁移必须写理由。允许不迁移的范围仅限旧 UI、旧 HTTP/daemon glue、旧 repository/DB 副作用、旧 IDE 兼容入口、历史过渡格式。
3. 先完整，再整理。可以在 `lib/engineering` 内重新命名、分层和类型化，但不能因为新接口暂时不需要就丢成熟能力。
4. 接入层不能反向定义核心。`lib/mainline`、agent tool、cold-start workflow 后续只适配 `lib/engineering`，不能把核心能力继续散落在外层。
5. 每层用测试证明能力还在。测试要覆盖查询语义、边界语义、增量语义和典型多语言项目，而不是只测构造函数。

## 第一阶段：AST 与语言解析内聚

目标：把当前散在 `lib/mainline/code/tree-sitter` 的成熟 tree-sitter 解析能力迁入 `lib/engineering/code/ast`，让 `lib/engineering` 自己拥有从源码到 AST summary 的完整入口。

必须迁入：

- parser 初始化与 wasm grammar 加载边界。
- 多语言插件：Swift、Objective-C、TypeScript/TSX、JavaScript、Python、Java、Kotlin、Go、Dart、Rust。
- `registerLanguage`、`supportedLanguages`、`isAvailable`、`parseToTree`、`analyzeFile`、`analyzeProject`。
- class/protocol/category/method/property/import/export/callSite/reference/inheritance/pattern/metrics 聚合。
- `generateContextForAgent` 的语义，后续可改为结构化 context 加 markdown renderer。
- 语言 profile：extension、source regex、role 识别、guard lang id、project language detection。

第一批实现切片：

- `AstRuntime-A`：新增 `lib/engineering/code/ast/runtime`，迁 parser-init、language plugin registry、grammar resolver。
- `AstLanguage-B`：把各语言 walker 从 `lib/mainline/code/tree-sitter/ast` 内聚到 `lib/engineering/code/ast/languages`。
- `AstAnalyzer-C`：迁 `AstAnalyzer` 项目级聚合入口，并接入现有 `EngineeringCodeAstNormalizer`。
- `AstTests-D`：为 Swift/TS/Python/Go/Rust 各加最小 fixture，验证 class、call site、pattern、metrics。

完成门槛：

- `lib/engineering` 不再需要通过 `lib/mainline/code/tree-sitter` 获得 AST 解析能力。
- `TreeSitterAstParser` 可以变成 mainline adapter，而不是能力主体。

## 第二阶段：ProjectGraph、调用图与数据流补齐

目标：`lib/engineering/code` 具备 legacy `ProjectGraph` 与 `core/analysis` 的成熟查询与解析语义。

必须迁入：

- ProjectGraph 风格索引：class/protocol/category/method/file/symbol/pattern/overview。
- inheritance chain、subclasses、all descendants、conformance、category extension、method overrides。
- `SymbolTableBuilder`、`ImportPathResolver`、`CallSiteExtractor`、`CallEdgeResolver`、`CallGraphAnalyzer`、`DataFlowInferrer` 的完整语义。
- call graph tier 策略、sampling 策略、unresolved edge 统计、data-flow edge 聚合。
- incremental update 和 deleted file cleanup。

第一批实现切片：

- `GraphCode-A`：补 `EngineeringCodeGraph` 的 ProjectGraph 等价 API 和索引测试。
- `CallGraph-B`：对齐 call/data-flow analyzer 的 legacy 行为，增加 fixture。
- `GraphParity-C`：建立 legacy-like AST summary 到新 code graph 的 golden 快照测试。

完成门槛：

- ProjectGraph 关键查询在 `lib/engineering/code` 内可直接完成。
- agent graph tool 不需要 mainline artifact 的旧 project graph 才能回答 class/call/impact 查询。

## 第三阶段：实体图与模块关系完整迁入

目标：迁入 `CodeEntityGraph` 与 `ModuleService` 的纯工程语义，形成 agent 可消费的统一实体关系图。

必须迁入：

- entity 类型：file、target、module、external、class、protocol、category、method、property、symbol、pattern、recipe。
- edge 类型：defines、contains、depends_on、inherits、conforms、extends、calls、data_flow、uses_pattern、is_part_of。
- 构建入口：from code graph、from dependency graph、from call graph、from candidates、from module facts。
- 查询入口：find/list/search、incoming/outgoing、findPath、impact radius、callers/callees、call impact、topology、cycles、hot nodes。
- agent context：保留 legacy `generateContextForAgent` 的上下文密度。
- 模块关系：模块识别、模块文件归属、模块依赖、层级、角色、邻居、风险模块。

第一批实现切片：

- `EntityGraph-A`：逐项对齐 CodeEntityGraph 查询 API，补缺口测试。
- `ModuleGraph-B`：新增 `lib/engineering/module` 或并入 `panorama/module` 的模块关系核心，迁 ModuleService 纯算法。
- `AgentContext-C`：做结构化 context renderer，覆盖 path/impact/call/data-flow/module。

完成门槛：

- 影响半径、路径查找、上下文生成不比 legacy 少。
- module relationship 不只存在于 panorama summary，而是可作为底层图事实查询。

## 第四阶段：Discovery、Workspace 与项目边界

目标：保留成熟项目发现能力，同时让 workspace 与写入边界在 `lib/engineering` 中有干净接口。

必须迁入：

- Discoverer API：detect、load、listTargets、getTargetFiles、getDependencyGraph。
- registry 顺序与冲突分析：spm、node、python、jvm、go、dart、rust、customConfig、generic。
- parser：Ruby DSL、YAML、JSON、Starlark/Bazel、Gradle、CMake。
- CustomConfig 成熟 profile：EasyBox、Bazel、Gradle convention、Melos、Tuist、Nx、CMake、XcodeGen 等。
- WorkspaceResolver 的工程事实：workspaceRoot、dataRoot、projectId、ghost/standard mode、config path。
- ProjectRegistry 的 project id 与 ghost workspace 路径算法。
- PathGuard 的写入边界语义，作为工程层安全接口，不绑定旧 permission manager。

第一批实现切片：

- `Workspace-A`：迁 WorkspaceResolver/ProjectRegistry/PathGuard 纯函数与接口。
- `DiscoveryParity-B`：为各 discoverer 建 fixture 和结果 contract 测试。
- `CustomConfig-C`：补 custom config profile 覆盖缺口。

完成门槛：

- `lib/engineering` 能独立识别 workspace 与项目边界。
- discovery 输出保留 scope/configuration/bridgeType/tags/visibility/conventionRole/layer 等成熟字段。

## 第五阶段：Snapshot、Diff 与增量流水线

目标：冷启动前工程流水线具备成熟增量判断与 snapshot 投影能力。

必须迁入：

- `ProjectSnapshot`、`ProjectSnapshotInput`、`buildProjectSnapshot` 的工程字段规范。
- `toResponseData`、`toSessionCache` 的投影语义，拆为工程层 projection，不接旧外部 runtime。
- `FileDiffPlanner`、`FileDiffSnapshotStore` 的路径 normalize、hash reconcile、changed/deleted/affected dimensions、full rebuild threshold、snapshot retention。
- `ProjectIntelligencePreparation` 的运行准备语义。
- `ProjectIntelligenceIncrementalPlanner` 的 baseline、skip、targeted、full-rescan 判断。
- `ProjectIntelligenceResultProjection` 的 target summary 与 local package modules。

第一批实现切片：

- `Snapshot-A`：新增 `lib/engineering/snapshot`，迁 project snapshot schema/builder/projection。
- `Incremental-B`：补齐 file diff snapshot store 的成熟路径与 hash 语义。
- `Workflow-C`：让 `EngineeringWorkflowRunner` 输出 snapshot/projection，并支持 full/targeted/skip/panorama-only 的真实 contract。

完成门槛：

- 冷启动前工程 artifact 能独立落盘与恢复。
- 增量策略能解释为什么 full、targeted、skip，而不是只返回粗略 mode。

## 第六阶段：Panorama、Dimension 与 Enhancement

目标：把 panorama 作为工程全景核心，而不是摘要装饰。

必须迁入：

- ModuleDiscoverer：文件补全、config layer、host 分解、vendor/resource 跳过、import fallback。
- RoleRefiner、CouplingAnalyzer、LayerInferrer 的成熟判断。
- PanoramaScanner、PanoramaAggregator、PanoramaService 的 overview、detail、health、gaps、stale/cache 标记。
- TechStackProfiler 与 DimensionAnalyzer。
- HealthRadar、KnowledgeGap、CallFlowSummary、module neighbors、external dependency hotspots。
- DimensionRegistry、DimensionSop、DimensionCopy 中和工程扫描/维度 gating 直接相关的规则。
- EnhancementRegistry 与各 pack 的 signal/exclusion/trigger 语义。

第一批实现切片：

- `PanoramaCore-A`：补 scanner/aggregator/service contract。
- `Dimension-B`：新增 `lib/engineering/dimension`，迁工程维度 registry/SOP/copy。
- `Enhancement-C`：把 optional stage 的 catalog 升级为 legacy registry 语义。

完成门槛：

- panorama 能回答模块详情、层级违规、耦合热点、知识缺口、维度覆盖。
- enhancement 不只是静态 catalog，而能参与 AST/project facts 预处理与审计。

## 并行推进窗口

当前并行审查窗口：

- `AST 窗口`：审 AST/tree-sitter/语言 profile。
- `Graph 窗口`：审 ProjectGraph、CodeEntityGraph、ModuleService、调用/数据流。
- `Discovery 窗口`：审 discovery/workspace/snapshot/incremental。
- `Panorama 窗口`：审 panorama/dimension/enhancement/optional。

第一批实现窗口建议：

- Worker 1 写 `lib/engineering/code/ast/**`，只迁 AST runtime/languages/analyzer。
- Worker 2 写 `lib/engineering/code/**` 与 `lib/engineering/entity/**`，只补 ProjectGraph/CodeEntityGraph 缺口。
- Worker 3 写 `lib/engineering/workspace/**`、`lib/engineering/discovery/**`，只补 workspace/path guard/discovery parity。
- Worker 4 写 `lib/engineering/snapshot/**` 与 `lib/engineering/workflow/**`，只补 snapshot/diff/incremental。
- 主窗口维护 `docs/migration/lib-engineering-mature-core-migration-plan.md`、`lib/engineering/index.ts`、最终整合和测试。

并行约束：

- worker 不改 `package.json`、`tsconfig.json`、`lib/mainline/**`，除非主窗口明确指定。
- worker 不删除文件、不提交。
- 每个 worker 必须在最终报告列出 changed files、补齐能力、未补齐能力和测试命令。
- 任何“丢弃”只能写入计划文档，不能直接从代码删除。

## 最近 24 小时执行顺序

1. 合并四个审查窗口结果，形成能力矩阵。
2. 先落地 AST 内聚和 Workspace/PathGuard，这两块是后续 graph/workflow 的底座。
3. 并行补 CodeEntityGraph 与 snapshot/diff。
4. 跑 `npm run typecheck -- --pretty false`、`npm test`，再针对新增模块跑定向 vitest。
5. 汇总缺口，不提交，除非用户明确要求。

## 2026-05-11 `mainline/code` 清理结果

`lib/mainline/code` 已清理，保留能力迁入 `lib/engineering/code`：

- AST port、language catalog、language service、source scanner、import parser、import path resolver、symbol table builder、call site extractor、tree-sitter parser 迁入 `lib/engineering/code`。
- 成熟多语言 walker 已进入 `lib/engineering/code/tree-sitter`：Swift、Objective-C、TypeScript/TSX、JavaScript、Python、Java、Kotlin、Go、Dart、Rust。
- tree-sitter runtime、language registry、`analyzeFile`、`analyzeProject`、`parseToTree`、`isAvailable`、`supportedLanguages` 已由 `lib/engineering/code/tree-sitter` 对外提供。
- `inheritanceGraph`、`patternStats`、project metrics、agent markdown context、Guard AST 查询语义已补入 engineering 入口。
- `CallGraphAnalyzer` 已补回成熟链路里的 tier/sampling/timeout 统计入口，并继续使用 `SymbolTableBuilder`、`ImportPathResolver`、`CallEdgeResolver`、`DataFlowInferrer` 作为独立分析层。
- `lib/mainline/**`、agent tool、guard、workflow 的代码解析引用已切到 `lib/engineering/code`，`mainline` 后续只作为接入 adapter，不再持有代码解析能力主体。

明确丢弃：

- `StructuralAstParser`：这是新仓库早期薄实现，没有 legacy/mainline 的成熟 AST 深度，不再作为核心或 fallback 保留。

## 2026-05-11 并行审查结果

审查结果确认：当前 `lib/engineering` 已经具备不少新骨架，但成熟底层实现仍有关键缺口。接下来按下面五条线并行推进。

### A. AST runtime 缺口

已迁入：语言 profile、AST fact schema、normalizer、code graph 查询面。

缺失：

- tree-sitter runtime 仍在 `lib/mainline/code/tree-sitter`。
- 多语言 walker 仍在 mainline：Swift、Objective-C、TypeScript/TSX、JavaScript、Python、Java、Kotlin、Go、Dart、Rust。
- `ProjectGraph.build(projectRoot)` 风格的“扫描源码并解析”入口没有进入 `lib/engineering`。
- grammar 检查、`ensureGrammars`、`inferLanguagesFromStats` 未迁入。
- call graph timeout、tier 降级、incremental 分析策略未迁齐。

第一动作：新增 `lib/engineering/code/tree-sitter`，把 runtime/language walker/analyzer 内聚进 engineering。

### B. Entity graph 与 graph query 缺口

已迁入：基础实体模型、BFS path、impact、topology、agent context、ProjectGraph 读查询。

缺失：

- workflow 生成 entityGraph 时没有灌入 callGraph/dataFlow，导致影响分析低估。
- patternStats、candidate relations、recipe/pattern 关系未自动进入实体图。
- graph query 缺 `path/topology/callImpact/entities/edges/conformances` 等外部查询口。
- ModuleService façade 缺位，多 discoverer 合并与目录扫描入口缺失。

第一动作：先补 `EngineeringEntityGraph.addCallGraph/addPatternStats/addCandidateRelations`，再扩 graph query。

### C. Workspace、Registry、PathGuard 缺口

已迁入：少量路径 helper。

缺失：

- `WorkspaceResolver.fromProject/toFacts` 未迁入。
- `ProjectRegistry` 未作为 engineering 公共 API 落位。
- `PathGuard` 未迁入，后续工程层持久化会缺写入边界。
- Ghost 模式 dataRoot/registry 兜底不完整。

第一动作：新增 `lib/engineering/workspace` 下 resolver、registry、path guard 的纯工程接口。

### D. Snapshot、Diff、Incremental 缺口

已迁入：workflow cache、JSON snapshot store、diff planner、四种 incremental mode。

缺失：

- legacy `ProjectSnapshot` 类型、builder、`toResponseData`、`toSessionCache` 没有 engineering 等价。
- `FileDiffSnapshotStore` 的维度-文件关系、latest/byId/list/clearProject/computeDiff/inferAffectedDimensions 不完整。
- `diff-parser` 的 git diff 获取与 hunk 解析未进入 engineering。

第一动作：新增 `lib/engineering/snapshot`，建立统一不可变 project snapshot，再补 persistent snapshot adapter。

### E. Dimension、Enhancement、Panorama 缺口

已迁入：panorama 主干、optional 轻量阶段、14 个 enhancement catalog。

缺失：

- legacy 统一维度域没有迁入：25 个维度、tier plan、SOP、copy、recipe dimension 分类。
- enhancement class API 没迁：`EnhancementPack`、`EnhancementRegistry`、pack 的 `detectPatterns/preprocessFile/getGuardRules/getExtraDimensions`。
- panorama legacy service API 未迁：`ensureData/rescan/invalidate/getResult/getGaps/getHealth`。
- 当前 dimension ID 与 legacy ID 不一致，optional gating 可能漏激活。

第一动作：新增 `lib/engineering/dimension` 与 `lib/engineering/enhancement`，再改 optional/panorama 使用统一 registry。

## 第一批 worker 写域

- Worker AST：只写 `lib/engineering/code/tree-sitter/**`、必要的 `lib/engineering/code/ast/**` 测试。
- Worker Entity：只写 `lib/engineering/entity/**`、`lib/engineering/graph/**` 测试。
- Worker Workspace：只写 `lib/engineering/workspace/**` 测试。
- Worker Snapshot：只写 `lib/engineering/snapshot/**`、必要的 `lib/engineering/workflow/cache/**` 测试。
- Worker Dimension：只写 `lib/engineering/dimension/**`、`lib/engineering/enhancement/**` 测试。

主窗口负责整合：

- `lib/engineering/index.ts` 导出。
- workflow runner 接入。
- mainline adapter 接入。
- typecheck/test。
- 是否提交。

## 2026-05-11 第一批落地状态

第一批已经完成并通过验证。它不是完整迁移终点，但已经把 `lib/engineering` 从薄骨架推进到可继续承载成熟底座的状态。

已落地：

- AST runtime：新增 `lib/engineering/code/tree-sitter`，具备 `web-tree-sitter` 初始化、grammar resolver、language registry、`supportedLanguages/isAvailable/parseToTree/analyzeFile/analyzeProject`。第一批已迁 TS/TSX、JavaScript、Python walker，并输出到 `EngineeringCodeAstFacts` normalizer。
- Entity/Graph：`EngineeringEntityGraph` 已补 `addCallGraph`、`addPatternStats`、`addCandidateRelations`；graph query 已补 `path/topology/callImpact/entities/edges/conformances`。workflow 构建 entity snapshot 时已写入 call/data-flow，避免影响分析只在 query provider 临时补边。
- Workspace：新增 `WorkspaceFacts`、`EngineeringWorkspaceResolver`、`EngineeringProjectRegistry`、`EngineeringPathGuard`，覆盖 standard/ghost/dataRoot/排除项目写边界。
- Snapshot：新增 engineering 版 `ProjectSnapshot`、builder、workflow result projection、`toResponseData`、`toSessionCache`。
- Dimension/Enhancement：新增 `lib/engineering/dimension` 与 `lib/engineering/enhancement`，迁入 25 个维度 registry、tier plan、recipe dimension helpers、SOP/copy compact API，以及 class-based enhancement registry 桥接层。
- Root export：`lib/engineering/index.ts` 已导出新增 AST runtime、dimension、enhancement、snapshot、workspace 能力。

已验证：

- `./node_modules/.bin/biome check` 覆盖本轮新增/修改的 engineering 模块与文档，通过。
- `npm run typecheck -- --pretty false` 通过。
- `npm test` 通过，61 files / 283 tests。

仍未完成：

- AST runtime 还缺 Swift、Objective-C、Java、Kotlin、Go、Dart、Rust walker。
- `ProjectGraph.build(projectRoot)` 风格的磁盘扫描 + AST 解析入口还没有作为完整工程 API 暴露。
- call graph 的 timeout、tier 降级、incremental analyze 还未补齐。
- `EngineeringModuleService`/AggregateDiscoverer façade 还未补，混合仓库多 discoverer 合并仍需要第二批做。
- persistent `FileDiffSnapshotStore`、维度-文件精确映射、git diff parser 还未补完。
- panorama 尚未接入统一 dimension registry，也没有完整 legacy service adapter。
- enhancement 当前是 class-based 桥接 registry，尚未把每个 legacy pack 的完整独立 detect/preprocess 逻辑完全展开。

第二批建议优先级：

1. 继续 AST walker 全语种迁入，优先 Swift/Go/Java/Kotlin。
2. 补 `EngineeringCodeProjectGraph.build`，让 workflow 能从 projectRoot/fileContents 自己产出 AST summary。
3. 补 `EngineeringModuleService` 和 AggregateDiscoverer，恢复多 discoverer 合并与手动目录扫描。
4. 补 persistent snapshot adapter 与 git diff parser。
5. 把 panorama optional 阶段接到统一 dimension/enhancement registry。
