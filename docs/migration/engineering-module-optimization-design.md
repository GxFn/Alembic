# Engineering 模块优化设计

## 目标

`lib/mainline/engineering` 的目标不是把 Alembic-legacy 重写成一套薄实现，而是把 legacy 已验证成熟的工程能力迁入后，整理成新 Alembic 可稳定消费的独立工程核心。

本阶段的优化顺序：

1. 保留完整 legacy source，不删成熟逻辑。
2. 建立活跃读模型，让 agent/tool/冷启动链路先能消费工程事实。
3. 再逐步把 raw legacy 中的 ProjectGraph、CodeEntityGraph、Panorama、project-intelligence phase 编排适配进新接口。
4. 最后才做内部层级精简和旧依赖替换。

## 分层

### 0. New Independent Engineering Module

路径：`lib/engineering`

用途：

- 新的工程能力主模块。
- 按 foundation → language/workspace/graph → discovery/code/entity/panorama → workflow 自底向上建设。
- `lib/mainline/engineering` 后续只作为过渡消费者，逐步迁出。

当前已建立：

- `foundation/EngineeringCoreTypes.ts`
- `language/EngineeringLanguageService.ts`
- `language/EngineeringLanguageProfiles.ts`
- `graph/EngineeringGraphPrimitives.ts`
- `workspace/EngineeringWorkspacePaths.ts`

建设记录见 `docs/migration/lib-engineering-bottom-up-build.md`。

### 1. Raw Legacy Source

路径：`lib/mainline/engineering/legacy-source`

用途：

- 原样保留 legacy 成熟实现。
- 作为行为和算法迁移的基准。
- 暂不参与当前 `tsconfig` 编译，因为其中保留旧 DB/repository/DI/agent 依赖原貌。

包含：

- `core/ast/ProjectGraph.ts`
- `core/analysis/*`
- `core/discovery/*`
- `core/enhancement/*`
- `service/knowledge/CodeEntityGraph.ts`
- `service/module/ModuleService.ts`
- `service/panorama/*`
- `workflows/capabilities/project-intelligence/*`
- `shared/*`、`types/*`、`domain/dimension/*`

### 2. Active Engineering Facade

入口：`EngineeringProjectAnalyzer`

职责：

- discoverer 检测与加载。
- target/file 收集。
- ProjectIntelligence artifact 构建。
- dependency graph、relationship graph、panorama summary 合成。
- 输出活跃读模型。

### 3. Active Read Models

当前已建立三类读模型：

- `EngineeringCodeGraph`：对齐 legacy `ProjectGraph` 的查询形态，提供 class/protocol/category/method/file/overview 查询。
- `EngineeringEntityGraph`：对齐 legacy `CodeEntityGraph` 的实体关系模型，先以内存方式物化 file/target/module/class/protocol/category/symbol 和关系边。
- `EngineeringPanoramaSnapshot`：对齐 legacy `PanoramaResult` 的消费形态，先输出模块、层级、循环、外部依赖快照。

这些模型的原则是只读、可序列化、可测试，不直接引入旧数据库。

## 已完成

- `EngineeringCapabilityInventory` 已新增为工程核心能力清单，明确 active、raw-preserved、adapter-planned 与 discarded legacy redundancy。
- `EngineeringCodeGraph.fromArtifact()` 从 AST artifact 建立 ProjectGraph 风格索引。
- `EngineeringEntityGraph.fromInput()` 从 discoverer、AST、semantic edges、call graph 建立实体/边读模型。
- `EngineeringPanoramaSnapshot.fromInput()` 从 panorama summary 和 relationship graph 建立 Panorama 快照。
- `EngineeringPanoramaRefiner` 已迁入 legacy Panorama 的关键活跃算法：depends_on/calls/data_flow 加权耦合、Tarjan SCC、外部依赖 fan-in、配置层级优先、拓扑回退、layer violation、AST/config/call/data-flow/topology 多信号角色投票。
- `lib/engineering` 已新增独立底层模块，`EngineeringPanoramaRefiner` 已开始消费其中的 language profile 和 workspace path 规则。
- `EngineeringProjectAnalyzer.analyze()` 已把三类读模型纳入返回结果。
- 工程测试已覆盖 Node workspace 下 class/inheritance/entity/panorama 读模型。
- 工程测试已直接覆盖 Panorama refiner 的成熟行为，避免后续把 weighted coupling 或 config-first layer 退回薄实现。
- 深挖文档见 `docs/migration/engineering-core-redesign-deep-dive.md`。

## 下一步适配顺序

1. **Panorama 细化**：继续把 raw `LanguageProfiles` 的完整 family/profile 数据迁入 active refiner，替换当前 adapter 内的核心 hint 子集。
2. **CodeEntityGraph 深化**：补齐 path、impact radius、topology、agent context 查询；保持 repository-free，再接新仓库数据层。
3. **ProjectGraph 深化**：补齐协议继承、Category/Extension 方法、增量更新和 ProjectGraph JSON 恢复能力。
4. **Project-Intelligence Phase 编排**：把 legacy Phase 1 → Phase 2.2 的冷启动前工程流水线接入新 mainline runner。
5. **增量链路**：接 `FileDiffPlanner`、snapshot store、affected files/dependent files 传播。

## 不做

- 不在本阶段接前端。
- 不把旧 DI 容器整体搬回新主线。
- 不删除 `legacy-source` 中尚未适配的成熟代码。
- 不再按 easybox/spm 这类例子重写功能，例子只作为成熟 discoverer/profile 的验证样本。
