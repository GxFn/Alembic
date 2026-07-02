# plan — 规划环(维度与规模决策)

daemon job 的 plan gate:采集项目情报(Core collectPlanProjectContext)→精简投影
(buildPlanFactsProjection,≤12KB 树+dimensionEvidenceDensity 证据密度)→内部 LLM
决策(runPlanAgent,persona 由 Core PlanAuthoringSpec 单源 render)→PlanSelection
(dimensions+scale.dimensionBudgets+moduleBindings)→投影给 Generate 环。

- 入口:`PlanSelectionGate.ts` runGeneratePlanGate / runPlanSelectionGate(按 generationStage)
- stage 契约:coldStart 免 moduleBindings;deepMining/moduleMining 必须绑定(Core planSelectionRequiresModuleTargets)
- 宿主对照:AlembicPlugin plan-tool(draft/confirm 无状态,host agent 自主决策,同一 Core 投影)
