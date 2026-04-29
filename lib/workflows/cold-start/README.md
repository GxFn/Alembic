# Cold-start Workflows

冷启动 workflow 只负责“从干净状态建立知识库”。它不应再承载 rescan/evolution/gap-fill，也不应默认使用历史 snapshot 做跳过逻辑。

## 当前来源

- 内部 Agent 冷启动：`bootstrapKnowledge()`。
- 外部 Agent 冷启动：`bootstrapExternal()`。
- 共享项目分析：当前来自 `runAllPhases()`。
- 内部自动填充：当前来自 `fillDimensionsV3()`。
- 外部完成：当前来自 `dimensionComplete()`。

## 内部 Agent 冷启动

语义：Dashboard 或内部 AgentRuntime 要求 Alembic 自动生成初始知识库。

目标步骤：

1. `FullResetPolicy`：清理旧 candidates、recipes、skills、wiki、semantic memory、runtime report、相关 DB 数据。
2. `ProjectAnalysisWorkflow`：执行完整项目分析，产出 `ProjectAnalysisSnapshot`。
3. `ColdStartDimensionPlanner`：基于语言、enhancement pack、base dimensions 生成完整维度计划。
4. `InternalDimensionFillWorkflow`：创建 `BootstrapTaskManager` 会话，按 tier fanout 运行内部 Agent。
5. `CompletionWorkflow`：写 checkpoint/report/snapshot，固化 semantic memory，触发 delivery/wiki/panorama。
6. 返回 Dashboard 兼容骨架：`cleanup`、`report`、`analysisFramework`、`bootstrapSession`、`status=filling`。

## 外部 Agent 冷启动

语义：MCP 外部 IDE Agent 获取项目 briefing 后，自己读代码并提交知识。

目标步骤：

1. `FullResetPolicy`。
2. `ProjectAnalysisWorkflow`。
3. `ColdStartDimensionPlanner`。
4. `ExternalSessionWorkflow`：创建 `BootstrapSession`，缓存 `ProjectAnalysisSnapshot`。
5. `MissionBriefingWorkflow`：返回 execution plan、evidence starters、targets、guard summary。
6. `ExternalDimensionCompletionWorkflow`：外部 Agent 每完成一维调用，统一处理 recipe 绑定、skill 生成、checkpoint、progress 和最终交付。

## 冷启动不做什么

- 不执行 recipe relevance audit。
- 不生成 evolution prescreen。
- 不根据 `TARGET_PER_DIM` 做 gap-fill。
- 不在 full reset 后再声称使用历史 snapshot 增量。

如果未来需要“保留部分历史结果重新构建”，应作为 `incremental-scan` 的 `file-diff` 优化，而不是冷启动默认行为。
