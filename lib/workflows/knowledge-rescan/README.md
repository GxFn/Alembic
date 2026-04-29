# Knowledge Rescan Workflows

Knowledge rescan workflow 负责“已有知识库的演进、验证和补齐”。它与文件快照增量不同：当前主要增量单位是 Recipe，而不是文件。

## 当前来源

- 内部 Agent 知识重扫：`rescanInternal()` → `runInternalKnowledgeRescanWorkflow()`。
- 外部 Agent 知识重扫：`rescanExternal()` → `runExternalKnowledgeRescanWorkflow()`。
- Recipe 快照与清理：`CleanupService.snapshotRecipes()`、`CleanupService.rescanClean()`。
- 证据审计：`RelevanceAuditor.audit()`。
- 预检：`buildEvolutionPrescreen()`。
- 内部执行：`InternalDimensionExecutionWorkflow` 的 `existingRecipes` + `evolutionPrescreen` 分支。
- 外部补齐：`MissionBriefingBuilder` + handler 注入的 `evidenceHints`。

## 内部 Agent 知识重扫

语义：Dashboard 要求 Alembic 自动验证旧知识并补齐缺口。

目标步骤：

1. `RecipeSnapshotCapability`：读取 active/published/staging/evolving recipes。
2. `RescanCleanPolicy`：清理衍生缓存，保留可消费 recipe 与 evolution proposals。
3. `KnowledgeSyncCapability`：恢复 recipe 文件与 DB 的一致性。
4. `ProjectAnalysisWorkflow`：重新收集项目上下文。
5. `KnowledgeRelevanceWorkflow`：审计 source refs、code entities、dependency graph。
6. `EvolutionPrescreenWorkflow`：生成 auto-resolved 与 needs-verification。
7. `GapPlanner`：按维度计算已有覆盖与补齐目标。
8. `InternalDimensionExecutionWorkflow`：仅对 gap 维度运行内部 Agent，prompt 中注入 existing recipes、decaying recipes、occupied triggers、prescreen。
9. 返回 Dashboard 兼容骨架：`rescan`、`relevanceAudit`、`gapAnalysis`、`bootstrapSession`、`status`。

## 外部 Agent 知识重扫

语义：MCP 外部 IDE Agent 获取 rescan briefing 后，自己执行 evolve 与 gap-fill。

目标步骤：

1. 与内部 rescan 共享 Recipe snapshot、clean、sync、project analysis、relevance audit、prescreen、gap plan。
2. `ExternalSessionWorkflow`：创建只包含请求维度的 session。
3. `RescanBriefingWorkflow`：构建 Mission Briefing。
4. `EvidenceHintInjector`：注入 `allRecipes`、`dimensionGaps`、`evolutionPrescreen`、`occupiedTriggers`、constraints。
5. 覆盖 execution workflow 为：evolve -> gap-fill -> dimension_complete。
6. `ExternalDimensionCompletionWorkflow` 复用冷启动完成链路，但 completion source 标记为 rescan。

## 文件快照增量作为优化

`BootstrapSnapshot` 和 `IncrementalBootstrap` 应迁移为 `FileDiffPlanner`，作为 rescan 的可选前置优化：

- `FileDiffPlan` 决定哪些维度可能受文件变更影响。
- `KnowledgeRescanPlan` 决定哪些 recipe 需要验证、哪些维度有 gap。
- 最终运行维度应为二者组合：`affectedByFileDiff union needsVerificationDims union gapDims`。

这样文件 diff 不会跳过必须重新验证的衰退 recipe，也不会把 rescan 错写成冷启动增量。
