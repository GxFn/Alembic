# Alembic-legacy 工程核心迁移状态

## 核心原则

新 Alembic 的冷启动前工程能力以 Alembic-legacy 已验证的方案为核心：`web-tree-sitter`、多语言 AST 插件、调用点抽取、跨文件 CallGraph/DataFlow、工程图谱和 Panorama 推断是主线事实来源。新仓库早期写的轻量 `StructuralAstParser` 只保留为过渡代码，不再作为 ProjectIntelligence、Kernel 或 Agent tool 的默认核心。

`web-tree-sitter` 不再被当作“可失败能力”。语法初始化、WASM 加载或插件注册失败时，应暴露为迁移/打包问题；不能静默降级到薄 parser 后假装完成工程理解。

## 已迁移并接入

- `resources/grammars/*.wasm` 已迁入新 Alembic，并纳入 npm package `files`。
- `lib/mainline/code/tree-sitter/ast/*` 已迁入 legacy 多语言插件：TypeScript、JavaScript、Python、Swift、Objective-C、Java、Kotlin、Go、Dart、Rust。
- `lib/mainline/code/tree-sitter/AstAnalyzer.ts` 已迁入 legacy AST 主入口，保留 classes、protocols、categories、methods、properties、imports、exports、callSites、references、inheritanceGraph、metrics、patterns。
- `lib/mainline/code/tree-sitter/analysis/*` 已迁入 legacy 调用图分析链路：CallSiteExtractor、SymbolTableBuilder、ImportPathResolver、CallEdgeResolver、DataFlowInferrer、CallGraphAnalyzer。
- `TreeSitterMainlineAstParser` 已成为 ProjectIntelligence 默认 parser，并把 legacy AST summary 暴露给上层。
- `MainlineKernel` 默认 AST parser 已切到 `TreeSitterMainlineAstParser`。
- Agent 内部 `code.outline` tool 默认 AST parser 已切到 `TreeSitterMainlineAstParser`。
- `MainlineProjectIntelligenceArtifact` 已新增 `astProjectSummary` 和 `callGraph`，不再只保存薄层 symbols/imports/callSites。
- `semanticEdges` 已融合 legacy CallGraph 的跨文件 `calls/constructs` 和 `data_flow` 边。
- `ProjectPanoramaSummary` 已从 artifact 汇总升级为基于 import/call/data_flow 的模块耦合、循环、层级和 layer violation 推断。
- `lib/mainline/engineering` 已新增为纯工程理解独立模块，边界上只输出工程事实，不生成 Recipe、不做 Runtime 注入。
- `EngineeringProjectAnalyzer` 已提供统一 facade：discoverer 检测 → target/files → 模块关系文件解析 → AST/CallGraph → Panorama/relationship graph。
- `EngineeringDiscovererRegistry` 已改为封装 legacy 成熟 `DiscovererRegistry`，不再维护按示例重写的薄 discoverer。
- legacy 工程 discoverer 栈已迁入：SPM、Node、Python、JVM、Go、Dart、Rust、CustomConfig、Generic fallback。
- `CustomConfigDiscoverer` 已整体迁入成熟自研构建系统 profile：Bazel、Buck2、Gradle Convention、Melos、EasyBox、Tuist、KSComponent、MTComponent、Flutter Add-to-App、React Native Hybrid、Kotlin Multiplatform、Nx、Pants、CMake、XcodeGen。
- SPM 迁移保留 `Package.swift` 正则解析、target/source files、package/target/remote dependency graph，并补齐 `.target(... dependencies: ["Core"])` 本地 target 简写依赖。
- Node/Python/Go discoverer 已在新工程 facade 下验证；Go 迁移补齐 `cmd/*` target 到 `internal/*` 包的 import 关系扫描。
- EasyBox 不再作为新仓库独立硬编码方向，而是作为 `CustomConfigDiscoverer` 的成熟 profile 运行，保留 Boxfile、Boxfile.local、本地模块、boxspec/podspec、配置层级和循环关系解析。
- `EngineeringRelationshipGraph` 已统一 config/import/call/data_flow 四类模块边，并输出 cycles、layers、layerViolations。
- `lib/mainline/engineering/legacy-source` 已作为 raw legacy 迁入区，完整保留冷启动前工程能力相关成熟源码，暂不做接口重塑：
  - `core/ast/ProjectGraph.ts`
  - `core/analysis/*`
  - `core/discovery/*`
  - `core/enhancement/*`
  - `service/knowledge/CodeEntityGraph.ts`
  - `service/module/ModuleService.ts`
  - `service/panorama/*`
  - `workflows/capabilities/project-intelligence/*`
  - `shared/*`、`types/*`、`domain/dimension/*`
- `legacy-source` 当前从 `tsconfig` 编译中排除，原因是这一层保留旧 DB/repository/DI/agent 依赖原貌；下一步再从 raw 区向新 `engineering` 接口逐步适配，而不是边迁边改丢功能。
- `LegacyEngineeringSourceManifest` 已在编译内导出 raw 迁入清单，测试会按清单检查关键成熟源码存在，避免后续整理时漏迁或误删。
- `EngineeringCodeGraph` 已新增为 active ProjectGraph 风格读模型，提供 class/protocol/category/method/file/overview 查询。
- `EngineeringEntityGraph` 已新增为 active CodeEntityGraph 风格内存读模型，物化 file/target/module/class/protocol/category/symbol 和关系边。
- `EngineeringPanoramaSnapshot` 已新增为 active Panorama 风格快照，输出模块、层级、循环、外部依赖概览。
- `EngineeringPanoramaRefiner` 已新增为 active Panorama 成熟算法 adapter，迁入 legacy `RoleRefiner`、`CouplingAnalyzer`、`LayerInferrer` 的核心逻辑：三边加权、Tarjan SCC、fan-in/fan-out、外部依赖 fan-in、配置优先层级、拓扑回退、多信号角色投票。
- `lib/engineering` 已新增为真正独立的工程能力新根目录，先从 `foundation`、`language`、`graph`、`workspace` 底层建设。
- `EngineeringPanoramaRefiner` 已开始消费 `lib/engineering/language` 和 `lib/engineering/workspace`，不再维护自己的语言 profile 和路径模块规则。
- `EngineeringProjectAnalyzer.analyze()` 已把 `codeGraph`、`entityGraph`、`panoramaSnapshot` 纳入返回结果。
- `EngineeringCapabilityInventory` 已新增，代码层面锁定 active、raw-preserved、adapter-planned 与明确丢弃的 legacy 冗余；`module-role-refinement`、`coupling-and-layer-inference`、`language-profiles` 已从 raw-preserved 推进为 active。
- 单独优化设计文档见 `docs/migration/engineering-module-optimization-design.md`。
- legacy 真实链路深挖与重设计文档见 `docs/migration/engineering-core-redesign-deep-dive.md`。

## 当前验证

- `npm run typecheck` 通过。
- `npm run build` 通过。
- `npm run test:unit` 通过：39 个测试文件、166 个测试。
- 工程模块测试通过：`lib/mainline/engineering/engineering.test.ts` 覆盖 legacy discoverer 栈注册、raw legacy 关键源码存在性、SPM、Node workspace、Python pyproject、Go module、CustomConfig/EasyBox。
- 工程模块测试新增 Panorama refiner 直接覆盖：weighted coupling、config-based layers、external fan-in、AST/config role signals。
- 新 `lib/engineering` 底座测试覆盖语言 profile、图 primitives、workspace module path 规则。
- 新增测试锁定跨文件调用边：`src/app.ts::render` 能解析到 `src/util.ts::helper`，并进入 `semanticEdges`。

## 仍需继续迁移

- legacy `ProjectGraph.ts` 已完整保留在 raw 区，但类/协议/继承查询 facade 还未作为 Agent 查询缓存层接入。
- legacy 工程 discoverer 已作为独立模块迁入；下一步需要把 discoverer 结果接入冷启动前置工程能力缓存，而不是只在测试和 facade 中验证。
- legacy `CodeEntityGraph` 已完整保留在 raw 区，但实体/关系物化还未接入新数据层。
- legacy Panorama 已完整保留在 raw 区，包括 `ModuleDiscoverer`、`RoleRefiner`、`CouplingAnalyzer`、`LayerInferrer`、`PanoramaAggregator`、`PanoramaScanner`、`PanoramaService`；其中角色精化、耦合分析、层级推断的核心算法已有 active adapter，下一步补齐完整 `LanguageProfiles` 和 PanoramaAggregator/TechStack/Dimension adapter。
- 冷启动/增量扫描的 project-intelligence 能力已完整保留在 raw 区；下一步需要把 Phase 1 到 Phase 2.2 的成熟编排接入新主线运行路径。
