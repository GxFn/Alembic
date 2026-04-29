# Common Capabilities Workflows

通用能力 workflow 是冷启动与增量扫描的组合材料，不表达业务入口语义。

## 当前迁移层

这些文件是快速拆分阶段的迁移 facade，先收束职责边界，暂不重写底层实现：

- `project-analysis/ProjectAnalysisWorkflow.ts`：`ProjectAnalysisCapability.run({ prepare, scan, materialize })` 包装旧 `runAllPhases()`，`collectProjectAnalysis()` 仅保留兼容入口。
- `project-analysis/ProjectAnalysisViews.ts`：内部 workflow 的 target file map、panorama summary、language extension 投影视图。
- `cleanup/CleanupPolicies.ts`：`runFullResetPolicy()` 与 `runRescanCleanPolicy()`。
- `knowledge-rescan/KnowledgeRescanPlanner.ts`：rescan sync、recipe audit、prescreen、gap plan、external evidence hints。
- `agent-execution/InternalDimensionFillWorkflow.ts`：内部 Agent task session 与 `fillDimensionsV3()` 调度。
- `agent-execution/ExternalMissionWorkflow.ts`：外部 Agent session cache、Mission Briefing、active session 查询。
- `progress/WorkflowSessionCache.ts`：内部 workflow 的 project analysis session cache。

后续优化阶段再把这些 facade 依赖的旧 `bootstrap/` 与 MCP shared helper 实现迁出。

## 目标能力

### Project Analysis

替代当前 `runAllPhases()` 的核心职责，只做项目分析：

- 文件收集与 target/module 识别。
- AST、Code Entity Graph、Call Graph。
- Dependency Graph、Panorama。
- Guard audit。
- Enhancement Pack 与语言画像。
- active dimensions 解析。

它不应清理数据，不应保存快照，不应判断 internal/external，不应构造 MCP/Dashboard 响应。

### Cleanup Policies

把清理从 handler 与 project analysis 中拿出来：

- `FullResetPolicy`：冷启动专用，清空知识库与运行时数据。
- `RescanCleanPolicy`：增量扫描专用，保留可消费 recipe，清理衍生缓存。
- `PreserveSnapshotsPolicy`：文件 diff 优化专用，显式保留 `bootstrap_snapshots` 与 `bootstrap_dim_files`。

### Planning

- `ColdStartPlan`：完整维度计划。
- `FileDiffPlan`：文件 hash diff 与受影响维度。
- `KnowledgeRescanPlan`：recipe audit、prescreen、gap、occupied triggers。
- `DimensionExecutionPlan`：最终要执行/跳过的维度，带原因。

### Agent Execution

- `InternalDimensionFillWorkflow`：内部 Agent fanout、tier 调度、candidate/skill consumer。
- `ExternalMissionWorkflow`：Mission Briefing、session cache、execution plan。
- `ExternalDimensionCompletionWorkflow`：外部 completion 副作用。

### Progress And Persistence

- task manager session。
- checkpoint 保存/恢复。
- report history。
- snapshot 保存/读取。
- semantic memory consolidation。

### Delivery

- Cursor/IDE delivery。
- wiki generation。
- panorama refresh。
- delivery verification。

## 组合原则

- Capability 输入输出用 typed DTO，不依赖 handler-local `ctx` shape。
- Side effect 必须由 policy 显式声明，不能隐藏在 analysis phase 中。
- Workflow preset 可以组合 capability，但 capability 不知道 preset 名称。
- Internal 与 external 的差异只出现在 execution/completion capability，不出现在 project analysis。
- 冷启动与增量扫描的差异只出现在 cleanup/planning capability，不出现在底层 scan phase。

## 最小接口草案

```ts
interface ProjectAnalysisSnapshot {
  projectRoot: string;
  dataRoot: string;
  allFiles: Array<{ path: string; relativePath: string; content: string }>;
  activeDimensions: Array<{ id: string; label?: string }>;
  language: { primaryLang: string | null; stats: Record<string, number> };
  ast: unknown;
  dependencyGraph: unknown;
  callGraph: unknown;
  panorama: unknown;
  guardAudit: unknown;
  warnings: string[];
}

interface FileDiffPlan {
  mode: 'full' | 'file-diff';
  affectedDimensions: string[];
  skippedDimensions: string[];
  changedFiles: string[];
  reason: string;
}

interface KnowledgeRescanPlan {
  preservedRecipes: number;
  auditSummary: unknown;
  prescreen: unknown;
  gapDimensions: string[];
  skippedDimensions: string[];
  occupiedTriggers: string[];
}
```

这些接口后续应迁移到 `lib/types/workflows.ts` 或各 workflow 的 `types.ts`，避免继续从 MCP handler 类型文件反向引用。
