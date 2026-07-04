# generate — 生成环(三 stage 执行)

| stage(wire 值) | 编排入口 | 语义 |
|---|---|---|
| coldStart | `ColdStartWorkflow.ts`(Phase1-4+异步派发)→`GenerateWorkflow.ts`(mode=full) | 空库全量首扫 |
| deepMining | `DeepMiningRoundGate.ts`(coverage-ledger 差距驱动多轮)→`GenerateWorkflow.ts`(mode=incremental) | 边际收敛的增量深挖 |
| moduleMining | `ModuleMiningWorkflow.ts`+`ModuleMiningSelection.ts` | plan moduleBindings 定向的模块挖掘 |

- `incremental/` — mode='incremental' 的实现(W3 自 sustain/ 迁入):
  IncrementalRescanWorkflow(编排器+模块底部注册副作用,GenerateWorkflow 懒加载它)
  /RescanCoverageLedgerWriter(每维度 coverage ledger 写入)/RescanMiningPlanArgs
  (挖掘计划选项构建与入参规整)。
- `execution/` — 维度执行核心:AiDimensionSessionRunner(并发调度)→DimensionRuntimeBuilder
  (预算/建议数量注入)→AlembicAgent generate-dimension pipeline(analyze→QualityGate→produce)
  →GenerateConsumers(候选落库/checkpoint/Skill)。PCV 证据与 process events 也在此。
- `runtime/` — 生成会话运行时:GenerateTaskManager(bs_ 会话)/GenerateEventEmitter
  (RECIPE_PIPELINE_EVENTS wire 事件)/GenerateRefine/GenerateEfficiency/UiStartupTasks。
- 完成阈值:Core DIMENSION_COMPLETION_FLOOR 单源(与宿主 dimension_complete 同数)。
